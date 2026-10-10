// 操作端（kg-dispatch-frontend）快照聚合：一次请求返回其 AppState 所需的全部服务端权威数据。
// 设计见《仿真与操作端数据打通设计.md》P1：
//   GET /api/frontend/snapshot            —— 轻量快照（垛级行 + 车辆 + 汇总），前端 2s 轮询对账
//   GET /api/frontend/snapshot?with=bundles —— 附带捆级明细（bundle_positions 全量，前端按 rev 变化才重拉）
// rev 为进程内修订号：沙盘每次写库存/捆位/车辆后 bumpRev()，前端比对 rev 决定是否重拉捆级明细，
// 避免 2s 轮询反复传输 ~6000 捆全量。进程重启 rev 重置，客户端按不等即重拉处理。
import {
  getSlots, getSpecs, getInventory, getBundlePositions, getGeoCfg, globalStacksPerSlot, getSimParams,
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

/** 本地某日 00:00 的 ISO 串（台账/事件均为 UTC ISO，字典序可比较）；offsetDays=0 今天、1 昨天… */
function localDayStartIso(offsetDays = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return d.toISOString();
}

/** 今日统计（全部出自服务端落库数据，操作端不得自行编造）：
 *  入库/出库件数与吨位 = 钢材台账（inbound_time / outbound_time 今日）；
 *  倒垛次数 = 事件流 restack.done；识别成功率 = 扫码闭环 /（扫码闭环 + 复核报警）；
 *  安全违章暂无真实采集源，恒 0（不造假）。successRate 无样本时为 null（前端显示「—」）。 */
function computeKpiToday(db) {
  const t0 = localDayStartIso(0);
  const inAgg = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(weight_kg),0) w FROM steel_ledger WHERE inbound_time >= ?').get(t0);
  const outAgg = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(weight_kg),0) w FROM steel_ledger WHERE outbound_time >= ?').get(t0);
  const restackCount = db.prepare("SELECT COUNT(*) n FROM sim_events WHERE type='restack.done' AND time >= ?").get(t0).n;
  const scan = db.prepare(`SELECT
      SUM(CASE WHEN type='inbound.scan' THEN 1 ELSE 0 END) ok,
      SUM(CASE WHEN type='alarm.raise' THEN 1 ELSE 0 END) bad
    FROM sim_events WHERE time >= ?`).get(t0);
  const ok = scan.ok || 0, bad = scan.bad || 0;
  return {
    todayInCount: inAgg.n,
    todayInTon: +(inAgg.w / 1000).toFixed(1),
    todayOutCount: outAgg.n,
    todayOutTon: +(outAgg.w / 1000).toFixed(1),
    restackCount,
    violations: 0,
    successRate: (ok + bad) > 0 ? +((ok / (ok + bad)) * 100).toFixed(1) : null,
  };
}

/** 近 7 日出入库趋势（件）：钢材台账按自然日聚合（in=入库件数，out=出库件数），day 为本地 MM-DD */
function computeWeekTrend(db) {
  const inQ = db.prepare('SELECT COUNT(*) n FROM steel_ledger WHERE inbound_time >= ? AND inbound_time < ?');
  const outQ = db.prepare('SELECT COUNT(*) n FROM steel_ledger WHERE outbound_time >= ? AND outbound_time < ?');
  const p = n => String(n).padStart(2, '0');
  const rows = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
    rows.push({ day: `${p(d.getMonth() + 1)}-${p(d.getDate())}`, in: inQ.get(d.toISOString(), localDayStartIso(i - 1)).n, out: outQ.get(d.toISOString(), localDayStartIso(i - 1)).n });
  }
  return rows;
}

/** 轻量快照（不含捆级明细）；withBundles=true 时附带 bundle_positions 全量 */
export function getFrontendSnapshot(db, { withBundles = false } = {}) {
  ensureIntegrTables(db);   // kpiToday/weekTrend 查 sim_events：新库首次快照前须先建表
  const slots = getSlots(db);
  const specs = getSpecs(db);
  const vehicles = listSnapshotVehicles(db);   // 未完成全量 + 最近完成（在途不滚出窗口，取消判定可靠）
  const inventory = getInventory(db);
  const geo = getGeoCfg();
  const tele = getTelemetry();
  return {
    serverTime: new Date().toISOString(),
    simStartTime: tele?.simStartTime ?? null,   // 沙盘启动/重置时刻（ISO）：前端「已出场」过滤旧世界留痕的基准（departedTime 早于它 = 旧世界，不显示）
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
    // 调度参数下发（倒计时口径同源）：操作端进厂车「超时自动确认」倒计时 = arriveTime + autoConfirmMin，
    // 窗口值必须来自这里（各标签页/刷新/重开全部一致），禁止前端本地另起口径
    params: { autoConfirmMin: Number(getSimParams(db).production.autoConfirmMin) || 0 },
    kpiToday: computeKpiToday(db),     // 今日统计（台账+事件流真实聚合，替代前端 mock）
    weekTrend: computeWeekTrend(db),   // 近 7 日出入库趋势（台账按自然日聚合）
    // 倒垛单（跨平板同步：生成/下发/完成均落库，此前纯本地导致他端无此单）
    restackPlans: listRestackPlans(db),
    // 出库装车顺序/置顶（跨平板同步：装车序调整/置顶捆号落库，此前推送前纯本地）
    outboundQueue: listOutboundQueue(db),
    // 任务认领（管理工独占规划权）：其他客户端只读可看不可改
    claims: listClaims(db),
    // 沙盘作业锁定中的库位（遥测随帧携带）：操作端「作业中」视觉的服务端权威来源
    ...(Array.isArray(tele?.lockedSlots) ? { lockedSlots: tele.lockedSlots } : {}),
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

const EVENTS_KEEP = 5000;   // 其余结构化事件保留量（游标重放窗口；仅裁未受独立保护的类型）
const OUTBOUND_KEEP = 1200; // 出库订单事件独立保留量（在办订单不被洪流挤出，重放必含；一单多车/装载重播事件多，1200 覆盖整日高负载）
const LOGS_KEEP = 400;      // log 类事件保留量（操作端留痕仅显近 50 条，采样足够）
const ALARM_KEEP = 200;     // 报警事件独立保留量（报警卡仅由事件重建，被挤出则操作端丢警）
const RESTACK_KEEP = 600;   // 倒垛完成事件独立保留量（P10 已出场按车归集倒垛史，被挤出则出场追溯缺吊）
const LEFT_KEEP = 600;      // 车辆离场事件独立保留量（已出场留痕/出场时刻由它回放，被挤出则出场记录丢时刻）

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
    CREATE TABLE IF NOT EXISTS restack_plans (
      id          TEXT PRIMARY KEY,        -- 倒垛单号（DD-xx / DD-Mx，操作端分配，单写者免对账）
      status      TEXT NOT NULL,           -- 编辑中 / 已下发 / 已完成
      payload     TEXT NOT NULL,           -- 计划全量 JSON（items/target/forbidden/forOutboundId/...）
      create_time TEXT NOT NULL,
      update_time TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbound_queue (
      order_no    TEXT PRIMARY KEY,        -- 出库单号（CK-xx / HT26-xxxx，与事件流 outbound.order 同号）
      qr_codes    TEXT NOT NULL,           -- 装车顺序（捆号数组 JSON，last-writer-wins）
      pinned      TEXT,                    -- 置顶捆号（单卡置顶语义，NULL = 无）
      update_time TEXT NOT NULL
    );
    -- 管理工账户（免密自动分配）：平板打开网页即分配一个新账户（会话级，刷新不丢）
    CREATE TABLE IF NOT EXISTS users (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,            -- 管理工-NN
      created_at TEXT NOT NULL
    );
    -- 任务认领（先到者独占规划权）：一辆车/一张单被认领后，其他客户端只读可看不可改
    CREATE TABLE IF NOT EXISTS task_claims (
      ref_id     TEXT PRIMARY KEY,         -- in:<vehId>（入库车）/ out:<orderNo>（出库单）
      owner_id   INTEGER NOT NULL,
      owner_name TEXT NOT NULL,
      claimed_at TEXT NOT NULL
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
        // 旧世界倒垛单一并作废（未完成的已下发/编辑中计划均属已消亡世界；已完成历史保留）
        db.prepare("DELETE FROM restack_plans WHERE status != '已完成'").run();
        // 旧世界出库装车序/置顶一并作废（订单随世界消亡）
        db.prepare('DELETE FROM outbound_queue').run();
        // 旧世界任务认领一并释放（车辆/订单随世界消亡，规划权回收）
        db.prepare('DELETE FROM task_claims').run();
      }
      // 出库单出场（vehicle.left kind=out）：订单随车闭环，认领释放（refId = out:<orderNo>）
      if (e.type === 'vehicle.left' && e.payload && e.payload.kind === 'out' && e.payload.orderNo) {
        releaseClaimByRef(db, `out:${e.payload.orderNo}`);
      }
    }
    db.prepare(`DELETE FROM sim_events WHERE type='log' AND seq <= (SELECT MAX(seq) FROM sim_events WHERE type='log') - ?`).run(LOGS_KEEP);
    // 出库订单事件（order/assign/progress）独立保留窗口：低频但必须可重放——被洪流挤出会导致
    // 新开操作端永远重建不出「出库跟踪」卡（车都在跑、订单却无据可查）
    db.prepare(`DELETE FROM sim_events WHERE type LIKE 'outbound.%' AND seq <= (SELECT MAX(seq) FROM sim_events WHERE type LIKE 'outbound.%') - ?`).run(OUTBOUND_KEEP);
    db.prepare(`DELETE FROM sim_events WHERE type LIKE 'alarm.%' AND seq <= (SELECT MAX(seq) FROM sim_events WHERE type LIKE 'alarm.%') - ?`).run(ALARM_KEEP);
    db.prepare(`DELETE FROM sim_events WHERE type = 'restack.done' AND seq <= (SELECT MAX(seq) FROM sim_events WHERE type = 'restack.done') - ?`).run(RESTACK_KEEP);
    db.prepare(`DELETE FROM sim_events WHERE type = 'vehicle.left' AND seq <= (SELECT MAX(seq) FROM sim_events WHERE type = 'vehicle.left') - ?`).run(LEFT_KEEP);
    // 总窗口只裁「未受独立保护的类型」（log / outbound.% / alarm.% / restack.done / vehicle.left 各有按类窗口；sim.start/sim.reset
    // 是操作端重放建立会话起点的锚点，一场一条不淘汰）——若总窗口连受保护类型一起按 seq 距离砍，
    // 日志洪流几分钟就能把数小时前的事件全部顶掉，独立窗口形同虚设（实测：环里只剩最近 2 分钟）
    db.prepare(`DELETE FROM sim_events WHERE seq <= (SELECT MAX(seq) FROM sim_events) - ? AND type <> 'log' AND type NOT LIKE 'outbound.%' AND type NOT LIKE 'alarm.%' AND type NOT LIKE 'sim.%' AND type <> 'restack.done' AND type <> 'vehicle.left'`).run(EVENTS_KEEP);
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

/** 操作端写入命令（幂等去重：同 kind+refId 已有 pending/claimed 在途命令时返回既有命令——
 *  多标签/多平板同时打开时，同一到期扫描会在每个标签页各触发一次自动推送/自动确认，
 *  不去重沙盘会把同一张出库单执行两遍） */
export function createCommand(db, { kind, refId = null, payload = null }) {
  if (!kind) return null;
  ensureIntegrTables(db);
  if (refId != null) {
    const dup = db.prepare("SELECT id FROM sim_commands WHERE kind=? AND ref_id=? AND status IN ('pending','claimed') ORDER BY id LIMIT 1")
      .get(kind, refId);
    if (dup) return getCommand(db, dup.id);
  }
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

/* ===================== 倒垛单落库（跨平板同步） =====================
 * 操作端是倒垛单的唯一写者（生成端分配单号，单写者免对账）：生成（编辑中）/
 * 下发（已下发）/完成（restack.done 事件驱动任一端回写）全生命周期落库，
 * 随快照下发——此前计划纯本地，发起端之外的平板既看不到计划也收不了口。 */

export function upsertRestackPlan(db, plan) {
  if (!plan || typeof plan.id !== 'string' || !plan.id) return { ok: false, error: '缺少计划 id' };
  if (!['编辑中', '已下发', '已完成'].includes(plan.status)) return { ok: false, error: '非法计划状态' };
  ensureIntegrTables(db);
  const t = new Date().toISOString();
  db.prepare(`
    INSERT INTO restack_plans (id, status, payload, create_time, update_time)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload, update_time=excluded.update_time`)
    .run(plan.id, plan.status, JSON.stringify(plan), t, t);
  bumpRev();
  return { ok: true, plan: listRestackPlans(db).find(p => p.id === plan.id) };
}

export function listRestackPlans(db) {
  ensureIntegrTables(db);
  return db.prepare('SELECT * FROM restack_plans ORDER BY create_time, id').all()
    .map(r => {
      let p = {};
      try { p = JSON.parse(r.payload) || {}; } catch { /* 损坏行跳过内容，仅保底 id/status */ }
      return { ...p, id: r.id, status: r.status };   // 列值状态权威（payload 内为保存时快照）
    });
}

/* ===================== 管理工账户（免密分配）+ 任务认领 =====================
 * 多平板多管理工：打开网页即自动分配一个新账户（免密，演示期）；
 * 认领（进某车/某单的任务队列视图即认领）先到者独占规划权——
 * 其他客户端能打开看该车信息，但规划顺序不可改（平板端 UI 只读化；
 * 服务端不做强制拒绝——演示期 UI 门禁即可，后续接真实权限再上服务端鉴权）。
 * 释放时机：车辆完成/离场（台账收口）、出库单出场（vehicle.left 事件）、sim.reset、认领者主动释放。 */

export function allocateUser(db) {
  ensureIntegrTables(db);
  const r = db.prepare('INSERT INTO users (name, created_at) VALUES (?, ?)').run('', new Date().toISOString());
  const id = Number(r.lastInsertRowid);
  const name = `管理工-${String(id).padStart(2, '0')}`;
  db.prepare('UPDATE users SET name=? WHERE id=?').run(name, id);
  return { id, name };
}

/** 认领任务（先到者独占）：已有他人认领 → ok:false + 现有认领者；自己重复认领幂等 ok:true */
export function claimTask(db, refId, ownerId, ownerName) {
  if (!refId || typeof refId !== 'string') return { ok: false, error: '缺少 refId' };
  if (!(ownerId > 0)) return { ok: false, error: '缺少 ownerId' };
  ensureIntegrTables(db);
  const cur = db.prepare('SELECT * FROM task_claims WHERE ref_id=?').get(refId);
  if (cur) {
    return cur.owner_id === ownerId
      ? { ok: true, claim: { refId, ownerId: cur.owner_id, ownerName: cur.owner_name } }
      : { ok: false, claim: { refId, ownerId: cur.owner_id, ownerName: cur.owner_name } };
  }
  db.prepare('INSERT INTO task_claims (ref_id, owner_id, owner_name, claimed_at) VALUES (?, ?, ?, ?)')
    .run(refId, ownerId, ownerName || `管理工-${ownerId}`, new Date().toISOString());
  return { ok: true, claim: { refId, ownerId, ownerName } };
}

/** 释放认领：仅认领者本人可释放 */
export function releaseTask(db, refId, ownerId) {
  ensureIntegrTables(db);
  const cur = db.prepare('SELECT * FROM task_claims WHERE ref_id=?').get(refId);
  if (!cur) return { ok: true, released: false };
  if (cur.owner_id !== ownerId) return { ok: false, error: '非认领者不可释放', claim: { refId, ownerId: cur.owner_id, ownerName: cur.owner_name } };
  db.prepare('DELETE FROM task_claims WHERE ref_id=?').run(refId);
  return { ok: true, released: true };
}

export function listClaims(db) {
  ensureIntegrTables(db);
  return db.prepare('SELECT ref_id, owner_id, owner_name, claimed_at FROM task_claims ORDER BY claimed_at').all()
    .map(r => ({ refId: r.ref_id, ownerId: r.owner_id, ownerName: r.owner_name, claimedAt: r.claimed_at }));
}

/** 认领释放（系统侧收口用）：入库车台账收口/出库单离场/车辆删除时直接按 refId 释放 */
export function releaseClaimByRef(db, refId) {
  ensureIntegrTables(db);
  db.prepare('DELETE FROM task_claims WHERE ref_id=?').run(refId);
}

/* ===================== 出库装车顺序/置顶（跨平板同步） =====================
 * 出库单本体由沙盘事件流承载（outbound.order/progress），但其「装车顺序/置顶捆号」
 * 是管理工在平板上的规划意图（推送前纯本地、他端不可见）：落库 last-writer-wins，
 * 快照下发全端；推送（dispatch-outbound-order）时推送方按推送捆序覆写本表——
 * 他端因此与沙盘实际装车序对齐（outbound.progress 的按序已装标记才不会错位）。 */

export function saveOutboundQueue(db, orderNo, qrCodes, pinned = null) {
  if (!orderNo || typeof orderNo !== 'string') return { ok: false, error: '缺少 orderNo' };
  if (!Array.isArray(qrCodes) || qrCodes.some(q => typeof q !== 'string')) return { ok: false, error: 'qrCodes 须为捆号数组' };
  if (pinned != null && typeof pinned !== 'string') return { ok: false, error: 'pinned 须为捆号或 null' };
  ensureIntegrTables(db);
  // 顺带清理 24h 前的陈旧行（历史订单的装车序不再有意义）
  db.prepare('DELETE FROM outbound_queue WHERE update_time < ?')
    .run(new Date(Date.now() - 86400000).toISOString());
  db.prepare(`
    INSERT INTO outbound_queue (order_no, qr_codes, pinned, update_time)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(order_no) DO UPDATE SET qr_codes=excluded.qr_codes, pinned=excluded.pinned, update_time=excluded.update_time`)
    .run(orderNo, JSON.stringify(qrCodes), pinned ?? null, new Date().toISOString());
  return { ok: true };
}

export function listOutboundQueue(db) {
  ensureIntegrTables(db);
  return db.prepare('SELECT * FROM outbound_queue ORDER BY update_time DESC').all()
    .map(r => {
      let qr = [];
      try { qr = JSON.parse(r.qr_codes) || []; } catch { /* 损坏行按空序 */ }
      return { orderNo: r.order_no, qrCodes: qr, ...(r.pinned ? { pinned: r.pinned } : {}), updateTime: r.update_time };
    });
}

/* ===================== 平板报警直达事件流 =====================
 * 天车工「异常上报」等人工报警此前纯本地（仅上报端可见）：这里提供直达事件流的
 * 上报/关闭端点，不经沙盘认领（人工观察无需仿真执行），全端 1s 内可见；
 * 仿真侧产生的报警仍走沙盘 emitSimEvent 通道，两源同流（source 区分）。 */

const TABLET_ALARM_TYPES = ['识别失败', '账实差异', '设备故障', '安全违章'];

export function raiseTabletAlarm(db, { alarmId, type, slot, desc, level } = {}) {
  if (!alarmId || typeof alarmId !== 'string') return { ok: false, error: '缺少 alarmId' };
  if (!TABLET_ALARM_TYPES.includes(type)) return { ok: false, error: '非法报警类型' };
  ensureIntegrTables(db);
  // 幂等：同 alarmId 已在事件流（重试/多标签并发）不重复上报——kpiToday 按 alarm.raise 计数，重复会虚增
  const dup = db.prepare(`SELECT seq FROM sim_events WHERE type='alarm.raise' AND json_extract(payload,'$.alarmId')=? LIMIT 1`)
    .get(alarmId);
  if (dup) return { ok: true, skipped: 'duplicate' };
  appendEvents(db, [{
    type: 'alarm.raise',
    payload: { alarmId, type, slot: slot || null, desc: desc || null, level: level || null, source: 'tablet' },
  }]);
  return { ok: true };
}

export function closeTabletAlarm(db, alarmId, method = '现场处置') {
  if (!alarmId || typeof alarmId !== 'string') return { ok: false, error: '缺少 alarmId' };
  appendEvents(db, [{ type: 'alarm.closed', payload: { alarmId, method, source: 'tablet' } }]);
  return { ok: true };
}
