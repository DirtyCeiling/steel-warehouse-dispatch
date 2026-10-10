// 无头逻辑自检：验证「已出场车辆追溯」数据链——出库装车引发的倒垛事件（restack.done）
// 携带订单号/车牌/让位捆号（P10 已出场按车辆归集倒垛史的数据源头），以及出库订单事件、
// 车辆离场事件可被服务端事件保留窗口保护（不被日志洪流挤出，平板刷新重放可重建已出场留痕）。
// 桩掉 DOM/Canvas，在 Node VM 中运行"调度仿真沙盘.html"完整脚本，手动泵 rAF 帧驱动仿真。
// 用法：node simulation/exited-restack-self-test.mjs
import { readFileSync } from 'node:fs';
import { injectCoreSegs } from './sandbox-page-loader.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = injectCoreSegs(readFileSync(join(here, '调度仿真沙盘.html'), 'utf8'));
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];

const absorber = new Proxy(function () {}, {
  get(t, p) { if (p === Symbol.toPrimitive) return () => 0; return absorber; },
  set() { return true; },
  apply() { return absorber; },
});
const elements = new Map();
function makeEl(id = '') {
  return {
    id, textContent: '', innerHTML: '', className: '', checked: false, value: '', style: {},
    children: [],
    appendChild(ch) { this.children.push(ch); return ch; },
    removeChild(ch) { const i = this.children.indexOf(ch); if (i >= 0) this.children.splice(i, 1); return ch; },
    get firstChild() { return this.children[0]; },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1680, height: 980 }),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    clientWidth: 1680, clientHeight: 620, scrollTop: 0, scrollHeight: 0,
  };
}
const documentStub = {
  visibilityState: 'visible',
  getElementById(id) {
    if (!elements.has(id)) {
      const el = makeEl(id);
      if (id === 'cv') el.getContext = () => absorber;
      elements.set(id, el);
    }
    return elements.get(id);
  },
  createElement(tag) { return makeEl('<' + tag + '>'); },
  querySelectorAll() { return []; },
  addEventListener() {},
};
const rafQueue = [];
let now = 0;
const sandbox = {
  document: documentStub,
  performance: { now: () => now },
  requestAnimationFrame: cb => { rafQueue.push(cb); return rafQueue.length; },
  devicePixelRatio: 1,
  ResizeObserver: class { observe() {} disconnect() {} },
  addEventListener() {},
  console,
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimeout,
  setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
  clearInterval,
  // 网络桩：无头无数据库/物流源——事件回推/遥测/台账写库全部静默成功（错误重试会拖慢泵帧）
  fetch: async () => ({ ok: true, json: async () => ({}) }),
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(`Math.random = (() => { let s = 20260930; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();`, sandbox);
vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });
sandbox.setPaused(false);   // 沙盘默认暂停：无头自检载入后立即开跑

/* 事件捕获：包装全局 emitSimEvent（顶层 function 声明挂在 VM 全局，内部调用走全局查找） */
const captured = [];
const origEmit = sandbox.emitSimEvent;
if (typeof origEmit !== 'function') { console.log('FAIL emitSimEvent 不在全局作用域'); process.exit(1); }
sandbox.emitSimEvent = (type, payload) => { captured.push({ type, payload }); origEmit(type, payload); };

async function pump(realSeconds, fps = 30) {
  const frames = Math.round(realSeconds * fps);
  for (let i = 0; i < frames; i++) {
    now += 1000 / fps;
    const q = rafQueue.splice(0);
    for (const cb of q) cb(now);
  }
  await new Promise(r => setImmediate(r));
}
let failed = 0, checkIdx = 0;
const failIdx = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  checkIdx++;
  if (!ok) { failed++; failIdx.push(checkIdx); }
  console.log(`#${checkIdx} ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  [' + detail + ']' : ''}`);
}

console.log('== 场景构造：被压目标捆 + 关联订单/车牌的出库任务 ==');
sandbox.setSpeed(16);
// 手工垛（与 order-fulfill-self-test「压货倒运按整层」同构）：
//   底层目标捆 XT-T（座位0）+ 同层旁捆 XT-N（座位1，不承压不动）；上层 XT-A/XC-B 压在目标捆正上方
const slots = sandbox.__dbg.storages;
const sProbe = slots.find(s => s.state !== 'locked' && s.stacks.length >= 2);
const kP0 = sProbe.stacks[0], kP1 = sProbe.stacks[1];
const spP = kP0.spec || sandbox.__dbg.lifts.length && null;
const specObj = (kP0.spec && kP0.spec.name) ? kP0.spec : { name: '螺纹钢 Φ25', rods: 15, color: '#000', weight: 0.52 };
const fakeB = (id, layer, seat, inTime) => ({
  id, slotId: sProbe.id, stackIdx: 0, specIdx: 0, grade: 'Q', len: 9, heat: 'HT0',
  rods: 1, wt: 1, inTime, pending: false, pos: { layer, seat, dx: 0, y: 0, dz: 0, yaw: 0 },
});
kP0.spec = specObj; kP0.inTime = -100; kP0.pending = 0; kP0.reserved = 0;
kP0.bundles = [fakeB('XT-T', 0, 0, -90), fakeB('XT-N', 0, 1, -80), fakeB('XT-A', 1, 0, -70), fakeB('XT-B', 1, 1, -60)];
kP0.count = 4;
kP1.bundles = []; kP1.count = 0; kP1.pending = 0; kP1.reserved = 0; kP1.spec = null;   // 本位空垛作倒垛落点
sProbe.state = 'occupied'; sProbe.lockSpec = null; sProbe.lockStack = null;
// 关联订单 + 车辆（出库装车引发的倒垛 = task.order/task.truck 都在）
const ORDER_NO = 'HT26-9901', PLATE = '测A·00001';
const order = { id: ORDER_NO, spec: specObj, span: 0, required: 1, assigned: 1, done: 0, tonsLoaded: 0, tasks: [], created: -10, doneAt: null, buyer: '自检' };
const tkP = { state: 'WORKING', x: 0, y: 0, targetY: 0, taskId: 'B-9901', plate: PLATE, remaining: 1, lane: 0 };
const task = {
  id: 'XT-1', type: 'out', spec: specObj, slot: sProbe, stackIdx: 0,
  state: 'pending', stage: 0, created: 0, robot: null,
  cranePushed: false, restackWaiting: false, restackLeft: 0, restackTotal: 0, restackWaitSince: 0,
  truck: tkP, batch: { id: 'B-9901', kind: 'out', span: 0, order, tasks: [], truck: tkP, created: 0 },
  order, scanRetries: 0, anomaly: false, bundleId: 'XT-T', liftedAt: 0, loadedDone: false,
};
order.tasks.push(task);
check('被压目标捆出库任务可排产（上方整层 2 捆先倒，再 1 吊装车）',
  (() => {
    sandbox.maybePushCraneJob(task);
    return task.cranePushed && task.restackTotal === 2;
  })(),
  `restackTotal=${task.restackTotal}`);

console.log('== 泵帧执行：倒垛落位 -> restack.done 事件（按车追溯字段） ==');
let restackEvents = [];
for (let i = 0; i < 60 && restackEvents.length < 2; i++) {
  await pump(5);
  restackEvents = captured.filter(e => e.type === 'restack.done');
}
check('倒垛完成事件已发出（2 吊压货各一条）', restackEvents.length >= 2, `${restackEvents.length} 条`);
const r1 = restackEvents[0] && restackEvents[0].payload;
check('restack.done 携带订单号 orderNo（P10 已出场按订单归集）', r1 && r1.orderNo === ORDER_NO, `orderNo=${r1 && r1.orderNo}`);
check('restack.done 携带车牌 plate（一单多车/按车牌归集）', r1 && r1.plate === PLATE, `plate=${r1 && r1.plate}`);
check('restack.done 携带让位捆号 forBundle（本吊倒垛为取出的目标捆）', r1 && r1.forBundle === 'XT-T', `forBundle=${r1 && r1.forBundle}`);
check('restack.done 保留源/目标垛位 + 被倒捆号（既有字段不回归）',
  r1 && typeof r1.from === 'string' && r1.fromStack > 0 && typeof r1.to === 'string' && r1.toStack > 0 && typeof r1.bundleId === 'string' && r1.bundleId !== 'XT-T',
  JSON.stringify(r1 && { from: r1.from + '#' + r1.fromStack, to: r1.to + '#' + r1.toStack, bundleId: r1.bundleId }));
check('操作端倒垛单（无 order）不误带字段：refId 缺省保持 null 兼容', r1 && r1.refId == null, `refId=${r1 && r1.refId}`);

console.log('== 泵帧执行：装车完成 -> 出库订单进度/完成事件 ==');
// 手工构造的 order 不走 createOutOrder（无 outbound.order 事件）——订单链的 order→progress→done
// 全链已在浏览器 E2E 验证（HT26-0001/0002 实车），此处断言 progress/done 两条推进事件即可
let orderEvents = [];
for (let i = 0; i < 90 && !orderEvents.some(e => e.type === 'outbound.done'); i++) {
  await pump(5);
  orderEvents = captured.filter(e => String(e.payload && e.payload.orderNo) === ORDER_NO && e.type.startsWith('outbound.'));
}
check('出库订单推进事件链（progress → done，含订单号）',
  ['outbound.progress', 'outbound.done'].every(t => orderEvents.some(e => e.type === t)),
  orderEvents.map(e => e.type).join('→'));

console.log('== 服务端事件保留窗口：restack.done / vehicle.left 不被日志洪流挤出 ==');
const { openDb } = await import('../server/database.js');
const { appendEvents, listEvents } = await import('../server/frontend.js');
const db = openDb(':memory:');
// 洪流：6000 条 log（远超 EVENTS_KEEP=5000 总窗口）+ 700 条倒垛 + 700 条离场（超各自窗口 600 的部分被裁、窗口内保留）
const flood = [];
for (let i = 0; i < 6000; i++) flood.push({ time: '2026-10-09T10:00:00Z', type: 'log', payload: { cat: 'crane', msg: '洪流 ' + i } });
for (let i = 0; i < 700; i++) flood.push({ time: '2026-10-09T11:00:00Z', type: 'restack.done', payload: { bundleId: 'B-' + i, orderNo: 'HT26-9' + i, from: '1-1', fromStack: 1, to: '1-2', toStack: 1 } });
for (let i = 0; i < 700; i++) flood.push({ time: '2026-10-09T12:00:00Z', type: 'vehicle.left', payload: { kind: 'out', plate: 'P' + i, orderNo: 'HT26-8' + i } });
for (let i = 0; i < 300; i++) flood.push({ time: '2026-10-09T13:00:00Z', type: 'outbound.order', payload: { orderNo: 'HT26-7' + i, specName: '螺纹钢 Φ25', bundles: 1 } });
appendEvents(db, flood);
// 按页翻全量统计某类型存活数（listEvents 每页 200 条混排各类型，须逐页累计而非按类型取页）
const keepOf = t => {
  let n = 0, after = 0;
  for (;;) {
    const page = listEvents(db, after, 200);
    if (!page.length) break;
    n += page.filter(e => e.type === t).length;
    after = page[page.length - 1].seq;
    if (page.length < 200) break;
  }
  return n;
};
const lastOf = t => {
  let last = null, after = 0;
  for (;;) {
    const page = listEvents(db, after, 200);
    if (!page.length) break;
    const hit = page.filter(e => e.type === t);
    if (hit.length) last = hit[hit.length - 1];
    after = page[page.length - 1].seq;
    if (page.length < 200) break;
  }
  return last;
};
check('倒垛事件按独立窗口保留（RESTACK_KEEP=600，最新 600 条存活）', keepOf('restack.done') === 600, `存活 ${keepOf('restack.done')}`);
check('离场事件按独立窗口保留（LEFT_KEEP=600，最新 600 条存活）', keepOf('vehicle.left') === 600, `存活 ${keepOf('vehicle.left')}`);
check('窗口内最新的倒垛事件仍携带订单号（平板刷新重放可归集）', (() => {
  const last = lastOf('restack.done');
  return last && last.payload.orderNo === 'HT26-9' + 699 && last.payload.bundleId === 'B-699';
})(), '');
check('全程运行零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.slice(0, 3).join('|'));

console.log(failed === 0 ? 'ALL PROBE CHECKS PASSED' : `${failed} FAILED`);
if (failed) console.log('FAILED_IDX:', JSON.stringify(failIdx));
process.exit(failed === 0 ? 0 : 1);
