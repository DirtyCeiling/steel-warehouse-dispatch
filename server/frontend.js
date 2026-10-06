// 操作端（kg-dispatch-frontend）快照聚合：一次请求返回其 AppState 所需的全部服务端权威数据。
// 设计见《仿真与操作端数据打通设计.md》P1：
//   GET /api/frontend/snapshot            —— 轻量快照（垛级行 + 车辆 + 汇总），前端 2s 轮询对账
//   GET /api/frontend/snapshot?with=bundles —— 附带捆级明细（bundle_positions 全量，前端按 rev 变化才重拉）
// rev 为进程内修订号：沙盘每次写库存/捆位/车辆后 bumpRev()，前端比对 rev 决定是否重拉捆级明细，
// 避免 2s 轮询反复传输 ~6000 捆全量。进程重启 rev 重置，客户端按不等即重拉处理。
import {
  getSlots, getSpecs, getInventory, getBundlePositions, getGeoCfg, globalStacksPerSlot,
} from './database.js';
import { listSnapshotVehicles } from './inbound.js';

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
  const vehicles = listSnapshotVehicles(db);   // 未完成全量 + 最近完成（在途不滚出窗口，取消判定可靠）
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
    trucks: tele?.trucks ?? [],
    telemetryAt: tele?.at ?? null,
    // 数据源「活着」= 有驾驶租约且遥测新鲜（遥测只在驾驶+未暂停时 1Hz 推送）：前端据此门控
    // 「会话数据」（出库跟踪/任务队列）——数据源没开或暂停中快照 drive=null，前端清空并停收
    // 会话事件（「没启动 = 没数据」）；点启动遥测恢复，同一世界经重放继续（sim.reset 兜底清旧世界）
    drive: (() => {
      const h = driveHolder();
      return (h && tele) ? { holderId: h.holderId, label: h.holderLabel, heartbeatAt: tele.at } : null;
    })(),
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
const OUTBOUND_KEEP = 400;  // 出库订单事件独立保留量（在办订单不被洪流挤出，重放必含）
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
      finish_time TEXT,
      claim_time  TEXT               -- 认领时刻（租约：超时未回写视为认领方失联，重新可领）
    );
  `);
  // 旧库迁移：补 claim_time 列
  const cmdCols = db.prepare('PRAGMA table_info(sim_commands)').all().map(c => c.name);
  if (!cmdCols.includes('claim_time')) db.prepare('ALTER TABLE sim_commands ADD COLUMN claim_time TEXT').run();
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
      if (e.type === 'sim.reset') {
        // 驾驶世界重建（仅驾驶窗口会广播 sim.reset）：旧世界全部未完成车辆随之作废——
        // 覆盖「登记窗口已关闭、无人为其清场」的幽灵车（沙盘自身的 collectAndCancelStaleVehicles
        // 只能取消本窗口内存里登记的车，跨窗口残账由这里兜底）；completed 历史台账保留
        const ghost = db.prepare("SELECT id FROM inbound_vehicles WHERE state != 'completed'").all();
        if (ghost.length) {
          const ph = ghost.map(g => g.id).join(',');
          db.prepare(`DELETE FROM inbound_loads WHERE vehicle_id IN (${ph})`).run();
          db.prepare(`DELETE FROM inbound_vehicles WHERE id IN (${ph})`).run();
          console.log(`[台账] sim.reset：作废旧世界未完成车辆 ${ghost.length} 辆（id: ${ghost.map(g => g.id).join(',')}）`);   // appendEvents 无 log 注入参数：直接走控制台
        }
      }
    }
    db.prepare(`DELETE FROM sim_events WHERE type='log' AND seq <= (SELECT MAX(seq) FROM sim_events WHERE type='log') - ?`).run(LOGS_KEEP);
    // 出库订单事件（order/assign/progress）独立保留窗口：低频但必须可重放——被洪流挤出会导致
    // 新开操作端永远重建不出「出库跟踪」卡（车都在跑、订单却无据可查）
    db.prepare(`DELETE FROM sim_events WHERE type LIKE 'outbound.%' AND seq <= (SELECT MAX(seq) FROM sim_events WHERE type LIKE 'outbound.%') - ?`).run(OUTBOUND_KEEP);
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

/* ===================== 驾驶租约（独占驾驶位仲裁） =====================
 * 沙盘 1Hz 遥测顺带心跳；TTL 10s 与遥测新鲜度（getTelemetry）同口径。
 * 无持久化：服务重启即无主，各沙盘下一帧遥测重新抢占（先到先得）。 */
let _driveLease = null;   // { holderId, holderLabel, acquiredAt, heartbeatAt }
const DRIVE_TTL_MS = 10000;

/** 心跳/抢占：持有者刷新；无主或已过期时由调用方接管（先到先得）；他人持有且未过期返回 false */
export function touchDrive(holderId, holderLabel = '') {
  if (!holderId) return false;
  const now = Date.now();
  if (_driveLease && _driveLease.holderId !== holderId &&
      now - Date.parse(_driveLease.heartbeatAt) < DRIVE_TTL_MS) return false;
  const at = new Date().toISOString();
  _driveLease = _driveLease && _driveLease.holderId === holderId
    ? { ..._driveLease, heartbeatAt: at }
    : { holderId, holderLabel, acquiredAt: at, heartbeatAt: at };
  return true;
}

/** 当前有效持有者；心跳超 TTL 即视为无主（返回 null，惰性判定，无定时器） */
export function driveHolder() {
  return _driveLease && Date.now() - Date.parse(_driveLease.heartbeatAt) < DRIVE_TTL_MS
    ? _driveLease : null;
}

/** 写回仲裁：id 空 = 非沙盘来源（人工页/操作端）放行；持有者放行；对「活跃他窗」409。
 *  租约无主（过期/服务重启）时写方接管——否则后台标签恢复后，排队的事件（含 sim.reset）
 *  会因租约过期全部被 409，永远发不出去（sim.reset 不达 → 幽灵车清场兜底失效的死锁）。 */
export function checkDriveAuth(holderId) {
  if (!holderId) return { ok: true };
  const l = driveHolder();
  if (!l) { touchDrive(holderId); return { ok: true }; }        // 无主 → 写方接管（先到先得）
  if (l.holderId === holderId) { touchDrive(holderId); return { ok: true }; }   // 持有者心跳
  return { ok: false, holder: l.holderLabel || l.holderId.slice(0, 8) };
}

/** 主动释放（切观景/关页）：仅持有者本人可释放 */
export function releaseDrive(holderId) {
  if (_driveLease && _driveLease.holderId === holderId) { _driveLease = null; return true; }
  return false;
}

/** 强制接管（人工确认后的让位转移）：无条件把租约转给新持有者。
 *  原持有者下一次遥测心跳将被 409 拒绝 → 其窗口自动转观景（被动侧无须再确认——
 *  接管已在新窗口侧经人工确认）。 */
export function takeoverDrive(holderId, holderLabel = '') {
  if (!holderId) return false;
  const at = new Date().toISOString();
  _driveLease = { holderId, holderLabel: holderLabel || `沙盘 ${holderId.slice(0, 8)}`, acquiredAt: at, heartbeatAt: at };
  return true;
}

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

/** 沙盘轮询认领：claim=true 时把 pending 原子置 claimed 再返回这些行（多实例只有一个拿到）。
 *  认领租约 CLAIM_LEASE_MS：claimed 超时未回写自动回滚为 pending——被暂停/关闭/遗留旧代码的
 *  沙盘窗口认走却不执行的命令，可被运行中的驾驶窗口重新认领，杜绝命令静默丢失。 */
const CLAIM_LEASE_MS = 30000;
export function listCommands(db, { status = 'pending', claim = false, limit = 10 } = {}) {
  ensureIntegrTables(db);
  const n = Math.min(20, Math.max(1, limit | 0));
  if (claim && status === 'pending') {
    db.prepare(`UPDATE sim_commands SET status='pending', claim_time=NULL
      WHERE status='claimed' AND claim_time IS NOT NULL AND claim_time < ?`)
      .run(new Date(Date.now() - CLAIM_LEASE_MS).toISOString());
    const ids = db.prepare('SELECT id FROM sim_commands WHERE status=? ORDER BY id LIMIT ?').all(status, n).map(r => r.id);
    if (!ids.length) return [];
    const ph = ids.map(() => '?').join(',');
    const nowIso = new Date().toISOString();
    const tx = db.transaction(() => {
      for (const id of ids) db.prepare("UPDATE sim_commands SET status='claimed', claim_time=? WHERE id=? AND status='pending'").run(nowIso, id);
    });
    tx();
    return db.prepare(`SELECT * FROM sim_commands WHERE id IN (${ph}) ORDER BY id`).all(...ids).map(commandView);
  }
  return db.prepare('SELECT * FROM sim_commands WHERE status=? ORDER BY id LIMIT ?').all(status, n).map(commandView);
}

/** 沙盘执行完回写；可附带事件（如 alarm.closed）一并落表。
 *  仅接受 claimed 态的回写：租约过期被重新认领/已完成的命令，迟到回执不覆盖。 */
export function finishCommand(db, id, { ok = true, result = null, events = [] } = {}) {
  const cur = db.prepare('SELECT id FROM sim_commands WHERE id=?').get(id);
  if (!cur) return null;
  const r = db.prepare("UPDATE sim_commands SET status=?, result=?, finish_time=? WHERE id=? AND status='claimed'")
    .run(ok ? 'done' : 'failed', result == null ? null : JSON.stringify(result), new Date().toISOString(), id);
  if (!r.changes) return getCommand(db, id);   // 已被重新认领或已完成：迟到回执不覆盖
  if (events.length) appendEvents(db, events);
  return getCommand(db, id);
}
