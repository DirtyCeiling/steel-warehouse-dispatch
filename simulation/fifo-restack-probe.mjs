// 探针：验证「严格先进先出选捆」下，出库目标捆在垛内的位置与倒垛吊数的关系。
// 用法：node simulation/fifo-restack-probe.mjs
import { readFileSync } from 'node:fs';
import { injectCoreSegs } from './sandbox-page-loader.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeFeedFetch } from './feed-stub.mjs';

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
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(`Math.random = (() => { let s = 20260824; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();`, sandbox);
vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });
sandbox.setPaused(false);
sandbox.fetch = makeFeedFetch(() => sandbox.__dbg.simTime);

async function pump(realSeconds, fps = 30) {
  const frames = Math.round(realSeconds * fps);
  for (let i = 0; i < frames; i++) {
    now += 1000 / fps;
    const q = rafQueue.splice(0);
    for (const cb of q) cb(now);
  }
  await new Promise(r => setImmediate(r));
}

console.log('== 跑 2 个仿真小时让库存积累 ==');
sandbox.setSpeed(16);
for (let i = 0; i < 45; i++) await pump(10); // 450s 实时 × 16 = 7200 仿真秒
console.log('errs:', sandbox.__dbg.errs.length);
const dist = sandbox.__dbg.storages
  .flatMap(s => s.stacks.map(k => k.bundles.length))
  .filter(n => n > 0)
  .reduce((m, n) => (m[n] = (m[n] || 0) + 1, m), {});
console.log('非空垛捆数分布（捆数: 垛数）:', JSON.stringify(dist));

console.log('== 连续下 6 个出库探针任务（默认 fifoPick=1 随机选捆），统计目标捆位置与实际倒垛吊数 ==');
let buriedCnt = 0, topCnt = 0, rsTotal = 0;
for (let n = 0; n < 6; n++) {
  const t = sandbox.createTask('out');
  if (!t) { console.log(`#${n + 1} 无法创建出库任务（库存不足？）`); break; }
  const k = t.slot.stacks[t.stackIdx];
  const stkN = k.bundles.length;
  const bIdx = k.bundles.findIndex(b => b.id === t.bundleId);
  const tb = k.bundles[bIdx];
  const above = tb && tb.pos
    ? k.bundles.filter(o => o !== tb && o.pos && o.pos.seat === tb.pos.seat && o.pos.layer > tb.pos.layer).length   // 座位列正上方压货（真压货）
    : Math.max(0, stkN - 1 - bIdx);
  const qLen0 = sandbox.__dbg.craneJobsDebug.length;
  t.state = 'pending';
  t.batch = { tasks: [], truck: { state: 'WORKING', x: 0, targetY: 0 } };
  t.truck = t.batch.truck;
  sandbox.maybePushCraneJob(t);
  const newJobs = sandbox.__dbg.craneJobsDebug.slice(qLen0);
  const rsJobs = newJobs.filter(j => j.kind === 'restack');
  console.log(`#${n + 1} 任务 ${t.id} · 库位 ${t.slot.code} 第${t.stackIdx + 1}垛 · 全垛 ${stkN} 捆`
    + ` · 目标捆 ${tb && tb.pos ? `第${tb.pos.layer + 1}层第${tb.pos.seat + 1}位` : `序号${bIdx}`} · 座位列压货 ${above} 捆`
    + ` · 实际入队倒垛吊 ${rsJobs.length} · 装车吊 ${newJobs.filter(j => j.kind === 'out').length}`);
  if (above > 0) buriedCnt++; else topCnt++;
  rsTotal += rsJobs.length;
  // 取消该探针任务，避免污染下一轮选捆（释放库位锁，让下一任务重新选）
  t.batch = null; t.truck = null;
  const idx = sandbox.__dbg.craneJobsDebug;
  idx.splice(qLen0);   // 撤掉刚入队的天车作业
  const ti = sandbox.__dbg.tasks.indexOf(t);
  if (ti >= 0) sandbox.__dbg.tasks.splice(ti, 1);
  if (t.order) { t.order.assigned--; t.order.tasks = t.order.tasks.filter(x => x !== t); }
  const st = t.slot;
  if (st.state === 'locked') { st.state = 'occupied'; st.lockSpec = null; st.lockStack = null; }
}
console.log(`\n结论：${buriedCnt} 次目标捆被压（倒垛 ${rsTotal} 吊 = 只倒同列压货）· ${topCnt} 次未被压直取（免倒垛）`);
process.exit(0);
