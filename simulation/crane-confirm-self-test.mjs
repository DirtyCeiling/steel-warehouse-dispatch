// 无头自检：天车完工人工确认闭环（人因环节：完工回汽车通道上方 → 天车工平板确认 → 命令放行沙盘）。
// 链路：天车完成一个调运任务（整车装卸 / 一张提货订单 / 一组倒垛的末吊）→ 转 WAIT_CONFIRM 驶回汽车通道上方待命
//   → 遥测 awaitConfirm/awaitDesc 下发操作端（平板弹「确认上个任务已完成」）
//   → 操作端 POST /api/frontend/commands { kind: 'crane-confirm' } → 沙盘认领执行 releaseCraneConfirm
//   → 天车恢复接单。未确认前该天车不接新活（同跨搭档被挡时先让位）。
// 断言：①内置默认关（URL/参数驱动才开，自测/无人值守不踩闸门）；②?confirm=1 强制开后，
//   完整任务收尾必转 WAIT_CONFIRM、回位坐标在汽车通道上方、日志/遥测留痕；
//   ③等待期不接新活；④crane-confirm 命令放行（结果 ok、日志留痕）；⑤放行后恢复接新吊；
//   ⑥默认关时全流程无人值守可完成（无 WAIT_CONFIRM）；⑦「调度参数」页路径（setDeviceParam）开闸同样生效。
// 用法：node simulation/crane-confirm-self-test.mjs
import { readFileSync } from 'node:fs';
import { injectCoreSegs } from './sandbox-page-loader.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = injectCoreSegs(readFileSync(join(here, '调度仿真沙盘.html'), 'utf8'));
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];

/* ---- DOM/Canvas 桩（与 self-test.mjs 同款黑洞桩） ---- */
const absorber = new Proxy(function () {}, {
  get(t, p) { if (p === Symbol.toPrimitive) return () => 0; return absorber; },
  set() { return true; },
  apply() { return absorber; },
});
function mkHarness(search) {
  const elements = new Map();
  const makeEl = (id = '') => ({
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
  });
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
  const state = { teleLog: [], eventLog: [], cmdQueue: [], cmdResults: {} };
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
    URLSearchParams,               // ?confirm= 等 URL 参数解析（self-test.mjs 同款注入）
    location: { search },          // ?confirm=1/0 强制开关闸门（不带 = 按 CFG/调度参数页）
  };
  // fetch 桩：必须在 runInContext 前挂上 —— 集成块（遥测/命令轮询）在脚本求值时判定 typeof fetch
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  sandbox.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    const m = u.match(/\/api\/frontend\/commands\/(\d+)\/finish/);
    if (m) { state.cmdResults[+m[1]] = body; return json({ ok: true }); }
    if (u.includes('/api/frontend/commands') && u.includes('claim=1')) {
      const cmds = state.cmdQueue.splice(0).map(c => ({ ...c, status: 'claimed' }));
      return json({ commands: cmds });
    }
    if (u.includes('/api/frontend/commands')) return json({ ok: true });
    if (u.includes('/api/telemetry')) { state.teleLog.push(body); return json({ ok: true }); }
    if (u.includes('/api/events')) {
      if (opts.method === 'POST' && Array.isArray(body?.events)) state.eventLog.push(...body.events);
      return json({ events: [], latest: 0 });
    }
    if (u.includes('/api/params')) return json({ schema: [], values: {} });
    if (u.includes('/api/bundle-rules')) return json({ rules: [] });
    return json({ ok: true });   // 库存/捆位写回、进厂登记等 fire-and-forget 全部吞掉
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`Math.random = (() => { let s = 20260824; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();`, sandbox);
  vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });
sandbox.setPaused(false);   // 沙盘默认暂停：载入后立即开跑
sandbox.setSpeed(24);
sandbox.setDeviceParam('crew', 'count', 0);   // 关人力环节：吊运节奏加快，缩短自检时长（与闸门逻辑正交）
sandbox.setDeviceParam('abnormal', 'scanHoldPct', 0);   // 关扫码异常阻断（随机消耗序列与旧行为一致）：本自检无人处置报警，避免机器狗 FAULT 挂起（异常闭环见 alarm-hold-self-test.mjs）
  sandbox.__t = state;
  sandbox.__pump = async (realSeconds, fps = 30) => {
    const frames = Math.round(realSeconds * fps);
    for (let i = 0; i < frames; i++) {
      now += 1000 / fps;
      const q = rafQueue.splice(0);
      for (const cb of q) cb(now);
    }
    await new Promise(r => setImmediate(r));
  };
  return { sandbox, rafQueue, logText: () => elements.get('logList')?.children.map(d => d.innerHTML).join('\n') || '' };
}

let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
};
const LANE_X = [45.8, 145.8, 245.8];      // 三条汽车通道中心 x（与 cellCX(7/19/31) 一致）
const SPAN_CY = [17, 49, 81];             // A/B/C 跨中心 y（与 cellCY(SPAN_ROWS) 一致）

/* =====================================================================
 * 阶段一：?confirm=1 强制开闸 —— 完工待确认 → 平板确认命令 → 放行恢复
 * ===================================================================== */
console.log('== 天车完工人工确认闭环（?confirm=1） ==');
const B = mkHarness('?confirm=1');
const sb = B.sandbox;
await sb.__pump(2);

check('① 内置默认关（CFG.crane.confirmGate = 0，闸门由 URL/参数驱动）', sb.__dbg.craneCfg.confirmGate === 0, JSON.stringify(sb.__dbg.craneCfg));

// 等第一辆车的完整调运任务收尾 → WAIT_CONFIRM
let waiter = null;
for (let i = 0; i < 150 && !waiter; i++) {
  await sb.__pump(2);
  waiter = sb.__dbg.craneStates.find(c => c.state === 'WAIT_CONFIRM') || null;
}
check('② 完成整车调运任务后转入完工待确认（WAIT_CONFIRM）', !!waiter, JSON.stringify(sb.__dbg.craneStates.map(c => `${c.name}:${c.state}`)));
if (waiter) {
  check('② 上个任务描述随遥测下发（入库吊运/出库装车/倒垛）', /(入库吊运|出库装车|倒垛)/.test(waiter.awaitDesc || ''), waiter.awaitDesc);
  check('② 待命位在汽车通道上方（x 为三条通道中心之一 · y 为所在跨中心）',
    LANE_X.includes(waiter.awaitAt?.x) && SPAN_CY.includes(waiter.awaitAt?.y), JSON.stringify(waiter.awaitAt));
  check('② 日志留痕：完工回汽车通道上方待命', B.logText().includes('已回到汽车通道上方待命'));
  // 遥测按真实时间 1s 定时推送（__pump 只推进模拟钟）：断言前有界等待至少一帧含该天车（上界 4s）
  for (let w = 0; w < 40 && !sb.__t.teleLog.some(t => (t?.cranes || []).some(c => c.name === waiter.name)); w++)
    await new Promise(r => setTimeout(r, 100));
  check('② 遥测携带 awaitConfirm + awaitDesc（操作端平板据此弹确认卡）',
    sb.__t.teleLog.some(t => (t?.cranes || []).some(c => c.name === waiter.name && c.awaitConfirm === true && c.awaitDesc === waiter.awaitDesc)),
    `遥测帧数 ${sb.__t.teleLog.length}`);

  // 等待期不接新活
  const jobsBefore = waiter.jobsDone;
  await sb.__pump(6);
  const hold = sb.__dbg.craneStates.find(c => c.name === waiter.name);
  check('③ 未确认前不接新任务（不派活、不下吊）', hold.state === 'WAIT_CONFIRM' && hold.jobsDone === jobsBefore,
    `${hold.state} · ${hold.jobsDone}/${jobsBefore}`);

  // 天车工平板确认 → crane-confirm 命令 → 沙盘放行
  sb.__t.cmdQueue.push({ id: 9001, kind: 'crane-confirm', refId: waiter.name, payload: { crane: waiter.name } });
  let released = null;
  for (let i = 0; i < 20 && !released; i++) {
    await sb.__pump(1);
    const c = sb.__dbg.craneStates.find(x => x.name === waiter.name);
    if (c.state !== 'WAIT_CONFIRM') released = c;
  }
  check('④ 命令放行：天车工确认后转出待确认', !!released, released ? released.state : '仍 WAIT_CONFIRM');
  check('④ 命令回执 ok（finish result）', sb.__t.cmdResults[9001]?.ok === true, JSON.stringify(sb.__t.cmdResults[9001] || {}));
  check('④ 日志留痕：天车工确认 · 恢复接单', B.logText().includes('天车工确认') && B.logText().includes('恢复接单派活'));

  // 放行后恢复接新吊：放行后该天车不再挂 WAIT_CONFIRM（恢复接单能力），且出库整体继续推进。
  // 注意跨约束：若放行的是 C 跨天车而下一批出库在 A/B 跨（随机种子决定），它跨跨干不了、只能等下一辆 C 跨车——
  // 「jobsDone 立即 +1」在此情形下不成立，故语义取「闸门放行 + 出库进度继续」（其余天车推进，jobsDone 总和增）。
  let resumed = false;
  if (released) {
    const totalJobsAfterRelease = sb.__dbg.craneStates.reduce((n, c) => n + c.jobsDone, 0);
    let seq = 9100;
    const t0 = Date.now();
    while (!resumed && Date.now() - t0 < 45000) {   // 真实 45s 上限：放行挡路天车 + 等出库整体推进
      const blocked = sb.__dbg.craneStates.find(c => c.state === 'WAIT_CONFIRM');
      if (blocked) {
        const id = seq++;
        sb.__t.cmdQueue.push({ id, kind: 'crane-confirm', refId: blocked.name, payload: { crane: blocked.name } });
        for (let w = 0; w < 30 && !sb.__t.cmdResults[id]; w++) await new Promise(r => setTimeout(r, 100));   // 等认领回执
      }
      await sb.__pump(2);
      const w = sb.__dbg.craneStates.find(c => c.name === waiter.name);
      const totalNow = sb.__dbg.craneStates.reduce((n, c) => n + c.jobsDone, 0);
      resumed = (w.state !== 'WAIT_CONFIRM') && (totalNow > totalJobsAfterRelease);
    }
  }
  check('⑤ 放行后闸门解除且出库整体继续推进', resumed,
    String(sb.__dbg.craneStates.find(c => c.name === waiter.name).state) + ' · 总吊数 ' +
    sb.__dbg.craneStates.reduce((n, c) => n + c.jobsDone, 0));

  // 未知天车 / 重复确认防御
  sb.__t.cmdQueue.push({ id: 9002, kind: 'crane-confirm', refId: 'TC-X9', payload: { crane: 'TC-X9' } });
  for (let i = 0; i < 20 && !sb.__t.cmdResults[9002]; i++) await sb.__pump(1);   // 命令轮询为真实 1s 定时器：轮询等回执
  check('④ 防御：未知天车命令回执失败（error）', sb.__t.cmdResults[9002]?.ok === false, JSON.stringify(sb.__t.cmdResults[9002] || {}));
} else {
  check('② 上个任务描述随遥测下发', false, '未进入 WAIT_CONFIRM（150×2s 实时 @24× 未完成整车任务）');
}

/* =====================================================================
 * 阶段二：默认（不带 ?confirm）—— 闸门关，无人值守全流程可完成
 * ===================================================================== */
console.log('== 默认关闸：无人值守全流程可完成 ==');
const A = mkHarness('');
const sa = A.sandbox;
await sa.__pump(2);
let sawWaiting = false;
for (let i = 0; i < 200 && sa.__dbg.trucksDone < 1; i++) {
  await sa.__pump(2);
  if (sa.__dbg.craneStates.some(c => c.state === 'WAIT_CONFIRM')) sawWaiting = true;
}
check('⑥ 默认关闸：整车完成离场（trucksDone ≥ 1）', sa.__dbg.trucksDone >= 1, `trucksDone=${sa.__dbg.trucksDone}`);
check('⑥ 默认关闸：全程无完工待确认', !sawWaiting);

// 「调度参数」页路径开闸（setDeviceParam = 参数页同源入口）→ 下一个整车收尾触发待确认
// 同时设「确认超时放行」= 60 仿真秒：⑦ 观察到待确认后不平板确认 → ⑧ 断言超时兜底自动放行
sa.setDeviceParam('crane', 'confirmTimeout', 60);
sa.setDeviceParam('crane', 'confirmGate', 1);
check('⑦ 调度参数页开闸（craneCfg.confirmGate = 1）', sa.__dbg.craneCfg.confirmGate === 1);
check('⑦ 确认超时放行参数（craneCfg.confirmTimeout = 60）', sa.__dbg.craneCfg.confirmTimeout === 60,
  JSON.stringify(sa.__dbg.craneCfg));
let waiter2 = null;
for (let i = 0; i < 200 && !waiter2; i++) {
  await sa.__pump(2);
  waiter2 = sa.__dbg.craneStates.find(c => c.state === 'WAIT_CONFIRM') || null;
}
check('⑦ 参数开闸后：下一整车收尾转入完工待确认', !!waiter2, waiter2 ? `${waiter2.name} · ${waiter2.awaitDesc}` : '未触发');

// 超时兜底：不发 crane-confirm 命令，待确认超 60 仿真秒自动放行（防平板无人确认全场停摆）
if (waiter2) {
  let timedOut = null;
  for (let i = 0; i < 50 && !timedOut; i++) {
    await sa.__pump(2);
    const c = sa.__dbg.craneStates.find(x => x.name === waiter2.name);
    if (c && c.state !== 'WAIT_CONFIRM') timedOut = c;
  }
  check('⑧ 超时兜底放行：未发确认命令也转出待确认', !!timedOut, timedOut ? timedOut.state : '仍 WAIT_CONFIRM');
  check('⑧ 日志留痕：超时兜底放行', A.logText().includes('超时兜底放行'));
  check('⑧ 计时起点清空（awaitSince 置空，不留悬挂状态）', timedOut && timedOut.awaitSince == null, JSON.stringify(timedOut && { st: timedOut.state, since: timedOut.awaitSince }));
} else {
  check('⑧ 超时兜底放行：未发确认命令也转出待确认', false, '未进入 WAIT_CONFIRM，前置失败');
  check('⑧ 日志留痕：超时兜底放行', false, '前置失败');
  check('⑧ 计时起点清空（awaitSince 置空，不留悬挂状态）', false, '前置失败');
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
