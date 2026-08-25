// 本地库存数据库（Node + SQLite / better-sqlite3）
// 存储钢厂棒材库区库存/库位数据：库位 -> 8 垛 -> 每垛 20 捆
// 另含主应用（三维库区）数据：库区/跨/库位/钢卷/调度任务
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { generateSlots, SPECS } from './layout.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const STACKS_PER_SLOT = 8;          // 每库位垛数（竖着排列）
export const BUNDLES_PER_STACK = 20;       // 每垛最多捆数
export const DB_PATH = process.env.WAREHOUSE_DB || join(__dirname, 'warehouse.db');

/** 打开（不存在则创建）数据库并建表；首次打开时自动灌入主应用数据 */
export function openDb(path = DB_PATH) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
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
  `);
}

/* ================= 主应用（三维库区）数据 ================= */

const APP_SEED_DIR = join(__dirname, '..', 'src', 'data');

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

/** 从 src/data/*.json 灌入主应用数据（重建）；无 JSON 文件则保持现状 */
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

/** 主应用全量数据（字段名与前端类型一致） */
export function getAppData(db) {
  const w = db.prepare('SELECT * FROM app_warehouse LIMIT 1').get();
  if (!w) return null;
  const spans = db.prepare('SELECT * FROM app_spans ORDER BY position').all()
    .map(s => ({ id: s.id, name: s.name, length: s.length, width: s.width, position: s.position }));
  const locations = db.prepare('SELECT * FROM app_locations ORDER BY span_id, row, col').all()
    .map(l => ({ id: l.id, spanId: l.span_id, row: l.row, column: l.col, status: l.status, capacity: l.capacity, ...(l.steel_coil_id ? { steelCoilId: l.steel_coil_id } : {}) }));
  const coils = db.prepare('SELECT * FROM app_coils ORDER BY coil_number').all()
    .map(c => ({ id: c.id, coilNumber: c.coil_number, specification: c.specification, weight: c.weight, diameter: c.diameter, material: c.material, status: c.status, ...(c.location_id ? { locationId: c.location_id } : {}) }));
  const tasks = db.prepare('SELECT * FROM app_tasks ORDER BY create_time').all()
    .map(t => ({ id: t.id, type: t.type, status: t.status, steelCoilId: t.steel_coil_id, ...(t.from_location_id ? { fromLocationId: t.from_location_id } : {}), ...(t.to_location_id ? { toLocationId: t.to_location_id } : {}), createTime: t.create_time, ...(t.complete_time ? { completeTime: t.complete_time } : {}) }));
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
  return getAppData(db).tasks.find(t => t.id === task.id);
}

/** 更新任务状态；置 completed 时自动记录完成时间 */
export function updateTaskStatus(db, id, status) {
  const cur = db.prepare('SELECT * FROM app_tasks WHERE id=?').get(id);
  if (!cur) return null;
  const completeTime = status === 'completed' && !cur.complete_time ? new Date().toISOString() : cur.complete_time;
  db.prepare('UPDATE app_tasks SET status=?, complete_time=? WHERE id=?').run(status, completeTime, id);
  return getAppData(db).tasks.find(t => t.id === id);
}

/** 删除调度任务；不存在返回 false */
export function deleteTask(db, id) {
  return db.prepare('DELETE FROM app_tasks WHERE id=?').run(id).changes > 0;
}

/* ---------------- 实际钢材分布灌库 ----------------
 * 按分区专业化归堆（与卸货推荐算法「同类货物放一起」原则一致）：
 *   铁姆肯区(1-2)        -> 圆钢 Φ50 / Φ60（轴承/机加工用钢）
 *   大棒区域(3-13)       -> 螺纹钢 Φ20 / Φ25（建材主力）
 *   大棒单支和长钢(14-16) -> 方钢 40×40（长尺定尺料，整跨合并库位）
 *   中棒区域(17-33)      -> 圆钢 Φ50/Φ60 + 螺纹钢 Φ25 混区（按号区成带分规格）
 * 同库位以单一规格为主，少量同族（同形状）规格邻垛混放；号区内按 area 成带，
 * 相邻库位同规格连片，形成聚簇。确定性随机流（mulberry32），灌库结果可复现。 */
const ZONE_SPEC_POOL = {
  '铁姆肯区':         ['圆钢 Φ50', '圆钢 Φ60'],
  '大棒区域':         ['螺纹钢 Φ20', '螺纹钢 Φ25'],
  '大棒单支和长钢':   ['方钢 40×40'],
  '中棒区域':         ['圆钢 Φ50', '圆钢 Φ60', '螺纹钢 Φ25'],
};
const SPEC_FAMILY = {   // 规格族（形状）：同族视为"相似货物"，允许同库位邻垛混放
  '螺纹钢 Φ20': 'rebar', '螺纹钢 Φ25': 'rebar',
  '圆钢 Φ50': 'round', '圆钢 Φ60': 'round',
  '方钢 40×40': 'square',
};
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 重建数据：写入规格 + 91 库位 + 728 垛，并按分区专业化灌入实际钢材分布
 *（约 40~50% 利用率，均已扫码入账；保留约一成空库位作入库缓冲）。
 */
export function seed(db) {
  const slots = generateSlots();
  const rnd = mulberry32(20260825);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM stacks').run();
    db.prepare('DELETE FROM storage_slots').run();
    db.prepare('DELETE FROM specs').run();

    const insSpec = db.prepare('INSERT INTO specs (name, weight, color) VALUES (?, ?, ?)');
    for (const s of SPECS) insSpec.run(s.name, s.weight, s.color);

    const insSlot = db.prepare(
      'INSERT INTO storage_slots (id, code, zone, area, span, merged, state) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insStack = db.prepare(
      'INSERT INTO stacks (slot_id, stack_no, spec, count, pending, in_time) VALUES (?, ?, ?, ?, 0, ?)');
    for (const s of slots) {
      insSlot.run(s.id, s.code, s.zone, s.area, s.span, s.merged, 'free');
      const pool = ZONE_SPEC_POOL[s.zone] || ['螺纹钢 Φ20'];
      const occupied = rnd() >= 0.10;                    // 约一成空库位（入库缓冲位）
      const primary = occupied ? pool[(s.area + s.span) % pool.length] : null;  // 按号区成带，相邻库位连片聚簇
      const usedStacks = occupied ? 3 + Math.floor(rnd() * 5) : 0;   // 占用 3~7 垛，其余留空垛
      for (let n = 1; n <= STACKS_PER_SLOT; n++) {
        if (n > usedStacks) { insStack.run(s.id, n, null, 0, null); continue; }
        let spec = primary;
        if (n === usedStacks && pool.length > 1 && rnd() < 0.3) {    // 末垛 30% 概率混入同族相近规格（相似货物同库位）
          spec = pool[(s.area + s.span + 1) % pool.length];
        }
        const count = 12 + Math.floor(rnd() * 9);        // 每垛 12~20 捆（接近满垛的真实码放）
        const inTime = -(600 + Math.floor(rnd() * 85800)); // 期初入账（前一日的负时刻，FIFO 基准）
        insStack.run(s.id, n, spec, count, inTime);
      }
      if (occupied) {
        db.prepare("UPDATE storage_slots SET state='occupied' WHERE id=?").run(s.id);
      }
    }
  });
  tx();
}

/** 库存汇总 */
export function getInventory(db) {
  const slotCount = db.prepare('SELECT COUNT(*) n FROM storage_slots').get().n;
  const totalBundles = db.prepare('SELECT COALESCE(SUM(count), 0) n FROM stacks').get().n;
  const pending = db.prepare('SELECT COALESCE(SUM(pending), 0) n FROM stacks').get().n;
  const occupiedSlots = db.prepare("SELECT COUNT(*) n FROM storage_slots WHERE state='occupied'").get().n;
  const totalCapacity = slotCount * STACKS_PER_SLOT * BUNDLES_PER_STACK;
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

/** 全部库位（含各垛） */
export function getSlots(db) {
  return db.prepare('SELECT * FROM storage_slots ORDER BY id').all()
    .map(s => ({ ...s, stacks: getStacks(db, s.id) }));
}

/** 单个库位（含各垛）；不存在返回 null */
export function getSlot(db, id) {
  const s = db.prepare('SELECT * FROM storage_slots WHERE id=?').get(id);
  if (!s) return null;
  return { ...s, stacks: getStacks(db, s.id) };
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
 * 垛清零时强制清空 spec 与 pending；库位所有垛清零后状态置 free。
 * 垛不存在返回 null。
 */
export function setStack(db, slotId, stackNo, patch = {}) {
  const cur = db.prepare('SELECT * FROM stacks WHERE slot_id=? AND stack_no=?').get(slotId, stackNo);
  if (!cur) return null;
  let spec = patch.spec !== undefined ? patch.spec : cur.spec;
  let count = patch.count !== undefined ? patch.count : cur.count;
  let pending = patch.pending !== undefined ? patch.pending : cur.pending;
  const in_time = patch.in_time !== undefined ? patch.in_time : cur.in_time;
  if (!count || count <= 0) { spec = null; pending = 0; count = 0; }
  db.prepare('UPDATE stacks SET spec=?, count=?, pending=?, in_time=? WHERE slot_id=? AND stack_no=?')
    .run(spec, count, pending, in_time, slotId, stackNo);
  const total = db.prepare('SELECT COALESCE(SUM(count), 0) n FROM stacks WHERE slot_id=?').get(slotId).n;
  db.prepare("UPDATE storage_slots SET state=? WHERE id=?").run(total > 0 ? 'occupied' : 'free', slotId);
  return getSlot(db, slotId);
}
