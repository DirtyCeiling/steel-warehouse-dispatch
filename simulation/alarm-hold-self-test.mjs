// 无头自检：机器狗异常挂起 -> 管理工平板处置 -> 恢复原任务 闭环（阻断式异常链路）。
// 链路：沙盘注入异常（扫码二维码污损重扫超限 / 行进卡死 / 到位硬件损坏）
//   -> 机器狗转 FAULT 停机、任务与同垛批量队列原样挂起 -> alarm.raise 推操作端报警中心
//   -> 管理工平板选处置方式确认 -> POST /api/frontend/commands { kind: 'alarm-handled' }
//   -> 沙盘认领：resumeFromFault 按故障类型恢复（补扫通过 / 脱困续走 / 检修复位）
//   -> 原任务完成、alarm.closed（resumed）回推闭环。
// 断言：①扫码异常阻断（默认 100%）：FAULT 挂起 + 报警事件 + 任务保留 + 挂起期零完成；
//   ②处置命令恢复补扫：转出 FAULT、原任务完成、alarm.closed resumed、回执 ok、日志留痕；
//   ③卡死：行进途中挂起 + 设备故障报警 + 现场复位后原任务完成；
//   ④损坏：到位对位挂起 + 检修后回原节拍续跑；
//   ⑤防御：未知报警号处置回执 ok 不误恢复；⑥scanHoldPct=0 回退旧行为（自动放行不挂起）。
// 用法：node simulation/alarm-hold-self-test.mjs
import { readFileSync } from 'node:fs';
import { injectCoreSegs } from './sandbox-page-loader.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = injectCoreSegs(readFileSync(join(here, '调度仿真沙盘.html'), 'utf8'));
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];

/* ---- DOM/Canvas 桩（与 crane-confirm-self-test.mjs 同款黑洞桩） ---- */
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
    URLSearchParams,
    location: { search },
  };
  // fetch 桩：必须在 runInContext 前挂上 —— 集成块（事件回推/命令轮询）在脚本求值时判定 typeof fetch
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
  vm.runInContext(`Math.random = (() => { let s = 20261004; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();`, sandbox);
  vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });
  sandbox.setPaused(false);   // 沙盘默认暂停：载入后立即开跑
  sandbox.setSpeed(24);
  sandbox.setDeviceParam('crew', 'count', 0);   // 关人力环节：吊运节奏加快，缩短自检时长（与异常链路正交）
  sandbox.setDeviceParam('robot', 'scanTime', 5);   // 扫码核验 120s -> 5s：缩短闭环时长（与异常注入/恢复逻辑正交）
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
/** 有界等待：条件满足即返回 true，超时返回当前值 */
async function waitUntil(fn, tries, pumpSecs, pump) {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v) return v;
    await pump(pumpSecs);
  }
  return fn();
}
/** 等事件批次冲刷（事件回推为真实 1s 定时器，__pump 只推进模拟钟） */
async function waitEvent(state, pred, tries = 30) {
  for (let i = 0; i < tries && !state.eventLog.some(pred); i++)
    await new Promise(r => setTimeout(r, 100));
  return state.eventLog.find(pred);
}
/** 推进仿真并消耗真实时间（命令认领/事件冲刷均为真实 1s 定时器：纯 __pump 不走真实钟） */
async function pumpReal(pump, simSecs, realMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < realMs) {
    await pump(simSecs);
    await new Promise(r => setTimeout(r, 60));
  }
}

/* =====================================================================
 * 阶段一：扫码异常（二维码污损）阻断 -> 处置 -> 补扫恢复
 * ===================================================================== */
console.log('== 扫码异常阻断闭环（scanFailPct=100 · maxScanRetries=0 · scanHoldPct=100） ==');
const B = mkHarness('');
const sb = B.sandbox;
await sb.__pump(2);
sb.setDeviceParam('abnormal', 'scanFailPct', 100);
sb.setDeviceParam('abnormal', 'maxScanRetries', 0);
sb.setDeviceParam('abnormal', 'scanHoldPct', 100);

let faulted = null;
for (let i = 0; i < 150 && !faulted; i++) {
  await sb.__pump(2);
  faulted = sb.__dbg.robots.find(r => r.state === 'FAULT') || null;
}
check('① 扫码异常挂起：机器狗转 FAULT 停机', !!faulted,
  faulted ? `${faulted.name} · fault=${JSON.stringify(faulted.fault && { kind: faulted.fault.kind, alarmId: faulted.fault.alarmId })}` : '150×2s 内未触发');
if (faulted) {
  const alarmId = faulted.fault.alarmId;
  const heldTaskId = faulted.task && faulted.task.id;
  check('① 挂起保留原任务（task 未弃单）', !!heldTaskId, heldTaskId || 'task=null');
  check('① 挂起保留同垛批量队列', Array.isArray(faulted.batch), `batch=${faulted.batch.length}`);
  const raise = await waitEvent(sb.__t, e => e.type === 'alarm.raise' && e.payload && e.payload.alarmId === alarmId);
  check('① alarm.raise 事件回推操作端（识别失败 · 带机器狗/任务号）', !!raise,
    raise ? JSON.stringify(raise.payload) : `eventLog=${sb.__t.eventLog.filter(e => e.type === 'alarm.raise').length} 条 raise`);
  check('① 报警事件字段完整（type/robot/taskId/desc）',
    raise && raise.payload.type === '识别失败' && raise.payload.robot === faulted.name && raise.payload.taskId === heldTaskId,
    raise ? `${raise.payload.type} · ${raise.payload.robot} · ${raise.payload.taskId}` : '');
  check('① 日志留痕：二维码污损挂起等现场处置', B.logText().includes('挂起任务原地等待现场处置'));

  // 挂起期间不完成任何扫码任务
  const doneBefore = sb.__dbg.robots.reduce((n, r) => n + r.tasksDone, 0);
  await sb.__pump(8);
  const doneAfter = sb.__dbg.robots.reduce((n, r) => n + r.tasksDone, 0);
  check('② 挂起期间该狗零完成任务（阻断生效，等管理工处置）',
    doneAfter === doneBefore, `${doneBefore} -> ${doneAfter}`);

  // 管理工平板处置：alarm-handled 命令（refId=报警号，method=清洁二维码）
  sb.__t.cmdQueue.push({ id: 9101, kind: 'alarm-handled', refId: alarmId, payload: { method: '清洁二维码' } });
  let resumed = null;
  await pumpReal(sb.__pump, 1, 2500);
  resumed = sb.__dbg.robots.find(r => r.name === faulted.name && r.state !== 'FAULT') || null;
  check('③ 处置命令恢复：机器狗转出 FAULT（原地补扫）', !!resumed, resumed ? resumed.state : '仍 FAULT');
  check('③ 命令回执 ok', sb.__t.cmdResults[9101]?.ok === true, JSON.stringify(sb.__t.cmdResults[9101] || {}));
  check('③ 日志留痕：处置后补扫任务恢复', B.logText().includes('现场处置（清洁二维码）后补扫'));
  sb.setDeviceParam('abnormal', 'scanFailPct', 0);   // 处置闭环后关注入：④ 断言不受其他狗/二次扫码异常干扰

  // 恢复后原任务完成（该狗 tasksDone 增加）
  const dogDoneBefore = sb.__dbg.robots.find(r => r.name === faulted.name).tasksDone;
  const finished = await waitUntil(() => sb.__dbg.robots.find(r => r.name === faulted.name).tasksDone > dogDoneBefore, 120, 2, sb.__pump);
  check('④ 原任务完成（补扫通过 -> 回传 -> tasksDone +1）', !!finished,
    `${dogDoneBefore} -> ${sb.__dbg.robots.find(r => r.name === faulted.name).tasksDone}`);
  const closed = await waitEvent(sb.__t, e => e.type === 'alarm.closed' && e.payload && e.payload.alarmId === alarmId);
  check('④ alarm.closed 回推闭环（resumed=true · 带恢复任务号）',
    !!closed && closed.payload.resumed === true && closed.payload.taskId === heldTaskId,
    closed ? JSON.stringify(closed.payload) : '未见 closed 事件');
  check('④ 后续任务正常执行（处置狗不再挂起、继续接单）',
    sb.__dbg.robots.find(r => r.name === faulted.name).state !== 'FAULT',
    sb.__dbg.robots.find(r => r.name === faulted.name).state);
}

/* =====================================================================
 * 阶段二：机器狗行进卡死 -> 现场复位 -> 原任务续跑
 * ===================================================================== */
console.log('== 机器狗卡死闭环（dogStuckPct=100） ==');
const C = mkHarness('');
const sc = C.sandbox;
await sc.__pump(2);
sc.setDeviceParam('abnormal', 'scanFailPct', 0);   // 排除扫码异常干扰
sc.setDeviceParam('abnormal', 'scanHoldPct', 0);
sc.setDeviceParam('abnormal', 'dogStuckPct', 100);

let stuck = null;
for (let i = 0; i < 150 && !stuck; i++) {
  await sc.__pump(2);
  stuck = sc.__dbg.robots.find(r => r.state === 'FAULT' && r.fault && r.fault.kind === 'stuck') || null;
}
check('① 行进卡死挂起：FAULT(stuck)，故障前状态为导航中', !!stuck,
  stuck ? `${stuck.name} · prevState=${stuck.fault.prevState} · alarm=${stuck.fault.alarmId}` : '未触发');
if (stuck) {
  const alarmId = stuck.fault.alarmId;
  const heldTaskId = stuck.task && stuck.task.id;
  check('① 卡死保留原任务与路径（恢复后从当前位置续走）', !!heldTaskId && !!stuck.path, `${heldTaskId} · 剩余路点 ${stuck.path ? stuck.path.length - stuck.pathIdx : 0}`);
  const raise = await waitEvent(sc.__t, e => e.type === 'alarm.raise' && e.payload && e.payload.alarmId === alarmId);
  check('① alarm.raise 事件（设备故障 · kind=stuck · 带机器狗）',
    !!raise && raise.payload.type === '设备故障' && raise.payload.kind === 'stuck' && raise.payload.robot === stuck.name,
    raise ? JSON.stringify(raise.payload) : '未见 raise');

  const doneBefore = sc.__dbg.robots.find(r => r.name === stuck.name).tasksDone;
  await sc.__pump(8);
  check('② 卡死期间零完成任务', sc.__dbg.robots.find(r => r.name === stuck.name).tasksDone === doneBefore);

  sc.__t.cmdQueue.push({ id: 9201, kind: 'alarm-handled', refId: alarmId, payload: { method: '现场复位' } });
  let resumed2 = null;
  await pumpReal(sc.__pump, 1, 2500);
  resumed2 = sc.__dbg.robots.find(r => r.name === stuck.name && r.state !== 'FAULT') || null;
  sc.setDeviceParam('abnormal', 'dogStuckPct', 0);   // 处置闭环后关注入：后续断言不受二次卡死干扰
  check('③ 现场复位：恢复导航（转出 FAULT 续走原路径）', !!resumed2, resumed2 ? resumed2.state : '仍 FAULT');
  check('③ 命令回执 ok', sc.__t.cmdResults[9201]?.ok === true, JSON.stringify(sc.__t.cmdResults[9201] || {}));
  check('③ 日志留痕：现场复位脱困恢复原任务', C.logText().includes('现场复位脱困'));

  const dogDone = sc.__dbg.robots.find(r => r.name === stuck.name).tasksDone;
  const finished2 = await waitUntil(() => sc.__dbg.robots.find(r => r.name === stuck.name).tasksDone > dogDone, 150, 2, sc.__pump);
  check('④ 原任务完成（脱困续走 -> 抵达 -> 扫码回传）', !!finished2,
    `${dogDone} -> ${sc.__dbg.robots.find(r => r.name === stuck.name).tasksDone}`);
  const closed2 = await waitEvent(sc.__t, e => e.type === 'alarm.closed' && e.payload && e.payload.alarmId === alarmId);
  check('④ alarm.closed 回推闭环（resumed）', !!closed2 && closed2.payload.resumed === true, closed2 ? JSON.stringify(closed2.payload) : '');
}

/* =====================================================================
 * 阶段三：机器狗硬件损坏 -> 检修 -> 回原节拍续跑
 * ===================================================================== */
console.log('== 机器狗硬件损坏闭环（dogBreakdownPct=100） ==');
const D = mkHarness('');
const sd = D.sandbox;
await sd.__pump(2);
sd.setDeviceParam('abnormal', 'scanFailPct', 0);
sd.setDeviceParam('abnormal', 'scanHoldPct', 0);
sd.setDeviceParam('abnormal', 'dogStuckPct', 0);
sd.setDeviceParam('abnormal', 'dogBreakdownPct', 100);

let broke = null;
for (let i = 0; i < 150 && !broke; i++) {
  await sd.__pump(2);
  broke = sd.__dbg.robots.find(r => r.state === 'FAULT' && r.fault && r.fault.kind === 'breakdown') || null;
}
check('① 到位损坏挂起：FAULT(breakdown)，故障前为转身对位', !!broke,
  broke ? `${broke.name} · prevState=${broke.fault.prevState} · alarm=${broke.fault.alarmId}` : '未触发');
if (broke) {
  const alarmId = broke.fault.alarmId;
  const raise = await waitEvent(sd.__t, e => e.type === 'alarm.raise' && e.payload && e.payload.alarmId === alarmId);
  check('① alarm.raise 事件（设备故障 · kind=breakdown）',
    !!raise && raise.payload.type === '设备故障' && raise.payload.kind === 'breakdown', raise ? JSON.stringify(raise.payload) : '');

  sd.__t.cmdQueue.push({ id: 9301, kind: 'alarm-handled', refId: alarmId, payload: { method: '检修恢复' } });
  // 等第一次故障解除（fault 清空或换新报警号）：dogBreakdownPct=100 下完成原任务后接新单会再次故障，只认第一次恢复
  let firstResume = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !firstResume) {
    await sd.__pump(1);
    await new Promise(r => setTimeout(r, 80));
    const r = sd.__dbg.robots.find(x => x.name === broke.name);
    if (r && (!r.fault || r.fault.alarmId !== alarmId)) firstResume = r;
  }
  sd.setDeviceParam('abnormal', 'dogBreakdownPct', 0);   // 关闭后续注入：原任务收尾断言不受二次故障干扰
  check('② 检修完成：第一次故障解除（回原节拍续跑）', !!firstResume,
    firstResume ? `state=${firstResume.state} · fault=${firstResume.fault ? firstResume.fault.alarmId : '已清除'}` : '仍 FAULT');
  check('② 命令回执 ok', sd.__t.cmdResults[9301]?.ok === true, JSON.stringify(sd.__t.cmdResults[9301] || {}));
  check('② 日志留痕：现场检修恢复回原节拍', D.logText().includes('现场检修恢复'));
  const dogDone = sd.__dbg.robots.find(r => r.name === broke.name).tasksDone;
  const finished3 = await waitUntil(() => sd.__dbg.robots.find(r => r.name === broke.name).tasksDone > dogDone, 150, 2, sd.__pump);
  check('③ 原任务完成（重新对位 -> 扫码 -> 回传）', !!finished3,
    `${dogDone} -> ${sd.__dbg.robots.find(r => r.name === broke.name).tasksDone}`);
  const closed3 = await waitEvent(sd.__t, e => e.type === 'alarm.closed' && e.payload && e.payload.alarmId === alarmId);
  check('③ alarm.closed 回推闭环（resumed）', !!closed3 && closed3.payload.resumed === true, closed3 ? JSON.stringify(closed3.payload) : '');
}

/* =====================================================================
 * 阶段四：防御与回退 —— 未知报警号处置幂等；scanHoldPct=0 旧行为
 * ===================================================================== */
console.log('== 防御与回退 ==');
const E = mkHarness('');
const se = E.sandbox;
await se.__pump(2);
se.setDeviceParam('abnormal', 'scanFailPct', 100);
se.setDeviceParam('abnormal', 'maxScanRetries', 0);
se.setDeviceParam('abnormal', 'scanHoldPct', 0);   // 旧行为：超限自动人工介入放行，不挂起

let anyFault = null;
for (let i = 0; i < 120; i++) {
  await se.__pump(2);
  if (se.__dbg.robots.some(r => r.state === 'FAULT')) { anyFault = true; break; }
  if (se.__dbg.abnormal.manualOverride >= 1) break;   // 走到旧放行路径即可
}
check('⑤ scanHoldPct=0 回退旧行为：超限自动放行（不进 FAULT 挂起）',
  !anyFault && se.__dbg.abnormal.manualOverride >= 1,
  `manualOverride=${se.__dbg.abnormal.manualOverride} · fault=${anyFault}`);
check('⑤ 旧路径日志留痕：人工介入核验放行', E.logText().includes('人工介入核验放行'));

// 未知报警号处置：回执 ok（非阻断类报警确认即闭环），不误恢复任何狗
se.__t.cmdQueue.push({ id: 9401, kind: 'alarm-handled', refId: 'BJ-S9999', payload: { method: '现场处置' } });
await pumpReal(se.__pump, 1, 2500);
check('⑥ 未知报警号处置：回执 ok 且不误恢复', se.__t.cmdResults[9401]?.ok === true && se.__dbg.robots.every(r => r.state !== 'FAULT'),
  JSON.stringify(se.__t.cmdResults[9401] || {}));

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
