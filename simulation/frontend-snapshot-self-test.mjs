// 操作端快照接口自检（P1 打通）：临时库 + 临时端口拉起 server/index.js，验证
//   1) GET /api/frontend/snapshot 轻量快照形状：91 库位（含垛行/垛数）、规格表、在厂车辆、
//      汇总口径（库容/占用/吨位）、P2 占位字段（cranes/dogs/kpiToday）不缺字段
//   2) ?with=bundles 附带捆级明细，与垛行 count 口径一致（期初刚 reset 时二者同源）
//   3) rev 修订号：写库存（PUT /api/slots/:id/stacks/:n）后 rev 变化——前端据此决定重拉捆级明细
//   4) 快照垛位编码与前端 warehouse.ts 同源（'区-跨' 形如 8-2，通道列不出库位）
// 用法：node simulation/frontend-snapshot-self-test.mjs（端口 3312，与 npm run sim 并行运行会端口冲突）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'fe-snap-'));
process.env.WAREHOUSE_DB = join(tmp, 't.db');
process.env.PORT = '3312';

const { startServer } = await import('../server/index.js');
const server = await startServer();
const API = 'http://127.0.0.1:3312';

let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
};

// 0) 灌期初库存
const reset = await (await fetch(`${API}/api/reset`, { method: 'POST' })).json();
check('POST /api/reset 灌库成功', reset.slotCount === 91, String(reset.slotCount));

// 1) 轻量快照形状
const snap = await (await fetch(`${API}/api/frontend/snapshot`)).json();
check('snapshot 返回 91 库位', snap.slots.length === 91, String(snap.slots?.length));
check('库位含编码/分区/区号/跨号/垛数与垛行', snap.slots.every(s =>
  typeof s.code === 'string' && typeof s.zone === 'string' && typeof s.area === 'number'
  && typeof s.span === 'number' && s.racks >= 1 && Array.isArray(s.stacks)
  && s.stacks.every(k => typeof k.stack_no === 'number' && typeof k.count === 'number')));
check('垛位编码「区-序号」/整跨合并 形态（与前端 warehouse.ts 同源）',
  snap.slots.every(s => s.merged ? /^\d+$/.test(s.code) : /^\d+-\d+$/.test(s.code))
  && new Set(snap.slots.map(s => s.code)).size === 91,
  snap.slots.slice(0, 3).map(s => s.code).join(','));
check('规格表 10 条含基准吨位', snap.specs.length === 10 && snap.specs.every(x => x.weight > 0 && x.color));
check('容量参数（全局垛数/每垛上限）', snap.capacity.globalStacksPerSlot >= 1 && snap.capacity.bundlesPerStack >= 1,
  `${snap.capacity.globalStacksPerSlot}×${snap.capacity.bundlesPerStack}`);
check('汇总含库容/占用/吨位', snap.inventory.totalBundles > 3000 && snap.inventory.totalCapacity > 0
  && snap.inventory.occupiedSlots >= 0 && snap.inventory.totalTons > 0,
  `${snap.inventory.totalBundles} 捆 / ${snap.inventory.totalTons} 吨 / 占用 ${snap.inventory.occupiedSlots}`);
check('P2 占位字段存在（cranes/dogs/kpiToday）', Array.isArray(snap.cranes) && Array.isArray(snap.dogs) && snap.kpiToday === null);
check('rev 修订号存在', Number.isFinite(snap.rev), String(snap.rev));
check('轻量快照不含捆级明细', !('bundles' in snap));

// 2) spawn 后快照车辆视图（推荐码表字段齐）
const sp = await (await fetch(`${API}/api/inbound/spawn`, { method: 'POST' })).json();
const snap2 = await (await fetch(`${API}/api/frontend/snapshot`)).json();
const v = snap2.vehicles.find(x => x.id === sp.id);
check('spawn 后快照含该车辆且视图完整', !!v && v.plate === sp.plate && v.loads.length >= 1
  && v.loads.every(l => typeof l.recCode === 'string' && l.recScore >= 0), v ? `${v.plate} ${v.state}` : 'null');
check('spawn 写路径 bump rev', snap2.rev !== snap.rev, `${snap.rev} -> ${snap2.rev}`);

// 2b) 沙盘本地车登记：注册即入确认队列（含推荐）；按车牌+运单去重；非法入参 400
const reg = await (await fetch(`${API}/api/inbound/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ plate: '豫A·88888', waybill: 'YD26-88888', mill: 'E2E钢厂', groups: [{ spec: '圆钢 Φ60', bundles: 5 }] }),
})).json();
check('register 登记本地进厂车（pending + 推荐）', reg.id > 0 && reg.state === 'pending' && reg.loads.length >= 1
  && reg.loads.every(l => l.recCode && l.recStackNo >= 1), reg.plate);
const reg2 = await (await fetch(`${API}/api/inbound/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ plate: '豫A·88888', waybill: 'YD26-88888', groups: [{ spec: '圆钢 Φ60', bundles: 5 }] }),
})).json();
check('register 同车牌+运单去重（返回原车）', reg2.id === reg.id, `${reg2.id} == ${reg.id}`);
const regBad = await fetch(`${API}/api/inbound/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ plate: 'X' }),
});
check('register 非法入参 400', regBad.status === 400, `status=${regBad.status}`);

// 3) 捆级明细：reset 后 bundle_positions 为空（沙盘期初对齐前的真实状态），
//    此处模拟沙盘对首库位做捆级对齐（POST /api/positions upserts），再验证快照明细口径
check('新库捆级表为空（bundleRows=0，吨位为估算）', snap.inventory.bundleRows === 0,
  String(snap.inventory.bundleRows));
const slotA = snap.slots.find(s => s.stacks.some(k => k.count > 0));
const upserts = [];
let bn = 0;
for (const k of slotA.stacks.filter(k => k.count > 0)) {
  for (let i = 0; i < k.count; i++) {
    upserts.push({ bundleId: `T-${slotA.code}-${k.stack_no}-${i}`, slotId: slotA.id, stackNo: k.stack_no,
      layer: i % 6, seat: (i / 6) | 0, spec: k.spec, len: 9, putTime: -1 });
    bn++;
  }
}
const push = await (await fetch(`${API}/api/positions`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ upserts }),
})).json();
check('POST /api/positions 捆级对齐写入', push.upserted === bn, `${push.upserted}/${bn}`);
const full = await (await fetch(`${API}/api/frontend/snapshot?with=bundles`)).json();
check('?with=bundles 返回捆级明细', Array.isArray(full.bundles) && full.bundles.length === bn,
  `${full.bundles?.length}/${bn}`);
check('捆行含 捆号/库位/垛/层座/规格/时刻', full.bundles.every(b =>
  typeof b.bundleId === 'string' && typeof b.slotId === 'number' && typeof b.stackNo === 'number'
  && typeof b.spec === 'string' && typeof b.putTime === 'number'));
const nA = full.bundles.filter(b => b.slotId === slotA.id).length;
check('首库位捆数与垛行 count 一致', nA === slotA.stacks.reduce((t, k) => t + k.count, 0),
  `${nA}/${slotA.stacks.reduce((t, k) => t + k.count, 0)}`);

// 4) 写库存后 rev 变化（前端重拉捆级明细的信号）
const slot0 = snap.slots[0];
const st0 = slot0.stacks.find(k => k.count === 0) || slot0.stacks[0];
const before = full.rev;
await fetch(`${API}/api/slots/${slot0.id}/stacks/${st0.stack_no}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(st0.count === 0 ? { spec: snap.specs[0].name, count: 3 } : { count: st0.count + 1 }),
});
const snap3 = await (await fetch(`${API}/api/frontend/snapshot`)).json();
check('PUT 垛行后 bump rev', snap3.rev !== before, `${before} -> ${snap3.rev}`);

// 5) 只读路径不 bump rev（连续两次快照 rev 稳定）
const again = await (await fetch(`${API}/api/frontend/snapshot`)).json();
check('只读快照 rev 稳定', again.rev === snap3.rev, `${snap3.rev} == ${again.rev}`);

// ---- P2：事件流（游标协议）----
const post = (path, body) => fetch(`${API}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
const ev1 = await post('/api/events', { events: [
  { type: 'log', payload: { cat: 'crane', msg: '自检事件1' } },
  { type: 'alarm.raise', payload: { alarmId: 'BJ-S9001', type: '识别失败', desc: '自检' } },
] });
check('POST /api/events 批量回推', (await ev1.json()).appended === 2);
const cur = await (await fetch(`${API}/api/events?after=0&limit=10`)).json();
check('GET /api/events 游标拉取按 seq 升序', cur.events.length >= 2 &&
  cur.events.every((e, i, a) => i === 0 || e.seq > a[i - 1].seq) &&
  cur.events.slice(-2).every(e => e.type === 'log' || e.type === 'alarm.raise'));
const afterSeq = cur.events[cur.events.length - 1].seq;
const none = await (await fetch(`${API}/api/events?after=${afterSeq}&limit=10`)).json();
check('游标增量：消费后无重复', none.events.length === 0, String(none.events.length));
const latest = await (await fetch(`${API}/api/events?latest=1`)).json();
check('latest 游标 = 最大 seq', latest.seq === afterSeq, `${latest.seq} == ${afterSeq}`);
const evp = JSON.parse(JSON.stringify(cur.events.find(e => e.type === 'alarm.raise')));
check('事件 payload 已反序列化为对象', evp.payload && evp.payload.alarmId === 'BJ-S9001');

// ---- P2：遥测（内存驻留 + 快照携带 + 10s 失效 + v1 旧格式拒绝）----
await post('/api/telemetry', { cranes: [{ name: 'TC-A1', span: 0, x: 100.5, y: 17, state: 'MOVE_PICK' }], dogs: [{ id: 'D-01', name: '疾风', state: 'SCAN', battery: 80, x: 12.5, y: 1 }] });
const tsnap = await (await fetch(`${API}/api/frontend/snapshot`)).json();
check('遥测写入后快照携带天车/机器狗', tsnap.cranes.length === 1 && tsnap.cranes[0].name === 'TC-A1'
  && tsnap.dogs.length === 1 && tsnap.dogs[0].battery === 80 && tsnap.dogs[0].x === 12.5 && !!tsnap.telemetryAt);
await post('/api/telemetry', { cranes: [{ name: 'TC-OLD', span: 0, x: 1, y: 1, state: 'IDLE' }], dogs: [{ id: 'D-9', name: '旧版', state: 'IDLE', battery: 50 }] });
const tsnap2 = await (await fetch(`${API}/api/slots`)).json();   // 触发一次别的读，确保旧推送已被处理过
const tguard = await (await fetch(`${API}/api/frontend/snapshot`)).json();
check('v1 旧格式遥测被拒绝（不覆盖新引擎数据）', tguard.cranes[0].name === 'TC-A1' && tguard.cranes.length === 1);

// ---- P3：命令通道（写入 → 认领 → 回写带事件）----
const cmd = await (await post('/api/frontend/commands', { kind: 'alarm-handled', refId: 'BJ-S9001', payload: { method: '清洁二维码' } })).json();
check('POST /api/frontend/commands 写入', cmd.id > 0 && cmd.status === 'pending' && cmd.refId === 'BJ-S9001');
const claimed = await (await fetch(`${API}/api/frontend/commands?claim=1&limit=5`)).json();
check('沙盘认领（claim 原子置 claimed）', claimed.commands.length === 1 && claimed.commands[0].id === cmd.id
  && claimed.commands[0].status === 'claimed');
const reClaim = await (await fetch(`${API}/api/frontend/commands?claim=1&limit=5`)).json();
check('二次轮询不再重复发放（多实例防重）', reClaim.commands.length === 0, String(reClaim.commands.length));
const fin = await (await post(`/api/frontend/commands/${cmd.id}/finish`, { ok: true, result: { note: 'done' }, events: [{ type: 'alarm.closed', payload: { alarmId: 'BJ-S9001' } }] })).json();
check('finish 回写 done + 附带事件落表', fin.status === 'done' && fin.result.note === 'done');
const closed = await (await fetch(`${API}/api/events?after=${afterSeq}&limit=10`)).json();
check('finish 附带事件可被游标拉到', closed.events.some(e => e.type === 'alarm.closed' && e.payload?.alarmId === 'BJ-S9001'));
const badFin = await fetch(`${API}/api/frontend/commands/999999/finish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
check('finish 不存在的命令返回 404', badFin.status === 404, `status=${badFin.status}`);

await new Promise(r => server.close(r));
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* WAL 句柄未释放时 Windows 上可能 EPERM，留临时目录无碍 */ }
console.log(failed ? `\n✗ ${failed} 项未通过` : '\n✓ 全部通过：操作端快照接口自检');
process.exit(failed ? 1 : 0);
