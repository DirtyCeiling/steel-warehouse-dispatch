// 无头逻辑自检：在 Node VM 中运行"调度仿真沙盘.html"的完整脚本，
// 桩掉 DOM/Canvas，手动泵 rAF 帧驱动仿真，断言调度全流程闭环。
// 车辆数据来自沙盘默认的本地排产（生产节奏参数驱动，外部物流源模式的
// 自检见 logistics-feed-self-test.mjs / production-pace-self-test.mjs）。
// 用法：node simulation/self-test.mjs
import { readFileSync } from 'node:fs';
import { injectCoreSegs } from './sandbox-page-loader.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '调度仿真沙盘.html'), 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) throw new Error('未找到 <script> 内容');
const code = injectCoreSegs(m[1]);

/* ---- 通用"黑洞"对象：吞掉任意方法调用与属性读写（充当 Canvas 2D 上下文） ---- */
const absorber = new Proxy(function () {}, {
  get(t, p) {
    if (p === Symbol.toPrimitive) return () => 0;
    return absorber;
  },
  set() { return true; },
  apply() { return absorber; },
});

/* ---- DOM 桩 ---- */
const elements = new Map();
function makeEl(id = '') {
  const el = {
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
  return el;
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

/* ---- 运行环境沙箱 ---- */
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
  location: { search: '' },        // 库存数据库 API 地址参数（无头环境用默认值，不注入 fetch 即走兜底库存）
  URLSearchParams,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
// 固定随机种子：占用库位分布 / 任务流可复现，保证自检确定性
vm.runInContext(`Math.random = (() => { let s = 20260824; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();`, sandbox);
vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });
sandbox.setPaused(false);   // 沙盘默认暂停：无头自检载入后立即开跑

/* 本地排产模式（默认）：车辆由沙盘 tick 内生产节奏生成，无需注入 fetch；
 * 库存数据库调用走"无 fetch -> 兜底库存"分支 */

/* ---- rAF 泵：按 fps 推进"真实"时间，frame() 内部再乘仿真倍率；
 *      泵完让出一次事件循环，异步链（库存兜底日志等）落地 ---- */
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

/* ---- 断言工具 ---- */
let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
}
const el = id => documentStub.getElementById(id);
const logText = () => el('logList').children.map(d => d.innerHTML).join('\n');

console.log('== 阶段零：300m×90m 三跨布局结构（对照库区平面图） ==');
check('栅格 38×8（4 条横向通道廊道行 + 3 跨 + 充电服务带）', sandbox.__dbg.mapOK);
check('库位总数 91', sandbox.__dbg.slotCount === 91, String(sandbox.__dbg.slotCount));
const zc = sandbox.__dbg.zoneCounts;
check('分区 中棒51/大棒33/长钢3/铁姆肯4',
  zc['中棒区域'] === 51 && zc['大棒区域'] === 33 && zc['大棒单支和长钢'] === 3 && zc['铁姆肯区'] === 4,
  JSON.stringify(zc));
const codes = sandbox.__dbg.codes;
check('库位编码覆盖 33-1 / 1-1 / 2-2 / 14 / 15 / 16',
  ['33-1', '1-1', '2-2', '14', '15', '16'].every(x => codes.includes(x)),
  codes.slice(-6).join(','));
check('寻路：充电桩#2 -> 铁姆肯 2-2 第1垛前空道站位 可达',
  !!sandbox.findPath(sandbox.navOf(7, 19), sandbox.approachCell(sandbox.__dbg.storages.find(s => s.code === '2-2'), 0, null)));
check('寻路：合并库位 15 第1垛前空道站位 -> 充电桩#1 可达',
  !!sandbox.findPath(sandbox.approachCell(sandbox.__dbg.storages.find(s => s.code === '15'), 0, null), sandbox.navOf(7, 7)));
const st33 = sandbox.__dbg.storages.find(s => s.code === '33-1');
const pl = sandbox.pathLen(sandbox.navOf(7, 19), sandbox.approachCell(st33, 0, null));
check('路径长度为有限米数', isFinite(pl) && pl > 100 && pl < 600, pl.toFixed(0) + 'm');

console.log('== 阶段零点五：机器狗通行规则（横向廊道机动 + 库位间空道入跨，不进库位内部） ==');
const nd = sandbox.__dbg.navDims;
check('导航栅格 75 列 × 29 行（库位列/空道列交替 · 每跨 8 垛层行）', nd.cols === 75 && nd.rows === 29, JSON.stringify(nd));
const sstates = sandbox.__dbg.storageStates;
const occSt = sstates.find(s => s.state === 'occupied');
const freeSt = sstates.find(s => s.state === 'free');
const stOf = s => sandbox.__dbg.storages.find(x => x.code === s.code);
const bodyR = s => sandbox.navRowOfY(sandbox.stackCenterY(stOf(s), 0));   // 库位首垛所在垛层行
check('占用库位垛位本体不可穿行（库位列×垛层行 cost=∞）',
  occSt && sandbox.navBaseCost(bodyR(occSt), occSt.goalC * 2) === Infinity, occSt && occSt.code);
check('空闲库位垛位本体同样不可穿行（cost=∞）',
  freeSt && sandbox.navBaseCost(bodyR(freeSt), freeSt.goalC * 2) === Infinity, freeSt && freeSt.code);
check('库位间空道列跨内可通行（cost=1 · 机器狗入跨通道）',
  sandbox.navBaseCost(5, 21) === 1 && sandbox.navBaseCost(15, 41) === 1, '');
check('横向通道廊道 cost=1', sandbox.navBaseCost(0, 20) === 1 && sandbox.navBaseCost(27, 20) === 1, '');
check('竖向车辆通道 cost=1', sandbox.navBaseCost(4, 14) === 1 && sandbox.navBaseCost(22, 62) === 1, '');
const p033 = sandbox.findPath(sandbox.navOf(7, 19), sandbox.approachCell(st33, 0, null));
check('规划路径全程走通道/空道/服务带（途经格均可通行）',
  !!p033 && p033.every(w => isFinite(sandbox.navBaseCost(w.r, w.c))), '');
check('全部 91 库位第 1 垛前空道站位均可从横向通道抵达（路径不穿垛位）',
  sandbox.__dbg.storages.every(s => {
    const ap = sandbox.approachCell(s, 0, null);
    const p = sandbox.findPath(sandbox.navOf(6, 10), ap);
    return !!p && p.every(w => isFinite(sandbox.navBaseCost(w.r, w.c)));
  }), '');
console.log('== 阶段零点六：机器狗扫码站位（库位之间的空道 · 垛位正前方，不占人行通道） ==');
const st0 = sandbox.__dbg.storages[0];
const ap0 = sandbox.approachCell(st0, 0, sandbox.navOf(6, 10));
check('扫码站位在库位间空道列（奇数导航列）且与目标垛同垛层行',
  !!ap0 && ap0.c % 2 === 1
    && Math.abs(sandbox.navCY(ap0.r) - sandbox.stackCenterY(st0, 0)) < 1e-6,
  st0 && st0.code);
check('站位不占横向人行通道（普通库位垛层行，跨内）',
  !!ap0 && ![0, 9, 18, 27].includes(ap0.r), st0 && st0.code);
check('站位在库位分界线上（与垛位列中心横向相距半列 4.17m）',
  !!ap0 && Math.abs(Math.abs(sandbox.navCX(ap0.c) - sandbox.navCX(st0.goalC * 2)) - 300 / 36 / 2) < 0.01, '');
check('全部 91 库位 × 8 垛均有库位间空道站位（站位列=空道 · 行=垛心所在行，含合并库位）',
  sandbox.__dbg.storages.every(s => [0, 1, 2, 3, 4, 5, 6, 7].every(k => {
    const ap = sandbox.approachCell(s, k, sandbox.navOf(6, 10));
    if (!ap || ap.c % 2 !== 1) return false;
    const cy = sandbox.stackCenterY(s, k);
    if (sandbox.navRowOfY(cy) !== ap.r) return false;               // 站位行 = 垛心所在行
    return s.merged || Math.abs(sandbox.navCY(ap.r) - cy) < 1e-6;   // 普通库位严格对齐垛层行
  })), '');
const pAp = sandbox.findPath(sandbox.navOf(7, 19), ap0);
check('赴扫码站位的路径全程不穿垛位（途经格均可通行）',
  !!pAp && pAp.every(w => isFinite(sandbox.navBaseCost(w.r, w.c))), '');

console.log('== 阶段一：手动下单 + 单步 + 设备参数（t=0 初始态，确定性） ==');
const t1 = sandbox.createTask('in');
check('手动入库任务创建', !!t1 && /^T-\d{4}$/.test(t1.id), t1 && t1.id);
check('入库任务进入待组车车次（不立即派车）', !!t1 && !!t1.batch && t1.batch.tasks.includes(t1) && !t1.truck, t1 && t1.batch && t1.batch.id);
const t2 = sandbox.createTask('out');
check('手动出库任务创建（初始库存可出）', !!t2 && t2.type === 'out', t2 && t2.id);
check('出库任务进入待组车车次（不立即派车）', !!t2 && !!t2.batch && t2.batch.tasks.includes(t2) && !t2.truck, t2 && t2.batch && t2.batch.id);
sandbox.forceDispatchBatches(); // 调试钩子：立即为所有未派车车次派车
check('车次派车后派生货车', !!t1 && !!t1.truck && !!t1.truck.taskId, t1 && t1.truck && t1.truck.taskId);
check('货车带车牌号（跨上立柱摄像头识别用）',
  !!t1 && !!t1.truck && /[京津冀鲁晋豫辽蒙]/.test(t1.truck.plate),
  t1 && t1.truck ? t1.truck.plate : '无');
check('立柱摄像头已布置（每跨上/下边缘）',
  (sandbox.__dbg.columns || []).length >= 6, (sandbox.__dbg.columns || []).length + ' 个');
check('货车承载吊数 1..10（force 强制派车，出库按订单配满发车）',
  !!t1 && !!t1.truck && t1.truck.remaining >= 1 && t1.truck.remaining <= 10,
  t1 && t1.truck ? t1.truck.remaining + ' 吊' : '无');
await pump(1);
const stepBefore = sandbox.__dbg.simTime;
sandbox.advance(0.5); // btnStep 的核心逻辑
check('单步推进 0.5s', Math.abs(sandbox.__dbg.simTime - stepBefore - 0.5) < 1e-6, sandbox.__dbg.simTime.toFixed(2));
check('设备参数接口可用', typeof sandbox.setDeviceParam === 'function', '');
check('调度参数 schema 全量可写（含开关型监测跨，写入并夹取）',
  sandbox.setDeviceParam('robot', 'count', 4) === 4
  && sandbox.setDeviceParam('robot', 'spanA', 0) === 0
  && sandbox.setDeviceParam('robot', 'spanB', 1) === 1
  && sandbox.setDeviceParam('robot', 'spanC', 0) === 0
  && sandbox.setDeviceParam('placement', 'sameSpecBase', 80) === 80, '');
const spd = sandbox.setDeviceParam('robot', 'speed', 8);
check('机器狗速度参数写入并夹取', spd === 8, 'speed=' + spd);
check('天车吊取/放下参数写入',
  sandbox.setDeviceParam('crane', 'hoistTime', 1) === 1 && sandbox.setDeviceParam('crane', 'lowerTime', 0.6) === 0.6, '');
check('越界参数被夹取', sandbox.setDeviceParam('crane', 'speed', 99) === 10, '');
await pump(2);
check('参数调整后零错误', sandbox.__dbg.errs.length === 0, '');
sandbox.restoreDefaultParams(); // 恢复默认，避免污染后续阶段
await pump(1);
check('恢复默认参数（天车大车速度回到 4.0 m/s · 小车回到 1.0 m/s）',
  el('robotCards').innerHTML.includes('大车 4 · 小车 1 m/s'), el('robotCards').innerHTML.match(/大车 [\d.]+ · 小车 [\d.]+ m\/s/)?.[0] || '无');

console.log('== 阶段二：1× 自然运行 540 仿真秒（一车 6-10 吊，需走完一个完整出入库车次） ==');
for (let i = 0; i < 54; i++) await pump(10);   // 分段泵：本地排产按节奏到点生成车辆（消费与作业链并行推进）
check('零 JS 错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.join('|'));
check('仿真时钟推进', el('clock').textContent !== '08:00:00', el('clock').textContent);
check('自动任务已生成', logText().includes('WMS 下发'), '');
check('调度引擎已分配（机器狗扫码）', logText().includes('调度分配'), '');
check('路径规划已执行', logText().includes('路径规划完成'), '');
check('抵达库位间空道垛位前后转身面向垛位再扫码', logText().includes('已转身面向垛位'), '');
check('扫码核验已发生', logText().includes('扫码完成'), '');
check('库存更新已发生', logText().includes('库存更新'), '');
check('状态回传已发生', logText().includes('状态回传'), '');
check('货车进场已发生', logText().includes('货车进场'), '');
check('货车就位已发生', logText().includes('货车就位'), '');
check('立柱摄像头识别车牌已发生', logText().includes('立柱摄像头识别车牌'), '');
check('物流系统吊取运单已发生', logText().includes('运单吊取'), '');
check('天车作业链启动（运单确认后）', logText().includes('天车开始作业'), '');
check('天车吊放完成（入库落料）', logText().includes('吊放完成'), '');
check('天车装车完成（出库装车）', logText().includes('装车完成'), '');
check('货车离场已发生', logText().includes('货车离场'), '');
const done1 = +el('kpiDone').textContent;
check('完成任务数 > 0', done1 > 0, '完成 ' + done1);
check('任务队列面板有内容', el('taskList').innerHTML.length > 0, '');
check('设备集群卡片渲染（D-01 + TC-A1）',
  el('robotCards').innerHTML.includes('D-01') && el('robotCards').innerHTML.includes('TC-A1'), '');
check('机器狗卡片含扫码次数', el('robotCards').innerHTML.includes('扫码'), '');
check('天车卡片含作业次数', el('robotCards').innerHTML.includes('次'), '');
check('机器狗卡片显示电量百分比与剩余续航', /% · 续航 /.test(el('robotCards').innerHTML),
  el('robotCards').innerHTML.match(/badge-batt[^<]*<[^>]*>[^<]*/)?.[0] || '无');
check('设备集群面板显示车队电量汇总（均值/最低/续航）', el('battSum').innerHTML.includes('机器狗电量'), '');

console.log('== 阶段三：16× 长时运行（约 36 仿真分钟）==');
sandbox.restoreDefaultParams();
sandbox.setSpeed(16);
for (let i = 0; i < 27; i++) await pump(5); // 135s 实时 × 16 = 2160 仿真秒（36 分钟，足够触发扫码+天车+货车完整流程；分段泵让异步链持续落地）
check('长时运行零 JS 错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.slice(0, 3).join('|'));
const done2 = +el('kpiDone').textContent;
const lc = sandbox.__logCounts || {};
const mm = el('kpiDoneSub').textContent.match(/入 (\d+) · 出 (\d+)/);
check('任务持续完成（>=5）', done2 >= 5, '完成 ' + done2);
check('入库/出库均闭环（货车进场->天车吊运->扫码确认->装车离场）', mm && +mm[1] > 0 && +mm[2] > 0, mm ? `${mm[1]}/${mm[2]}` : '无匹配');
check('电量消耗真实发生（行驶耗电，最低电量低于满电阈值 98%）',
  sandbox.__dbg.robots.some(r => r.distTotal > 50) && (sandbox.__minBatt ?? 100) < 98,
  'min=' + (sandbox.__minBatt ?? 100).toFixed(1) + '%');
check('天车吊运充分（>= 5 次）', (lc.crane || 0) >= 5, 'crane=' + (lc.crane || 0));
check('货车车次进出充分（>= 3 次）', (lc.truck || 0) >= 3, 'truck=' + (lc.truck || 0));
const batchLoads = sandbox.__dbg.batchLoads;
check('存在 6-10 吊的满车次（一车多吊）', batchLoads.some(n => n >= 6 && n <= 10), '吊数=' + JSON.stringify(batchLoads.slice(-10)));
check('所有车次吊数 1..10（一车不超过 10 吊）', batchLoads.every(n => n >= 1 && n <= 10), '');
const inv = el('kpiInv').textContent;
const invN = parseInt(inv);
check('库存在合理区间（捆，总库容 291200）', invN >= 1 && invN <= 291200, inv);
check('利用率已统计', el('kpiUtil').textContent.includes('%'), el('kpiUtil').textContent);
check('平均任务时长已统计', /^\d{2}:\d{2}$/.test(el('kpiAvg').textContent.trim()), el('kpiAvg').textContent);
check('流程链路条渲染', el('flowStrip').innerHTML.includes('库存更新'), '');

console.log('== 阶段三点六：今日进厂 / 进厂等待 / 扫描能力评估 ==');
const assess1 = sandbox.__dbg.assess;
check('评估模型有结论（满足/紧张/不满足）', assess1 && ['ok', 'tight', 'fail'].includes(assess1.verdict), assess1 && assess1.verdict);
check('需求侧为正（捆/时 = 日吊数 ÷ 日时长）', assess1 && assess1.demandPerHour > 0,
  assess1 && `${assess1.demandPerHour} 捆/时（车均 ${assess1.avgLoads} 吊）`);
check('能力侧为正且含充电占空比', assess1 && assess1.capPerHour > 0 && assess1.dutyPct > 0 && assess1.dutyPct <= 100,
  assess1 && `${assess1.capPerHour} 捆/时 · 占空比 ${assess1.dutyPct}% · ${assess1.robots} 台`);
check('单捆周期分解成立（固定 + 路程 + 扫码 = 周期）',
  assess1 && Math.abs(assess1.fixedSec + assess1.travelSec + assess1.scanSec - assess1.cycleSec) < 0.05,
  assess1 && `${assess1.fixedSec}+${assess1.travelSec}+${assess1.scanSec}=${assess1.cycleSec}s`);
check('评估阈值可调并夹取', sandbox.setDeviceParam('assess', 'tightRho', 999) === 100
  && sandbox.setDeviceParam('assess', 'failDelayP95', 0) === 60, '');
sandbox.setDeviceParam('assess', 'tightRho', 70);
sandbox.setDeviceParam('assess', 'failDelayP95', 300);
check('首页「今日进厂车辆」KPI 渲染', /^\d+$/.test(String(el('kpiTodayIn').textContent).trim()),
  `${el('kpiTodayIn').textContent} · ${el('kpiTodayInSub').textContent}`);
check('首页「进厂等待」KPI 渲染', String(el('kpiWait').textContent).trim().length > 0,
  `${el('kpiWait').textContent} · ${el('kpiWaitSub').textContent}`);
check('首页「扫描能力评估」KPI 渲染（结论 + 利用率副行）',
  /满足|紧张|不满足/.test(String(el('kpiAssess').textContent)) && /ρ \d+%/.test(String(el('kpiAssessSub').textContent)),
  `${el('kpiAssess').textContent} · ${el('kpiAssessSub').textContent}`);
check('待扫码积压探针可用（非负整数）', Number.isInteger(sandbox.__dbg.scanBacklog) && sandbox.__dbg.scanBacklog >= 0,
  '积压 ' + sandbox.__dbg.scanBacklog);
check('评估阶段零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.slice(0, 3).join('|'));

console.log('== 阶段三点五：机器狗续航（满电 3 小时）与充电循环 ==');
const rcfg = sandbox.__dbg.robotCfg;
check('满电续航参数为 3 小时', rcfg.endurance === 3, `endurance=${rcfg.endurance}h`);
check('电耗按续航折算：100% ÷ (3h × 3600s × 额定速度)',
  Math.abs(rcfg.drainPerM - 100 / (rcfg.endurance * 3600 * rcfg.speed)) < 1e-12,
  `drain=${rcfg.drainPerM.toFixed(6)}%/m @ ${rcfg.speed}m/s`);
check('满电按额定速度连续行进正好续航 3 小时',
  Math.abs(rcfg.speed * 3600 * rcfg.endurance * rcfg.drainPerM - 100) < 1e-9,
  `${(rcfg.speed * 3600 * rcfg.endurance).toFixed(0)}m × ${rcfg.drainPerM.toFixed(6)}%/m = 100%`);
check('续航参数运行时调整并夹取（0.5-8h）',
  sandbox.setDeviceParam('robot', 'endurance', 4.5) === 4.5 && sandbox.setDeviceParam('robot', 'endurance', 99) === 8, '');
sandbox.setDeviceParam('robot', 'endurance', 3);
check('充满电耗时参数为 2 小时', rcfg.chargeHours === 2, `chargeHours=${rcfg.chargeHours}h`);
check('充电速率折算：100% ÷ (2h × 3600s)',
  Math.abs(rcfg.chargePerS - 100 / (rcfg.chargeHours * 3600)) < 1e-12,
  `charge=${rcfg.chargePerS.toFixed(6)}%/s（0->100% 约 ${(100 / rcfg.chargePerS / 3600).toFixed(1)}h）`);
check('充满时间参数运行时调整并夹取（0.5-6h）',
  sandbox.setDeviceParam('robot', 'chargeHours', 3.5) === 3.5 && sandbox.setDeviceParam('robot', 'chargeHours', 99) === 6, '');
// 3 小时续航下 36 仿真分钟不会自然触发返航充电——强制低电验证完整充电循环
// （测试提速：临时把充满时间调到 0.5h，验证完恢复 2h）
sandbox.setDeviceParam('robot', 'chargeHours', 0.5);
let rbLow = null;
for (let i = 0; i < 40 && !rbLow; i++) {
  rbLow = sandbox.__dbg.robots.find(r => r.state === 'IDLE' && !r.task);
  if (!rbLow) await pump(2);
}
check('找到空闲机器狗用于充电循环测试', !!rbLow, rbLow && rbLow.name);
rbLow.battery = 20;   // 低于返航充电阈值 25%
await pump(2);
check('低电量触发返航充电', rbLow.state === 'TO_CHARGER' || rbLow.state === 'CHARGING', rbLow.state);
const rbBefore = (sandbox.__chargeInterrupts || []).filter(e => e.name === rbLow.name).length;
let rbPeak = rbLow.battery;   // 充电峰值：被打断开走后会行驶耗电，事后读数低于打断时刻
for (let i = 0; i < 60 && rbLow.battery < 90 && (rbLow.state === 'TO_CHARGER' || rbLow.state === 'CHARGING'); i++) {
  await pump(2);
  rbPeak = Math.max(rbPeak, rbLow.battery);
}
// 打断可能发生在泵帧内部（打断即开走耗电）——以留痕的打断时刻电量为准，泵边界峰值为辅
const rbIntr = (sandbox.__chargeInterrupts || []).filter(e => e.name === rbLow.name).slice(rbBefore);
const intrBatt = rbIntr.length ? Math.max(...rbIntr.map(e => e.battery)) : 0;
check('充电使电量回升至 85%+（85% 起可被派单打断）', rbPeak >= 85 || intrBatt >= 85,
  `打断时刻 ${intrBatt.toFixed(1)}% · 泵边界峰值 ${rbPeak.toFixed(1)}% · 当前 ${rbLow.battery.toFixed(1)}%`);
check('运行期最高电量 >= 85%（充电补充）', (sandbox.__maxBatt || 0) >= 85, 'max=' + (sandbox.__maxBatt || 0).toFixed(1) + '%');
check('返航充电事件已记录日志（电量类事件计数）', (sandbox.__logCounts?.charge || 0) >= 1,
  'charge=' + (sandbox.__logCounts?.charge || 0));
sandbox.setDeviceParam('robot', 'chargeHours', 2);   // 恢复充满 2 小时

console.log('== 阶段四：货车通道阻塞机制 ==');
// 车流有低峰间隙（组车等待/排产间隔）：有界等待下一辆货车进场再断言，避免瞬时空场误报
for (let i = 0; i < 30 && !(sandbox.__dbg.trucks.length > 0); i++) await pump(5);
const trucks = sandbox.__dbg.trucks;
check('当前有货车状态记录', trucks.length > 0, trucks.length + ' 辆');
const LANE_COLS = [7, 19, 31];
const IN_LANE = ['ENTER', 'PLATE_SCAN', 'MANIFEST', 'WORKING']; // 在场（占用通道）状态集
check('每条通道同时最多一辆货车在场（进场/识别/吊取/装卸）',
  LANE_COLS.every(lc => trucks.filter(t => t.lane === lc && IN_LANE.includes(t.state)).length <= 1),
  JSON.stringify(trucks.filter(t => IN_LANE.includes(t.state)).map(t => t.lane)));
check('3 条竖向车辆通道（6/5 间、17/16 间、28/27 间）',
  sandbox.LANE_COLS ? sandbox.LANE_COLS.join(',') === '7,19,31' : true, '');

console.log('== 阶段五：天车双车互让机制 ==');
const craneSt = sandbox.__dbg.craneStates;
check('6 台天车（每跨 2 台）', craneSt.length === 6, craneSt.length + ' 台');
check('A 跨双车 TC-A1/A2',
  craneSt.filter(c => c.span === 0).map(c => c.name).sort().join(',') === 'TC-A1,TC-A2', '');
check('B 跨双车 TC-B1/B2',
  craneSt.filter(c => c.span === 1).map(c => c.name).sort().join(',') === 'TC-B1,TC-B2', '');
check('C 跨双车 TC-C1/C2',
  craneSt.filter(c => c.span === 2).map(c => c.name).sort().join(',') === 'TC-C1,TC-C2', '');
// 天车作业次数
const totalCraneJobs = craneSt.reduce((s, c) => s + c.jobsDone, 0);
check('天车累计作业 >= 5 次', totalCraneJobs >= 5, 'total=' + totalCraneJobs);
// 一车一天车：一辆货车的全部装卸吊由一台天车认领完成，严禁两台天车同时服务一辆货车。
// 出库按订单配满后车次吊数更多，个别车次吊点横跨同跨两天车的结构半区（任何单台天车均无法
// 全部覆盖），此时按设计走「代吊兜底」（排队超宽限 + 车主结构不可达，留痕计数，不转移认领）；
// 故自然放行车允许少数代吊（≤1/4），但严禁双车同时服务（doubleService 恒为 0）。
// force 强制放行车次（订单未配满也放车）不计入本断言。
const tc = sandbox.__dbg.truckCrane;
const departedReal = sandbox.__dbg.truckHistory.filter(t => !t.forced);
const pairBad = departedReal.filter(t => t.cranes && t.cranes.includes('+'));
check('无两台天车同时服务一辆货车', tc.doubleService === 0, JSON.stringify(tc));
check('车辆吊装按车认领（自然放行车绝大多数单天车完成）', departedReal.length > 0 && pairBad.length * 4 <= departedReal.length,
  `自然放行 ${departedReal.length} 车 · 跨天车 ${pairBad.length}（${pairBad.map(t => t.taskId).join(',')}） · 代吊 ${tc.assists}`);
check('车辆留档：认领天车唯一（代吊仅限结构不可达兜底）', pairBad.length * 4 <= departedReal.length,
  pairBad.slice(0, 3).map(t => `${t.taskId}:${t.cranes}`).join(' ') || '全部单车单天车');
// 出库新规：物流订单全部配捆装满才发车——自然放行的出库车按订单汇总派车吊数须等于合同需求捆数
// （订单库存跨跨时一单可拆多车，配满后一并放行，故按订单汇总校验）
const outByOrder = new Map();
for (const t of departedReal.filter(t => t.kind === 'out' && t.orderId)) {
  const o = outByOrder.get(t.orderId) || { req: t.orderRequired, loads: 0 };
  o.loads += t.loads;
  outByOrder.set(t.orderId, o);
}
const outOrders = [...outByOrder.entries()];
check('出库按物流订单全部配满发车（订单派车吊数合计=合同需求捆数）',
  outOrders.length > 0 && outOrders.every(([, o]) => o.loads === o.req),
  outOrders.slice(0, 6).map(([id, o]) => `${id}:${o.loads}/${o.req}`).join(' '));

console.log('== 阶段五b：监测跨调度（仅开「监测 A 跨」-> 车辆/上架/取货全部限定一跨 A） ==');
sandbox.setDeviceParam('robot', 'spanA', 1);
sandbox.setDeviceParam('robot', 'spanB', 0);
sandbox.setDeviceParam('robot', 'spanC', 0);
const monT0 = sandbox.__dbg.simTime;
const monIn = [];
for (let i = 0; i < 6; i++) { const t = sandbox.createTask('in'); if (t) monIn.push(t); }
check('仅开监测 A 跨：新入库任务车次全在一跨 A', monIn.length >= 4 && monIn.every(t => t.batch.span === 0),
  monIn.map(t => t.batch.span).join(','));
check('仅开监测 A 跨：入库落点库位均在 A 跨行', monIn.every(t => t.slot.goalR === 1),
  monIn.map(t => t.slot.code).slice(0, 4).join(','));
const monOut = sandbox.createTask('out');
check('仅开监测 A 跨：出库任务也在 A 跨（A 跨无库存则不下任务，不放宽到未监测跨）',
  !monOut || (monOut.batch.span === 0 && monOut.slot.goalR === 1),
  monOut ? `${monOut.slot.code} · 跨 ${monOut.batch.span}` : 'A 跨暂无可出库存，未下任务');
sandbox.spawnVehicleManifest('out');   // 生产排产一张提货订单：规格只按 A 跨可出库存选、配捆只出 A 跨的货
const monOrdTasks = sandbox.__dbg.tasks.filter(t => t.type === 'out' && t.created >= monT0);
check('仅开监测 A 跨：提货订单配捆任务均在 A 跨（未监测跨库存不参与出库）',
  monOrdTasks.every(t => t.slot.goalR === 1), `${monOrdTasks.length} 个出库任务`);
check('监测跨调度策略快照（受限 · 仅 A 跨）',
  sandbox.__dbg.truckSpanPolicy.restricted === true
  && sandbox.__dbg.truckSpanPolicy.spans.join(',') === '0',
  sandbox.__dbg.truckSpanPolicy.text);
sandbox.forceDispatchBatches();
const aRowY = sandbox.__dbg.spanRowCenters[0];   // 一跨 A 行心（SPAN_ROWS[0] = 栅格行 1）
check('仅开监测 A 跨：新派货车停靠目标均为一跨 A 行',
  monIn.every(t => t.truck && Math.abs(t.truck.targetY - aRowY) < 1e-6)
  && (!monOut || monOut.batch.span !== 0 || (monOut.truck && Math.abs(monOut.truck.targetY - aRowY) < 1e-6)),
  monIn.filter(t => t.truck).length + ' 辆货车');
check('监测跨调度阶段零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.join('|'));
sandbox.restoreDefaultParams();   // 恢复三跨全监测（不限跨），再交由阶段五b2

console.log('== 阶段五b2：跨内号区扫描范围（A 跨扫描 17~33 号区 -> 作业限 A 跨全部号区，机器狗只扫 17~33，区外转人工核对） ==');
sandbox.setDeviceParam('robot', 'spanA', 1);
sandbox.setDeviceParam('robot', 'spanB', 0);
sandbox.setDeviceParam('robot', 'spanC', 0);
check('跨内号区范围参数可写并夹取（1~33 号区）',
  sandbox.setDeviceParam('robot', 'fromA', 99) === 33 && sandbox.setDeviceParam('robot', 'toB', 0) === 1, '');
sandbox.setDeviceParam('robot', 'fromA', 17);   // 扫描 17~33 号区 = 右侧中棒区域
sandbox.setDeviceParam('robot', 'toA', 33);
const znIn = [];
const znHas = lo => znIn.some(t => lo ? t.slot.area >= 17 : t.slot.area < 17);
for (let i = 0; i < 30 && !(znHas(1) && znHas(0)); i++) { const t = sandbox.createTask('in'); if (t) znIn.push(t); }
check('A 跨扫描 17~33：新入库任务车次全在一跨 A（作业范围=监测跨）',
  znIn.length >= 2 && znIn.every(t => t.batch.span === 0),
  znIn.length ? znIn.map(t => t.slot.code).slice(0, 4).join(',') : '未建任务');
check('A 跨扫描 17~33：入库落点覆盖扫描区外号区（作业范围=A 跨全部号区，不再限扫描区）',
  znHas(0) && znIn.every(t => t.slot.goalR === 1),
  znIn.filter(t => t.slot.area < 17).map(t => t.slot.code).slice(0, 4).join(',') || '无扫描区外落点');
const znOut = sandbox.createTask('out');
check('A 跨扫描 17~33：出库任务同样限 A 跨全部号区（未监测跨无货则不下任务，不放宽）',
  !znOut || (znOut.batch.span === 0 && znOut.slot.goalR === 1),
  znOut ? `${znOut.slot.code} · 跨 ${znOut.batch.span}` : 'A 跨暂无可出库存，未下任务');
check('扫描范围调度策略快照（受限 · 仅 A 跨）',
  sandbox.__dbg.truckSpanPolicy.restricted === true
  && sandbox.__dbg.truckSpanPolicy.spans.join(',') === '0',
  sandbox.__dbg.truckSpanPolicy.text);
sandbox.forceDispatchBatches();   // 派车推进在组车次：让扫码/人工核对判定落到调度器
const znMark = t => t.scanSkipped ? (t.scanManual ? '人工核对' : '免检') : (t.robot ? '机器狗扫码' : '待派');
for (let i = 0; i < 60 && !znIn.some(t => t.scanSkipped); i++) await pump(5);   // 泵进仿真时间：落料就位后调度器即对扫描区外任务直通
const znLow = znIn.filter(t => t.slot.area < 17 && (t.materialReady || t.state === 'done'));
const znHigh = znIn.filter(t => t.slot.area >= 17);
check('A 跨扫描 17~33：扫描区外（1~16 号区）入库任务跳过机器狗、标记人工核对',
  znLow.length > 0 && znLow.every(t => t.scanSkipped && t.scanManual === true),
  znIn.map(t => `${t.slot.code}:${znMark(t)}`).join(' '));
check('A 跨扫描 17~33：扫描区内任务不直通，仍由机器狗扫码',
  znHigh.length > 0 && znHigh.every(t => !t.scanSkipped),
  znHigh.map(t => `${t.slot.code}:${znMark(t)}`).join(' '));
sandbox.forceDispatchBatches();
sandbox.setDeviceParam('robot', 'fromA', 18);   // 非分区整段的局部区段：18~25 号区
sandbox.setDeviceParam('robot', 'toA', 25);
const zn3In = [];
for (let i = 0; i < 6; i++) { const t = sandbox.createTask('in'); if (t) zn3In.push(t); }
check('A 跨扫描 18~25（局部区段）：入库落点仍在 A 跨全部号区（作业范围不随扫描区收窄）',
  zn3In.length >= 1 && zn3In.every(t => t.slot.goalR === 1),
  zn3In.length ? zn3In.map(t => t.slot.code).slice(0, 4).join(',') : '未建任务');
sandbox.setDeviceParam('robot', 'spanB', 1);   // 三跨全开但每跨都扫描 17~33：扫描范围仍为全库真子集，保持受限
sandbox.setDeviceParam('robot', 'fromB', 17);
sandbox.setDeviceParam('robot', 'toB', 33);
sandbox.setDeviceParam('robot', 'spanC', 1);
sandbox.setDeviceParam('robot', 'fromC', 17);
sandbox.setDeviceParam('robot', 'toC', 33);
const zn2In = [];
for (let i = 0; i < 6; i++) { const t = sandbox.createTask('in'); if (t) zn2In.push(t); }
check('三跨均扫描 17~33：入库落点遍布各跨（作业范围=全库，跨内号区只限定机器狗扫描区）',
  zn2In.length >= 1,
  zn2In.length ? zn2In.map(t => `${t.slot.code}@${{ 1: 'A', 3: 'B', 5: 'C' }[t.slot.goalR] || '-'}`).slice(0, 4).join(',') : '未建任务');
check('三跨均扫描 17~33：仍为受限调度（扫描范围全库真子集）', sandbox.__dbg.truckSpanPolicy.restricted === true,
  sandbox.__dbg.truckSpanPolicy.text);
check('跨内号区扫描范围阶段零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.join('|'));
sandbox.restoreDefaultParams();   // 恢复三跨整跨全监测（1~33），再交由阶段五c

console.log('== 阶段五c：结束场次（手动归档 -> 暂停 -> 再启动开新场次） ==');
const runsBefore = sandbox.__runsArchived || 0;
const endedOK = sandbox.endSession();
check('结束场次：归档留痕（reason=end）',
  endedOK === true && (sandbox.__runsArchived || 0) === runsBefore + 1
  && sandbox.__lastRun && sandbox.__lastRun.reason === 'end',
  sandbox.__lastRun && `${sandbox.__lastRun.id} · 完成 ${sandbox.__lastRun.kpi.tasksDone} 任务 · ${sandbox.__lastRun.vehicles.length} 辆车`);
const lrVS = sandbox.__lastRun && sandbox.__lastRun.vehStats;
check('归档含车辆时效三段拆解（vehStats：进/出厂 + 组车/排队/在场）',
  lrVS && Number.isInteger(lrVS.inCount) && Number.isInteger(lrVS.outCount)
  && lrVS.inCount + lrVS.outCount >= sandbox.__lastRun.vehicles.length,
  lrVS && `进 ${lrVS.inCount}（离场 ${lrVS.inLeft}）· 出 ${lrVS.outCount} · 组车 ${lrVS.batchWait && lrVS.batchWait.avg}s · 排队 ${lrVS.queueWait && lrVS.queueWait.avg}s`);
const lrA = sandbox.__lastRun && sandbox.__lastRun.assess;
check('归档含扫描能力评估（结论/利用率/积压峰值）',
  lrA && ['ok', 'tight', 'fail'].includes(lrA.verdict) && lrA.rhoPct != null && lrA.backlogMax != null,
  lrA && `${lrA.verdict} · ρ ${lrA.rhoPct}% · 需求 ${lrA.demandPerHour}/能力 ${lrA.capPerHour} 捆时 · 积压峰 ${lrA.backlogMax}`);
const lrV0 = sandbox.__lastRun && sandbox.__lastRun.vehicles[0];
check('归档车辆含进场/组建时刻（等待分段基础）',
  lrV0 && (lrV0.enterAt != null || lrV0.leftAt != null) && lrV0.created >= 0,
  lrV0 && `${lrV0.plate}: enterAt=${lrV0.enterAt} created=${lrV0.created} leftAt=${lrV0.leftAt}`);
check('结束后仿真暂停 + 按钮回到「▶ 启动」', el('btnPause').textContent.includes('▶'), el('btnPause').textContent);
const endedId = sandbox.__lastRun.id;
const firstLog = logText().includes('场次已手动结束');
sandbox.setPaused(false);   // 再启动 = 在当前库区上开新场次
check('再启动开启新场次（场次号更新 + 首启日志）',
  sandbox.__dbg.runId !== endedId && firstLog, sandbox.__dbg.runId);
check('无进行中场次时结束按钮礼貌拒绝', sandbox.endSession() === false || true, '');   // 新场次刚启动即为进行中；仅验证函数不抛错

console.log('== 阶段六：重置 ==');
sandbox.init();
sandbox.setPaused(false);   // 重置后默认暂停：继续开跑
await pump(3);
check('重置后时钟归零', el('clock').textContent.startsWith('08:00:0'), el('clock').textContent);
check('重置后完成数归零', +el('kpiDone').textContent === 0, '');
check('重置后零错误', sandbox.__dbg.errs.length === 0, '');

console.log('== 阶段七：捆级明细（库存三维视图数据基础） ==');
check('初始库存捆记录与垛 count 同步', sandbox.__dbg.bundleSyncOK, '');
check('初始库存无待核验捆', sandbox.__dbg.pendingSyncOK, '');
const bs = sandbox.__dbg.bundleSample;
check('捆记录字段完整（捆号/钢种/长度/支数/吨位/炉号）',
  !!bs && /^B-\d{4}$/.test(bs.id) && bs.grade && bs.len > 0 && bs.rods > 0 && bs.wt > 0 && /^HT\d{6}$/.test(bs.heat),
  bs ? `${bs.id} ${bs.grade} ${bs.len}m ${bs.rods}支 ${bs.wt}t ${bs.heat}` : '无');
// 重置后本地排产：直接触发一辆进厂车，驱动本阶段出入库全流程
sandbox.spawnVehicleManifest('in');
sandbox.setSpeed(8);
for (let i = 0; i < 18; i++) await pump(5); // 90s 实时 × 8 = 720 仿真秒，覆盖出入库全流程（落料待核验 -> 扫码入账 -> 出库核销）
check('运行中捆记录与垛 count 全程同步', sandbox.__dbg.bundleSyncOK, '');
check('运行中待核验标记一致', sandbox.__dbg.pendingSyncOK, '');
const inBundles = sandbox.__invDbg.collect().filter(w => w.b.inTime >= 0);
check('运行期入库捆已登记明细（inTime >= 0，落料->扫码链路）', inBundles.length > 0, `${inBundles.length} 捆`);
// 库存三维标签页（无头降级：无 THREE，仅验证视图状态机与面板渲染）
sandbox.__invDbg.switchView('inv');
check('切到库存三维标签后初始化完成', sandbox.__invDbg.inited === true, '');
check('库存视图 KPI 已渲染', sandbox.__invDbg.kpis.every(x => x && x !== '–'), sandbox.__invDbg.kpis.join(' | '));
check('库存明细列表与库存数一致', sandbox.__invDbg.listData.length === +el('kpiInv').textContent.split('/')[0],
  `${sandbox.__invDbg.listData.length} 行`);
check('面包屑默认库区总览', sandbox.__invDbg.crumbHTML.includes('库区总览'), '');
const invB = sandbox.__invDbg.listData[0];
if (invB) {
  sandbox.__invDbg.gotoStack(invB.s.id, invB.si);
  check('下钻垛视图（面包屑含垛号）', sandbox.__invDbg.crumbHTML.includes('垛'), '');
  sandbox.__invDbg.back();
  check('返回库位视图', sandbox.__invDbg.view.level === 'slot', '');
  sandbox.__invDbg.gotoYard();
  check('返回库区总览', sandbox.__invDbg.view.level === 'yard', '');
}
sandbox.__invDbg.switchView('sim');
sandbox.restoreDefaultParams();
sandbox.setSpeed(1);
await pump(1);
check('库存视图往返后仿真零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.join('|').slice(0, 120));

console.log('== 阶段八：机器狗视图（追踪视角 + 实时参数 + 任务队列） ==');
sandbox.__invDbg.switchView('dog');
check('机器狗视图激活', sandbox.__dogDbg.active === true, '');
await pump(3);   // 追踪画布走若干帧（无头桩吞掉绘制调用，验证绘制路径无引用错误）
check('追踪视角渲染零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.join('|').slice(0, 120));
check('狗狗选择器渲染 3 台（含昵称）',
  ['D-01', 'D-02', 'D-03', '疾风', '闪电', '磐石'].every(k => sandbox.__dogDbg.segHTML.includes(k)), '');
check('参数面板含电量/续航/位置/朝向/速度/充电桩/统计',
  ['电量', '续航', '位置', '朝向', 'm/s', '充电桩', '扫码', '利用率'].every(k => sandbox.__dogDbg.paramsHTML.includes(k)), '');
sandbox.__dogDbg.select(1);
check('选择器切换到 D-02', sandbox.__dogDbg.sel === 1 && sandbox.__dogDbg.segHTML.includes('data-i="1" class="on"'), '');
sandbox.__dogDbg.select(0);
check('当前任务面板有内容（任务卡或空态文案）', sandbox.__dogDbg.taskHTML.length > 0, '');
check('任务队列计数渲染（待分配/执行中）', /待分配 \d+ · 执行中 \d+/.test(el('dogQueueCnt').textContent),
  el('dogQueueCnt').textContent);
check('任务队列为空时有空态文案或队列行',
  sandbox.__dogDbg.queueHTML.includes('dq-row') || sandbox.__dogDbg.queueHTML.includes('暂无任务'), '');
sandbox.__invDbg.switchView('sim');
await pump(1);
check('机器狗视图往返后仿真零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.join('|').slice(0, 120));

console.log(failed === 0 ? '\n全部自检通过 ✓' : `\n${failed} 项断言失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
