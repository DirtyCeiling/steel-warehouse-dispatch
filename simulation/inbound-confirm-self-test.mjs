// 无头自检：进厂确认「超时自动确认」（调度参数 production.autoConfirmMin，默认 5 分钟，0 = 关闭）。
// 验证：超时未确认的车辆按推荐/人工调整方案自动确认下发；未超时车辆不受影响；
//       无合法落点的超时车确认失败并保持待确认；参数置 0 时整体关闭。
// 用法：node simulation/inbound-confirm-self-test.mjs
process.env.LOGI_API = 'http://127.0.0.1:9';   // 指向立即拒绝的端口：强制走本地随机兜底，不依赖物流数据源
const { openDb, seed, getSimParams, setSimParams } = await import('../server/database.js');
const {
  spawnIncomingVehicle, adjustLoad, listCandidates, getVehicleView, autoConfirmExpired,
} = await import('../server/inbound.js');

let n = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`); n++;
};
const backdate = (db, id, minutes) =>
  db.prepare('UPDATE inbound_vehicles SET arrive_time=? WHERE id=?')
    .run(new Date(Date.now() - minutes * 60000).toISOString(), id);

const db = openDb(':memory:');
seed(db);

/* ---- 默认参数 ---- */
assert(getSimParams(db).production.autoConfirmMin === 5, '调度参数默认确认超时 5 分钟（production.autoConfirmMin）');

/* ---- 超时自动确认：仅放行超时车辆 ---- */
const expired = await spawnIncomingVehicle(db);
assert(expired && expired.id && expired.loads.length, '本地兜底生成进厂车并给出垛位分配推荐');
backdate(db, expired.id, 6);                      // 6 分钟前进厂：超过默认 5 分钟时限
const fresh = await spawnIncomingVehicle(db);     // 刚进厂：未超时
const hit = autoConfirmExpired(db);
assert(hit.length === 1 && hit[0].id === expired.id, `一次扫描只确认超时车辆（本次确认 ${hit.length} 辆）`);
assert(hit[0].plate === expired.plate && hit[0].waybill === expired.waybill, '自动确认返回车牌/运单供留痕');
const doneView = getVehicleView(db, expired.id);
assert(doneView.state === 'confirmed' && !!doneView.confirmedTime, '超时车辆已按推荐方案确认下发（pending -> confirmed）');
assert(getVehicleView(db, fresh.id).state === 'pending', '未超时车辆保持待确认');
assert(autoConfirmExpired(db).length === 0, '已确认车辆不会被重复扫描（幂等）');

/* ---- 超时自动确认保留人工调整落点（调整照常沉淀权重学习） ---- */
const v2 = await spawnIncomingVehicle(db);
backdate(db, v2.id, 6);
const v2view = getVehicleView(db, v2.id);
const load = v2view.loads[0];
const claimed = new Set(v2view.loads.map(l => `${l.recSlotId}:${l.recStackNo}`));
const cands = listCandidates(db, load.spec, 1)
  .filter(c => c.free >= load.bundles && !claimed.has(`${c.slotId}:${c.stackNo}`));
assert(cands.length > 0, '存在可改垛的合法候选落点');
const target = cands[0];
const adj = adjustLoad(db, v2.id, load.id, target.slotId, target.stackNo);
assert(!adj.error, `人工改垛成功（${target.code} 第${target.stackNo}垛）${adj.error ? '：' + adj.error : ''}`);
const hit2 = autoConfirmExpired(db).find(x => x.id === v2.id);
assert(hit2 && !hit2.error, '超时后按人工调整方案自动确认');
const v2after = getVehicleView(db, v2.id);
assert(v2after.state === 'confirmed' && v2after.loads[0].slotId === target.slotId && v2after.loads[0].adjusted,
  '自动确认保留人工调整的最终落点');
const fb = db.prepare('SELECT action FROM placement_feedback WHERE vehicle_id=?').all(v2.id);
assert(fb.length === v2after.loads.length && fb.some(f => f.action === 'adjusted'), '确认留痕完整（含 adjusted 组供权重学习）');

/* ---- 无合法落点：确认失败保持待确认 ---- */
const t = new Date(Date.now() - 6 * 60000).toISOString();
db.prepare("INSERT INTO inbound_vehicles (plate, waybill, mill, arrive_time, state) VALUES ('测A·00000', 'YD26-00001', '测试厂', ?, 'pending')").run(t);
const hit3 = autoConfirmExpired(db);
assert(hit3.length === 1 && hit3[0].error, '无垛位分配的超时车确认失败并返回原因（保持待确认等人工处理）');

/* ---- 参数置 0：整体关闭 ---- */
setSimParams(db, { production: { autoConfirmMin: 0 } });
const v4 = await spawnIncomingVehicle(db);
backdate(db, v4.id, 60);
assert(autoConfirmExpired(db).length === 0, 'autoConfirmMin=0 时超时自动确认关闭');
assert(getVehicleView(db, v4.id).state === 'pending', '关闭后超时车辆保持待确认');
assert(clampGuard(), '超时参数按 schema 夹取（120 -> 60 分钟）');
function clampGuard() {
  const after = setSimParams(db, { production: { autoConfirmMin: 120 } }).production.autoConfirmMin;
  return after === 60;
}

console.log(`\n全部通过：${n} 项断言（进厂确认超时自动确认）`);
