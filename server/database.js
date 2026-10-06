// 本地库存数据库（Node + SQLite / better-sqlite3）
// 存储钢厂棒材库区库存/库位数据：库位 -> 垛（物理垛数按现场布局 1/2/3/10，全局参数
// stacksPerSlot 与逐库位覆盖 slot_racks 表只能在物理上限内收窄，「库房参数设计」页编辑）
// -> 每垛 ≤ 400 捆（通用上限，实际按限高收窄）
// 另含主应用（三维库区）数据：库区/跨/库位/钢卷/调度任务
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { generateSlots, physicalRacksOf, SPECS } from './layout.js';
import { paramDefaults, clampParam } from './params.js';
/* 垛位推荐算法包（独立项目 StackAlloc）：规格族/杆径/捆制几何/垛容的唯一实现。
 * 本文件保留 geoCfg / specRulesCache 两个参数状态（sim_params / spec_rules 表同步），
 * 计算公式全部委托算法包，保证「推荐、校验、落位三处同口径」。 */
import {
  SPEC_FAMILY, SPEC_DIMS, GEO_DEFAULTS,
  rowsOf, deriveRods as saDeriveRods, bundleRods as saBundleRods,
  bundleDiaCm as saBundleDiaCm, pileDims as saPileDims, stackCap as saStackCap,
} from './stack-alloc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const STACKS_PER_SLOT = 10;         // 每库位垛数（竖着排列）
export const BUNDLES_PER_STACK = 400;      // DB 硬上限（stacks 表 CHECK 约束用）；每垛捆数上限实为库房参数
                                           // （warehouse.bundlesPerStack，默认 100、范围 10~100），实际垛容
                                           // stackCap = min(参数上限, 并排×限高)，见 params.js / GEO_DEFAULTS
export const DB_PATH = process.env.WAREHOUSE_DB || join(__dirname, 'warehouse.db');

/** 打开（不存在则创建）数据库并建表；首次打开时自动灌入主应用数据 */
export function openDb(path = DB_PATH) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  syncGeoCfg(db);     // 库房几何/捆制参数：sim_params warehouse 段 -> geoCfg
  syncSpecRules(db);  // 捆制规则覆盖 -> specRulesCache
  syncRackOverrides(db);   // 每库位垛数覆盖 -> slotRacksCache
  fillStackRows(db);      // 生效垛数调大后补齐空垛行（raw 查询按行取垛，须与生效垛数一致）
  if (!hasAppData(db)) {
    try { seedAppData(db); } catch { /* 种子 JSON 缺失时保持空库 */ }
  }
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS specs (
      name   TEXT PRIMARY KEY,
      weight REAL NOT NULL,
      color  TEXT NOT NULL
    );
    -- 捆制规则覆盖（「库房参数设计」页编辑）：每规格每捆支数；0 = 引擎自动推导；
    -- 无行 = 预置值（SPEC_DIMS.rods）
    CREATE TABLE IF NOT EXISTS spec_rules (
      spec  TEXT PRIMARY KEY,
      rods  INTEGER NOT NULL CHECK (rods BETWEEN 0 AND 999)
    );
    -- 每库位垛数（货架数）覆盖（「库房参数设计」页编辑）：无行 = 全局统一值
    --（sim_params warehouse.stacksPerSlot）；code 与 storage_slots.code 同源但不设外键——
    -- 重建库区会清空重灌 storage_slots，覆盖配置须保留
    CREATE TABLE IF NOT EXISTS slot_racks (
      code  TEXT PRIMARY KEY,
      racks INTEGER NOT NULL CHECK (racks BETWEEN 1 AND ${STACKS_PER_SLOT})
    );
    CREATE TABLE IF NOT EXISTS storage_slots (
      id     INTEGER PRIMARY KEY,
      code   TEXT NOT NULL UNIQUE,
      zone   TEXT NOT NULL,
      area   INTEGER NOT NULL,
      span   INTEGER NOT NULL,          -- 0=A跨 1=B跨 2=C跨；3=整跨合并位
      merged INTEGER NOT NULL DEFAULT 0,
      state  TEXT NOT NULL DEFAULT 'free'   -- free / occupied / locked
    );
    CREATE TABLE IF NOT EXISTS stacks (
      slot_id  INTEGER NOT NULL REFERENCES storage_slots(id),
      stack_no INTEGER NOT NULL CHECK (stack_no BETWEEN 1 AND ${STACKS_PER_SLOT}),
      spec     TEXT,                    -- 同垛单一规格；空垛为 NULL
      count    INTEGER NOT NULL DEFAULT 0 CHECK (count BETWEEN 0 AND ${BUNDLES_PER_STACK}),
      pending  INTEGER NOT NULL DEFAULT 0,  -- 待扫码捆数
      in_time  REAL,                    -- 垛内最早捆入库时间（仿真时钟秒，FIFO 用）
      PRIMARY KEY (slot_id, stack_no)
    );
    -- 捆级三维落位：天车按垛内实际堆放落位后的具体坐标（每在库捆一行）
    --   layer 层号（0=底层，自下而上）/ seat 层内座位号（座位网格固定，落定不挪位）
    --   dx/dz = 捆心相对垛格中心偏移（米）；y = 捆底标高（米）；yaw = 微偏转（弧度）
    -- 仿真在落料/倒垛/出库时增量同步；期初加载与重置时全量对齐（replace）
    CREATE TABLE IF NOT EXISTS bundle_positions (
      bundle_id  TEXT PRIMARY KEY,      -- 捆号（B-xxxx，与捆标签/捆级明细一致）
      slot_id    INTEGER NOT NULL REFERENCES storage_slots(id),
      stack_no   INTEGER NOT NULL CHECK (stack_no BETWEEN 1 AND ${STACKS_PER_SLOT}),
      layer      INTEGER NOT NULL CHECK (layer >= 0),
      seat       INTEGER NOT NULL CHECK (seat >= 0),
      spec       TEXT,                  -- 规格名（冗余，便于外部系统直读）
      len        REAL,                  -- 捆长（米，冗余）
      dx         REAL NOT NULL DEFAULT 0,
      y          REAL NOT NULL DEFAULT 0,
      dz         REAL NOT NULL DEFAULT 0,
      yaw        REAL NOT NULL DEFAULT 0,
      put_time   REAL,                  -- 落位时刻（仿真时钟秒，期初为负值）
      updated_at TEXT NOT NULL          -- 墙钟时间（ISO 字符串）
    );
    -- 主应用（三维库区）数据表：库区 / 跨 / 库位 / 钢卷 / 调度任务
    CREATE TABLE IF NOT EXISTS app_warehouse (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      total_area        REAL NOT NULL,
      number_of_spans   INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_spans (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      length    REAL NOT NULL,
      width     REAL NOT NULL,
      position  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_locations (
      id            TEXT PRIMARY KEY,
      span_id       TEXT NOT NULL,
      row           INTEGER NOT NULL,
      col           INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'empty',   -- empty / occupied / reserved
      capacity      INTEGER NOT NULL DEFAULT 20,
      steel_coil_id TEXT
    );
    CREATE TABLE IF NOT EXISTS app_coils (
      id            TEXT PRIMARY KEY,
      coil_number   TEXT NOT NULL UNIQUE,
      specification TEXT NOT NULL,
      weight        REAL NOT NULL,
      diameter      REAL NOT NULL,
      material      TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'in-stock',  -- in-stock / reserved / shipping
      location_id   TEXT
    );
    CREATE TABLE IF NOT EXISTS app_tasks (
      id               TEXT PRIMARY KEY,
      type             TEXT NOT NULL,   -- inbound / outbound / transfer
      status           TEXT NOT NULL DEFAULT 'pending',  -- pending / executing / completed / failed
      steel_coil_id    TEXT NOT NULL,
      from_location_id TEXT,
      to_location_id   TEXT,
      create_time      TEXT NOT NULL,
      complete_time    TEXT
    );
    -- 调度规划参数（主系统「调度参数」页 / 仿真沙盘共用，key 形如 placement.sameSpecBase）
    CREATE TABLE IF NOT EXISTS sim_params (
      key   TEXT PRIMARY KEY,
      value REAL NOT NULL
    );
    -- 进厂车辆（管理工「进厂确认」页）：车牌/运单识别结果 + 垛位分配确认状态
    CREATE TABLE IF NOT EXISTS inbound_vehicles (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      plate          TEXT NOT NULL,
      waybill        TEXT NOT NULL,
      mill           TEXT NOT NULL,
      arrive_time    TEXT NOT NULL,
      state          TEXT NOT NULL DEFAULT 'pending',   -- pending / confirmed / completed
      confirmed_time TEXT,
      departed_time  TEXT                               -- 卸毕离场时刻（沙盘回传，台账闭环）
    );
    -- 进厂车辆的垛位分配（一组 = 同规格连续吊装、集中码放同一垛，垛满拆多组）
    CREATE TABLE IF NOT EXISTS inbound_loads (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id   INTEGER NOT NULL REFERENCES inbound_vehicles(id),
      spec         TEXT NOT NULL,
      bundles      INTEGER NOT NULL CHECK (bundles > 0),
      rec_slot_id  INTEGER NOT NULL,
      rec_stack_no INTEGER NOT NULL,
      rec_score    REAL NOT NULL DEFAULT 0,
      rec_parts    TEXT NOT NULL DEFAULT '[]',        -- 推荐评分分解 JSON
      slot_id      INTEGER,                           -- 最终垛位（未调整为空，取推荐值）
      stack_no     INTEGER,
      adjusted     INTEGER NOT NULL DEFAULT 0
    );
    -- 人工确认/调整留痕：调整组的推荐落点 vs 实际落点 + 触发的权重优化量
    CREATE TABLE IF NOT EXISTS placement_feedback (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      time           TEXT NOT NULL,
      vehicle_id     INTEGER,
      plate          TEXT,
      spec           TEXT NOT NULL,
      bundles        INTEGER NOT NULL,
      action         TEXT NOT NULL,                   -- confirmed / adjusted
      rec_code       TEXT,
      rec_stack_no   INTEGER,
      final_code     TEXT,
      final_stack_no INTEGER,
      deltas         TEXT NOT NULL DEFAULT '[]'       -- 权重变化 [{key,label,from,to}]
    );
    -- 钢材台账（一捆一行，与捆标签一一对应）：字段 = Excel「钢材入库数据-近3个月」全 18 列
    -- （钢材类型/材质/炉号/长度/支数/重量/日期/采购商/合同号/规格/标准/库位/垛位/垛位层/
    --   入库时间/进厂车牌/出库时间/出厂车牌）+ 捆标签附加字段（供应商/PO号/材料号）。
    -- 落位写库（syncBundlePositions）自动建账：新捆插入、倒垛仅迁位置、出库回写离场信息；
    -- 捆号随沙盘重启复用（自增 id 区分物理捆），期初全量对齐 replace 时清除已落位的在库行
    -- （身份重建，非出库），已出库历史与未落位的扫码补录行保留。
    CREATE TABLE IF NOT EXISTS steel_ledger (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      bundle_id      TEXT NOT NULL,             -- 捆号（B-xxxx，与捆标签/bundle_positions 一致）
      steel_type     TEXT,                      -- 钢材类型（螺纹钢/圆钢/方钢/管材，按规格族推导）
      grade          TEXT,                      -- 钢材材质（牌号：HRB400E / 45# / S690G5QL ...）
      heat_no        TEXT,                      -- 炉号
      len            REAL,                      -- 长度（米）
      rods           INTEGER,                   -- 支数
      weight_kg      REAL,                      -- 重量（千克，与标签口径一致）
      produce_date   TEXT,                      -- 日期（标签生产/出厂日期）
      buyer          TEXT,                      -- 采购商（出库提货单回填）
      contract_no    TEXT,                      -- 合同号（标签·供货合同）
      spec           TEXT,                      -- 规格/直径（规格名，如 圆钢 Φ60）
      standard       TEXT,                      -- 标准（GB/T 1499.2 / EN10297-1 ...）
      supplier       TEXT,                      -- 供应商（标签抬头钢厂）
      po_no          TEXT,                      -- PO号（标签）
      material_no    TEXT,                      -- 材料号（标签）
      slot_id        INTEGER,                   -- 库位（storage_slots.id；未落位补录行为 NULL）
      stack_no       INTEGER,                   -- 垛位
      layer          INTEGER,                   -- 垛位层（0=底层，导出 +1）
      inbound_time   TEXT,                      -- 入库时间（NULL=期初存量）
      inbound_plate  TEXT,                      -- 进厂车牌
      outbound_time  TEXT,                      -- 出库时间（NULL=在库）
      outbound_plate TEXT,                      -- 出厂车牌
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_bundle   ON steel_ledger(bundle_id, outbound_time);
    CREATE INDEX IF NOT EXISTS idx_ledger_heat     ON steel_ledger(heat_no);
    CREATE INDEX IF NOT EXISTS idx_ledger_contract ON steel_ledger(contract_no);
    CREATE INDEX IF NOT EXISTS idx_ledger_inbound  ON steel_ledger(inbound_time);
  `);
  // 轻量迁移：历史库文件补列（CREATE TABLE IF NOT EXISTS 不会给已存在的表加新列）
  try { db.prepare('SELECT departed_time FROM inbound_vehicles LIMIT 1').get(); }
  catch { db.exec('ALTER TABLE inbound_vehicles ADD COLUMN departed_time TEXT'); }
  // 每库位垛数上限调整（8 -> 10 等）：旧库文件的 CHECK 约束写死在建表语句里，
  // SQLite 改约束必须重建表（建新表 -> 拷数据 -> 换名），否则写入第 9/10 垛会被拒
  widenStackChecks(db);
}

/** 上限不一致时按当前 STACKS_PER_SLOT 重建表（保留数据；列名/语义完全一致） */
function widenStackChecks(db) {
  const plans = [
    { name: 'slot_racks', pat: /racks\s+INTEGER NOT NULL CHECK \(racks BETWEEN 1 AND (\d+)\)/ },
    { name: 'stacks', pat: /stack_no\s+INTEGER NOT NULL CHECK \(stack_no BETWEEN 1 AND (\d+)\)/ },
    { name: 'bundle_positions', pat: /stack_no\s+INTEGER NOT NULL CHECK \(stack_no BETWEEN 1 AND (\d+)\)/ },
  ];
  for (const { name, pat } of plans) {
    const sql = db.prepare(`SELECT sql s FROM sqlite_master WHERE type='table' AND name=?`).get(name)?.s;
    if (!sql) continue;
    const m = sql.match(pat);
    if (!m || Number(m[1]) === STACKS_PER_SLOT) continue;
    db.exec(`ALTER TABLE ${name} RENAME TO ${name}_old;
      ${sql.replace(new RegExp(`BETWEEN 1 AND ${m[1]}`), `BETWEEN 1 AND ${STACKS_PER_SLOT}`)};
      INSERT INTO ${name} SELECT * FROM ${name}_old;
      DROP TABLE ${name}_old;`);
  }
}

/* ================= 调度规划参数（sim_params 表） ================= */

/** 读取调度参数：schema 默认值 + 库内覆盖值合并（读取时按 schema 夹取，兼容历史越界值），返回 { sec: { key: value } } */
export function getSimParams(db) {
  const values = paramDefaults();
  for (const r of db.prepare('SELECT key, value FROM sim_params').all()) {
    const dot = String(r.key).indexOf('.');
    if (dot < 0) continue;
    const sec = r.key.slice(0, dot), key = r.key.slice(dot + 1);
    const v = clampParam(sec, key, r.value);
    if (values[sec] && v !== null) values[sec][key] = v;
  }
  return values;
}

/** 更新调度参数：patch = { sec: { key: value } }，按 schema 夹取并 upsert；返回合并后的全量值 */
export function setSimParams(db, patch = {}) {
  const up = db.prepare(
    'INSERT INTO sim_params (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const tx = db.transaction(() => {
    for (const [sec, kv] of Object.entries(patch || {})) {
      if (!kv || typeof kv !== 'object') continue;
      for (const [key, raw] of Object.entries(kv)) {
        const v = clampParam(sec, key, raw);
        if (v !== null) up.run(`${sec}.${key}`, v);
      }
    }
  });
  tx();
  syncGeoCfg(db);   // warehouse 段参数即时生效（垛容/捆径/限高等几何函数实时读取）
  return getSimParams(db);
}

/* ================= 主应用（三维库区）数据 ================= */

const APP_SEED_DIR = join(__dirname, 'data');

function readSeedJson(file) {
  return JSON.parse(readFileSync(join(APP_SEED_DIR, file), 'utf8'));
}

/** 种子 JSON 文件是否齐全 */
export function appSeedFilesExist() {
  return ['warehouse.json', 'locations.json', 'coils.json', 'tasks.json']
    .every(f => existsSync(join(APP_SEED_DIR, f)));
}

/** 主应用数据是否已入库 */
export function hasAppData(db) {
  return db.prepare('SELECT COUNT(*) n FROM app_warehouse').get().n > 0;
}

/** 从 server/data/*.json 灌入主应用数据（重建）；无 JSON 文件则保持现状 */
export function seedAppData(db) {
  if (!appSeedFilesExist()) return;
  const warehouse = readSeedJson('warehouse.json');
  const locations = readSeedJson('locations.json');
  const coils = readSeedJson('coils.json');
  const tasks = readSeedJson('tasks.json');
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM app_tasks').run();
    db.prepare('DELETE FROM app_coils').run();
    db.prepare('DELETE FROM app_locations').run();
    db.prepare('DELETE FROM app_spans').run();
    db.prepare('DELETE FROM app_warehouse').run();

    db.prepare('INSERT INTO app_warehouse (id, name, total_area, number_of_spans) VALUES (?, ?, ?, ?)')
      .run(warehouse.id, warehouse.name, warehouse.totalArea, warehouse.numberOfSpans);
    const insSpan = db.prepare('INSERT INTO app_spans (id, name, length, width, position) VALUES (?, ?, ?, ?, ?)');
    for (const s of warehouse.spans) insSpan.run(s.id, s.name, s.length, s.width, s.position);

    const insLoc = db.prepare(
      'INSERT INTO app_locations (id, span_id, row, col, status, capacity, steel_coil_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const l of locations) insLoc.run(l.id, l.spanId, l.row, l.column, l.status, l.capacity, l.steelCoilId ?? null);

    const insCoil = db.prepare(
      'INSERT INTO app_coils (id, coil_number, specification, weight, diameter, material, status, location_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const c of coils) insCoil.run(c.id, c.coilNumber, c.specification, c.weight, c.diameter, c.material, c.status, c.locationId ?? null);

    const insTask = db.prepare(
      'INSERT INTO app_tasks (id, type, status, steel_coil_id, from_location_id, to_location_id, create_time, complete_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const t of tasks) insTask.run(t.id, t.type, t.status, t.steelCoilId, t.fromLocationId ?? null, t.toLocationId ?? null, t.createTime, t.completeTime ?? null);
  });
  tx();
}

/** app_tasks 行 -> 前端字段（camelCase，空字段省略） */
function taskView(t) {
  return { id: t.id, type: t.type, status: t.status, steelCoilId: t.steel_coil_id,
    ...(t.from_location_id ? { fromLocationId: t.from_location_id } : {}),
    ...(t.to_location_id ? { toLocationId: t.to_location_id } : {}),
    createTime: t.create_time,
    ...(t.complete_time ? { completeTime: t.complete_time } : {}) };
}

/** 主应用全量数据（字段名与前端类型一致） */
export function getAppData(db) {
  const w = db.prepare('SELECT * FROM app_warehouse LIMIT 1').get();
  if (!w) return null;
  const spans = db.prepare('SELECT * FROM app_spans ORDER BY position').all()
    .map(s => ({ id: s.id, name: s.name, length: s.length, width: s.width, position: s.position }));
  const locations = db.prepare('SELECT * FROM app_locations ORDER BY span_id, row, col').all()
    .map(l => ({ id: l.id, spanId: l.spanId, row: l.row, column: l.col, status: l.status, capacity: l.capacity, ...(l.steel_coil_id ? { steelCoilId: l.steel_coil_id } : {}) }));
  const coils = db.prepare('SELECT * FROM app_coils ORDER BY coil_number').all()
    .map(c => ({ id: c.id, coilNumber: c.coil_number, specification: c.specification, weight: c.weight, diameter: c.diameter, material: c.material, status: c.status, ...(c.location_id ? { locationId: c.location_id } : {}) }));
  const tasks = db.prepare('SELECT * FROM app_tasks ORDER BY create_time').all().map(taskView);
  return {
    warehouse: { id: w.id, name: w.name, totalArea: w.total_area, numberOfSpans: w.number_of_spans, spans },
    locations, coils, tasks,
  };
}

/** 新建调度任务（id 冲突或钢卷不存在返回 null） */
export function createTask(db, task) {
  if (!task || !task.id || !task.type || !task.steelCoilId) return null;
  const coil = db.prepare('SELECT id FROM app_coils WHERE id=?').get(task.steelCoilId);
  if (!coil) return null;
  try {
    db.prepare('INSERT INTO app_tasks (id, type, status, steel_coil_id, from_location_id, to_location_id, create_time, complete_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(task.id, task.type, task.status || 'pending', task.steelCoilId, task.fromLocationId ?? null, task.toLocationId ?? null, task.createTime || new Date().toISOString(), task.completeTime ?? null);
  } catch { return null; }
  return taskView(db.prepare('SELECT * FROM app_tasks WHERE id=?').get(task.id));
}

/** 更新任务状态；置 completed 时自动记录完成时间 */
export function updateTaskStatus(db, id, status) {
  const cur = db.prepare('SELECT * FROM app_tasks WHERE id=?').get(id);
  if (!cur) return null;
  const completeTime = status === 'completed' && !cur.complete_time ? new Date().toISOString() : cur.complete_time;
  db.prepare('UPDATE app_tasks SET status=?, complete_time=? WHERE id=?').run(status, completeTime, id);
  return taskView(db.prepare('SELECT * FROM app_tasks WHERE id=?').get(id));
}

/** 删除调度任务；不存在返回 false */
export function deleteTask(db, id) {
  return db.prepare('DELETE FROM app_tasks WHERE id=?').run(id).changes > 0;
}

/* ---------------- 实际钢材分布灌库 ----------------
 * 按现场分区专业化归堆（与卸货推荐算法「同类货物放一起」原则一致）：
 *   一跨棒材（装棒筒/大棒/中棒 -> 螺纹、圆钢；14~16 大棒头(制光钢) -> 圆钢 Φ60）
 *   二跨管材（小无缝短管 Φ50/Φ100、219/460 长管 Φ200~Φ600、高钢管、扁钢杂 -> 方钢）
 *   三跨外贸/内贸棒扁钢与商品坯（螺纹、圆钢、方钢）
 * 同库位以单一规格为主，少量同族（同形状）规格邻垛混放；号区内按 area 成带，
 * 相邻库位同规格连片，形成聚簇。确定性随机流（mulberry32），灌库结果可复现。 */
const ZONE_SPEC_POOL = {
  // 一跨 A（棒材跨）
  '装棒筒区':                    ['螺纹钢 Φ20', '螺纹钢 Φ25'],
  '大棒区域':                    ['圆钢 Φ50', '圆钢 Φ60'],
  '大棒头（制光钢）':            ['圆钢 Φ60'],
  '中棒区域':                    ['圆钢 Φ50', '螺纹钢 Φ25'],
  '备用区域':                    ['螺纹钢 Φ20', '圆钢 Φ50'],
  // 二跨 B（管材跨）
  '扁钢杂区域':                  ['方钢 40×40'],
  '219及钢管长钢区域（10米以上）': ['管材 Φ200', '管材 Φ400'],
  '460管（9.5米左右）':           ['管材 Φ400', '管材 Φ600'],
  '高钢管':                      ['管材 Φ600'],
  '高钢管（临时）':               ['管材 Φ400'],
  '小无缝及钢管短钢区域（8米以内）': ['管材 Φ50', '管材 Φ100'],
  '钢管外贸区域':                ['管材 Φ100', '管材 Φ200'],
  // 三跨 C（外贸/内贸棒扁钢跨）
  '冀鲁扁钢区域':                ['方钢 40×40'],
  '大棒外贸区域':                ['圆钢 Φ50', '圆钢 Φ60'],
  '小中棒外贸区域':              ['螺纹钢 Φ20', '螺纹钢 Φ25'],
  '外贸长钢区域':                ['圆钢 Φ60'],
  '小棒内贸区域':                ['螺纹钢 Φ20'],
  '待定':                        ['螺纹钢 Φ25'],
  '扁棒圆钢区域':                ['圆钢 Φ50'],
  '商品坯':                      ['方钢 40×40'],
};
/* 规格族 SPEC_FAMILY / 规格杆径 SPEC_DIMS / 捆内支数排布 rowsOf / 库房几何默认 GEO_DEFAULTS
 * 均已上移到垛位推荐算法包（StackAlloc），本文件经 import 同源使用（见文件头）。 */

/* 库房几何参数（默认 = StackAlloc GEO_DEFAULTS；openDb / setSimParams / 规则保存时与 sim_params 同步）
 * fillRatio = 库容装载比例（%）：仅期初灌库（seed/buildSeedSlots）按此比例铺层，重建库区生效 */
let geoCfg = { ...GEO_DEFAULTS };
export { GEO_DEFAULTS };
/** 当前库房几何参数快照（只读副本） */
export function getGeoCfg() { return { ...geoCfg }; };
function syncGeoCfg(db) {
  const w = getSimParams(db).warehouse || {};
  for (const k of Object.keys(GEO_DEFAULTS)) if (Number.isFinite(w[k])) geoCfg[k] = w[k];
}
/* spec_rules 覆盖缓存（与表同步：openDb / applyBundleRules / 查询时刷新） */
let specRulesCache = new Map();
function syncSpecRules(db) {
  specRulesCache = new Map(db.prepare('SELECT spec, rods FROM spec_rules').all().map(r => [r.spec, r.rods]));
}
/** 捆制规则覆盖缓存（Map：规格 -> 支数，0=引擎自动推导）：垛位推荐算法包的 rules 入参 */
export function getSpecRules() { return specRulesCache; }

/** 补齐垛行：全局/逐库位垛数调大后，缺的垛号补空行（inbound/落位等按行取垛的路径与生效垛数一致）；
 *  只补不删——调小后仍有存货的高位垛保留（见 shapeSlotStacks）。须在 syncGeoCfg/syncRackOverrides 之后调用。 */
function fillStackRows(db) {
  const slots = db.prepare('SELECT id, code FROM storage_slots').all();
  if (!slots.length) return 0;
  const have = new Set(db.prepare('SELECT slot_id || :sep || stack_no k FROM stacks').all({ sep: '\0' }).map(r => r.k));
  const ins = db.prepare('INSERT INTO stacks (slot_id, stack_no) VALUES (?, ?)');
  let added = 0;
  const tx = db.transaction(() => {
    for (const s of slots) {
      for (let n = 1; n <= effectiveRacks(s.code); n++) {
        const k = s.id + '\0' + n;
        if (!have.has(k)) { ins.run(s.id, n); added++; }
      }
    }
  });
  tx();
  return added;
}

/* ================= 每库位垛数（货架数）：物理垛数上限 + 全局统一值 + 逐库位覆盖 =================
 * 生效垛数 = min(slot_racks 覆盖 > sim_params warehouse.stacksPerSlot, 库位物理垛数)。
 * 物理垛数 = 现场实际垛位列数（2/3/10，一跨 14~16 合并位 1，见 layout.js physicalRacks）；
 * 调小后仍有存货的高位垛保留（垛清空即自然收敛），getSlots 按此合成垛行。 */
let slotRacksCache = new Map();
function syncRackOverrides(db) {
  slotRacksCache = new Map(db.prepare('SELECT code, racks FROM slot_racks').all().map(r => [r.code, r.racks]));
}
const rackLimit = n => Math.max(1, Math.min(STACKS_PER_SLOT, Math.round(Number(n) || STACKS_PER_SLOT)));
/** 全局统一垛数（sim_params warehouse.stacksPerSlot，已夹取 1~10；超过物理垛数的库位按物理值收窄） */
export function globalStacksPerSlot() { return rackLimit(geoCfg.stacksPerSlot); }
/** 生效垛数（不含在货兜底）：覆盖 > 全局参数，均不超过库位物理垛数 */
export function effectiveRacks(code) {
  const ov = slotRacksCache.get(code);
  return Math.min(rackLimit(ov != null ? ov : geoCfg.stacksPerSlot), physicalRacksOf(code));
}
/** 逐库位覆盖快照：{ code: racks }（仅覆盖项），供 GET /api/slot-racks 与期初重灌 */
export function getSlotRacks(db) {
  syncRackOverrides(db);
  return Object.fromEntries(slotRacksCache);
}
/** 更新逐库位覆盖：racks = { code: 垛数 | null }（null/越界回退 = 清除该覆盖，跟随全局）；
 *  返回 { racks 合并后的覆盖快照, global 当前全局值, changed 变更明细 } */
export function applySlotRacks(db, racks = {}) {
  const known = new Set(db.prepare('SELECT code FROM storage_slots').all().map(r => r.code));
  const up = db.prepare('INSERT INTO slot_racks (code, racks) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET racks=excluded.racks');
  const del = db.prepare('DELETE FROM slot_racks WHERE code=?');
  const changed = [];
  const tx = db.transaction(() => {
    for (const [code, raw] of Object.entries(racks || {})) {
      if (!known.has(code)) continue;
      const v = raw == null ? null : Math.min(rackLimit(raw), physicalRacksOf(code));   // 覆盖不超过物理垛数
      const cur = slotRacksCache.get(code);
      if (v == null) {
        if (cur == null) continue;
        del.run(code); slotRacksCache.delete(code);
        changed.push({ code, from: cur, to: null });
      } else {
        if (cur === v) continue;
        const fromEff = effectiveRacks(code);   // 先取变更前生效值（覆盖 > 全局）
        up.run(code, v); slotRacksCache.set(code, v);
        changed.push({ code, from: fromEff, to: v });
      }
    }
  });
  tx();
  return { racks: Object.fromEntries(slotRacksCache), global: rackLimit(geoCfg.stacksPerSlot), changed };
}

/* ---- 捆制/垛容几何：公式在 StackAlloc 算法包，此处注入当前库房参数与捆制规则转发 ---- */

/** 捆制规则引擎：给定杆径(mm)，按三角数支数推导使捆径落入 [minCm, maxCm] 的最小支数；
 *  单支即达标 -> 1；单支仍超上限（如 Φ600）也返回 1——单支是物理下限，由调用方警示。 */
export function deriveRods(diaMm, minCm = geoCfg.minDiaCm, maxCm = geoCfg.maxDiaCm) {
  return saDeriveRods(diaMm, { ...geoCfg, minDiaCm: minCm, maxDiaCm: maxCm });
}
/** 每捆支数：spec_rules 覆盖（>0=手工覆盖 / 0=引擎自动）> 预置值 > 自动推导；未知规格返回 0 */
export function bundleRods(specName) {
  return saBundleRods(specName, geoCfg, specRulesCache);
}
/** 捆径（一捆合起来的外接圆直径，cm）：打捆件（支数>1）口径须落在 min~max 上下限内 */
export function bundleDiaCm(specName) {
  return saBundleDiaCm(specName, geoCfg, specRulesCache);
}
/** 规格码放几何：{ across 每层并排数, maxLayers 限高可堆层数, geo 物理垛容 }；未知规格返回 null */
export function pileDims(specName) {
  return saPileDims(specName, geoCfg, specRulesCache);
}
/** 垛容量（捆）：min(每垛通用上限, 每层并排 × 限高层数)——与仿真沙盘 stackCap 完全同口径。
 *  进厂确认的推荐/校验若超此口径，分配单会超出物理垛容、与沙盘实际落位背离。 */
export function stackCap(specName) {
  return saStackCap(specName, geoCfg, specRulesCache);
}
/** 全量捆制规则（含几何核算与来源）：供 GET /api/bundle-rules 与规则页展示 */
export function getBundleRules(db) {
  syncGeoCfg(db); syncSpecRules(db);
  const weightOf = db.prepare('SELECT weight FROM specs WHERE name=?');
  return Object.keys(SPEC_DIMS).map(spec => {
    const d = SPEC_DIMS[spec];
    const rule = specRulesCache.get(spec);
    const rods = bundleRods(spec);
    return {
      spec, dia: d.dia, shape: SPEC_FAMILY[spec],
      rods, source: rule == null ? 'preset' : (rule > 0 ? 'override' : 'auto'),
      presetRods: d.rods,
      rows: rowsOf(rods), diaCm: +bundleDiaCm(spec).toFixed(1),
      cap: stackCap(spec), single: rods === 1,
      weight: weightOf.get(spec)?.weight ?? null,
    };
  });
}
/** 更新捆制规则覆盖：rules = [{ spec, rods }]（rods>0 覆盖 / 0=引擎自动 / null=恢复预置）。
 *  棒材（非管材）按理论米重自动重算单捆吨位（圆/螺纹 d²×0.00617、方钢 d²×0.00785 kg/m，9m 基准）。
 *  返回 { warnings 捆径越界警示, weights 吨位变更 [{spec,from,to}] } */
export function applyBundleRules(db, rules = []) {
  const warnings = [], weights = [];
  const up = db.prepare('INSERT INTO spec_rules (spec, rods) VALUES (?, ?) ON CONFLICT(spec) DO UPDATE SET rods=excluded.rods');
  const del = db.prepare('DELETE FROM spec_rules WHERE spec=?');
  const setW = db.prepare('UPDATE specs SET weight=? WHERE name=?');
  const tx = db.transaction(() => {
    for (const r of rules || []) {
      if (!r || !(r.spec in SPEC_DIMS)) continue;
      if (r.rods == null) { del.run(r.spec); specRulesCache.delete(r.spec); continue; }
      const rods = Math.max(0, Math.min(999, Math.round(Number(r.rods) || 0)));
      up.run(r.spec, rods);
      specRulesCache.set(r.spec, rods);
    }
    for (const name of Object.keys(SPEC_DIMS)) {
      const d = SPEC_DIMS[name], rods = bundleRods(name), diaCm = bundleDiaCm(name);
      if (!rods || diaCm == null) continue;
      if (rods > 1 && (diaCm < geoCfg.minDiaCm - 1e-9 || diaCm > geoCfg.maxDiaCm + 1e-9))
        warnings.push(`${name}：${rods} 支/捆 · 捆径 ${diaCm.toFixed(1)}cm 超出口径 ${geoCfg.minDiaCm}~${geoCfg.maxDiaCm}cm`);
      const fam = SPEC_FAMILY[name];
      if (fam === 'pipe') continue;   // 管材无壁厚数据，吨位保持手工值
      const kgm = d.dia * d.dia * (fam === 'square' ? 0.00785 : 0.00617);
      const w = +(kgm * 9 * rods / 1000).toFixed(2);
      const cur = db.prepare('SELECT weight FROM specs WHERE name=?').get(name);
      if (cur && Math.abs(cur.weight - w) > 1e-9) { setW.run(w, name); weights.push({ spec: name, from: cur.weight, to: w }); }
    }
  });
  tx();
  return { warnings, weights };
}
export { SPEC_FAMILY };
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 期初钢材分布（纯函数，确定性随机流 mulberry32(20260825)，结果可复现）。
 * seed(db) 据此灌库；GET /api/slots?variant=seed 原样返回同一分布 ——
 * 沙盘 ?feed=all 全量回放时以此为期初（数据库当前值已含历史出入库结果，
 * 直接在其上重放事件流会重复计数），从期初重建与驾驶实例一致的库存轨迹。
 */
export function buildSeedSlots(rackOverrides = null) {
  const slots = generateSlots();
  const rnd = mulberry32(20260825);
  const out = [];
  for (const s of slots) {
    const pool = ZONE_SPEC_POOL[s.zone] || ['螺纹钢 Φ20'];
    const occupied = rnd() >= 0.04;                    // 约 4% 空库位（入库缓冲位，其余靠未满垛顶装）
    const primary = occupied ? pool[(s.area + s.span) % pool.length] : null;  // 按号区成带，相邻库位连片聚簇
    const nRacks = rackOverrides && rackOverrides[s.code] != null
      ? rackLimit(rackOverrides[s.code]) : effectiveRacks(s.code);   // 每库位垛数：覆盖 > 全局
    const usedStacks = occupied ? Math.min(nRacks, nRacks - 1 + (rnd() < 0.8 ? 1 : 0)) : 0;   // 高密度：尽量铺满（八成满垛），余下留空垛
    const stacks = [];
    for (let n = 1; n <= nRacks; n++) {
      if (n > usedStacks) { stacks.push({ stack_no: n, spec: null, count: 0, pending: 0, in_time: null }); continue; }
      let spec = primary;
      if (n === usedStacks && pool.length > 1 && rnd() < 0.3) {    // 末垛 30% 概率混入同族相近规格（相似货物同库位）
        spec = pool[(s.area + s.span + 1) % pool.length];
      }
      const dim = pileDims(spec);
      // 铺层策略：按限高可堆层数的「库容装载比例」（geoCfg.fillRatio，%）±4% 抖动铺放、每垛至少 2 层
      //（垛体稳定下限，低比例时以 2 层为准）；铺层比例随机流按垛均匀消耗（与规格无关，
      //  保证空库位数量稳定）；大口径单支管（Φ200/Φ400/Φ600，单支吊运）保持满垛，
      //  作为「限高收窄」样例。默认 22% 即原 18~26% 区间，随机流逐次调用不变、分布可复现。
      const fillF = Math.min(1, Math.max(0.05, geoCfg.fillRatio / 100 - 0.04 + 0.08 * rnd()));
      const count = (spec === '管材 Φ200' || spec === '管材 Φ400' || spec === '管材 Φ600')
        ? stackCap(spec)
        : Math.min(dim.across * Math.max(2, Math.round(dim.maxLayers * fillF)), stackCap(spec));
      const inTime = -(600 + Math.floor(rnd() * 85800)); // 期初入账（前一日的负时刻，FIFO 基准）
      stacks.push({ stack_no: n, spec, count, pending: 0, in_time: inTime });
    }
    out.push({ id: s.id, code: s.code, zone: s.zone, area: s.area, span: s.span, merged: s.merged,
      state: occupied ? 'occupied' : 'free', racks: nRacks, stacks });
  }
  /* 空库位兜底：随机流按垛消耗后极端情况可能 0 空位——强制匀距 3 库位留空作入库缓冲位（确定性） */
  if (out.filter(s => s.state === 'free').length < 3) {
    for (const id of [7, 41, 74]) {
      const s = out[id];
      if (!s || s.state === 'free') continue;
      s.state = 'free';
      for (const k of s.stacks) { k.spec = null; k.count = 0; k.pending = 0; k.in_time = null; }
    }
  }
  return out;
}
/** 期初种子分布（与 /api/slots 行形状一致，供沙盘全量回放重建期初）；
 *  逐库位垛数覆盖与全局参数一并生效（与 seed 同源）。db 可选：不传时仅按全局参数（探针离线调用） */
export function getSeedSlots(db = null) {
  return buildSeedSlots(db ? getSlotRacks(db) : null);
}

/**
 * 重建数据：写入规格 + 91 库位（一跨 33 / 二跨 25 / 三跨 33，现场布局）+ 各库位物理垛，
 * 并按分区专业化灌入实际钢材分布
 *（按限高可堆层数的「库容装载比例」铺层——默认 22%；可在
 *  「库房参数设计」页调整 fillRatio 后重建。总库容按当前库房参数计：
 *  Σ每库位生效垛数×每垛捆数上限（默认 555×100=55,500 捆通用上限，
 *  实际垛容按规格限高收窄），均已扫码入账；保留少量空库位与未满垛作入库缓冲）。
 */
export function seed(db) {
  syncGeoCfg(db); syncSpecRules(db); syncRackOverrides(db);   // 重建按当前库房参数/捆制规则/每库位垛数铺层
  const slots = buildSeedSlots(getSlotRacks(db));
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM bundle_positions').run();   // 捆级落位坐标随重建清空（外键依赖 storage_slots，须先删）
    db.prepare('DELETE FROM steel_ledger WHERE outbound_time IS NULL AND slot_id IS NOT NULL').run();   // 台账：已落位的在库捆随库区重建清除（非出库；已出库历史与未落位补录行保留）
    db.prepare('DELETE FROM stacks').run();
    db.prepare('DELETE FROM storage_slots').run();
    db.prepare('DELETE FROM specs').run();

    const insSpec = db.prepare('INSERT INTO specs (name, weight, color) VALUES (?, ?, ?)');
    for (const s of SPECS) insSpec.run(s.name, s.weight, s.color);

    const insSlot = db.prepare(
      'INSERT INTO storage_slots (id, code, zone, area, span, merged, state) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insStack = db.prepare(
      'INSERT INTO stacks (slot_id, stack_no, spec, count, pending, in_time) VALUES (?, ?, ?, ?, ?, ?)');
    for (const s of slots) {
      insSlot.run(s.id, s.code, s.zone, s.area, s.span, s.merged, s.state);
      for (const k of s.stacks) insStack.run(s.id, k.stack_no, k.spec, k.count, k.pending, k.in_time);
    }
  });
  tx();
}

/** 库存汇总（库容 = Σ 每库位生效垛数 × 每垛通用上限，逐库位垛数覆盖/全局参数即时生效） */
export function getInventory(db) {
  syncRackOverrides(db);
  const slotCount = db.prepare('SELECT COUNT(*) n FROM storage_slots').get().n;
  const totalBundles = db.prepare('SELECT COALESCE(SUM(count), 0) n FROM stacks').get().n;
  const pending = db.prepare('SELECT COALESCE(SUM(pending), 0) n FROM stacks').get().n;
  const occupiedSlots = db.prepare("SELECT COUNT(*) n FROM storage_slots WHERE state='occupied'").get().n;
  let stackTotal = 0;
  for (const r of db.prepare('SELECT code FROM storage_slots').all()) stackTotal += effectiveRacks(r.code);
  const totalCapacity = stackTotal * geoCfg.bundlesPerStack;
  const perZone = db.prepare(`
    SELECT s.zone,
           COUNT(DISTINCT s.id)          AS slots,
           COALESCE(SUM(k.count), 0)     AS bundles,
           COALESCE(SUM(k.pending), 0)   AS pending
    FROM storage_slots s
    LEFT JOIN stacks k ON k.slot_id = s.id
    GROUP BY s.zone`).all();
  return {
    slotCount, totalBundles, pending, occupiedSlots, totalCapacity,
    utilization: totalCapacity ? totalBundles / totalCapacity : 0,
    perZone,
  };
}

/** 库位垛行按生效垛数裁剪/合成（getSlots / getSlot 共用）：空垛超出部分隐藏、
 *  缺失补空行；仍有存货的高位垛保留到实际最高有货层 */
function shapeSlotStacks(db, st) {
  syncRackOverrides(db);
  const n = effectiveRacks(st.code);
  st.racks = n;
  const raw = st.stacks;
  const floor = raw.reduce((m, k) => Math.max(m, (k.count > 0 || k.pending > 0) ? k.stack_no : 0), n);
  const keep = new Map(raw.map(k => [k.stack_no, k]));
  st.stacks = [];
  for (let no = 1; no <= floor; no++) {
    st.stacks.push(keep.get(no) || { slot_id: st.id, stack_no: no, spec: null, count: 0, pending: 0, in_time: null });
  }
  return st;
}

/** 全部库位（含各垛）：两条查询 + 内存归并，避免逐库位 N+1。
 *  每库位按生效垛数（覆盖 > 全局）裁剪/合成垛行——行内 racks = 生效垛数。 */
export function getSlots(db) {
  const slots = db.prepare('SELECT * FROM storage_slots ORDER BY id').all()
    .map(s => ({ ...s, stacks: [] }));
  const byId = new Map(slots.map(s => [s.id, s]));
  for (const k of db.prepare('SELECT * FROM stacks ORDER BY slot_id, stack_no').all()) {
    const st = byId.get(k.slot_id);
    if (st) st.stacks.push(k);
  }
  for (const st of slots) shapeSlotStacks(db, st);
  return slots;
}

/** 单个库位（含各垛）；不存在返回 null */
export function getSlot(db, id) {
  const s = db.prepare('SELECT * FROM storage_slots WHERE id=?').get(id);
  if (!s) return null;
  return shapeSlotStacks(db, { ...s, stacks: getStacks(db, s.id) });
}

function getStacks(db, slotId) {
  return db.prepare('SELECT * FROM stacks WHERE slot_id=? ORDER BY stack_no').all(slotId);
}

/** 规格列表 */
export function getSpecs(db) {
  return db.prepare('SELECT * FROM specs ORDER BY name').all();
}

/**
 * 更新某一垛（spec/count/pending/in_time），并同步库位状态。
 * 行不存在时按需补插（调大每库位垛数后未重建即可投用，序号 1~10 受表约束）。
 * 垛清零时强制清空 spec 与 pending，并删除该垛全部捆级落位坐标；
 * 库位所有垛清零后状态置 free。垛序号超物理上限返回 null。
 */
export function setStack(db, slotId, stackNo, patch = {}) {
  let cur = db.prepare('SELECT * FROM stacks WHERE slot_id=? AND stack_no=?').get(slotId, stackNo);
  if (!cur) {
    if (!(stackNo >= 1 && stackNo <= STACKS_PER_SLOT)) return null;
    db.prepare('INSERT INTO stacks (slot_id, stack_no) VALUES (?, ?)').run(slotId, stackNo);
    cur = db.prepare('SELECT * FROM stacks WHERE slot_id=? AND stack_no=?').get(slotId, stackNo);
  }
  let spec = patch.spec !== undefined ? patch.spec : cur.spec;
  let count = patch.count !== undefined ? patch.count : cur.count;
  let pending = patch.pending !== undefined ? patch.pending : cur.pending;
  const in_time = patch.in_time !== undefined ? patch.in_time : cur.in_time;
  if (count > geoCfg.bundlesPerStack) count = geoCfg.bundlesPerStack;   // 每垛通用上限（库房参数）
  if (!count || count <= 0) {
    spec = null; pending = 0; count = 0;
    db.prepare('DELETE FROM bundle_positions WHERE slot_id=? AND stack_no=?').run(slotId, stackNo);
    db.prepare('DELETE FROM steel_ledger WHERE slot_id=? AND stack_no=? AND outbound_time IS NULL').run(slotId, stackNo);   // 台账随垛清零（库存修正，非出库；已出库历史保留）
  }
  db.prepare('UPDATE stacks SET spec=?, count=?, pending=?, in_time=? WHERE slot_id=? AND stack_no=?')
    .run(spec, count, pending, in_time, slotId, stackNo);
  const total = db.prepare('SELECT COALESCE(SUM(count), 0) n FROM stacks WHERE slot_id=?').get(slotId).n;
  db.prepare("UPDATE storage_slots SET state=? WHERE id=?").run(total > 0 ? 'occupied' : 'free', slotId);
  return getSlot(db, slotId);
}

/* ================= 捆级三维落位（bundle_positions 表） ================= */

/* ================= 钢材台账（steel_ledger 表） =================
 * 一捆一行（自增 id 为物理捆主键；bundle_id 可随沙盘重启复用，按 id 区分）。
 * 入账通道：syncBundlePositions 落位写库自动建账（本节三个内部钩子）+ POST /api/ledger 扫码补录。 */
const FAMILY_TYPE = { rebar: '螺纹钢', round: '圆钢', square: '方钢', pipe: '管材' };   // 规格族 -> 钢材类型
const steelTypeOf = spec => (spec && SPEC_FAMILY[spec]) ? FAMILY_TYPE[SPEC_FAMILY[spec]] : null;

/** 新捆入账（入库落料/期初对齐）：整行插入；putTime<0（期初）无入库时刻 */
function ledgerInsert(db, p, now) {
  db.prepare(`INSERT INTO steel_ledger
    (bundle_id, steel_type, grade, heat_no, len, rods, weight_kg, produce_date, buyer, contract_no,
     spec, standard, supplier, po_no, material_no, slot_id, stack_no, layer, inbound_time, inbound_plate, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    String(p.bundleId), steelTypeOf(p.spec), p.grade ?? null, p.heatNo ?? null,
    p.len ?? null, p.rods ?? null, p.weightKg ?? null, p.produceDate ?? null, p.buyer ?? null, p.contractNo ?? null,
    p.spec ?? null, p.standard ?? null, p.supplier ?? null, p.poNo ?? null, p.materialNo ?? null,
    p.slotId ?? null, p.stackNo != null ? p.stackNo | 0 : null, p.layer != null ? Math.max(0, p.layer | 0) : null,
    (p.putTime != null && p.putTime < 0) ? null : now,
    p.plate ?? null, now);
}

/** 增量 upsert：在库行已存在 = 倒垛迁移（仅迁位置，身份/入库信息以首次入账为准）；否则新捆入账 */
function ledgerUpsertIncremental(db, p, now) {
  const cur = db.prepare('SELECT id FROM steel_ledger WHERE bundle_id=? AND outbound_time IS NULL ORDER BY id DESC LIMIT 1')
    .get(String(p.bundleId));
  if (!cur) return ledgerInsert(db, p, now);
  db.prepare('UPDATE steel_ledger SET slot_id=?, stack_no=?, layer=?, updated_at=? WHERE id=?')
    .run(p.slotId, p.stackNo | 0, Math.max(0, p.layer | 0), now, cur.id);
}

/** 出库吊走：回写在库行的出库时间/出厂车牌/采购商（账随实走，行保留作出库历史） */
function ledgerMarkOutbound(db, bundleId, { plate = null, buyer = null } = {}, now) {
  db.prepare(`UPDATE steel_ledger
    SET outbound_time=?, outbound_plate=COALESCE(?, outbound_plate), buyer=COALESCE(?, buyer), updated_at=?
    WHERE id = (SELECT id FROM steel_ledger WHERE bundle_id=? AND outbound_time IS NULL ORDER BY id DESC LIMIT 1)`)
    .run(now, plate, buyer, now, String(bundleId));
}

/**
 * 同步捆级落位坐标：upserts 增量写入（落料/倒垛落位），deletes 按捆号删除（出库吊走）；
 * replace=true 时先清空全表再写入（期初加载/重置后的全量对齐）。返回 { upserted, deleted, total }。
 * 行格式：{ bundleId, slotId, stackNo, layer, seat, spec?, len?, dx, y, dz, yaw, putTime?,
 *          grade?, heatNo?, rods?, weightKg?, produceDate?, contractNo?, standard?, supplier?,
 *          poNo?, materialNo?, plate?（进厂车牌，入库落料时携带） } —— 标签元数据透视进钢材台账。
 * deletes 元素：捆号字符串，或 { bundleId, plate?（出厂车牌）, buyer?（采购商） }（出库信息回填台账）。
 * replace 时台账联动：清除已落位的在库行（身份重建，非出库），随后逐行重新入账。
 */
export function syncBundlePositions(db, { replace = false, upserts = [], deletes = [] } = {}) {
  const del = db.prepare('DELETE FROM bundle_positions WHERE bundle_id=?');
  const ins = db.prepare(`INSERT INTO bundle_positions
    (bundle_id, slot_id, stack_no, layer, seat, spec, len, dx, y, dz, yaw, put_time, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bundle_id) DO UPDATE SET
      slot_id=excluded.slot_id, stack_no=excluded.stack_no, layer=excluded.layer, seat=excluded.seat,
      spec=excluded.spec, len=excluded.len, dx=excluded.dx, y=excluded.y, dz=excluded.dz, yaw=excluded.yaw,
      put_time=excluded.put_time, updated_at=excluded.updated_at`);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    if (replace) {
      db.prepare('DELETE FROM bundle_positions').run();
      db.prepare('DELETE FROM steel_ledger WHERE outbound_time IS NULL AND slot_id IS NOT NULL').run();
    }
    for (const d of deletes || []) {
      const id = typeof d === 'string' ? d : d && d.bundleId;
      if (id == null) continue;
      del.run(String(id));
      ledgerMarkOutbound(db, id, typeof d === 'object' ? d : {}, now);
    }
    let n = 0;
    for (const p of upserts || []) {
      if (!p || !p.bundleId || p.slotId == null || !(p.stackNo >= 1)) continue;
      ins.run(String(p.bundleId), p.slotId, p.stackNo | 0, Math.max(0, p.layer | 0), Math.max(0, p.seat | 0),
        p.spec ?? null, p.len ?? null,
        Number(p.dx) || 0, Number(p.y) || 0, Number(p.dz) || 0, Number(p.yaw) || 0,
        p.putTime ?? null, now);
      if (replace) ledgerInsert(db, p, now); else ledgerUpsertIncremental(db, p, now);
      n++;
    }
    return n;
  });
  const upserted = tx();
  return {
    upserted,
    deleted: (deletes || []).filter(d => (typeof d === 'string' ? d : d && d.bundleId) != null).length,
    total: db.prepare('SELECT COUNT(*) n FROM bundle_positions').get().n,
  };
}

/** 查询捆级落位坐标：可按 slotId / stackNo 过滤；返回 camelCase 行数组 */
export function getBundlePositions(db, { slotId, stackNo } = {}) {
  let sql = 'SELECT * FROM bundle_positions';
  const cond = [], args = [];
  if (slotId != null) { cond.push('slot_id=?'); args.push(slotId); }
  if (stackNo != null) { cond.push('stack_no=?'); args.push(stackNo); }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  sql += ' ORDER BY slot_id, stack_no, layer, seat';
  return db.prepare(sql).all(...args).map(r => ({
    bundleId: r.bundle_id, slotId: r.slot_id, stackNo: r.stack_no,
    layer: r.layer, seat: r.seat, spec: r.spec, len: r.len,
    dx: r.dx, y: r.y, dz: r.dz, yaw: r.yaw, putTime: r.put_time, updatedAt: r.updated_at,
  }));
}

/* ================= 钢材台账查询 / 扫码补录 / CSV 导出 ================= */

function ledgerView(r) {
  return {
    id: r.id, bundleId: r.bundle_id,
    steelType: r.steel_type, grade: r.grade, heatNo: r.heat_no,
    len: r.len, rods: r.rods, weightKg: r.weight_kg, produceDate: r.produce_date,
    buyer: r.buyer, contractNo: r.contract_no, spec: r.spec, standard: r.standard,
    supplier: r.supplier, poNo: r.po_no, materialNo: r.material_no,
    slotId: r.slot_id, slotCode: r.slot_code ?? null, stackNo: r.stack_no, layer: r.layer,
    inboundTime: r.inbound_time, inboundPlate: r.inbound_plate,
    outboundTime: r.outbound_time, outboundPlate: r.outbound_plate, updatedAt: r.updated_at,
  };
}

/**
 * 台账多条件查询。filters：bundleId/heatNo/contractNo/plate(进厂或出厂)/grade/buyer/supplier（模糊）、
 * spec（精确）、state=in|out（在库/已出库）、from/to（入库时间范围，to 可为 YYYY-MM-DD）、limit/offset。
 * 返回 { total, rows }（rows 按入账倒序，含库位编码 slotCode）。
 */
export function getSteelLedger(db, f = {}) {
  const cond = [], args = [];
  const like = (col, v) => { cond.push(`l.${col} LIKE ?`); args.push(`%${v}%`); };
  if (f.bundleId) like('bundle_id', f.bundleId);
  if (f.heatNo) like('heat_no', f.heatNo);
  if (f.contractNo) like('contract_no', f.contractNo);
  if (f.plate) { cond.push('(l.inbound_plate LIKE ? OR l.outbound_plate LIKE ?)'); args.push(`%${f.plate}%`, `%${f.plate}%`); }
  if (f.spec) { cond.push('l.spec = ?'); args.push(f.spec); }
  if (f.grade) like('grade', f.grade);
  if (f.buyer) like('buyer', f.buyer);
  if (f.supplier) like('supplier', f.supplier);
  if (f.state === 'in') cond.push('l.outbound_time IS NULL');
  if (f.state === 'out') cond.push('l.outbound_time IS NOT NULL');
  if (f.from) { cond.push('l.inbound_time >= ?'); args.push(f.from); }
  if (f.to) { cond.push('l.inbound_time <= ?'); args.push(/^\d{4}-\d{2}-\d{2}$/.test(f.to) ? f.to + 'T23:59:59.999Z' : f.to); }
  const where = cond.length ? ' WHERE ' + cond.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM steel_ledger l${where}`).get(...args).n;
  const limit = Math.min(50000, Math.max(1, f.limit | 0 || 200));
  const offset = Math.max(0, f.offset | 0);
  const rows = db.prepare(`SELECT l.*, s.code AS slot_code FROM steel_ledger l
    LEFT JOIN storage_slots s ON s.id = l.slot_id${where}
    ORDER BY l.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(ledgerView);
  return { total, rows };
}

/** 单捆台账（在库行优先，其次最近一条历史）；不存在返回 null */
export function getSteelLedgerEntry(db, bundleId) {
  const r = db.prepare(`SELECT l.*, s.code AS slot_code FROM steel_ledger l
    LEFT JOIN storage_slots s ON s.id = l.slot_id
    WHERE l.bundle_id=? ORDER BY (l.outbound_time IS NULL) DESC, l.id DESC LIMIT 1`).get(String(bundleId));
  return r ? ledgerView(r) : null;
}

/** 台账可补录字段（camelCase -> 列名）：扫码枪扫捆标签二维码补齐/修正标签元数据 */
const LEDGER_META_FIELDS = {
  steelType: 'steel_type', grade: 'grade', heatNo: 'heat_no', len: 'len', rods: 'rods',
  weightKg: 'weight_kg', produceDate: 'produce_date', buyer: 'buyer', contractNo: 'contract_no',
  spec: 'spec', standard: 'standard', supplier: 'supplier', poNo: 'po_no', materialNo: 'material_no',
  inboundPlate: 'inbound_plate', outboundPlate: 'outbound_plate',
};

/**
 * 扫码补录/修正：按捆号更新在库行（无在库行取最近历史行；均无则立未落位新行）。
 * 仅入参中出现的字段被覆盖；给了 spec 没给 steelType 时按规格族自动推导钢材类型。
 * 返回更新后的台账视图；缺 bundleId 返回 null。
 */
export function upsertSteelLedgerMeta(db, row = {}) {
  if (!row || !row.bundleId) return null;
  if (row.spec !== undefined && row.steelType === undefined) row.steelType = steelTypeOf(row.spec);
  const now = new Date().toISOString();
  const cur = db.prepare('SELECT id FROM steel_ledger WHERE bundle_id=? ORDER BY (outbound_time IS NULL) DESC, id DESC LIMIT 1')
    .get(String(row.bundleId));
  if (cur) {
    const sets = [], args = [];
    for (const [k, col] of Object.entries(LEDGER_META_FIELDS)) {
      if (row[k] === undefined) continue;
      sets.push(`${col}=?`); args.push(row[k]);
    }
    if (sets.length) db.prepare(`UPDATE steel_ledger SET ${sets.join(', ')}, updated_at=? WHERE id=?`).run(...args, now, cur.id);
  } else {
    const cols = ['bundle_id'], vals = [String(row.bundleId)];
    for (const [k, col] of Object.entries(LEDGER_META_FIELDS)) {
      if (row[k] === undefined) continue;
      cols.push(col); vals.push(row[k]);
    }
    cols.push('updated_at'); vals.push(now);
    db.prepare(`INSERT INTO steel_ledger (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  }
  return getSteelLedgerEntry(db, row.bundleId);
}

/* CSV 导出：列序与 Excel「钢材入库数据-近3个月 需收集」模板一致（18 列），前置捆号、
 * 后置标签附加字段（供应商/PO号/材料号）；调用方加 UTF-8 BOM 供 Excel 直开。 */
const LEDGER_CSV_HEADERS = ['捆号', '钢材类型', '钢材材质', '炉号', '长度', '支数', '重量', '日期', '采购商', '合同号',
  '规格/直径', '标准', '库位', '垛位', '垛位层', '入库时间', '进厂车牌', '出库时间', '出厂车牌', '供应商', 'PO号', '材料号'];

const csvCell = v => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const fmtTs = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 台账行数组（getSteelLedger 的 rows）-> CSV 文本；入库时间为空 = 期初存量（显式标注） */
export function steelLedgerCsv(rows) {
  const lines = [LEDGER_CSV_HEADERS.join(',')];
  for (const r of rows) {
    lines.push([
      r.bundleId, r.steelType, r.grade, r.heatNo, r.len, r.rods, r.weightKg, r.produceDate,
      r.buyer, r.contractNo, r.spec, r.standard,
      r.slotCode ?? r.slotId ?? '', r.stackNo ?? '', r.layer != null ? r.layer + 1 : '',
      r.inboundTime ? fmtTs(r.inboundTime) : '期初', r.inboundPlate, fmtTs(r.outboundTime), r.outboundPlate,
      r.supplier, r.poNo, r.materialNo,
    ].map(csvCell).join(','));
  }
  return lines.join('\r\n');
}
