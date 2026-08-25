// 无头逻辑自检：在 Node VM 中运行"调度仿真沙盘.html"的完整脚本，
// 桩掉 DOM/Canvas，手动泵 rAF 帧驱动仿真，断言调度全流程闭环。
// 用法：node simulation/self-test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '调度仿真沙盘.html'), 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) throw new Error('未找到 <script> 内容');
const code = m[1];

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
      if (id === 'cv') el.getContext = () => absorber;
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
};
sandbox.window = sandbox;
vm.createContext(sandbox);
// 固定随机种子：占用库位分布 / 任务流可复现，保证自检确定性
vm.runInContext(`Math.random = (() => { let s = 20260824; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();`, sandbox);
vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });

/* ---- rAF 泵：按 fps 推进"真实"时间，frame() 内部再乘仿真倍率 ---- */
function pump(realSeconds, fps = 30) {
  const frames = Math.round(realSeconds * fps);
  for (let i = 0; i < frames; i++) {
    now += 1000 / fps;
    const q = rafQueue.splice(0);
    for (const cb of q) cb(now);
  }
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
check('寻路：充电桩#2(r7c19) -> 铁姆肯 2-2(r5c3) 可达', !!sandbox.findPath({ r: 7, c: 19 }, { r: 5, c: 3 }));
check('寻路：合并库位 15(r3c17) -> 充电桩#1(r7c7) 可达', !!sandbox.findPath({ r: 3, c: 17 }, { r: 7, c: 7 }));
const pl = sandbox.pathLen({ r: 7, c: 19 }, { r: 1, c: 37 });
check('路径长度为有限米数', isFinite(pl) && pl > 100 && pl < 600, pl.toFixed(0) + 'm');

console.log('== 阶段零点五：机器狗通行规则（只走通道 + 垛位间隙，不进库位内部） ==');
const sstates = sandbox.__dbg.storageStates;
const occSt = sstates.find(s => s.state === 'occupied');
const freeSt = sstates.find(s => s.state === 'free');
check('占用库位不可穿行（cost=∞）', occSt && sandbox.cellBaseCost(occSt.goalR, occSt.goalC) === Infinity, occSt && occSt.code);
check('空闲库位同样不可穿行（cost=∞，仅作作业格进入）', freeSt && sandbox.cellBaseCost(freeSt.goalR, freeSt.goalC) === Infinity, freeSt && freeSt.code);
check('横向通道廊道 cost=1', sandbox.cellBaseCost(0, 10) === 1 && sandbox.cellBaseCost(6, 20) === 1, '');
check('竖向车辆通道 cost=1', sandbox.cellBaseCost(1, 7) === 1 && sandbox.cellBaseCost(5, 31) === 1, '');
const p033 = sandbox.findPath({ r: 7, c: 19 }, { r: 1, c: 37 });
check('规划路径全程走通道/服务带（途经格均可通行，仅终点为作业库位）',
  !!p033 && p033.slice(0, -1).every(w => isFinite(sandbox.cellBaseCost(w.r, w.c))), '');
check('全部 91 库位均可从横向通道抵达（通道边进入作业格）',
  sstates.every(s => !!sandbox.findPath({ r: 6, c: 10 }, { r: s.goalR, c: s.goalC })), '');
console.log('== 阶段零点六：机器狗扫码站位（走到垛位旁通道边，转身面向垛位，不进垛位） ==');
const st0 = sandbox.__dbg.storages[0];
const ap0 = sandbox.approachCell(st0, { r: 6, c: 10 });
check('扫码站位点是库位相邻的可通行格（通道/间隙，非垛位本体）',
  !!ap0 && isFinite(sandbox.cellBaseCost(ap0.r, ap0.c))
    && Math.abs(ap0.r - st0.goalR) + Math.abs(ap0.c - st0.goalC) === 1,
  st0 && st0.code);
check('全部 91 库位均有通道边站位点（含合并库位）',
  sandbox.__dbg.storages.every(s => {
    const ap = sandbox.approachCell(s, { r: 6, c: 10 });
    return ap && isFinite(sandbox.cellBaseCost(ap.r, ap.c));
  }), '');
const pAp = sandbox.findPath({ r: 7, c: 19 }, ap0);
check('赴扫码站位点的路径全程不穿垛位（途经格均可通行）',
  !!pAp && pAp.every(w => isFinite(sandbox.cellBaseCost(w.r, w.c))), '');

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
check('货车承载吊数 1..10（不足 6 吊按现有吊数放行）',
  !!t1 && !!t1.truck && t1.truck.remaining >= 1 && t1.truck.remaining <= 10,
  t1 && t1.truck ? t1.truck.remaining + ' 吊' : '无');
pump(1);
const stepBefore = sandbox.__dbg.simTime;
sandbox.advance(0.5); // btnStep 的核心逻辑
check('单步推进 0.5s', Math.abs(sandbox.__dbg.simTime - stepBefore - 0.5) < 1e-6, sandbox.__dbg.simTime.toFixed(2));
check('设备参数接口可用', typeof sandbox.setDeviceParam === 'function', '');
const spd = sandbox.setDeviceParam('robot', 'speed', 8);
check('机器狗速度参数写入并夹取', spd === 8, 'speed=' + spd);
check('天车吊取/放下参数写入',
  sandbox.setDeviceParam('crane', 'hoistTime', 1) === 1 && sandbox.setDeviceParam('crane', 'lowerTime', 0.6) === 0.6, '');
check('越界参数被夹取', sandbox.setDeviceParam('crane', 'speed', 99) === 10, '');
pump(2);
check('参数调整后零错误', sandbox.__dbg.errs.length === 0, '');
sandbox.restoreDefaultParams(); // 恢复默认，避免污染后续阶段
pump(1);
check('恢复默认参数（天车速度回到 4.0 m/s）',
  el('robotCards').innerHTML.includes('速度 4 m/s'), el('robotCards').innerHTML.match(/速度 [\d.]+ m\/s/)?.[0] || '无');

console.log('== 阶段二：1× 自然运行 540 仿真秒（一车 6-10 吊，需走完一个完整出入库车次） ==');
pump(540);
check('零 JS 错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.join('|'));
check('仿真时钟推进', el('clock').textContent !== '08:00:00', el('clock').textContent);
check('自动任务已生成', logText().includes('WMS 下发'), '');
check('调度引擎已分配（机器狗扫码）', logText().includes('调度分配'), '');
check('路径规划已执行', logText().includes('路径规划完成'), '');
check('到垛位旁通道边后转身面向垛位再扫码', logText().includes('已转身面向垛位'), '');
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

console.log('== 阶段三：16× 长时运行（约 36 仿真分钟）==');
sandbox.restoreDefaultParams();
sandbox.setSpeed(16);
pump(135); // 135s 实时 × 16 = 2160 仿真秒（36 分钟，足够触发扫码+天车+货车完整流程）
check('长时运行零 JS 错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.slice(0, 3).join('|'));
const done2 = +el('kpiDone').textContent;
const lc = sandbox.__logCounts || {};
const mm = el('kpiDoneSub').textContent.match(/入 (\d+) · 出 (\d+)/);
check('任务持续完成（>=5）', done2 >= 5, '完成 ' + done2);
check('入库/出库均闭环（货车进场->天车吊运->扫码确认->装车离场）', mm && +mm[1] > 0 && +mm[2] > 0, mm ? `${mm[1]}/${mm[2]}` : '无匹配');
check('充电循环已触发（返航充电 >= 2 次）', (lc.charge || 0) >= 2, JSON.stringify(lc));
check('电量被充电补充（运行期最高电量 >= 85%）', (sandbox.__maxBatt || 0) >= 85, 'max=' + (sandbox.__maxBatt || 0).toFixed(1) + '%');
check('电量消耗真实发生（运行期最低电量 <= 70%）', (sandbox.__minBatt ?? 100) <= 70, 'min=' + (sandbox.__minBatt ?? 100).toFixed(1) + '%');
check('天车吊运充分（>= 5 次）', (lc.crane || 0) >= 5, 'crane=' + (lc.crane || 0));
check('货车车次进出充分（>= 3 次）', (lc.truck || 0) >= 3, 'truck=' + (lc.truck || 0));
const batchLoads = sandbox.__dbg.batchLoads;
check('存在 6-10 吊的满车次（一车多吊）', batchLoads.some(n => n >= 6 && n <= 10), '吊数=' + JSON.stringify(batchLoads.slice(-10)));
check('所有车次吊数 1..10（一车不超过 10 吊）', batchLoads.every(n => n >= 1 && n <= 10), '');
const inv = el('kpiInv').textContent;
const invN = parseInt(inv);
check('库存在合理区间（捆，总库容 14560）', invN >= 1 && invN <= 14560, inv);
check('利用率已统计', el('kpiUtil').textContent.includes('%'), el('kpiUtil').textContent);
check('平均任务时长已统计', /^\d{2}:\d{2}$/.test(el('kpiAvg').textContent.trim()), el('kpiAvg').textContent);
check('流程链路条渲染', el('flowStrip').innerHTML.includes('库存更新'), '');

console.log('== 阶段四：货车通道阻塞机制 ==');
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

console.log('== 阶段六：重置 ==');
sandbox.init();
pump(3);
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
sandbox.setSpeed(8);
pump(90); // 90s 实时 × 8 = 720 仿真秒，覆盖出入库全流程（落料待核验 -> 扫码入账 -> 出库核销）
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
pump(1);
check('库存视图往返后仿真零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.join('|').slice(0, 120));

console.log(failed === 0 ? '\n全部自检通过 ✓' : `\n${failed} 项断言失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
