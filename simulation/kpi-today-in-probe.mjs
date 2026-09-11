// 探针：首页「今日进厂车辆」KPI 口径 = 入库 + 出库车一并计入
// 用法：node simulation/kpi-today-in-probe.mjs
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
function makeEl(id = '') {
  const el = {
    id, textContent: '', innerHTML: '', className: '', checked: false, value: '', style: {},
    children: [],
    appendChild(ch) { this.children.push(ch); return ch; },
    removeChild(ch) { const i = this.children.indexOf(ch); if (i >= 0) this.children.splice(i, 1); return ch; },
    get firstChild() { return this.children[0]; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1680, height: 980 }),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    clientWidth: 1680, clientHeight: 620, scrollTop: 0, scrollHeight: 0,
  };
  return el;
}
const elements = new Map();
const documentStub = {
  visibilityState: 'visible',
  getElementById(id) {
    if (!elements.has(id)) {
      const el = makeEl(id);
      if (id === 'cv' || id === 'dogCv') el.getContext = () => absorber;
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
  addEventListener() {}, console,
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimeout, setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; }, clearInterval,
  location: { search: '' }, URLSearchParams,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(`Math.random = (() => { let s = 20260824; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();`, sandbox);
vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });
sandbox.setPaused(false);

const flushMicrotasks = () => new Promise(r => setImmediate(r));
async function pump(realSeconds, fps = 30) {
  const frames = Math.round(realSeconds * fps);
  for (let i = 0; i < frames; i++) {
    now += 1000 / fps;
    const q = rafQueue.splice(0);
    for (const cb of q) cb(now);
  }
  await flushMicrotasks();
}

let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
};
const el = id => documentStub.getElementById(id);

// 泵到场上既有入库车又有出库车派车留档
for (let i = 0; i < 40; i++) {
  await pump(5);
  const hist = sandbox.__dbg.truckHistory;
  const hasIn = hist.some(t => t.kind === 'in');
  const hasOut = hist.some(t => t.kind === 'out');
  if (hasIn && hasOut) break;
}

const hist = sandbox.__dbg.truckHistory;
const inN = hist.filter(t => t.kind === 'in').length;
const outN = hist.filter(t => t.kind === 'out').length;
const kpiV = Number(el('kpiTodayIn').textContent);
const sub = el('kpiTodayInSub').textContent;
console.log(`truckHistory: 入库 ${inN} · 出库 ${outN} · 合计 ${hist.length}`);
console.log(`KPI 今日进厂车辆 = ${kpiV} · 副行「${sub}」`);

check('今日同时存在入库与出库车（探针前提）', inN > 0 && outN > 0, `入 ${inN} · 出 ${outN}`);
check('KPI 数 = 入库 + 出库（两种都算进厂）', kpiV === inN + outN, `KPI ${kpiV} vs 入+出 ${inN + outN}`);
check('副行分解一致', sub.includes(`入库 ${inN}`) && sub.includes(`出库 ${outN}`), sub);

process.exit(failed ? 1 : 0);
