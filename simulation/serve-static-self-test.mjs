// 静态站 + 库存数据库 API 自检：临时库 + 临时端口拉起两端，验证
//   1) 库存/库位 API 形状（getSlots 归并查询）、进厂确认全流程（spawn->改垛->确认）、
//      主应用任务接口（createTask/updateTaskStatus 返回单任务视图）
//   2) 静态文件服务：brotli/gzip 内容协商压缩、ETag/304 协商缓存、原文回退、路径穿越拦截
// 用法：node simulation/serve-static-self-test.mjs（端口 3311/5998，与 npm run sim 并行运行会端口冲突）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.WAREHOUSE_DB = join(mkdtempSync(join(tmpdir(), 'opt-verify-')), 't.db');
process.env.PORT = '3311';
process.env.SIM_PORT = '5998';

const { startServer } = await import('../server/index.js');
await startServer();
const API = 'http://127.0.0.1:3311';

let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
};

// 0) 临时库先灌初始库存（正式流程为 npm run db:init，这里走等价的 /api/reset）
const reset = await (await fetch(`${API}/api/reset`, { method: 'POST' })).json();
check('POST /api/reset 灌库成功', reset.slotCount === 91, String(reset.slotCount));

// 1) /api/slots 形状与排序不变（getSlots 重写）
const slots = (await (await fetch(`${API}/api/slots`)).json()).slots;
check('GET /api/slots 返回 91 库位', slots.length === 91, String(slots.length));
check('每库位 8 垛且按 stack_no 升序',
  slots.every(s => s.stacks.length === 8 && s.stacks.every((k, i) => k.stack_no === i + 1)));
const inv = await (await fetch(`${API}/api/inventory`)).json();
check('GET /api/inventory 正常', inv.slotCount === 91 && inv.totalBundles > 3000, `${inv.totalBundles} 捆`);

// 2) spawn -> 车辆列表 -> 改垛 -> 确认（getVehicleView/码表复用路径）
const sp = await (await fetch(`${API}/api/inbound/spawn`, { method: 'POST' })).json();
check('POST /api/inbound/spawn 生成车辆', !!sp.id && sp.loads.length >= 1, sp.plate);
check('spawn 视图含推荐码表字段', sp.loads.every(l => typeof l.recCode === 'string' && l.recScore >= 0));
const veh = await (await fetch(`${API}/api/vehicles?limit=10`)).json();
check('GET /api/vehicles 分页/总数一致', veh.vehicles.length >= 1 && veh.total >= veh.vehicles.length,
  `${veh.vehicles.length}/${veh.total}`);
check('/api/vehicles 视图与单车视图一致',
  JSON.stringify(veh.vehicles.find(v => v.id === sp.id)) === JSON.stringify({ ...sp, source: undefined }));
const adj = await (await fetch(`${API}/api/inbound/${sp.id}/loads/${sp.loads[0].id}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ slotId: sp.loads[0].recSlotId, stackNo: sp.loads[0].recStackNo }),
})).json();
check('PUT 改垛（原落点重设）成功', !adj.error, adj.error || '');
const cf = await (await fetch(`${API}/api/inbound/${sp.id}`, { method: 'POST' })).json();
check('POST 确认下发成功', !cf.error && cf.vehicle.state === 'confirmed', cf.error || '');

// 2.5) 确认单 -> 沙盘执行闭环：match 查询 + 卸毕回传 + 口径对齐 + seed 变体
const hit = await (await fetch(`${API}/api/inbound/match?plate=${encodeURIComponent(sp.plate)}&waybill=${encodeURIComponent(sp.waybill)}`)).json();
check('match 按车牌+运单命中已确认分配单', hit && hit.id === sp.id && hit.state === 'confirmed'
  && hit.loads.every(l => l.recCode && l.recStackNo >= 1), hit ? `#${hit.id}` : 'null');
const miss = await (await fetch(`${API}/api/inbound/match?plate=${encodeURIComponent('冀Z·00000')}&waybill=NONE`)).json();
check('match 未命中返回 null（沙盘回退本地推荐）', miss === null, JSON.stringify(miss));
const unl = await (await fetch(`${API}/api/inbound/${sp.id}/unload`, { method: 'POST' })).json();
check('卸毕回传：confirmed -> completed + departed_time',
  !unl.error && unl.vehicle.state === 'completed' && !!unl.vehicle.departedTime,
  JSON.stringify(unl).slice(0, 100));
const vehDone = await (await fetch(`${API}/api/vehicles?state=completed`)).json();
check('车辆记录可按 completed 筛选', vehDone.vehicles.some(v => v.id === sp.id), `total=${vehDone.total}`);
const reUnl = await (await fetch(`${API}/api/inbound/${sp.id}/unload`, { method: 'POST' })).json();
check('重复回传幂等（不重复记时）', !reUnl.error && reUnl.vehicle.departedTime === unl.vehicle.departedTime, '');

const cands600 = await (await fetch(`${API}/api/inbound/candidates?spec=${encodeURIComponent('管材 Φ600')}&bundles=1`)).json();
check('Φ600 候选余量 ≤ 12（物理垛容口径与沙盘一致）',
  cands600.candidates.length > 0 && cands600.candidates.every(c => c.free <= 12),
  cands600.candidates.length ? `maxFree=${Math.max(...cands600.candidates.map(c => c.free))}` : '无候选');
const seedSlots = await (await fetch(`${API}/api/slots?variant=seed`)).json();
check('seed 变体：91 库位 × 8 垛，形状与 /api/slots 一致',
  seedSlots.slots.length === 91 && seedSlots.slots.every(s => s.stacks.length === 8)
  && seedSlots.slots.every((s, i) => s.code === slots[i].code),
  `${seedSlots.slots.length} 库位`);
check('seed 分布 Φ200 ≤ 130、Φ400 ≤ 30、Φ600 ≤ 12（单支管限高收窄）',
  seedSlots.slots.flatMap(s => s.stacks).every(k => !k.spec || !['管材 Φ200', '管材 Φ400', '管材 Φ600'].includes(k.spec)
    || k.count <= ({ '管材 Φ200': 130, '管材 Φ400': 30, '管材 Φ600': 12 })[k.spec]),
  '');
await fetch(`${API}/api/params`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ values: { robot: { spanB: 0, spanC: 0 } } }) });
const mc = await (await fetch(`${API}/api/inbound/candidates?spec=${encodeURIComponent('螺纹钢 Φ20')}&bundles=1`)).json();
check('监测范围受限：服务端候选全部落在监测跨（A 跨或整跨合并位）',
  mc.candidates.length > 0 && mc.candidates.every(c => c.span === 0 || c.merged),
  `n=${mc.candidates.length} spans=[${[...new Set(mc.candidates.map(c => c.span))].join(',')}]`);
await fetch(`${API}/api/params`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ values: { robot: { spanB: 1, spanC: 1 } } }) });   // 恢复默认

// 3) 主应用任务接口（createTask/updateTaskStatus 单行映射路径）
const coil = (await (await fetch(`${API}/api/app/data`)).json())?.coils?.[0];
const tk = await (await fetch(`${API}/api/app/tasks`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: 'T-OPT-1', type: 'transfer', steelCoilId: coil.id }),
})).json();
check('POST /api/app/tasks 返回任务视图', tk && tk.id === 'T-OPT-1' && tk.status === 'pending' && tk.createTime, JSON.stringify(tk).slice(0, 80));
const tk2 = await (await fetch(`${API}/api/app/tasks/T-OPT-1`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ status: 'completed' }),
})).json();
check('PUT 任务状态返回 completeTime', tk2 && tk2.status === 'completed' && tk2.completeTime, JSON.stringify(tk2).slice(0, 80));

// 4) 静态站：压缩 + 304（serve.mjs；其内部再起 DB 服务会撞已占端口，仅告警不影响）
await import('./serve.mjs');
const SIM = 'http://127.0.0.1:5998';
const r1 = await fetch(`${SIM}/3d`, { headers: { 'Accept-Encoding': 'br' } });
const brLen = Number(r1.headers.get('content-length'));
check('沙盘 3D 页 brotli 压缩生效', r1.headers.get('content-encoding') === 'br', `${brLen} B`);
const etag = r1.headers.get('etag');
const r2 = await fetch(`${SIM}/3d`, { headers: { 'Accept-Encoding': 'br', 'If-None-Match': etag } });
check('ETag 命中返回 304', r2.status === 304, `status=${r2.status}`);
const r3 = await fetch(`${SIM}/`, { headers: { 'Accept-Encoding': '' } });
const page = await r3.text();
check('未带压缩头时返回原文且页面完整', page.includes('</html>'), page.length + ' 字符');
const r4 = await fetch(`${SIM}/../server/index.js`);
check('目录穿越仍被拦截', r4.status === 403 || r4.status === 404, `status=${r4.status}`);

console.log(failed === 0 ? '\n回归验证通过 ✓' : `\n${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
