// 无头专项探针：同垛批量扫码——同一垛位的多个待扫任务由机器狗一趟连续扫完，不重复跑。
// 场景 A：3 个同垛入库任务均已落料 -> 派单即归并，一只狗到访一次扫完 3 个；
// 场景 B：先落料 1 个派狗在途，第 2 个同垛任务随后落料 -> 到场捎带，同一趟扫完。
// 用法：node simulation/scan-batch-probe.mjs
import { readFileSync } from 'node:fs';
import { injectCoreSegs } from './sandbox-page-loader.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = injectCoreSegs(readFileSync(join(here, '调度仿真沙盘.html'), 'utf8'));
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) throw new Error('未找到 <script> 内容');

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
  addEventListener() {},
  console,
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimeout,
  setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
  clearInterval,
  location: { search: '' },
  URLSearchParams,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(`Math.random = (() => { let s = 20260824; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();`, sandbox);
vm.runInContext(m[1], sandbox, { filename: 'sandbox-inline.js' });

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
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
}

sandbox.init();
for (let i = 0; i < 10; i++) await pump(0.1);
sandbox.setSpeed(16);
sandbox.setPaused(false);
const D = sandbox.__dbg;

// 提速探针：扫码 3s/捆（批量行为与扫码时长无关），生产节奏压到最低（避免背景车流干扰）
sandbox.setDeviceParam('robot', 'scanTime', 3);
sandbox.setDeviceParam('production', 'inPerDay', 1);
sandbox.setDeviceParam('production', 'outPerDay', 1);

// 选空闲垛位：count=0 且无待扫码，落在机器狗扫描范围内（默认三跨全监测）
const spanOf = s => (s.merged ? 1 : Math.round((s.row - 1) / 2));   // 库位所在跨（0/1/2 = A/B/C）
function freeStack(excludeCodes = [], span = null) {
  for (const s of D.storages) {
    if (excludeCodes.includes(s.code)) continue;
    if (span != null && spanOf(s) !== span) continue;
    for (let k = 0; k < s.stacks.length; k++) {
      const st = s.stacks[k];
      if (st.count === 0 && !st.pending && !(st.reserved > 0)) return { slot: s, stackIdx: k };
    }
  }
  return null;
}
// 确认单路径建同垛任务（仅建任务：目标垛 pending 须为 0，落料抬 pending 须在建完所有同垛任务之后）
function mkTaskOn(code, stackIdx) {
  return sandbox.createTask('in', { target: { code, stackIdx }, silent: true });
}
// 直接落料（绕过天车吊运链，聚焦扫码调度）：同计数制抬 pending + 任务具备扫码条件（对齐天车落料的垛级字段）
function land(t) {
  t.materialReady = true;
  t.materialReadyAt = D.simTime;
  const st = t.slot, k = st.stacks[t.stackIdx];
  if (k.count === 0) { k.spec = t.spec; k.inTime = D.simTime; }   // 垛内首捆定规格（FIFO 计时）
  k.count++; k.pending++;
  if (k.reserved > 0) k.reserved--;                              // 组车预占转实落
  st.state = 'occupied'; st.lockSpec = null; st.lockStack = null;
  return t;
}
const done = t => t.state === 'done';
async function pumpUntil(cond, capS = 4000, step = 0.5) {
  for (let el = 0; el < capS && !cond(); el += step) await pump(step);
  return cond();
}

console.log('== 场景 A：3 个同垛待扫任务 -> 派单归并，一趟扫完 ==');
const A = freeStack();
check('场景 A 找到空闲垛位', !!A, A && `${A.slot.code} 第${A.stackIdx + 1}垛`);
const aTasks = [mkTaskOn(A.slot.code, A.stackIdx), mkTaskOn(A.slot.code, A.stackIdx), mkTaskOn(A.slot.code, A.stackIdx)];
aTasks.forEach(land);
check('场景 A 三个任务同垛落料', aTasks.every(Boolean) && aTasks.every(t => t.slot.code === A.slot.code && t.stackIdx === A.stackIdx),
  aTasks.map(t => t && t.id).join(','));
const aOk = await pumpUntil(() => aTasks.every(done));
check('场景 A 三个任务全部扫码闭环', aOk, aTasks.map(t => `${t.id}:${t.state}`).join(' '));
const aLogs = (sandbox.__scanBatchLog || []).filter(e => e.slot === A.slot.code && e.stackIdx === A.stackIdx);
check('场景 A 一趟扫完（批量完结留痕 3 个任务）',
  aLogs.length === 1 && aLogs[0].ids.length === 3 && aTasks.every(t => aLogs[0].ids.includes(t.id)),
  aLogs.map(e => `${e.robot}:${e.ids.join('/')}`).join(' ') || '无批量留痕');
check('场景 A 同一只狗扫码（不重复派狗）',
  aTasks.every(t => t.scanRobot && t.scanRobot === aTasks[0].scanRobot),
  aTasks.map(t => `${t.id}:${t.scanRobot || '-'}`).join(' '));
const kA = D.storages.find(s => s.code === A.slot.code).stacks[A.stackIdx];
check('场景 A 垛待扫码清零（3 捆入账）', kA.pending === 0 && kA.count === 3, `pending=${kA.pending} count=${kA.count}`);

console.log('== 场景 B：在途期间同垛第 2 个任务落料 -> 到场捎带，同一趟扫完 ==');
// 同车归并只作用于「当前待组车次（首个未派车的入库批次）」：B 必须落在该批次所在跨，
// b1 才会并进它、随后创建的同规格 b2 才会沿用 b1 的垛位（否则并进别的车次/别跨的既有垛）
const openIn = D.batches.find(x => x.kind === 'in' && !x.dispatched);
const B = freeStack([A.slot.code], openIn ? openIn.span : null);
check('场景 B 找到另一空闲垛位', !!B, B && `${B.slot.code} 第${B.stackIdx + 1}垛`);
const b1 = land(mkTaskOn(B.slot.code, B.stackIdx));
check('场景 B 首任务落料', !!b1, b1 && b1.id);
// 等首任务派单（狗在途），再让同垛第 2 个任务落料（同车归并沿用 b1 的垛位：目标垛已落料，确认单路径不再收）
const bAssigned = await pumpUntil(() => b1.state === 'assigned', 2000, 0.2);
check('场景 B 首任务已派狗在途', bAssigned, `state=${b1.state}`);
const b2 = land(sandbox.createTask('in', { spec: b1.spec, silent: true }));
check('场景 B 次任务随后落料（同车归并同垛）', !!b2 && b2.slot.code === B.slot.code && b2.stackIdx === B.stackIdx,
  b2 && `${b2.id}@${b2.slot.code} 第${b2.stackIdx + 1}垛`);
const bOk = await pumpUntil(() => done(b1) && done(b2));
check('场景 B 两个任务全部扫码闭环', bOk, `${b1.id}:${b1.state} ${b2.id}:${b2.state}`);
const bLogs = (sandbox.__scanBatchLog || []).filter(e => e.slot === B.slot.code && e.stackIdx === B.stackIdx);
check('场景 B 到场捎带一趟扫完（批量留痕含两个任务）',
  bLogs.length === 1 && bLogs[0].ids.length === 2 && bLogs[0].ids.includes(b1.id) && bLogs[0].ids.includes(b2.id),
  bLogs.map(e => `${e.robot}:${e.ids.join('/')}`).join(' ') || '无批量留痕');
check('场景 B 同一只狗扫码', b1.scanRobot && b1.scanRobot === b2.scanRobot, `${b1.scanRobot || '-'} / ${b2.scanRobot || '-'}`);

console.log('== 复核：不同垛位仍分别派单（不误并） ==');
const C1 = freeStack([A.slot.code, B.slot.code]);
const c1 = land(mkTaskOn(C1.slot.code, C1.stackIdx));
const C2slot = D.storages.find(s => s.code !== C1.slot.code && s.code !== A.slot.code && s.code !== B.slot.code
  && s.stacks.some(k => k.count === 0 && !k.pending && !(k.reserved > 0)));
const C2 = C2slot ? { slot: C2slot, stackIdx: C2slot.stacks.findIndex(k => k.count === 0 && !k.pending && !(k.reserved > 0)) } : null;
const c2 = C2 ? land(mkTaskOn(C2.slot.code, C2.stackIdx)) : null;
const cOk = await pumpUntil(() => c1 && c2 && done(c1) && done(c2));
check('两个不同垛位任务各自闭环', !!(cOk && c1 && c2), `${c1 && c1.id}:${c1 && c1.state} ${c2 && c2.id}:${c2 && c2.state}`);
const cCross = (sandbox.__scanBatchLog || []).some(e => e.ids.includes(c1.id) && e.ids.includes(c2.id));
check('不同垛位未被并入同一趟', !cCross && !!c1.scanRobot && !!c2.scanRobot, `${c1.scanRobot || '-'} / ${c2.scanRobot || '-'}`);

check('探针全程零错误', D.errs.length === 0, D.errs.slice(0, 3).join('|'));
console.log(failed ? `\n${failed} 项断言失败 ✗` : '\n同垛批量扫码专项探针全部通过 ✓');
process.exit(failed ? 1 : 0);
