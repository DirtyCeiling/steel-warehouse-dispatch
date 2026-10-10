// 多平板数据同步自检（2026-10-08 双平板不同步修复的回归测试）：临时库 + 临时端口拉起
// server/index.js，模拟「平板A操作 → 平板B 拉快照/事件流」的双端视角，断言全端收敛一致：
//   1) 入库核验（verify）：A 核验 → B 快照见 verified（已核验）+ 事件流有 inbound.verified
//   2) 入库推送（confirm）：A 推送 → B 快照见 confirmed（已规划）+ 事件流有 inbound.confirmed
//   3) 幂等：重复核验/确认返回既定错误（平板端 api 层静默跳过的依据）
//   4) 平板报警直达事件流：上报/重复上报幂等/关闭，事件可被 B 消费（source=tablet）
//   5) 倒垛单落库：生成（编辑中）→ 下发（已下发）→ 快照全端可见；sim.reset 清未完成计划
//   6) 组内置顶跨端同步：queue 接口带 pinnedLoadId → 车辆视图 loads 携带 pinned
//   7) 遥测 lockedSlots：沙盘上报作业锁定库位 → 快照携带（「作业中」视觉服务端权威）
//   8) 出库确定命令通道：outbound-confirm 命令可写入（沙盘认领后广播 outbound.confirmed）
// 用法：node simulation/multi-tablet-sync-self-test.mjs（端口 3313）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'mt-sync-'));
process.env.WAREHOUSE_DB = join(tmp, 't.db');
process.env.PORT = '3313';

const { startServer } = await import('../server/index.js');
const server = await startServer();
const API = 'http://127.0.0.1:3313';

let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
};
const j = (r) => r.json();

// 双端消费原语：平板B的视角 = 快照 + 事件游标
const snapB = async () => (await fetch(`${API}/api/frontend/snapshot`)).json();
const eventsB = async (after) =>
  (await (await fetch(`${API}/api/events?after=${after}&limit=200`)).json()).events;

// 0) 灌期初
await fetch(`${API}/api/reset`, { method: 'POST' });

// 1) 平板A核验 → 平板B同步「已核验」
const sp = await (await fetch(`${API}/api/inbound/spawn`, { method: 'POST' })).json();
const vehId = sp.vehicle?.id ?? sp.id;
check('平板A登记进厂车', vehId != null, `vehId=${vehId}`);
const rv = await (await fetch(`${API}/api/inbound/${vehId}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
check('平板A核验成功（pending→verified）', rv.vehicle?.state === 'verified', rv.vehicle?.state ?? rv.error);
let s1 = await snapB();
check('平板B快照见 verified（已核验）', s1.vehicles.find((v) => v.id === vehId)?.state === 'verified',
  s1.vehicles.find((v) => v.id === vehId)?.state);
const ev1 = await eventsB(0);
check('平板B事件流收到 inbound.verified', ev1.some((e) => e.type === 'inbound.verified' && e.payload?.vehId === vehId));
const rv2 = await (await fetch(`${API}/api/inbound/${vehId}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
check('重复核验幂等（返回「该车已核验」）', rv2.error === '该车已核验', rv2.error);

// 2) 平板A推送 → 平板B同步「已规划」
const rc = await (await fetch(`${API}/api/inbound/${vehId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
check('平板A推送确认成功（verified→confirmed）', rc.vehicle?.state === 'confirmed', rc.vehicle?.state ?? rc.error);
const s2 = await snapB();
check('平板B快照见 confirmed（已规划）', s2.vehicles.find((v) => v.id === vehId)?.state === 'confirmed',
  s2.vehicles.find((v) => v.id === vehId)?.state);
const ev2 = await eventsB(0);
check('平板B事件流收到 inbound.confirmed', ev2.some((e) => e.type === 'inbound.confirmed' && e.payload?.vehId === vehId));
const rc2 = await (await fetch(`${API}/api/inbound/${vehId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
check('重复推送幂等（返回「该车已确认」）', rc2.error === '该车已确认', rc2.error);

// 3) verified 后改垛仍可调（推送前窗口）与推送后拒绝——守卫口径
const v2 = await (await fetch(`${API}/api/inbound/spawn`, { method: 'POST' })).json();
const vehId2 = v2.vehicle?.id ?? v2.id;
await fetch(`${API}/api/inbound/${vehId2}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const loads2 = (await (await fetch(`${API}/api/inbound`)).json()).vehicles.find((v) => v.id === vehId2)?.loads ?? [];
const cand = (await (await fetch(`${API}/api/inbound/candidates?spec=${encodeURIComponent(loads2[0]?.spec ?? '')}&bundles=1`)).json()).candidates?.[0];
if (cand) {
  const adj = await (await fetch(`${API}/api/inbound/${vehId2}/loads/${loads2[0].id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slotId: cand.slotId, stackNo: cand.stackNo }),
  })).json();
  check('已核验（未推送）仍可改垛', !adj.error, adj.error ?? `${cand.code}#${cand.stackNo}`);
} else {
  check('已核验（未推送）仍可改垛', true, '（无候选库位，跳过）');
}
await fetch(`${API}/api/inbound/${vehId2}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
const adjAfter = await (await fetch(`${API}/api/inbound/${vehId2}/loads/${loads2[0]?.id ?? 0}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ slotId: cand?.slotId ?? 1, stackNo: cand?.stackNo ?? 1 }),
})).json();
check('推送后改垛被拒（跨端口径不变）', !!adjAfter.error, adjAfter.error);

// 4) 平板报警直达事件流
const alarmId = 'BJ-TTEST01';
const ra = await (await fetch(`${API}/api/frontend/alarms`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ alarmId, type: '账实差异', slot: '8-2', desc: '平板上报测试', level: '中' }),
})).json();
check('平板报警上报成功', ra.ok === true, JSON.stringify(ra));
const ra2 = await (await fetch(`${API}/api/frontend/alarms`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ alarmId, type: '账实差异', slot: '8-2', desc: '平板上报测试', level: '中' }),
})).json();
check('重复上报幂等（skipped=duplicate）', ra2.ok === true && ra2.skipped === 'duplicate', JSON.stringify(ra2));
const ev3 = await eventsB(0);
const raiseEv = ev3.filter((e) => e.type === 'alarm.raise' && e.payload?.alarmId === alarmId);
check('平板B事件流收到 alarm.raise（source=tablet）仅一条', raiseEv.length === 1 && raiseEv[0].payload?.source === 'tablet');
const rcl = await (await fetch(`${API}/api/frontend/alarms/${alarmId}/close`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ method: '现场处置' }),
})).json();
check('平板报警关闭成功', rcl.ok === true);
const ev4 = await eventsB(0);
check('平板B事件流收到 alarm.closed', ev4.some((e) => e.type === 'alarm.closed' && e.payload?.alarmId === alarmId));
const badType = await (await fetch(`${API}/api/frontend/alarms`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ alarmId: 'BJ-TTEST02', type: '不存在类型' }),
})).json();
check('非法报警类型被拒', !!badType.error, badType.error);

// 5) 倒垛单落库（生成/下发/重置清场）
const planA = { id: 'DD-M1', source: '8-2', items: [{ qrCode: 'B-0001', grade: '螺纹钢', spec: 'Φ20', orderStatus: '未配单' }], recommend: '测试计划', target: '8-3', forbidden: [], status: '编辑中' };
const rp1 = await (await fetch(`${API}/api/frontend/restack-plans`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(planA),
})).json();
check('倒垛单生成落库', rp1.ok === true && rp1.plan?.status === '编辑中', JSON.stringify(rp1.plan?.status));
let s5 = await snapB();
check('平板B快照见倒垛单（编辑中）', s5.restackPlans?.some((p) => p.id === 'DD-M1' && p.status === '编辑中'));
const rp2 = await (await fetch(`${API}/api/frontend/restack-plans`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...planA, status: '已下发', target: '9-1', taskId: 'RW-RM1-01' }),
})).json();
check('倒垛单下发更新', rp2.plan?.status === '已下发' && rp2.plan?.target === '9-1');
s5 = await snapB();
check('平板B快照见倒垛单（已下发）', s5.restackPlans?.some((p) => p.id === 'DD-M1' && p.status === '已下发'));
// sim.reset（驾驶身份事件回推）→ 未完成倒垛单清场
await fetch(`${API}/api/events`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ driveId: 'test-drive-1', events: [{ type: 'sim.reset' }] }),
});
s5 = await snapB();
check('sim.reset 后未完成倒垛单清场', !(s5.restackPlans ?? []).some((p) => p.id === 'DD-M1'));
const badPlan = await (await fetch(`${API}/api/frontend/restack-plans`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'DD-X', status: '乱写' }),
})).json();
check('非法计划状态被拒', !!badPlan.error, badPlan.error);

// 6) 组内置顶跨端同步（pinnedLoadId）——register 构造确定性两组装载（随机 spawn 可能单组）
const sSpecs = (await snapB()).specs.map((x) => x.name).filter(Boolean);
const reg = await (await fetch(`${API}/api/inbound/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    plate: '冀B·SYNC1', waybill: 'YD26-SYNC01', mill: '测试钢厂',
    groups: [{ spec: sSpecs[0], bundles: 2 }, { spec: sSpecs[1], bundles: 2 }],
  }),
})).json();
const vehId3 = reg?.id;
const loads3 = (await (await fetch(`${API}/api/inbound`)).json()).vehicles.find((v) => v.id === vehId3)?.loads ?? [];
check('测试车装载 ≥2 组（置顶/调序可验）', loads3.length >= 2, `${loads3.length} 组`);
if (loads3.length >= 2) {
  const fullIds = loads3.map((l) => l.id);
  const q = await (await fetch(`${API}/api/inbound/${vehId3}/queue`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loadIds: [...fullIds].reverse(), pinnedLoadId: fullIds[1], pinnedBundleNo: 2 }),
  })).json();
  check('调序+置顶上报成功（捆级粒度）', q.ok === true);
  const v3view = (await (await fetch(`${API}/api/inbound`)).json()).vehicles.find((v) => v.id === vehId3);
  const pinnedLoad = v3view.loads.find((l) => l.pinned);
  check('车辆视图携带置顶捆位（单卡置顶：该装载内第 2 捆）',
    v3view.loads.filter((l) => l.pinned).length === 1 && pinnedLoad.id === fullIds[1] && pinnedLoad.pinnedBundle === 2,
    v3view.loads.map((l) => `${l.id}${l.pinned ? `*${l.pinnedBundle}` : ''}`).join(','));
  const s6 = await snapB();
  const v6 = s6.vehicles.find((v) => v.id === vehId3);
  check('平板B快照同显置顶捆位', v6?.loads?.filter((l) => l.pinned && l.pinnedBundle === 2).length === 1);
  const badPin = await (await fetch(`${API}/api/inbound/${vehId3}/queue`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loadIds: fullIds, pinnedLoadId: fullIds[0], pinnedBundleNo: 99 }),
  })).json();
  check('置顶捆号超出装载捆数被拒', !!badPin.error, badPin.error);
}

// 7) 遥测 lockedSlots（作业锁定库位 → 快照携带）
await fetch(`${API}/api/telemetry`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    driveId: 'test-drive-1', driveLabel: '自检',
    simStartTime: new Date().toISOString(),
    cranes: [{ name: 'TC-A1', span: 0, x: 10, y: 10, state: 'IDLE' }],
    dogs: [{ id: 'DOG-1', name: 'DOG-1', state: 'IDLE', battery: 90, x: 1, y: 1 }],
    trucks: [],
    lockedSlots: ['8-2', '8-3'],
  }),
});
const s7 = await snapB();
check('快照携带遥测 lockedSlots', Array.isArray(s7.lockedSlots) && s7.lockedSlots.join(',') === '8-2,8-3',
  s7.lockedSlots?.join(','));

// 8) 出库装车顺序/置顶落库（跨平板同步）
const oq1 = await (await fetch(`${API}/api/frontend/outbound-queue/CK-SYNC1`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ qrCodes: ['B-0003', 'B-0001', 'B-0002'], pinned: 'B-0003' }),
})).json();
check('出库装车序+置顶落库', oq1.ok === true);
const s8 = await snapB();
const row8 = (s8.outboundQueue ?? []).find((r) => r.orderNo === 'CK-SYNC1');
check('平板B快照见出库装车序与置顶捆号',
  row8 && row8.qrCodes.join(',') === 'B-0003,B-0001,B-0002' && row8.pinned === 'B-0003',
  JSON.stringify(row8));
const oq2 = await (await fetch(`${API}/api/frontend/outbound-queue/CK-SYNC1`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ qrCodes: ['B-0001', 'B-0002', 'B-0003'], pinned: null }),
})).json();
const s8b = await snapB();
const row8b = (s8b.outboundQueue ?? []).find((r) => r.orderNo === 'CK-SYNC1');
check('推送方覆写装车序并清除置顶（last-writer-wins）',
  oq2.ok === true && row8b && row8b.qrCodes.join(',') === 'B-0001,B-0002,B-0003' && !row8b.pinned,
  JSON.stringify(row8b));
const oqBad = await (await fetch(`${API}/api/frontend/outbound-queue/CK-BAD`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ qrCodes: [123] }),
})).json();
check('非法 qrCodes 被拒', !!oqBad.error, oqBad.error);

// 9) 出库确定命令通道
const oc = await (await fetch(`${API}/api/frontend/commands`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ kind: 'outbound-confirm', refId: 'CK-TEST1', payload: { plate: '冀A·TEST' } }),
})).json();
check('outbound-confirm 命令写入', oc.kind === 'outbound-confirm' && oc.status === 'pending', `id=${oc.id}`);
// 模拟沙盘认领（须持驾驶租约：先遥测帧占位，本测试 driveId=test-drive-1 已持有）
const claim = await (await fetch(`${API}/api/frontend/commands?claim=1&limit=5&drive=test-drive-1`)).json();
const mine = (claim.commands ?? []).find((c) => c.id === oc.id);
check('沙盘可认领 outbound-confirm', !!mine && mine.status === 'claimed');
if (mine) {
  const fin = await (await fetch(`${API}/api/frontend/commands/${oc.id}/finish`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driveId: 'test-drive-1', ok: true, events: [{ type: 'outbound.confirmed', payload: { orderNo: 'CK-TEST1', plate: '冀A·TEST' } }] }),
  })).json();
  check('执行回写 done + 广播 outbound.confirmed', fin.status === 'done');
  const ev8 = await eventsB(0);
  check('平板B事件流收到 outbound.confirmed', ev8.some((e) => e.type === 'outbound.confirmed' && e.payload?.orderNo === 'CK-TEST1'));
}

// 9) 超时自动确认也发事件（verified/pending 都在扫描范围）
//    —— 直接调用内部函数不可行（服务内闭包），此处以 DB 直改 arrive_time 回拨 + 等待 15s 扫描验证
const auto = await (await fetch(`${API}/api/inbound/spawn`, { method: 'POST' })).json();
const vehAuto = auto.vehicle?.id ?? auto.id;
await fetch(`${API}/api/params`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ production: { autoConfirmMin: 1 } }),
});
// better-sqlite3 直改 arrive_time（与 verify-closed-loop 同款手法）
const bs3 = (await import('better-sqlite3')).default;
const db = new bs3(process.env.WAREHOUSE_DB);
db.prepare('UPDATE inbound_vehicles SET arrive_time=? WHERE id=?').run(new Date(Date.now() - 61000).toISOString(), vehAuto);
db.close();
console.log('… arrive_time 已回拨 61s，等服务端 15s 扫描自动确认（最多 20s）');
await new Promise((r) => setTimeout(r, 20000));
const s9 = await snapB();
check('超时自动确认（pending→confirmed）', s9.vehicles.find((v) => v.id === vehAuto)?.state === 'confirmed',
  s9.vehicles.find((v) => v.id === vehAuto)?.state);
const ev9 = await eventsB(0);
check('自动确认也广播 inbound.confirmed（auto=true）',
  ev9.some((e) => e.type === 'inbound.confirmed' && e.payload?.vehId === vehAuto && e.payload?.auto === true));
await fetch(`${API}/api/params`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ production: { autoConfirmMin: 5 } }),
});

server.close();
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放：留给系统清理 */ }
console.log(failed ? `\n✗ ${failed} 项未通过` : '\n✓ 全部通过：多平板数据同步自检');
process.exit(failed ? 1 : 0);
