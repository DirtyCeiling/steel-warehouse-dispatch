// 进厂车辆垛位分配确认模块（管理工「进厂确认」页后端）
// 流程：车辆进厂 -> 车牌/运单识别（默认取车辆进出库物流数据仿真 LogisticsData_Sim 的下一辆进厂车，
//       数据源离线时回退本地随机模拟，接口留待真实识别接入）->
//       按归堆策略权重（sim_params.placement，与「调度参数」页/仿真沙盘同源）
//       生成垛位分配推荐 -> 管理工确认或调整 -> 调整结果沉淀为权重优化。
// 权重优化规则（感知机式微调）：对被人工改动的组，分别在推荐落点与实际落点上
// 复算各评分维度，人工选择在某维度上更优则该维度权重 +STEP、更劣则 -STEP，
// 按 schema 夹取——下一次同类取舍时算法即偏向管理工的选择。
// 推荐引擎（评分/整组分配/候选列表/学习方向）与监测范围判定均在垛位推荐算法包
// （StackAlloc，经 ./stack-alloc.js 接入），本文件只做 DB 台账与视图适配。
import {
  getSimParams, setSimParams, SPEC_FAMILY, stackCap, getGeoCfg, getSpecRules,
} from './database.js';
import { PARAM_SCHEMA } from './params.js';
import {
  monitoredScopesOf, regionRestrictedOf, slotInOpScope,
  recommendAllocation as saRecommendAllocation, listCandidates as saListCandidates,
  learnDeltas as saLearnDeltas,
} from './stack-alloc.js';

export const SPAN_LABELS = ['A跨', 'B跨', 'C跨', '整跨合并'];
const MILLS = ['承德建龙', '新兴铸管', '唐山瑞丰', '敬业集团', '首钢迁安', '石钢京诚'];
const PROVINCES = ['冀', '京', '津', '鲁', '豫', '晋', '辽', '陕', '蒙'];

function scopeWarnText(ms) {
  return ms.map(m => `${SPAN_LABELS[m.span]}${m.lo > 1 || m.hi < 33 ? `（${m.lo}~${m.hi} 号区）` : ''}`).join('、');
}

/* 车辆物流数据源（LogisticsData_Sim，独立程序）：进厂确认从这里取下一辆进厂车，
 * 车牌/运单/配载与仿真沙盘消费的是同一条事件流；数据源离线时回退本地随机生成。 */
const LOGI_API = process.env.LOGI_API || 'http://127.0.0.1:5288';
const FEED_CONSUMER = 'inbound-confirm';

function ensureFeedTable(db) {
  db.exec('CREATE TABLE IF NOT EXISTS feed_cursors (consumer TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0)');
}
function getFeedCursor(db) {
  ensureFeedTable(db);
  const r = db.prepare('SELECT seq FROM feed_cursors WHERE consumer=?').get(FEED_CONSUMER);
  return r ? r.seq : 0;
}
function setFeedCursor(db, seq) {
  db.prepare('INSERT INTO feed_cursors (consumer, seq) VALUES (?, ?) ON CONFLICT(consumer) DO UPDATE SET seq=excluded.seq')
    .run(FEED_CONSUMER, seq);
}

async function fetchSourceEvents(after) {
  const res = await fetch(`${LOGI_API}/api/events?type=in&after=${after}&limit=1`,
    { signal: AbortSignal.timeout(1500) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function readSourceEvent(r) {
  const ev = (r.events || [])[0];
  if (!ev) return { exhausted: true, lastSeq: r.lastSeq };
  const groups = (ev.manifest || [])        // 事件负载已扁平展开（ev.plate / ev.manifest ...）
    .map(g => ({ spec: g.spec, bundles: Math.max(0, Math.round(g.bundles || 0)) }))
    .filter(g => SPEC_FAMILY[g.spec] && g.bundles > 0);
  if (!groups.length) return { exhausted: false, skip: ev };   // 空配载/契约外规格：调用方跳过后推进游标
  return { event: ev, groups, plate: ev.plate, waybill: ev.waybill, mill: ev.mill };
}

/** 从物流数据源取下一辆未消费的进厂车事件（按本页独立游标）；取不到返回 null */
async function nextSourceVehicle(db) {
  if (typeof fetch !== 'function') return null;
  let r = await fetchSourceEvents(getFeedCursor(db));
  // 数据源事件流被重置（流长度回退到游标之前）：游标自愈重新对齐流头（与沙盘 ?feed 消费端同规则）
  if ((r.lastSeq ?? 0) < getFeedCursor(db)) {
    setFeedCursor(db, 0);
    r = await fetchSourceEvents(0);
  }
  return readSourceEvent(r);
}

/* 「调度参数」schema 中 placement 段的中文标签（反馈留痕/前端展示用） */
const PLACEMENT_LABELS = {};
for (const s of PARAM_SCHEMA) {
  if (s.sec === 'placement') for (const d of s.defs) PLACEMENT_LABELS[d.key] = d.label;
}

const LEARN_STEP = 2;             // 单次确认每个维度的最大步长（分）

const nowIso = () => new Date().toISOString();
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const randint = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

/* ================= 归堆推荐引擎（垛位推荐算法包 StackAlloc） =================
 * 评分/整组贪心分配/候选列表/落点复算/学习方向均由算法包实现（与仿真沙盘同一源码），
 * 此处把 DB 行适配成算法包的库位/垛视图（垛视图带 no = stack_no），并按
 * 「锁定库位 + 监测范围」先行过滤候选库位（进厂确认页口径：整跨合并位任一跨监测即可荐）。 */

function loadYard(db) {
  const slots = db.prepare('SELECT * FROM storage_slots ORDER BY id').all()
    .map(s => ({ ...s, stacks: [] }));
  const byId = new Map(slots.map(s => [s.id, s]));
  for (const k of db.prepare('SELECT * FROM stacks ORDER BY slot_id, stack_no').all()) {
    const st = byId.get(k.slot_id);
    if (st) st.stacks.push({ ...k, no: k.stack_no });
  }
  return slots;
}

/** 算法包入参：库房几何参数 + 捆制规则覆盖（与垛容/捆径核算同源同口径） */
const allocCtx = () => ({ geo: getGeoCfg(), rules: getSpecRules() });

/** 候选库位过滤：库位锁定出局；监测范围受限时范围外出局 */
function candidateSlots(db) {
  const P = getSimParams(db);
  const ms = monitoredScopesOf(P), restricted = regionRestrictedOf(ms);
  const yard = loadYard(db);
  return {
    W: P.placement, yard,
    slots: yard.filter(st => st.state !== 'locked' && !(restricted && !slotInOpScope(st, ms))),
  };
}

/**
 * 为一组（spec × bundles 捆）生成垛位分配推荐：
 * 贪心取最优候选垛，装满后再荐次优（同车同规格集中码放、垛满另荐），返回分配数组。
 */
export function recommendAllocation(db, spec, bundles) {
  const { W, yard, slots } = candidateSlots(db);
  const r = saRecommendAllocation({ slots, nearSlots: yard, spec, bundles, W, ...allocCtx() });
  return {
    allocations: r.allocations.map(a => ({
      slotId: a.slot.id, code: a.slot.code, zone: a.slot.zone,
      area: a.slot.area, span: a.slot.span, stackNo: a.stack.no,
      bundles: a.bundles, score: a.score, parts: a.parts,
    })),
    shortfall: r.shortfall,
  };
}

/** 候选落点列表（调整下拉框用）：先「容量够整组」后综合分降序，含剩余容量与评分分解 */
export function listCandidates(db, spec, bundles, limit = 20) {
  const { W, yard, slots } = candidateSlots(db);
  return saListCandidates({ slots, nearSlots: yard, spec, bundles, W, limit, ...allocCtx() })
    .map(c => ({
      slotId: c.slot.id, stackNo: c.stack.no, code: c.slot.code, zone: c.slot.zone,
      area: c.slot.area, span: c.slot.span, merged: !!c.slot.merged,
      spanLabel: c.slot.merged ? SPAN_LABELS[3] : SPAN_LABELS[c.slot.span],
      score: c.score, parts: c.parts, free: c.free, enough: c.enough,
    }));
}

/* ================= 车辆进厂（车牌/运单识别模拟） ================= */

function makePlate() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const tail = Array.from({ length: 5 }, () => pick((letters + '0123456789').split(''))).join('');
  return `${pick(PROVINCES)}${pick(letters.split(''))}·${tail}`;
}

/** 本地随机生成一辆进厂车（兜底：物流数据源离线时工作台仍可用） */
function spawnLocalVehicle(db) {
  const params = getSimParams(db);
  const minLoads = Math.round(params.truck.minLoads);
  const maxLoads = Math.round(params.truck.maxLoads);
  const specs = [...new Set(Object.keys(SPEC_FAMILY))];
  const total = randint(minLoads, maxLoads);          // 一车吊数与仿真组车规则一致
  const primary = pick(specs);
  const mixed = Math.random() * 100 < params.truck.mixedSpecPct;
  if (mixed) {
    const second = pick(specs.filter(s => s !== primary));
    const g1 = Math.max(minLoads - 1, Math.ceil(total * (0.55 + Math.random() * 0.2)));
    return { groups: [{ spec: primary, bundles: g1 }, { spec: second, bundles: total - g1 }],
      plate: makePlate(), waybill: `YD26-${randint(10000, 99999)}`, mill: pick(MILLS) };
  }
  return { groups: [{ spec: primary, bundles: total }],
    plate: makePlate(), waybill: `YD26-${randint(10000, 99999)}`, mill: pick(MILLS) };
}

/** 按识别结果（车牌/运单/逐组配载）落库并生成垛位分配推荐 */
function insertVehicleWithLoads(db, v) {
  const insVeh = db.prepare(
    'INSERT INTO inbound_vehicles (plate, waybill, mill, arrive_time, state) VALUES (?, ?, ?, ?, \'pending\')');
  const insLoad = db.prepare(`
    INSERT INTO inbound_loads
      (vehicle_id, spec, bundles, rec_slot_id, rec_stack_no, rec_score, rec_parts)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  return db.transaction(() => {
    const id = insVeh.run(v.plate, v.waybill, v.mill, nowIso()).lastInsertRowid;
    for (const g of v.groups) {
      const { allocations } = recommendAllocation(db, g.spec, g.bundles);   // 逐组推荐（垛满自动拆垛）
      for (const a of allocations) {
        insLoad.run(id, g.spec, a.bundles, a.slotId, a.stackNo, a.score, JSON.stringify(a.parts));
      }
    }
    return id;
  })();
}

function hasVehicleIdentity(db, plate, waybill) {
  return !!db.prepare('SELECT id FROM inbound_vehicles WHERE plate=? AND waybill=? LIMIT 1').get(plate, waybill);
}

/** 登记一辆仿真沙盘本地进厂车（本地排产模式下沙盘生成即登记，保证操作端 P10 待办/
 *  P3 入库单与沙盘进厂车同源一致）；按车牌+运单去重（重开沙盘页不产生重复台账）。
 *  返回车辆视图（含推荐垛位），非法入参返回 null。 */
export function registerIncomingVehicle(db, v) {
  if (!v || !v.plate || !v.waybill || !Array.isArray(v.groups) || !v.groups.length) return null;
  for (const g of v.groups) {
    if (!g || !g.spec || !(g.bundles > 0)) return null;
  }
  if (hasVehicleIdentity(db, v.plate, v.waybill)) {
    const row = db.prepare('SELECT id FROM inbound_vehicles WHERE plate=? AND waybill=? LIMIT 1').get(v.plate, v.waybill);
    return getVehicleView(db, row.id);
  }
  const id = insertVehicleWithLoads(db, { plate: v.plate, waybill: v.waybill, mill: v.mill || '—', groups: v.groups });
  return getVehicleView(db, id);
}

/** 消费物流源下一条进厂车事件并登记为待确认车辆（跳过空配载；按 车牌+运单 去重，
 *  数据源重置重放同一段流时不产生重复台账），游标先推进再落库。
 *  返回 { inserted: 车辆视图 } | { duplicate: true } | { exhausted: true } | null（数据源不可达）。 */
async function ingestNextSourceVehicle(db) {
  let src = await nextSourceVehicle(db);
  while (src && src.skip) {                       // 空/契约外事件：跳过并推进游标再取
    setFeedCursor(db, src.skip.seq);
    src = await nextSourceVehicle(db);
  }
  if (!src) return null;                          // fetch 失败（数据源离线）
  if (src.exhausted) return { exhausted: true };
  setFeedCursor(db, src.event.seq);
  if (hasVehicleIdentity(db, src.plate, src.waybill)) return { duplicate: true };
  const id = insertVehicleWithLoads(db, src);
  return { inserted: getVehicleView(db, id) };
}

/**
 * 模拟一车进厂：车牌/运单识别 —— 优先取车辆物流数据源（LogisticsData_Sim）的下一辆
 * 未消费进厂车（与仿真沙盘同一条事件流，与后台自动进厂轮询共用同一游标）；源离线回退本地随机，
 * 源在线但事件流消费完则明确报错（保持「车辆数据只有一个来源」）。
 */
export async function spawnIncomingVehicle(db) {
  try {
    const r = await ingestNextSourceVehicle(db);
    if (r && r.inserted) return { ...r.inserted, source: `logistics:${LOGI_API}` };
    if (r && r.exhausted) {
      return { error: `物流数据源（${LOGI_API}）暂无待处理进厂车辆 —— 可在数据源控制台手动注入或等待排产` };
    }
  } catch (e) { /* 数据源离线：回退本地随机模拟 */ }
  const id = insertVehicleWithLoads(db, { ...spawnLocalVehicle(db) });
  return { ...getVehicleView(db, id), source: 'local-fallback' };
}

/**
 * 后台自动进厂（进厂确认/车辆记录两页与三维仿真车辆同源同步的核心）：
 * 持续把物流源进厂车事件登记进确认队列，沙盘（?feed 模式）消费同一条流——
 * 两个消费端各自持游标，事件 1:1 对应，按车牌+运单匹配确认单执行。
 * 每次调用最多连取 cap 条（防事件积压时单次调用过重）；源离线/消费完静默返回 0。
 */
export async function pollInboundFromSource(db, cap = 8) {
  let n = 0;
  try {
    for (let i = 0; i < cap; i++) {
      const r = await ingestNextSourceVehicle(db);
      if (!r || r.exhausted) break;
      if (r.duplicate) continue;
      n++;
      console.log(`[进厂确认] 物流源车辆自动进厂：${r.inserted.plate} / ${r.inserted.waybill}（${r.inserted.bundles} 捆），待管理工确认`);
    }
  } catch { /* 物流源不可达：下轮轮询重试，不打断服务 */ }
  return n;
}

/* ================= 视图 / 校验 ================= */

function slotCodeMap(db) {
  return new Map(db.prepare('SELECT id, code FROM storage_slots').all().map(s => [s.id, s.code]));
}

/** 单车完整视图（loads 含推荐值与最终值；最终为空表示未调整、取推荐）；
 *  codes 传入本请求已建好的 slotId->code 映射可免逐车重复全表建表 */
export function getVehicleView(db, id, codes = slotCodeMap(db)) {
  const v = db.prepare('SELECT * FROM inbound_vehicles WHERE id=?').get(id);
  if (!v) return null;
  const loads = db.prepare('SELECT * FROM inbound_loads WHERE vehicle_id=? ORDER BY id').all(id)
    .map(l => ({
      id: l.id, spec: l.spec, bundles: l.bundles, adjusted: !!l.adjusted,
      recSlotId: l.rec_slot_id, recStackNo: l.rec_stack_no,
      recCode: codes.get(l.rec_slot_id) || String(l.rec_slot_id),
      recScore: l.rec_score, recParts: safeParse(l.rec_parts),
      ...(l.slot_id != null
        ? { slotId: l.slot_id, stackNo: l.stack_no, code: codes.get(l.slot_id) || String(l.slot_id) }
        : {}),
    }));
  return {
    id: v.id, plate: v.plate, waybill: v.waybill, mill: v.mill,
    arriveTime: v.arrive_time, state: v.state, ...(v.confirmed_time ? { confirmedTime: v.confirmed_time } : {}),
    ...(v.departed_time ? { departedTime: v.departed_time } : {}),
    bundles: loads.reduce((n, l) => n + l.bundles, 0),
    loads,
  };
}

function safeParse(json, fallback = []) {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : fallback; } catch { return fallback; }
}

export function listInboundVehicles(db, limit = 25) {
  const codes = slotCodeMap(db);   // 整批共用一份码表，避免逐车重复全表扫描
  return db.prepare('SELECT id FROM inbound_vehicles ORDER BY id DESC LIMIT ?').all(limit)
    .map(r => getVehicleView(db, r.id, codes));
}

/** 批量取车辆视图（车辆记录页分页接口用）：一次码表 + 逐车查详情 */
export function listVehicleViews(db, ids) {
  const codes = slotCodeMap(db);
  return ids.map(id => getVehicleView(db, id, codes)).filter(Boolean);
}

/** 组内已占容量统计：(slotId,stackNo) -> 已计划捆数；excludeLoadId 用于换垛时剔除自身旧计划 */
function buildClaims(db, vehicleId, excludeLoadId = 0) {
  const claims = new Map();
  for (const l of db.prepare('SELECT * FROM inbound_loads WHERE vehicle_id=?').all(vehicleId)) {
    if (l.id === excludeLoadId) continue;
    const slotId = l.slot_id ?? l.rec_slot_id;
    const stackNo = l.stack_no ?? l.rec_stack_no;
    const key = `${slotId}:${stackNo}`;
    claims.set(key, (claims.get(key) || 0) + l.bundles);
  }
  return claims;
}

/** 校验某组落在指定垛位是否合法（库位可用、监测范围、同垛单规格、容量含同车已计划量） */
function validateTarget(db, yard, claims, spec, slotId, stackNo, bundles) {
  const st = yard.find(s => s.id === slotId);
  if (!st) return '库位不存在';
  if (st.state === 'locked') return `库位 ${st.code} 已被任务锁定`;
  const P = getSimParams(db);
  const ms = monitoredScopesOf(P);
  if (regionRestrictedOf(ms) && !slotInOpScope(st, ms)) {
    return `库位 ${st.code} 不在作业范围·未监测跨（当前仅监测 ${scopeWarnText(ms)}），不安排作业`;
  }
  const k = st.stacks.find(x => x.stack_no === stackNo);
  if (!k) return `库位 ${st.code} 无第 ${stackNo} 垛`;
  if (k.pending > 0) return `库位 ${st.code} 第${stackNo}垛待扫码核验，暂不可作落点`;
  if (k.count > 0 && k.spec !== spec) return `库位 ${st.code} 第${stackNo}垛已有 ${k.spec}（同垛不混异规格）`;
  const free = stackCap(spec) - k.count - (claims.get(`${slotId}:${stackNo}`) || 0);
  if (bundles > free) return `库位 ${st.code} 第${stackNo}垛容量不足（余 ${Math.max(0, free)} 捆 < ${bundles} 捆）`;
  return null;
}

/* ================= 调整 / 确认 ================= */

/** 管理工改垛：仅待确认车辆可改；合法即更新最终落点并标记 adjusted */
export function adjustLoad(db, vehicleId, loadId, slotId, stackNo) {
  const v = db.prepare('SELECT * FROM inbound_vehicles WHERE id=?').get(vehicleId);
  const l = db.prepare('SELECT * FROM inbound_loads WHERE id=? AND vehicle_id=?').get(loadId, vehicleId);
  if (!v || !l) return { error: '车辆或分配组不存在' };
  if (v.state !== 'pending') return { error: '该车已确认下发，不可再调整' };
  const yard = loadYard(db);
  const err = validateTarget(db, yard, buildClaims(db, vehicleId, loadId), l.spec, slotId, stackNo, l.bundles);
  if (err) return { error: err };
  db.prepare('UPDATE inbound_loads SET slot_id=?, stack_no=?, adjusted=1 WHERE id=?').run(slotId, stackNo, loadId);
  return { vehicle: getVehicleView(db, vehicleId) };
}

/** 在当前权重下对比推荐落点与人工落点的分维差异，累计各权重的微调方向（算法包 learnDeltas） */
function learnDeltas(db, yard, adjustedLoads) {
  if (!adjustedLoads.length) return [];
  const W = getSimParams(db).placement;
  const idxOf = (slotId, stackNo) => {
    const st = yard.find(s => s.id === slotId);
    return st ? st.stacks.findIndex(x => x.no === stackNo) : -1;
  };
  return saLearnDeltas({
    slots: yard, W, ...allocCtx(),
    adjusted: adjustedLoads.map(l => ({
      spec: l.spec,
      rec: { slotId: l.rec_slot_id, stackIdx: idxOf(l.rec_slot_id, l.rec_stack_no) },
      fin: { slotId: l.slot_id, stackIdx: idxOf(l.slot_id, l.stack_no) },
    })),
  });
}

/** 管理工确认：校验全部组 -> 留痕 -> 人工调整沉淀为权重优化 -> 置已确认 */
export function confirmVehicle(db, vehicleId) {
  const v = db.prepare('SELECT * FROM inbound_vehicles WHERE id=?').get(vehicleId);
  if (!v) return { error: '车辆不存在' };
  if (v.state !== 'pending') return { error: '该车已确认' };
  const yard = loadYard(db);
  const loads = db.prepare('SELECT * FROM inbound_loads WHERE vehicle_id=? ORDER BY id').all(vehicleId);
  if (!loads.length) return { error: '该车无有效垛位分配（库区可能已满），请先释放库容' };

  const claims = new Map();
  for (const l of loads) {
    const err = validateTarget(db, yard, claims, l.spec, l.slot_id ?? l.rec_slot_id, l.stack_no ?? l.rec_stack_no, l.bundles);
    if (err) return { error: `${l.spec} ×${l.bundles}：${err}` };
    const key = `${l.slot_id ?? l.rec_slot_id}:${l.stack_no ?? l.rec_stack_no}`;
    claims.set(key, (claims.get(key) || 0) + l.bundles);
  }

  const codes = slotCodeMap(db);
  const adjusted = loads.filter(l => l.adjusted && l.slot_id != null);
  const dirs = learnDeltas(db, yard, adjusted);

  const insFb = db.prepare(`
    INSERT INTO placement_feedback
      (time, vehicle_id, plate, spec, bundles, action, rec_code, rec_stack_no, final_code, final_stack_no, deltas)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const applyW = {};
  const appliedDeltas = [];
  const tx = db.transaction(() => {
    const before = getSimParams(db).placement;
    for (const d of dirs) {
      applyW[d.key] = before[d.key] + LEARN_STEP * d.dir;   // setSimParams 会按 schema 夹取
    }
    let after = before;
    if (Object.keys(applyW).length) after = setSimParams(db, { placement: applyW }).placement;
    for (const key of Object.keys(applyW)) {
      if (after[key] !== before[key]) {
        appliedDeltas.push({ key, label: PLACEMENT_LABELS[key] || key, from: before[key], to: after[key] });
      }
    }
    const t = nowIso();
    for (const l of loads) {
      const isAdj = !!(l.adjusted && l.slot_id != null);
      insFb.run(t, v.id, v.plate, l.spec, l.bundles, isAdj ? 'adjusted' : 'confirmed',
        codes.get(l.rec_slot_id) || String(l.rec_slot_id), l.rec_stack_no,
        codes.get(l.slot_id ?? l.rec_slot_id) || '', l.stack_no ?? l.rec_stack_no,
        JSON.stringify(isAdj ? appliedDeltas : []));
    }
    db.prepare("UPDATE inbound_vehicles SET state='confirmed', confirmed_time=? WHERE id=?").run(t, v.id);
  });
  tx();
  return { vehicle: getVehicleView(db, vehicleId), deltas: appliedDeltas };
}

/** 删除待确认车辆（误识别/演练数据清理）；已确认车辆保留台账 */
export function deleteVehicle(db, vehicleId) {
  const v = db.prepare('SELECT * FROM inbound_vehicles WHERE id=?').get(vehicleId);
  if (!v) return { error: '车辆不存在' };
  if (v.state !== 'pending') return { error: '已确认车辆属作业台账，不可删除' };
  db.transaction(() => {
    db.prepare('DELETE FROM inbound_loads WHERE vehicle_id=?').run(vehicleId);
    db.prepare('DELETE FROM inbound_vehicles WHERE id=?').run(vehicleId);
  })();
  return { ok: true };
}

/* ================= 超时自动确认 =================
 * 管理工长时间未确认的待确认车辆按当前推荐/调整方案自动确认下发
 * （时限 = 调度参数 production.autoConfirmMin 分钟，0 = 关闭），
 * 避免无人值守时确认队列积压、入库闭环卡住。 */

/** 扫描并自动确认全部超时待确认车辆：返回本次处理结果 [{id, plate?, waybill?, error?}] */
export function autoConfirmExpired(db) {
  const minutes = Math.round(Number(getSimParams(db).production.autoConfirmMin) || 0);
  if (!(minutes > 0)) return [];
  const cutoff = new Date(Date.now() - minutes * 60000).toISOString();   // arrive_time 为 ISO 串，可字典序比较
  const ids = db.prepare(
    "SELECT id FROM inbound_vehicles WHERE state='pending' AND arrive_time <= ? ORDER BY id")
    .all(cutoff).map(r => r.id);
  return ids.map(id => {
    const r = confirmVehicle(db, id);
    return r.error
      ? { id, error: r.error }
      : { id, plate: r.vehicle.plate, waybill: r.vehicle.waybill };
  });
}

/* ================= 确认单 -> 沙盘执行（闭环通道） =================
 * 沙盘消费同一条物流事件流建入库任务时，按 车牌+运单 匹配已确认分配单，
 * 按管理工确认的最终落点执行卸货；卸毕由沙盘回传 departed_time 台账闭环。 */

/** 沙盘按车牌+运单查询已确认（或已完成）的进厂车分配单：命中返回车辆视图，未确认/不存在返回 null */
export function matchConfirmedVehicle(db, plate, waybill) {
  if (!plate || !waybill) return null;
  const r = db.prepare(`
    SELECT id FROM inbound_vehicles
    WHERE plate=? AND waybill=? AND state IN ('confirmed','completed')
    ORDER BY id DESC LIMIT 1`).get(plate, waybill);
  return r ? getVehicleView(db, r.id) : null;
}

/** 沙盘回传：该车卸货完毕离场（台账生命周期 pending -> confirmed -> completed） */
export function completeVehicle(db, vehicleId) {
  const v = db.prepare('SELECT * FROM inbound_vehicles WHERE id=?').get(vehicleId);
  if (!v) return { error: '车辆不存在' };
  if (v.state === 'pending') return { error: '该车尚未确认，不能标记作业完成' };
  if (v.state !== 'completed') {
    db.prepare("UPDATE inbound_vehicles SET state='completed', departed_time=? WHERE id=?").run(nowIso(), vehicleId);
  }
  return { vehicle: getVehicleView(db, vehicleId) };
}

/* ================= 人工反馈统计（算法优化效果） ================= */

export function feedbackStats(db, recentLimit = 12) {
  const totals = db.prepare(`
    SELECT COUNT(DISTINCT v.id)                          AS vehicles,
           COUNT(l.id)                                   AS groups,
           COALESCE(SUM(l.adjusted AND v.state <> 'pending'), 0) AS adjusted
    FROM inbound_vehicles v
    LEFT JOIN inbound_loads l ON l.vehicle_id = v.id
    WHERE v.state IN ('confirmed','completed')`).get();
  const recent = db.prepare(
    'SELECT * FROM placement_feedback ORDER BY id DESC LIMIT ?').all(recentLimit)
    .map(r => ({
      time: r.time, plate: r.plate, spec: r.spec, bundles: r.bundles, action: r.action,
      ...(r.rec_code ? { recCode: r.rec_code, recStackNo: r.rec_stack_no } : {}),
      finalCode: r.final_code, finalStackNo: r.final_stack_no,
      deltas: safeParse(r.deltas),
    }));
  return {
    totals: {
      vehicles: totals.vehicles,
      groups: totals.groups || 0,
      adjusted: totals.adjusted || 0,
      adjustRate: totals.groups ? (totals.adjusted || 0) / totals.groups : 0,
    },
    recent,
    weights: getSimParams(db).placement,
  };
}
