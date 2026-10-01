// 无头自检：物流源自动进厂轮询（pollInboundFromSource）——「进厂确认/车辆记录」与三维仿真的同源同步。
// 验证：后台轮询把物流源进厂车事件登记为待确认车辆（出厂事件不进队列）；流尾幂等；
//       事件流重置重放按 车牌+运单 去重不重复入账；与「模拟车辆进厂」按钮共用游标互不重复；
//       自动进厂车确认后可被沙盘 /api/inbound/match 逻辑（matchConfirmedVehicle）按车牌+运单命中。
// 用法：node simulation/inbound-feed-sync-self-test.mjs
process.env.LOGI_API = 'http://127.0.0.1:5288';   // 地址任意：fetch 被本文件替换为物流源桩，不发真实请求
const { openDb, seed } = await import('../server/database.js');
const {
  spawnIncomingVehicle, pollInboundFromSource, confirmVehicle, matchConfirmedVehicle,
} = await import('../server/inbound.js');
const { makeFeedFetch } = await import('./feed-stub.mjs');

let n = 0;
const assert = (cond, msg) => {
  if (!cond) { console.error(`✗ ${msg}`); process.exit(1); }
  console.log(`✓ ${msg}`); n++;
};

// 恒定源时钟：不自排产，事件全部由剧本注入（确定性断言）
const feed = makeFeedFetch(() => 0);
globalThis.fetch = feed;   // inbound.js 走全局 fetch —— 指向桩即整链路无头可测

const db = openDb(':memory:');
seed(db);
const vehCount = () => db.prepare('SELECT COUNT(*) c FROM inbound_vehicles').get().c;
const feedCursor = () => db.prepare('SELECT seq FROM feed_cursors WHERE consumer=?').get('inbound-confirm').seq;
const injectIn = (plate, waybill, manifest) =>
  feed.inject('in', { plate, waybill, mill: '首钢迁安', manifest });

/* ---- 自动进厂：事件 1:1 登记为待确认车辆 ---- */
injectIn('冀A·80001', 'YD26-80001', [{ spec: '螺纹钢 Φ20', bundles: 6 }]);
feed.inject('out', { orderNo: 'L26-80001', spec: '螺纹钢 Φ25', bundles: 5 });   // 出厂事件：不进确认队列
injectIn('冀A·80002', 'YD26-80002', [{ spec: '管材 Φ200', bundles: 5 }]);
injectIn('冀A·80003', 'YD26-80003', [{ spec: '圆钢 Φ50', bundles: 3 }, { spec: '方钢 40×40', bundles: 3 }]);
assert(await pollInboundFromSource(db) === 3, '一次轮询把流上 3 辆进厂车全部登记（出厂事件跳过）');
assert(vehCount() === 3, '台账共 3 辆（出厂事件未产生车辆记录）');
assert(feedCursor() === 4, '游标推进到流尾（seq=4）');
const rows = db.prepare('SELECT plate, waybill, state FROM inbound_vehicles ORDER BY id').all();
assert(rows.every(r => r.state === 'pending'), '自动进厂车均为待确认（等管理工核对/超时放行）');
assert(rows[2].waybill === 'YD26-80003', '登记顺序与事件流一致');

/* ---- 流尾幂等：重复轮询不重复入账 ---- */
assert(await pollInboundFromSource(db) === 0, '流尾再轮询：无新增');
assert(vehCount() === 3, '台账不变（幂等）');

/* ---- 单次调用上限（cap）：事件积压时分批消费，不阻塞 ---- */
for (let i = 10; i < 20; i++) injectIn(`冀A·8${String(i).padStart(4, '0')}`, `YD26-8${String(i).padStart(4, '0')}`, [{ spec: '螺纹钢 Φ25', bundles: 4 }]);
assert(await pollInboundFromSource(db) === 8, '积压 10 辆时单次轮询最多消费 8 条（cap 防阻塞）');
assert(await pollInboundFromSource(db) === 2, '下轮轮询消费余量');
assert(vehCount() === 13, '积压事件全部补齐入账');

/* ---- 事件流重置重放：按 车牌+运单 去重，不产生重复台账 ---- */
feed.resetStream();
injectIn('冀A·80001', 'YD26-80001', [{ spec: '螺纹钢 Φ20', bundles: 6 }]);   // 重放同车牌+运单
injectIn('冀A·80002', 'YD26-80002', [{ spec: '管材 Φ200', bundles: 5 }]);
assert(await pollInboundFromSource(db) === 0, '重放已入账事件：全部去重跳过（0 新增）');
assert(vehCount() === 13, '数据源重置重放不产生重复车辆');

/* ---- 与「模拟车辆进厂」按钮共用游标：互不重复 ---- */
let r = await spawnIncomingVehicle(db);
assert(r && r.error, `流已消费完：手动进厂明确报错而非重复入账（${r && r.error ? '源暂无待处理车辆' : '异常'}）`);
injectIn('冀A·80030', 'YD26-80030', [{ spec: '螺纹钢 Φ20', bundles: 6 }]);
r = await spawnIncomingVehicle(db);
assert(r && r.id && String(r.source || '').startsWith('logistics:'), '手动进厂取到物流源下一辆车（与轮询同游标衔接）');
assert(db.prepare('SELECT COUNT(*) c FROM inbound_vehicles WHERE waybill=?').get('YD26-80030').c === 1, '手动进厂登记且不与轮询重复');

/* ---- 确认单联动：自动进厂车确认后可被沙盘按车牌+运单命中 ---- */
const first = db.prepare('SELECT id, plate, waybill FROM inbound_vehicles ORDER BY id LIMIT 1').get();
const cf = confirmVehicle(db, first.id);
assert(!cf.error, '自动进厂车确认下发成功');
const m = matchConfirmedVehicle(db, first.plate, first.waybill);
assert(m && m.id === first.id && Array.isArray(m.loads) && m.loads.length, '沙盘按车牌+运单命中已确认分配单（确认单 -> 沙盘执行闭环）');
assert(matchConfirmedVehicle(db, '冀A·80002', 'YD26-80002') === null, '未确认车辆不命中（沙盘回退自身推荐）');

console.log(`\n全部通过：${n} 项断言（物流源自动进厂同步）`);
