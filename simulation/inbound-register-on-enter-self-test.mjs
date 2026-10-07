// 无头自检：进厂车「进场才登记服务器确认队列」——厂外排队车不进 P10 待办/进厂确认队列。
// 规则：本地排产生成车辆后仅暂存 regPend，货车 QUEUE 解除（驶入通道，enterAt 记点）时才调
// registerLocalVehicle 登记（P10 待办出现）并挂起确认闸门（awaitConfirm，天车等 P10 确认）。
// 断言：登记不早于进场（simTime >= enterAt）、登记瞬间车不在 QUEUE、登记后批次挂起 awaitConfirm。
// 用法：node simulation/inbound-register-on-enter-self-test.mjs
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

/* 服务器 mock：register 记录登记时刻的仿真时间与同牌车状态；
 * /api/inbound 恒回 pending（确认轮询查到 pending 不放行，awaitConfirm 可稳定断言）。 */
const registers = [];   // [{ plate, simTime, truckState, enterAt, summonAt }]
let regSeq = 100;
const json = data => ({ ok: true, status: 200, json: async () => data });
sandbox.fetch = async (u, opts = {}) => {
  const url = String(u);
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (url.includes('/api/inbound/register')) {
    const tk = (sandbox.__dbg.truckHistory || []).find(t => t.plate === body.plate);
    registers.push({
      plate: body.plate,
      simTime: sandbox.__dbg.simTime,
      truckState: tk ? tk.state : '(无车)',
      enterAt: tk ? tk.enterAt : null,
      summonAt: tk ? tk.summonAt : null,
    });
    return json({ id: ++regSeq, plate: body.plate, waybill: body.waybill, loads: [] });
  }
  if (url.includes('/api/inbound') && opts.method === 'DELETE') return json({ ok: true });
  if (url.includes('/api/inbound')) return json({ vehicles: registers.map((r, i) => ({ id: 100 + i + 1, plate: r.plate, state: 'pending' })) });
  if (url.includes('/api/slots')) return json({ slots: [] });   // 空 -> 走内置期初库存兜底（与无 fetch 自检同源）
  return json({});
};

vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });
sandbox.setDeviceParam('production', 'operatorPlanWaitMin', 0);   // 关闭平板规划等待：启动即本地排产
sandbox.init();
sandbox.setPaused(false);
sandbox.setSpeed(8);

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

console.log('== 阶段一：泵到首辆进厂车派车 ==');
for (let i = 0; i < 240 && !(sandbox.__dbg.truckHistory || []).some(t => t.kind === 'in'); i++) pump(1);
const inTrucks = sandbox.__dbg.truckHistory.filter(t => t.kind === 'in');
check('零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.slice(0, 3).join('|'));
check('本地排产已派进厂车', inTrucks.length > 0, inTrucks.length + ' 辆');

console.log('== 阶段二：登记时机 = 进场时刻（QUEUE 解除）==');
for (let i = 0; i < 240 && registers.length === 0; i++) pump(1);
check('进场后有登记（P10 待办出现）', registers.length > 0, `登记 ${registers.length} 次`);
for (const r of registers) {
  // 登记瞬间车辆须处于进场后状态（ENTER 驶入 / PLATE_SCAN 停靠识别 / MANIFEST 运单 / WORKING 吊运）——QUEUE 即厂外排队，不允许登记
  check(`登记 ${r.plate} 发生在进场后（登记时车状态=${r.truckState}）`,
    ['ENTER', 'PLATE_SCAN', 'MANIFEST', 'WORKING'].includes(r.truckState), `simTime=${r.simTime?.toFixed?.(1)}`);
}

console.log('== 阶段三：登记即挂起确认闸门（天车等 P10 确认）==');
pump(1);
const pendingBatches = sandbox.__dbg.batches.filter(b => b.plate && registers.some(r => r.plate === b.plate));
check('同牌车次已挂起 awaitConfirm', pendingBatches.length > 0 && pendingBatches.every(b => b.awaitConfirm === true),
  pendingBatches.map(b => `${b.id}:${b.awaitConfirm}`).join(' '));

console.log('== 阶段四：继续运行无幽灵登记（每车只登记一次）==');
pump(120);
check('运行零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.slice(0, 3).join('|'));
const byPlate = new Map();
for (const r of registers) byPlate.set(r.plate, (byPlate.get(r.plate) || 0) + 1);
check('每车牌只登记一次', [...byPlate.values()].every(n => n === 1),
  [...byPlate.entries()].filter(([, n]) => n > 1).map(([p, n]) => `${p}×${n}`).join(' ') || `${byPlate.size} 车 ×1`);

console.log(failed === 0 ? '\n全部通过：进厂车进场才登记待办' : `\n失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
