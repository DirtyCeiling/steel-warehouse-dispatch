// 操作端（kg-dispatch-frontend）快照聚合：一次请求返回其 AppState 所需的全部服务端权威数据。
// 设计见《仿真与操作端数据打通设计.md》P1：
//   GET /api/frontend/snapshot            —— 轻量快照（垛级行 + 车辆 + 汇总），前端 2s 轮询对账
//   GET /api/frontend/snapshot?with=bundles —— 附带捆级明细（bundle_positions 全量，前端按 rev 变化才重拉）
// rev 为进程内修订号：沙盘每次写库存/捆位/车辆后 bumpRev()，前端比对 rev 决定是否重拉捆级明细，
// 避免 2s 轮询反复传输 ~6000 捆全量。进程重启 rev 重置，客户端按不等即重拉处理。
import {
  getSlots, getSpecs, getInventory, getBundlePositions, getGeoCfg, globalStacksPerSlot,
} from './database.js';
import { listInboundVehicles } from './inbound.js';

let _rev = Date.now();

/** 沙盘写路径（库存/捆位/车辆确认等）调用：任何库存权威数据变化 */
export function bumpRev() { _rev = Date.now(); }

/** 库存总吨位：优先按捆级明细 Σ specs.weight × len / 9（与沙盘捆重算法一致；len 空按 9m 基准）；
 *  沙盘尚未做过期初对齐（bundle_positions 为空，如刚 reset 的新库）时按垛行 count × 基准吨位估算 */
function totalTons(db) {
  const w = new Map(getSpecs(db).map(s => [s.name, s.weight]));
  const rows = db.prepare('SELECT spec, len FROM bundle_positions').all();
  if (rows.length) {
    let tons = 0;
    for (const b of rows) {
      const base = w.get(b.spec);
      if (base == null) continue;
      tons += base * (b.len || 9) / 9;
    }
    return +tons.toFixed(1);
  }
  let est = 0;
  for (const k of db.prepare('SELECT spec, count FROM stacks WHERE count > 0').all()) {
    const base = w.get(k.spec);
    if (base != null) est += base * k.count;
  }
  return +est.toFixed(1);
}

/** 轻量快照（不含捆级明细）；withBundles=true 时附带 bundle_positions 全量 */
export function getFrontendSnapshot(db, { withBundles = false } = {}) {
  const slots = getSlots(db);
  const specs = getSpecs(db);
  const vehicles = listInboundVehicles(db, 25);
  const inventory = getInventory(db);
  const geo = getGeoCfg();
  const tele = getTelemetry();
  return {
    serverTime: new Date().toISOString(),
    rev: _rev,
    capacity: {
      globalStacksPerSlot: globalStacksPerSlot(),
      bundlesPerStack: geo.bundlesPerStack,
    },
    slots,
    specs,
    vehicles,
    inventory: {
      ...inventory,
      totalTons: totalTons(db),
      // 沙盘是否已做过捆级期初对齐（0 = 崭新库/沙盘未连过，吨位为垛行估算、捆明细需前端降级合成）
      bundleRows: db.prepare('SELECT COUNT(*) n FROM bundle_positions').get().n,
    },
    // 沙盘遥测（1Hz 回推，内存驻留）：无沙盘在线时为空，前端保留本地天车游走降级
    cranes: tele?.cranes ?? [],
    dogs: tele?.dogs ?? [],
    telemetryAt: tele?.at ?? null,
    kpiToday: null,
    ...(withBundles ? { bundles: getBundlePositions(db) } : {}),
  };
}

/* =====================================================================
 * P2/P3：事件流 + 遥测 + 命令通道（设计见《仿真与操作端数据打通设计.md》）
 *   事件表 sim_events：沙盘批量回推（POST），操作端游标轮询（GET ?after=），
 *     协议与 LogisticsData_Sim 的车辆事件流同款；环形保留最近 2000 条。
 *   遥测：进程内存驻留（天车 x/y/状态 + 机器狗），沙盘 1Hz POST 覆写，快照携带下发。
 *   命令表 sim_commands：操作端写入（POST /api/frontend/commands），
 *     沙盘轮询认领（GET ?claim=1 原子置 claimed，多实例只有一个拿到），
 *     执行完回写（POST /:id/finish，可附带事件一并落表）。
 * ===================================================================== */

const EVENTS_KEEP = 5000;   // 结构化生命周期事件保留量（游标重放窗口）
const LOGS_KEEP = 400;      // log 类事件保留量（操作端留痕仅显近 50 条，采样足够）

function ensureIntegrTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sim_events (
      seq     INTEGER PRIMARY KEY AUTOINCREMENT,
      time    TEXT NOT NULL,
      type    TEXT NOT NULL,
      payload TEXT
    );
    CREATE TABLE IF NOT EXISTS sim_commands (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT NOT NULL,      -- dispatch-outbound / dispatch-restack / alarm-handled
      ref_id     TEXT,               -- 操作端单据号（CK-xx / DD-xx / BJ-xx），事件回推按此对账
      payload    TEXT,
      status     TEXT NOT NULL DEFAULT 'pending',   -- pending / claimed / done / failed
      result     TEXT,
      create_time TEXT NOT NULL,
      finish_time TEXT
    );
  `);
}

/** 沙盘批量回推事件；返回写入条数（分层淘汰：日志类仅留近期 400 条，结构化生命周期事件留 5000 条
 *  ——16 倍速下日志洪流可达每分钟数百条，若等量淘汰会把复核/报警/出厂等关键事件挤出操作端消费窗口） */
export function appendEvents(db, events) {
  if (!Array.isArray(events) || events.length === 0) return 0;
  ensureIntegrTables(db);
  const now = new Date().toISOString();
  const ins = db.prepare('INSERT INTO sim_events (time, type, payload) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    for (const e of events) {
      if (!e || typeof e.type !== 'string') continue;
      ins.run(e.time ?? now, e.type, e.payload == null ? null : JSON.stringify(e.payload));
    }
    db.prepare(`DELETE FROM sim_events WHERE type='log' AND seq <= (SELECT MAX(seq) FROM sim_events WHERE type='log') - ?`).run(LOGS_KEEP);
    db.prepare(`DELETE FROM sim_events WHERE seq <= (SELECT MAX(seq) FROM sim_events) - ?`).run(EVENTS_KEEP);
  });
  return tx(), events.length;
}

/** 操作端游标拉取：after 之后按 seq 升序（与 LogisticsData_Sim 同款协议） */
export function listEvents(db, after = 0, limit = 50) {
  ensureIntegrTables(db);
  const n = Math.min(200, Math.max(1, limit | 0));
  return db.prepare('SELECT seq, time, type, payload FROM sim_events WHERE seq > ? ORDER BY seq LIMIT ?')
    .all(after | 0, n)
    .map(r => ({ seq: r.seq, time: r.time, type: r.type, payload: r.payload == null ? null : JSON.parse(r.payload) }));
}

/** 当前最大 seq（客户端初始化游标用） */
export function latestEventSeq(db) {
  ensureIntegrTables(db);
  return db.prepare('SELECT COALESCE(MAX(seq), 0) s FROM sim_events').get().s;
}

let _telemetry = null;   // { cranes, dogs, at }：内存驻留，重启自然重建
let _staleTeleWarned = false;

/** 遥测落驻：仅接受 v2 模式（dogs 项带 x/y 坐标）。
 *  旧代码沙盘页（遗留窗口）推送的 v1 模式会被拒绝——否则新旧实例 last-writer-wins 交替，
 *  操作端机器狗位置标记会闪烁消失。旧实例整体被拒后自然只剩新引擎的数据。 */
export function setTelemetry(t, log = () => {}) {
  if (!t || !Array.isArray(t.cranes)) { _telemetry = null; return; }
  const staleDogs = Array.isArray(t.dogs) && t.dogs.some(d => d == null || typeof d.x !== 'number' || typeof d.y !== 'number');
  if (staleDogs) {
    if (!_staleTeleWarned) {
      _staleTeleWarned = true;
      log('[操作端集成] 检测到旧版沙盘页仍在推送 v1 遥测（dogs 无坐标）已拒绝——请关闭遗留的旧沙盘窗口（旧实例还会抢命令/写库存）');
    }
    return;
  }
  _telemetry = { ...t, at: new Date().toISOString() };
}
export function getTelemetry() { return _telemetry && (Date.now() - Date.parse(_telemetry.at) < 10000) ? _telemetry : null; }

/** 操作端写入命令 */
export function createCommand(db, { kind, refId = null, payload = null }) {
  if (!kind) return null;
  ensureIntegrTables(db);
  const r = db.prepare('INSERT INTO sim_commands (kind, ref_id, payload, create_time) VALUES (?, ?, ?, ?)')
    .run(kind, refId ?? null, payload == null ? null : JSON.stringify(payload), new Date().toISOString());
  return getCommand(db, Number(r.lastInsertRowid));
}

function getCommand(db, id) {
  const c = db.prepare('SELECT * FROM sim_commands WHERE id=?').get(id);
  return c ? commandView(c) : null;
}

function commandView(c) {
  return {
    id: c.id, kind: c.kind, refId: c.ref_id,
    payload: c.payload == null ? null : JSON.parse(c.payload),
    status: c.status,
    result: c.result == null ? null : JSON.parse(c.result),
    createTime: c.create_time, ...(c.finish_time ? { finishTime: c.finish_time } : {}),
  };
}

/** 沙盘轮询认领：claim=true 时把 pending 原子置 claimed 再返回这些行（多实例只有一个拿到） */
export function listCommands(db, { status = 'pending', claim = false, limit = 10 } = {}) {
  ensureIntegrTables(db);
  const n = Math.min(20, Math.max(1, limit | 0));
  if (claim && status === 'pending') {
    const ids = db.prepare('SELECT id FROM sim_commands WHERE status=? ORDER BY id LIMIT ?').all(status, n).map(r => r.id);
    if (!ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    const tx = db.transaction(() => {
      for (const id of ids) db.prepare("UPDATE sim_commands SET status='claimed' WHERE id=? AND status='pending'").run(id);
    });
    tx();
    return db.prepare(`SELECT * FROM sim_commands WHERE id IN (${ph}) ORDER BY id`).all(...ids).map(commandView);
  }
  return db.prepare('SELECT * FROM sim_commands WHERE status=? ORDER BY id LIMIT ?').all(status, n).map(commandView);
}

/** 沙盘执行完回写；可附带事件（如 alarm.closed）一并落表 */
export function finishCommand(db, id, { ok = true, result = null, events = [] } = {}) {
  const cur = db.prepare('SELECT id FROM sim_commands WHERE id=?').get(id);
  if (!cur) return null;
  db.prepare("UPDATE sim_commands SET status=?, result=?, finish_time=? WHERE id=?")
    .run(ok ? 'done' : 'failed', result == null ? null : JSON.stringify(result), new Date().toISOString(), id);
  if (events.length) appendEvents(db, events);
  return getCommand(db, id);
}
