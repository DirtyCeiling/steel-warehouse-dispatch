// 无头自检：本地排产出库订单「等 P10 出库规划推送确认后才装车」。
// 规则：createOutOrder 生成订单带 awaitConfirm=true，maybePushCraneJob 检查 task.order.awaitConfirm 挂起；
//      dispatch-outbound-order 命令确认后放行（awaitConfirm=false）。
// 断言：确认前天车不装车（craneJobs 无该订单吊）；确认后正常装车。
// 用法：node simulation/outbound-confirm-gate-self-test.mjs
import { readFileSync } from 'node:fs';
import { injectCoreSegs } from './sandbox-page-loader.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = injectCoreSegs(readFileSync(join(here, '调度仿真沙盘.html'), 'utf8'));
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) throw new Error('未找到 <script> 内容');
const code = m[1];

const absorber = new Proxy(function () {}, {
  get(t, p) { if (p === Symbol.toPrimitive) return () => 0; return absorber; },
  set() { return true; },
  apply() { return absorber; },
});

const elements = new Map();
function makeEl(id = '') {
  const el = {
    id, textContent: '', innerHTML: '', className: '', checked: false, value: '', style: {},
    children: [],
    appendChild(ch) { this.children.push(ch); return ch; },
    removeChild(ch) { const i = this.children.indexOf(ch); if (i >= 0) this.children.splice(i, 1); return ch; },
    get firstChild() { return this.children[0]; },
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1680, height: 980 }),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    clientWidth: 1680, clientHeight: 620, scrollTop: 0, scrollHeight: 0,
  };
  return el;
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
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(`Math.random = (() => { let s = 20260824; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();`, sandbox);

// 服务器 mock：/api/slots 空 -> 兜底库存；/api/inbound 空；dispatch-outbound-order 命令经 __simInteg.cmd 直接注入
sandbox.fetch = async (u, opts = {}) => {
  const url = String(u);
  if (url.includes('/api/slots')) return { ok: true, json: async () => ({ slots: [] }) };
  if (url.includes('/api/inbound')) return { ok: true, json: async () => ({ vehicles: [] }) };
  return { ok: true, json: async () => ({}) };
};

vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });
sandbox.setDeviceParam('production', 'operatorPlanWaitMin', 0);   // 关闭平板规划等待：本地排产兜底
sandbox.init();
sandbox.setPaused(false);
sandbox.setSpeed(16);

function pump(realSeconds, fps = 30) {
  const frames = Math.round(realSeconds * fps);
  for (let i = 0; i < frames; i++) {
    now += 1000 / fps;
    const q = rafQueue.splice(0);
    for (const cb of q) cb(now);
  }
}

let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
}

console.log('== 阶段一：生成出库订单并派车 ==');
// 手动创建出库订单（不走 createOutOrder 的自动节奏）
const specName = sandbox.__dbg.storages[0]?.stacks[0]?.bundles[0]?.spec?.name || '圆钢 Φ50';
const orderId = 'HT26-TEST';
// 用 dispatch-outbound 命令注入订单（带 awaitConfirm）
sandbox.__simInteg.cmd('dispatch-outbound', { specName, bundles: 3, orderNo: orderId });
pump(2);
const order = (sandbox.__dbg.orders || []).find(o => o.id === orderId);
check('订单已创建', !!order, orderId);
check('订单带 awaitConfirm=true（等 P10 确认）', order?.awaitConfirm === true, String(order?.awaitConfirm));

// 派车（车进入 QUEUE/ENTER/PLATE_SCAN/WORKING）
sandbox.forceDispatchBatches();
pump(30);   // 足够车进场停靠+识别+运单
const truck = (sandbox.__dbg.truckHistory || []).find(t => t.kind === 'out');
check('出库车已派车', !!truck, truck?.plate);
check('车已进场（非 QUEUE）', truck && truck.state !== 'QUEUE', truck?.state);

console.log('== 阶段二：确认前天车不装车 ==');
pump(60);   // 给足时间让天车作业
const doneBefore = (sandbox.__dbg.lifts || []).filter(t => t.type === 'out' && t.orderId === orderId && t.state === 'done').length;
check('确认前无出库任务完成', doneBefore === 0, `${doneBefore} 个`);
const pushedBefore = (sandbox.__dbg.lifts || []).filter(t => t.type === 'out' && t.orderId === orderId && t.cranePushed).length;
check('确认前天车未接装车吊（cranePushed=false）', pushedBefore === 0, `${pushedBefore} 个已推`);

console.log('== 阶段三：P10 确认后正常装车 ==');
// 模拟管理工 P10 点「出库规划」推送确认（用订单真实捆号）
sandbox.__simInteg.cmd('dispatch-outbound-order', { orderNo: orderId, qrCodes: order.bundleIds });
pump(1);
const orderAfter = (sandbox.__dbg.orders || []).find(o => o.id === orderId);
check('确认后 awaitConfirm=false', orderAfter?.awaitConfirm === false, String(orderAfter?.awaitConfirm));
pump(180);   // 让天车装车（出库吊运+机器狗扫码耗时较长）
const doneAfter = (sandbox.__dbg.lifts || []).filter(t => t.type === 'out' && t.orderId === orderId && t.state === 'done').length;
const pushedAfter = (sandbox.__dbg.lifts || []).filter(t => t.type === 'out' && t.orderId === orderId && t.cranePushed).length;
check('确认后天车开始接装车吊', pushedAfter > 0, `${pushedAfter} 个已推`);
check('确认后有任务完成', doneAfter > 0, `${doneAfter} 个`);

console.log(failed === 0 ? '\n全部通过：出库确认闸门' : `\n失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
