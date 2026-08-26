// 无头逻辑自检：验证「出库订单履约 + 异常分支 + 出场复验 + 时序 KPI/台账 + 倒垛等待机制」。
// 桩掉 DOM/Canvas，在 Node VM 中运行"调度仿真沙盘.html"完整脚本，手动泵 rAF 帧驱动仿真。
// 用法：node simulation/order-fulfill-self-test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeFeedFetch } from './feed-stub.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '调度仿真沙盘.html'), 'utf8');
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
sandbox.setPaused(false);   // 沙盘默认暂停：无头自检载入后立即开跑

/* 车辆物流数据源桩：沙盘不再本地生成车辆，出库订单/异常/复验所需任务量由源事件流供给 */
sandbox.fetch = makeFeedFetch(() => sandbox.__dbg.simTime);

async function pump(realSeconds, fps = 30) {
  const frames = Math.round(realSeconds * fps);
  for (let i = 0; i < frames; i++) {
    now += 1000 / fps;
    const q = rafQueue.splice(0);
    for (const cb of q) cb(now);
  }
  await new Promise(r => setImmediate(r));   // 让物流源桩的异步链落地
}
let failed = 0, checkIdx = 0;
const failIdx = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  checkIdx++;
  if (!ok) { failed++; failIdx.push(checkIdx); }
  console.log(`#${checkIdx} ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  [' + detail + ']' : ''}`);
}
const logText = () => documentStub.getElementById('logList').children.map(d => d.innerHTML).join('\n');

console.log('== 探针：16× 跑 2 个仿真小时 ==');
// 运单差异每车运单吊取仅掷一次骰，默认 5% 在本测试的车次量下属小概率——调高到 40% 确定性触发该分支
sandbox.setDeviceParam('abnormal', 'manifestMismatchPct', 40);
sandbox.setSpeed(16);
for (let i = 0; i < 45; i++) await pump(10); // 450s 实时 × 16 = 7200 仿真秒（分段泵：物流源事件持续落地）
check('运行零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.slice(0, 3).join('|'));

console.log('== 订单模型 ==');
const orders = sandbox.__dbg.orders;
check('已下发出库订单（合同号格式：手动零星 HT26- / 物流源 L26-）',
  orders.length > 0 && /^(HT26-\d{4}|L26-\d{6})$/.test(orders[0].id), orders.length + ' 张 · 首单 ' + (orders[0] && orders[0].id));
const doneOrders = orders.filter(o => o.done >= o.required);
check('存在齐套闭环订单（凑齐才闭环）', doneOrders.length > 0, doneOrders.length + ' 张完成');
check('闭环订单吨位累计 > 0', doneOrders.every(o => o.tons > 0), doneOrders.slice(0, 3).map(o => o.id + ':' + o.tons + 't').join(' '));
check('订单履约闭环计数 > 0（齐套出厂）', (sandbox.__ordersDone || 0) > 0, '__ordersDone=' + sandbox.__ordersDone);
check('未完成订单 assigned <= required', orders.every(o => o.assigned <= o.required && o.done <= o.required), '');
check('KPI 副标含订单数', /订单 \d+/.test(documentStub.getElementById('kpiDoneSub').textContent),
  documentStub.getElementById('kpiDoneSub').textContent);

console.log('== 异常分支 + 出场复验 ==');
const ab = sandbox.__dbg.abnormal;
check('扫码失败已注入（4% 概率）', ab.scanFail > 0, JSON.stringify(ab));
check('扫码失败 -> 重扫/人工介入已触发（异常留痕计数，不受日志窗口挤出影响）',
  ab.scanAnomalyLog > 0, 'anomalyLog=' + ab.scanAnomalyLog);
check('异常留痕计数 = 重扫次数 + 人工介入次数',
  ab.scanAnomalyLog === ab.scanFail + ab.manualOverride,
  `${ab.scanAnomalyLog} = ${ab.scanFail} + ${ab.manualOverride}`);
check('运单差异已注入（本测试调高至 40% 触发）', ab.manifestMismatch > 0, 'mismatch=' + ab.manifestMismatch);
check('出场复验已执行', logText().includes('出场复验'), '');
check('复验通过后才离场（离场前复验日志存在）', logText().includes('出场复验通过') || logText().includes('出场复验异常'), '');

console.log('== 时序 KPI + 台账 ==');
check('时序采样点已累积（每 60 仿真秒一点）', sandbox.__dbg.kpiSeriesLen >= 60, sandbox.__dbg.kpiSeriesLen + ' 点');
const last = sandbox.__dbg.kpiSeriesLast;
check('采样点字段完整（t/inv/done/pend）', !!last && last.inv >= 0 && last.done > 0 && last.pend >= 0, JSON.stringify(last));
check('任务台账已留痕', sandbox.__dbg.ledgerSize > 0, sandbox.__dbg.ledgerSize + ' 条');
check('无 localStorage 环境静默降级（不报错）', sandbox.__dbg.errs.length === 0, '');

console.log('== 一车一天车（2 仿真小时 · 多车次长跑） ==');
const tc2 = sandbox.__dbg.truckCrane;
check('无两台天车同时服务一辆货车', tc2.doubleService === 0, JSON.stringify(tc2));
check('车辆吊装按车认领（每辆离场车恰由一台天车完成）', tc2.multiCrane === 0 && tc2.served > 0,
  `单天车 ${tc2.served - tc2.multiCrane}/${tc2.served} 车 · 跨天车 ${tc2.multiCrane} · 代吊 ${tc2.assists}`);

console.log('== 倒垛降级修复：restackWaiting 机制 ==');
// 构造场景：把某出库任务的目标垛塞满同规格压货，且全库无空位 -> maybePushCraneJob 必须拒绝入队（不再误核销）
sandbox.setSpeed(1);
const outTask = sandbox.createTask('out');
check('探针出库任务可创建', !!outTask, outTask && outTask.id);
// 直接模拟：全库垛位填满（含目标垛上方压货），planRestackJobs 必然返回 null
for (const s of sandbox.__dbg.storages) {
  for (const k of s.stacks) {
    while (k.count < 20) {
      if (k.count === 0) { k.spec = outTask.spec; k.inTime = -100; }
      k.count++; k.pending = 0;
      k.bundles.push({ id: 'X', slotId: s.id, stackIdx: s.stacks.indexOf(k), specIdx: 0, grade: 'Q', len: 9, heat: 'HT0', rods: 1, wt: 1, inTime: -50, pending: false });
    }
  }
}
outTask.state = 'crane'; outTask.dogDone = true;
outTask.batch = { truck: { state: 'WORKING', x: 0, targetY: 0 } }; outTask.truck = outTask.batch.truck;
const before = sandbox.__dbg.bundleSyncOK;   // 填充后仍同步
sandbox.maybePushCraneJob(outTask);
check('全库无倒垛落点时：任务不入队（restackWaiting=true）', outTask.restackWaiting === true && !outTask.cranePushed, '');
check('此时不核销库存（目标捆仍在垛中）', sandbox.__dbg.bundleSyncOK === before, '');
check('等待文案已提示', logText().includes('装车排队等待'), '');

console.log(failed === 0 ? 'ALL PROBE CHECKS PASSED' : `${failed} FAILED`);
if (failed) console.log('FAILED_IDX:', JSON.stringify(failIdx));
process.exit(failed === 0 ? 0 : 1);
