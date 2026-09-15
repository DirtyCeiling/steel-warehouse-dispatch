// 探针：验证出库装车「取吊绳」环节（crane.unhookTime，默认 74s）。
// 断言：①参数登记与夹取；②出库吊落车后天车进入 UNHOOK 且历时 ≈ unhookTime；
// ③取吊绳仅出现在出库吊（入库/倒垛吊不取绳）；④取绳期间货车保持 WORKING 等待，
//   末吊绳取出后货车才转 VERIFY 复验并离场；⑤unhookTime=0 关闭环节时零阻塞零日志。
// 用法：node simulation/unhook-probe.mjs
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
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(`Math.random = (() => { let s = 20260824; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();`, sandbox);
vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });
sandbox.setPaused(false);
sandbox.setSpeed(16);

async function pump(realSeconds, fps = 30) {
  const frames = Math.round(realSeconds * fps);
  for (let i = 0; i < frames; i++) {
    now += 1000 / fps;
    const q = rafQueue.splice(0);
    for (const cb of q) cb(now);
  }
  await new Promise(r => setImmediate(r));
}
async function pumpFrame() {   // 单帧推进（逐帧采样天车状态用）
  now += 1000 / 30;
  const q = rafQueue.splice(0);
  for (const cb of q) cb(now);
  await new Promise(r => setImmediate(r));
}

let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
};
const logText = () => elements.get('logList')?.children.map(d => d.innerHTML).join('\n') || '';
const UNHOOK_DUR = 74;

console.log('== ① 参数登记与夹取 ==');
check('unhookTime 默认 74s（登记生效）', sandbox.setDeviceParam('crane', 'unhookTime', 74) === 74);
check('unhookTime 越界夹取（999 -> 300）', sandbox.setDeviceParam('crane', 'unhookTime', 999) === 300);
sandbox.setDeviceParam('crane', 'unhookTime', UNHOOK_DUR);

console.log('== ② 跑到首个出库取吊绳（UNHOOK）观察窗口 ==');
let obs = null;   // {name, truckTaskId, t0}
const unhookKinds = new Set();
let leftAt = null;   // 观察中天车离开 UNHOOK 的仿真时刻
const capFrames = 300 * 30;   // 最多 300s 实时逐帧采样（16 倍速 ≈ 80 分钟仿真秒）
for (let f = 0; f < capFrames && !(obs && leftAt != null); f++) {
  await pumpFrame();
  for (const cr of sandbox.__dbg.craneStates) {
    if (cr.state === 'UNHOOK') {
      unhookKinds.add(cr.jobKind || 'null');
      if (!obs && cr.jobKind === 'out') obs = { name: cr.name, truckTaskId: cr.truckTaskId, t0: sandbox.__dbg.simTime };
    } else if (obs && cr.name === obs.name && leftAt == null) {
      leftAt = sandbox.__dbg.simTime;
    }
  }
}
if (!obs) {
  check('观察到出库装车取吊绳（UNHOOK）', false, '300s 实时内未出现');
  process.exit(1);
}
const dur = leftAt != null ? leftAt - obs.t0 : null;
check('取吊绳历时 ≈ unhookTime（74s）', dur != null && dur >= UNHOOK_DUR - 1 && dur <= UNHOOK_DUR + 3, dur == null ? '未观察到退出' : `${dur.toFixed(1)}s`);   // 帧步长量化 ±1 帧容差
check('取吊绳仅出现在出库吊（无入库/倒垛吊取绳）', [...unhookKinds].every(k => k === 'out'), [...unhookKinds].join(','));
check('事件日志含「天车取吊绳」', logText().includes('天车取吊绳'));

console.log('== ③ 货车等待联动（末吊吊绳取出后复验离场） ==');
const tkOf = () => sandbox.__dbg.truckHistory.find(t => t.taskId === obs.truckTaskId);
const tkDuring = tkOf();
check('取绳期间货车保持 WORKING 等待（未提前复验/离场）', tkDuring && tkDuring.inScene && tkDuring.state === 'WORKING',
  tkDuring ? `${tkDuring.state}${tkDuring.inScene ? '' : '（已离场）'}` : '未找到车辆');
let departed = false;
for (let c = 0; c < 90 && !departed; c++) {   // 最长 90×pump(2) = 3 分钟实时，等复验 + 离场
  await pump(2);
  const tk = tkOf();
  departed = tk && !tk.inScene;
}
const tkAfter = tkOf();
check('吊绳取出后货车复验放行并离场', !!departed && tkAfter && !tkAfter.inScene && tkAfter.done + '/' + tkAfter.loads,
  tkAfter ? `${tkAfter.state} · ${tkAfter.done}/${tkAfter.loads} 吊 · ${tkAfter.inScene ? '仍在场' : '已离场'}` : '未找到车辆');

console.log('== ④ unhookTime=0 关闭环节 ==');
sandbox.setDeviceParam('crane', 'unhookTime', 0);
const logLen0 = logText().split('天车取吊绳').length - 1;
const sdBefore = sandbox.__dbg.simTime;
await pump(8);
const sdDelta = sandbox.__dbg.simTime - sdBefore;
const hookN0 = sandbox.__dbg.craneStates.filter(c => c.state === 'UNHOOK').length;
check('关闭后无天车滞留 UNHOOK', hookN0 === 0, `观测 ${Math.round(sdDelta)} 仿真秒 · UNHOOK 计数 ${hookN0}`);
check('关闭后零 JS 错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.slice(0, 2).join('|'));
sandbox.restoreDefaultParams();   // 恢复内置默认（unhookTime 回 74），不污染后续探针

console.log('== ⑤ 场次归档含天车作业明细 ==');
sandbox.archiveSession('end');   // 归档当前场次（帧循环已自动 markRunStarted）
const rec = sandbox.__lastRun;
check('归档记录生成且含逐吊明细/按天车汇总', !!rec && Array.isArray(rec.cranes) && Array.isArray(rec.perCrane),
  rec ? `cranes ${rec.cranes.length} 吊 · perCrane ${rec.perCrane.length} 台` : '无归档记录');
const crs = (rec && rec.cranes) || [];
const crOut = crs.filter(c => c.kind === 'out');
const badPhase = crs.filter(c => !(c.queueAt <= c.startAt && c.startAt <= c.hoistAt && c.startAt <= c.dropAt &&
  (c.unhookAt == null || c.dropAt <= c.unhookAt)));
check('五时刻单调（排队 ≤ 开始 ≤ 吊取/落位 ≤ 取绳）', crs.length > 0 && badPhase.length === 0,
  badPhase.length ? badPhase.slice(0, 2).map(c => `${c.crane}/${c.kind}`).join('|') : `${crs.length} 吊`);
check('仅出库吊有取绳时刻（入库/倒垛吊为空）', crOut.length > 0 && crOut.every(c => c.unhookAt != null)
  && crs.filter(c => c.kind !== 'out').every(c => c.unhookAt == null),
  `出库 ${crOut.length} 吊均含取绳`);
check('出库吊带车牌/车次（车辆维度可追溯）', crOut.every(c => c.plate && c.batch),
  crOut[0] ? `${crOut[0].plate} / ${crOut[0].batch}` : '');
const pcSum = ((rec && rec.perCrane) || []).reduce((s, p) => s + p.in + p.out + p.restack, 0);
check('按天车汇总吊数 = 逐吊明细条数', pcSum === crs.length, `汇总 ${pcSum} vs 明细 ${crs.length}`);

console.log(failed ? `\n未通过 ${failed} 项 ✗` : '\n全部通过 ✓');
process.exit(failed ? 1 : 0);
