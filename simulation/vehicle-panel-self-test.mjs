// 无头自检：验证「车辆作业进度」面板 —— 车辆选择器 + 卸货/取货完成情况。
// 桩掉 DOM/Canvas，在 Node VM 中运行"调度仿真沙盘.html"完整脚本，泵 rAF 帧驱动仿真。
// 用法：node simulation/vehicle-panel-self-test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '调度仿真沙盘.html'), 'utf8');
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
    id, textContent: '', innerHTML: '', className: '', checked: false, value: '',
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
vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });
sandbox.setPaused(false);   // 沙盘默认暂停：无头自检载入后立即开跑

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
const el = id => documentStub.getElementById(id);

console.log('== 阶段一：t=0 初始态（无车）==');
sandbox.init();
sandbox.setPaused(false);   // 重置后默认暂停：继续开跑
pump(1);
check('零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.join('|'));
check('无车时面板为空态（暂无车辆）',
  el('vehSelect').innerHTML.includes('暂无车辆') && el('vehDetail').innerHTML.includes('暂无车辆'),
  el('vehDetail').innerHTML.slice(0, 40));
check('计数显示 0 在场 · 0 累计', el('vehCount').textContent.includes('0 在场') && el('vehCount').textContent.includes('0 累计'),
  el('vehCount').textContent);

console.log('== 阶段二：手动下单 + 派车，验证车辆下拉与明细 ==');
sandbox.createTask('in');
sandbox.createTask('in');
sandbox.createTask('out');
sandbox.forceDispatchBatches(); // 立即派车（入库与出库不同跨/通道时可能派多辆）
pump(0.5);
check('零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.join('|'));
const hist = sandbox.__dbg.truckHistory;
check('货车已留档（truckHistory 非空）', Array.isArray(hist) && hist.length > 0, '留档 ' + hist.length + ' 辆');
check('下拉含入库车（卸货）', el('vehSelect').innerHTML.includes('卸货'), el('vehSelect').innerHTML.slice(0, 80));
check('下拉含出库车（取货）', el('vehSelect').innerHTML.includes('取货'), '');
check('明细已渲染：车牌号', /[京津冀鲁晋豫辽蒙]/.test(el('vehDetail').innerHTML), '');
check('明细已渲染：车次号 B-', el('vehDetail').innerHTML.includes('B-'), '');
check('明细已渲染：每吊明细行（库位编码 -）', el('vehDetail').innerHTML.includes('号通道') && el('vehDetail').innerHTML.includes('垛'),
  '');
check('计数显示在场车辆 >= 1', /[1-9] 在场/.test(el('vehCount').textContent), el('vehCount').textContent);

console.log('== 阶段三：跑满一车，验证完成情况推进 ==');
sandbox.restoreDefaultParams();
sandbox.setSpeed(8);
pump(300); // 足够走完若干完整车次（卸货/取货闭环）
check('运行零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.slice(0, 3).join('|'));
check('累计车辆留档 > 0', sandbox.__dbg.truckHistory.length > 0, sandbox.__dbg.truckHistory.length + ' 辆');
const doneC = +el('kpiDone').textContent;
check('有任务完成（卸货/取货闭环）', doneC > 0, '完成 ' + doneC);
const detailHtml = el('vehDetail').innerHTML;
check('明细含完成状态（已卸货/已装车）', detailHtml.includes('已卸货') || detailHtml.includes('已装车'), '');
check('明细含进度标签（x/y 吊完成）', /\/\d+ 吊完成/.test(detailHtml), (detailHtml.match(/\/\d+ 吊完成/))?.[0] || '无');
// 校验完成统计与实际任务状态一致：面板里 N/M 吊完成 == batch.tasks 里 state==='done' 数量
const sel = el('vehSelect').value;
const veh = sandbox.__dbg.truckHistory.find(t => t.taskId === sel);
if (veh) {
  const realDone = veh.done, total = veh.loads;
  check('面板完成数 = 实际任务 done 数（' + veh.taskId + '）',
    detailHtml.includes(`${realDone}/${total} 吊完成`),
    `面板=${detailHtml.match(/\d+\/\d+ 吊完成/)?.[0] || '无'} 实际=${realDone}/${total}`);
}
// 下拉过滤：已出厂且全部吊闭环（入库=扫码入账、出库=装车完成）的车不再出现在下拉
const optIds = [...el('vehSelect').innerHTML.matchAll(/value="(B-[\d-]+)"/g)].map(m => m[1]);
const finishedGone = sandbox.__dbg.truckHistory.filter(t => !t.inScene && t.loads > 0 && t.done >= t.loads);
check('下拉不含「已出厂且扫描完毕」的车（作业收尾即移出）',
  finishedGone.every(t => !optIds.includes(t.taskId)),
  `下拉 ${optIds.length} 辆 · 已收尾离场 ${finishedGone.length} 辆（${finishedGone.slice(0, 2).map(t => t.taskId).join(',')}）`);
// 至少一辆已离场车留档可回看
const leftAny = sandbox.__dbg.truckHistory.some(t => !t.inScene);
check('已离场车辆留档（回看完成情况）', leftAny, '在场=' + sandbox.__dbg.truckHistory.filter(t => t.inScene).length
  + ' 累计=' + sandbox.__dbg.truckHistory.length);

console.log('== 阶段四：单车聚焦模式（只看一辆车 + 运送目的地 + 相关任务）==');
sandbox.restoreDefaultParams();
sandbox.setSpeed(1);
sandbox.createTask('in'); sandbox.createTask('in'); sandbox.createTask('out');
sandbox.forceDispatchBatches();   // 立即派车，确保有在场车辆可供聚焦
pump(1);
check('零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.slice(0, 3).join('|'));
const onScene = sandbox.__dbg.truckHistory.filter(t => t.inScene);
check('聚焦前提：在场货车 >= 1', onScene.length >= 1, '在场 ' + onScene.length + ' 辆');
const fTarget = onScene[0];
sandbox.setFocusVehicle(fTarget.taskId);
sandbox.setFocusMode(true);
check('focusMode 已开启', sandbox.__dbg.focusMode === true, '');
check('focusTruckId = 选中车', sandbox.__dbg.focusTruckId === fTarget.taskId,
  '聚焦=' + sandbox.__dbg.focusTruckId + ' 选中=' + fTarget.taskId);
const fids = sandbox.__dbg.focusTaskIds;
const fVeh = sandbox.__dbg.truckHistory.find(t => t.taskId === fTarget.taskId);
check('相关任务集合非空', Array.isArray(fids) && fids.length > 0, (fids ? fids.length : 0) + ' 个任务');
check('相关任务数 = 该车吊数', !!fids && !!fVeh && fids.length === fVeh.loads,
  '相关=' + (fids ? fids.length : '?') + ' 吊=' + (fVeh ? fVeh.loads : '?'));
pump(0.6);                        // 触发 refreshPanels 更新任务队列
check('任务队列已按聚焦过滤', el('taskCount').textContent.includes('聚焦'), el('taskCount').textContent);
check('聚焦期间零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.slice(0, 3).join('|'));
sandbox.setFocusMode(false);
check('focusMode 已关闭', sandbox.__dbg.focusMode === false, '');
check('退出聚焦后 focusTruckId 为 null', sandbox.__dbg.focusTruckId === null, '');
pump(0.6);
check('任务队列恢复全景', !el('taskCount').textContent.includes('聚焦'), el('taskCount').textContent);

console.log('== 阶段五：重置后回到空态 ==');
sandbox.init();
sandbox.setPaused(false);   // 重置后默认暂停：继续开跑
pump(1);
check('重置后零错误', sandbox.__dbg.errs.length === 0, '');
check('重置后留档清空、面板空态', sandbox.__dbg.truckHistory.length === 0 && el('vehDetail').innerHTML.includes('暂无车辆'), '');

console.log(failed === 0 ? '\n车辆作业进度面板自检通过 ✓' : `\n${failed} 项断言失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
