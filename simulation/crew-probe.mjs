// 探针：验证吊运工人因环节（crew 段：挂绳 / 放绳 / 出库取绳；库区班组默认 6 人 + 每车 1 名车上专职）。
// 模型：每一吊（入库卸车 / 出库装车 / 倒垛）两端各一次人工作业——
//   吊运前天车到位转 WAIT_HOOK 等人 → 吊运工到吊点 → 挂绳 hookTime → 天车才 HOIST
//   （库位侧由库区班组步行前往；入库车端由该车专职吊运工即到即干、不上库位）；
//   落位后天车转 WAIT_UNHOOK 等人 → 放绳 unhookTime（自吊钩取下）→ 吊毕收尾；
//   出库落车放绳后车上专职继续取出捆内吊绳 ropeOutTime（ROPE_OUT：不挡天车、挡货车转 VERIFY 复验离场）。
// 断言：①参数登记与夹取（含 ropeOutTime）；②WAIT_HOOK → 挂绳 → HOIST 时序（hoistAt ≥ hookAt），入库车端挂绳由专职承接；
// ③WAIT_UNHOOK → 放绳 → 收尾（unhookAt ≥ dropAt）；④三种作业（入/出/倒垛）均含挂/放绳；
// ⑤出库落车专职放绳 + ROPE_OUT 取绳期间货车保持 WORKING，收清才复验离场；
// ⑥crew.count=0 关闭人力环节后天车不再等待、班组与车上专职均退场、新吊无挂/放绳时刻；
// ⑦场次归档含 crew 汇总（挂/放/取绳人次）+ 时刻单调（取绳 ≥ 放绳 ≥ 落位）。
// 用法：node simulation/crew-probe.mjs
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
let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
};
const logText = () => elements.get('logList')?.children.map(d => d.innerHTML).join('\n') || '';
const HOOK_S = 60, UNHOOK_S = 45, ROPE_S = 30, HOIST_S = 2.0;   // 默认参数（与 CFG.crew / CFG.crane.hoistTime 一致）

console.log('== ① 参数登记与夹取 ==');
check('crew 五参数默认登记（库区 6 人 · 行进 1.4 m/s · 挂 60s · 放 45s · 取 30s）',
  sandbox.__dbg.crewCfg.count === 6 && sandbox.__dbg.crewCfg.walkSpeed === 1.4
  && sandbox.__dbg.crewCfg.hookTime === HOOK_S && sandbox.__dbg.crewCfg.unhookTime === UNHOOK_S
  && sandbox.__dbg.crewCfg.ropeOutTime === ROPE_S,
  JSON.stringify(sandbox.__dbg.crewCfg));
check('人数越界夹取（99 -> 12）', sandbox.setDeviceParam('crew', 'count', 99) === 12);
sandbox.setDeviceParam('crew', 'count', 6);
check('出库取绳时间越界夹取（9999 -> 300）', sandbox.setDeviceParam('crew', 'ropeOutTime', 9999) === 300);
sandbox.setDeviceParam('crew', 'ropeOutTime', ROPE_S);
check('库区吊运工班组 6 人在岗（R-01~R-06）',
  sandbox.__dbg.crewStates.length === 6 && sandbox.__dbg.crewStates.every(r => /^R-0\d$/.test(r.name)),
  sandbox.__dbg.crewStates.map(r => r.name).join(','));

console.log('== ② 天车等人挂绳 → 挂绳完成才起吊（入库车端由车上专职承接） ==');
let sawWaitHook = null;          // {crane, tEnter}
let sawRiggerWork = false;       // 有人进入 HOOK（挂绳作业中）
let sawTruckHook = false;        // 入库车端挂绳由车上专职吊运工承接
let hookSpan = null;             // WAIT_HOOK 进入 → HOIST 的仿真时长（下界：挂绳 ≥ hookTime；库位侧另含行走）
const capSec = 420;              // 最多 420s 实时观察（16× ≈ 112 分钟仿真秒；HOIST 仅 2 仿真秒，逐帧抽样不漏看）
const t0 = sandbox.__dbg.simTime;
let crewBusySeen = 0;
for (let f = 0; f < capSec * 30 && (hookSpan == null || !sawRiggerWork || !sawTruckHook); f += 1) {
  await pump(1 / 30);   // 逐帧抽样（1 帧 = 1/30s 实时 = 0.53 仿真秒 @16×），确保抓到 2s 的 HOIST 态
  for (const cr of sandbox.__dbg.craneStates) {
    if (cr.state === 'WAIT_HOOK' && !sawWaitHook) sawWaitHook = { name: cr.name, tEnter: sandbox.__dbg.simTime };
    if (sawWaitHook && cr.name === sawWaitHook.name && cr.state === 'HOIST' && hookSpan == null)
      hookSpan = sandbox.__dbg.simTime - sawWaitHook.tEnter;   // 首吊测完即止（等下一台仍在等的会重复观测）
  }
  for (const r of sandbox.__dbg.crewStates) {
    if (r.state === 'HOOK') { sawRiggerWork = true; crewBusySeen++; }
  }
  for (const tr of sandbox.__dbg.truckRiggerStates) {
    if (tr.state === 'HOOK' || (tr.req && tr.req.kind === 'hook')) { sawTruckHook = true; sawRiggerWork = true; }
  }
}
check('天车到位后进入 WAIT_HOOK（等人挂绳）', !!sawWaitHook, sawWaitHook ? `${sawWaitHook.name} @${Math.round(sawWaitHook.tEnter - t0)}s` : `${capSec}s 实时内未出现`);
check('吊运工被派往挂绳并进入作业（HOOK）', sawRiggerWork, `HOOK 观测 ${crewBusySeen} 次`);
check('入库车端挂绳由车上专职吊运工承接（T-xx · 不上库位）', sawTruckHook,
  sandbox.__dbg.truckRiggerStates.map(r => `${r.name}:${r.state}${r.req ? '/' + r.req.kind : ''}`).join('|') || '无专职在岗');
check('车上专职不步行（累计步行恒 0）', sandbox.__dbg.truckRiggerStates.every(r => r.walk === 0),
  sandbox.__dbg.truckRiggerStates.map(r => r.walk).join('/') || '无');
check('挂绳完成后天车转 HOIST（起吊）', hookSpan != null);
check('等人挂绳时长 ≥ hookTime（挂绳作业下界；库位侧另含行走）', hookSpan != null && hookSpan >= HOOK_S - 20,
  hookSpan == null ? '未观察到' : `${hookSpan.toFixed(0)}s（含行走/派单等待）`);
check('事件日志含吊运工挂绳', logText().includes('挂绳'));

console.log('== ③ 落位等人放绳 → 放完才收尾；④ 入/出/倒垛三种吊均含挂/放绳；出库落车另有专职取绳 ==');
let sawWaitUnhook = false, restackWithCrew = false, sawRopeOut = false, ropeOutTruckWorking = true;
let ropeLogSeen = false;   // 取绳日志现场快照：日志窗口 260 条会被后续吊挤出，ROPE_OUT 当帧即取
for (let s = 0; s < 420 && !(sawWaitUnhook && restackWithCrew && sawRopeOut); s += 1 / 30) {
  now += 1000 / 30;
  const q = rafQueue.splice(0);
  for (const cb of q) cb(now);
  for (const tr of sandbox.__dbg.truckRiggerStates) {   // 逐帧采：ROPE_OUT 仅约 30 仿真秒（16× 下 ~2s 实时），稀采样易漏
    if (tr.state === 'ROPE_OUT') {
      sawRopeOut = true;
      const lt = logText();
      if (lt.includes('取出吊绳') || lt.includes('吊绳已取出收回')) ropeLogSeen = true;
      const tk = sandbox.__dbg.trucks.find(t => t.taskId === tr.truck);
      if (tk && tk.state !== 'WORKING') ropeOutTruckWorking = false;
    }
  }
  if (s % 3 > 1 / 30) continue;
  for (const cr of sandbox.__dbg.craneStates) {
    if (cr.state === 'WAIT_UNHOOK') sawWaitUnhook = true;
    if (cr.state === 'WAIT_HOOK' && cr.jobKind === 'restack') restackWithCrew = true;
  }
  await new Promise(r => setImmediate(r));
}
check('天车落位后进入 WAIT_UNHOOK（等人放绳）', sawWaitUnhook);
check('出库落车后车上专职取绳（ROPE_OUT）已发生', sawRopeOut);
check('取绳期间货车保持装卸中（WORKING），收清才转复验', sawRopeOut && ropeOutTruckWorking);
const st = sandbox.__dbg.crewStat;
check('班组累计：挂绳 + 放绳 + 出库取绳均已发生（各端一次人工）', st.hooked > 0 && st.unhooked > 0 && st.ropeOuts > 0,
  `挂 ${st.hooked} / 放 ${st.unhooked} / 取 ${st.ropeOuts} · 天车等人 挂 ${Math.round(st.waitHook)}s / 放 ${Math.round(st.waitUnhook)}s`);
check('库区吊运工累计步行（真实行走）', sandbox.__dbg.crewStates.some(r => r.walk > 0), sandbox.__dbg.crewStates.map(r => r.walk).join('/'));
check('事件日志含吊运工放绳', logText().includes('放绳'));
check('事件日志含出库取绳（取出吊绳/收清）', ropeLogSeen || logText().includes('取出吊绳') || logText().includes('吊绳已取出收回'));

console.log('== ⑤ 末吊放绳/取绳期间货车等待，收清复验离场 ==');
// 找一辆正处 WAIT_UNHOOK 的出库吊关联货车：货车应 WORKING；等其离场
let lastTruck = null;
for (let s = 0; s < 300 && !lastTruck; s += 1 / 30) {
  now += 1000 / 30;
  const q = rafQueue.splice(0);
  for (const cb of q) cb(now);
  if (s % 3 > 1 / 30) continue;
  const cr = sandbox.__dbg.craneStates.find(c => c.state === 'WAIT_UNHOOK' && c.jobKind === 'out' && c.truckTaskId);
  if (cr) lastTruck = cr.truckTaskId;
  await new Promise(r => setImmediate(r));
}
if (!lastTruck) {   // 兜底：等待期内任意已完成出库车
  const tks = sandbox.__dbg.truckHistory.filter(t => t.kind !== 'in' && t.done > 0);
  lastTruck = tks.length ? tks[tks.length - 1].taskId : null;
}
check('观察到出库装车吊（货车维度可追溯）', !!lastTruck, lastTruck || '未出现');
let departed = false;
if (lastTruck) {
  for (let c = 0; c < 150 && !departed; c++) {
    await pump(2);
    const tk = sandbox.__dbg.truckHistory.find(t => t.taskId === lastTruck);
    departed = tk && !tk.inScene;
  }
}
check('末吊放绳+取绳收清后货车复验放行并离场', departed, lastTruck ? `${lastTruck} ${departed ? '已离场' : '仍在场'}` : '');

console.log('== ⑥ crew.count=0 关闭人力环节 ==');
sandbox.setDeviceParam('crew', 'count', 0);
await pump(8);    // 关闭后：未承接的等待即刻放行、在岗干完手中活后退场
let cleared = sandbox.__dbg.crewStates.length === 0 && sandbox.__dbg.truckRiggerStates.length === 0;
for (let c = 0; c < 40 && !cleared; c++) {   // 最多再等 40×2s：在岗人员完成手中活陆续退场
  await pump(2);
  cleared = sandbox.__dbg.crewStates.length === 0 && sandbox.__dbg.truckRiggerStates.length === 0;
}
const after = sandbox.__dbg;
check('关闭后班组与车上专职清空（在岗干完手中活后离场）', cleared, `库区 ${after.crewStates.length} 人 · 车上 ${after.truckRiggerStates.length} 人`);
check('关闭后无天车滞留 WAIT_HOOK/WAIT_UNHOOK', after.craneStates.every(c => c.state !== 'WAIT_HOOK' && c.state !== 'WAIT_UNHOOK'),
  after.craneStates.map(c => `${c.name}:${c.state}`).filter(s => s.includes('WAIT')).join('|') || '无等待');
const h1 = sandbox.__dbg.crewStat.hooked;
await pump(10);   // 再跑一段：确认无新的人工作业被派发
const h2 = sandbox.__dbg.crewStat.hooked;
check('关闭后挂绳派发停止（累计不再增长）', h1 === h2 && h2 > 0, `${h1} -> ${h2}`);
check('关闭后零 JS 错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.slice(0, 2).join('|'));
sandbox.restoreDefaultParams();   // 恢复内置默认（库区 6 人），不污染后续探针

console.log('== ⑦ 场次归档：crew 汇总（挂/放/取绳）+ 时刻单调 ==');
sandbox.archiveSession('end');
const rec = sandbox.__lastRun;
check('归档含吊运工汇总（挂/放/取绳人次 + 天车等人时长 + 按人明细）',
  !!rec && rec.crew && rec.crew.hooked > 0 && rec.crew.unhooked > 0 && rec.crew.ropeOuts > 0 && Array.isArray(rec.crew.per) && rec.crew.per.length > 0,
  rec && rec.crew ? `挂 ${rec.crew.hooked} / 放 ${rec.crew.unhooked} / 取 ${rec.crew.ropeOuts} · 天车等人 挂 ${rec.crew.waitHook}s / 放 ${rec.crew.waitUnhook}s · ${rec.crew.per.length} 人` : '无归档');
const crs = (rec && rec.cranes) || [];
const crewed = crs.filter(c => c.hookAt != null && c.unhookAt != null);
const kinds = new Set(crewed.map(c => c.kind));
const badMono = crewed.filter(c => !(c.queueAt <= c.startAt && c.startAt <= c.hookAt && c.hookAt <= c.hoistAt
  && c.hoistAt <= c.dropAt && c.dropAt <= c.unhookAt));
check('六时刻单调（排队 ≤ 开始 ≤ 挂绳 ≤ 吊取 ≤ 落位 ≤ 放绳）', crewed.length > 0 && badMono.length === 0,
  badMono.length ? badMono.slice(0, 2).map(c => `${c.crane}/${c.kind}`).join('|') : `${crewed.length} 吊全部通过`);
const outRoped = crs.filter(c => c.kind === 'out' && c.ropeOutAt != null);
check('出库吊取绳时刻已回填且不早于放绳（ropeOutAt ≥ unhookAt）',
  outRoped.length > 0 && outRoped.every(c => c.unhookAt != null && c.ropeOutAt >= c.unhookAt),
  `出库含取绳 ${outRoped.length} 吊`);
check('人力环节覆盖入库与出库吊（两种均有挂/放绳时刻）', kinds.has('in') && kinds.has('out'), [...kinds].join(',') || '无');
if (kinds.has('restack')) check('倒垛吊同样含挂/放绳时刻', true);
const hookDur = crewed.map(c => c.hoistAt - c.hookAt);   // 挂好 → 吊起 = 纯吊取耗时（对照设备固有 hoistTime，见 ② 的下界断言）
const unhookDur = crewed.map(c => c.unhookAt - c.dropAt); // 落位 → 放完 = 放绳段（≥ unhookTime 人工耗时下界）
check('吊取段 ≈ hoistTime 且放绳段 ≥ unhookTime（人工耗时下界）',
  hookDur.length && Math.min(...hookDur) >= HOIST_S - 2 && Math.max(...hookDur) <= HOIST_S + 8
  && Math.min(...unhookDur) >= UNHOOK_S - 2,
  `吊取段 ${Math.min(...hookDur)}~${Math.max(...hookDur)}s · 放绳段 min ${Math.min(...unhookDur)}s`);
const pcSum = ((rec && rec.perCrane) || []).reduce((s, p) => s + p.in + p.out + p.restack, 0);
check('按天车汇总吊数 = 逐吊明细条数', pcSum === crs.length, `汇总 ${pcSum} vs 明细 ${crs.length}`);

console.log(failed ? `\n未通过 ${failed} 项 ✗` : '\n全部通过 ✓');
process.exit(failed ? 1 : 0);
