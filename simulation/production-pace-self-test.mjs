// 无头自检：验证「生产节奏」—— 按每日进厂/出厂车辆数生成随车运单，全天铺开不一次下完。
// 桩掉 DOM/Canvas，在 Node VM 中运行"调度仿真沙盘.html"完整脚本，直接 advance() 推进仿真钟。
// 用法：node simulation/production-pace-self-test.mjs
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
  return {
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
// 固定随机种子，保证可复现
vm.runInContext(`Math.random = (() => { let s = 20260824; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();`, sandbox);
vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });

let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
}

/* 直接按仿真钟推进（advance 内部固定 0.05s 子步长），跑到目标仿真秒 */
function runTo(simSec) {
  let guard = 0;
  while (sandbox.__dbg.simTime < simSec && guard++ < 2_000_000) sandbox.advance(1.0);
}

console.log('== 阶段零：生产节奏配置与参数夹取 ==');
check('默认 每日进厂 150 辆', sandbox.setDeviceParam('production', 'inPerDay', 150) === 150, '');
check('默认 每日出厂 100 辆', sandbox.setDeviceParam('production', 'outPerDay', 100) === 100, '');
check('越界参数被夹取（inPerDay 9999 -> 600）', sandbox.setDeviceParam('production', 'inPerDay', 9999) === 600, '');
check('越界参数被夹取（outPerDay 1 -> 10）', sandbox.setDeviceParam('production', 'outPerDay', 1) === 10, '');
sandbox.restoreDefaultParams();
check('恢复默认（inPerDay=150, outPerDay=100）',
  sandbox.setDeviceParam('production', 'inPerDay', 150) === 150 && sandbox.setDeviceParam('production', 'outPerDay', 100) === 100, '');

console.log('== 阶段一：跑 3 个仿真小时，验证按速率排产 ==');
sandbox.init();
const WIN = 3 * 3600;           // 3 个仿真小时 = 1/8 天
runTo(WIN);
check('运行零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.slice(0, 3).join('|'));
const log = sandbox.__spawnLog || [];
const inSpawn = log.filter(e => e.type === 'in');
const outSpawn = log.filter(e => e.type === 'out');
// 期望：150/8≈18.75 辆进厂，100/8≈12.5 辆出厂（3 小时窗口），允许抖动容差
check('进厂车辆数符合日速率（150/日 → 3h 约 19 辆）',
  inSpawn.length >= 12 && inSpawn.length <= 26, inSpawn.length + ' 辆');
check('出厂车辆数符合日速率（100/日 → 3h 约 12 辆）',
  outSpawn.length >= 6 && outSpawn.length <= 20, outSpawn.length + ' 辆');
check('随车运单按 6-10 吊（一车门类）',
  log.every(e => e.made >= 1 && e.made <= 10) && log.some(e => e.made >= 6), '吊数=' + JSON.stringify(log.map(e => e.made).slice(0, 12)));

console.log('== 阶段二：全天铺开，不一次下完 ==');
const inTimes = inSpawn.map(e => e.t).sort((a, b) => a - b);
const span = inTimes[inTimes.length - 1] - inTimes[0];
check('进厂排产覆盖几乎整个窗口（首末间隔 > 2 小时）', span > 2 * 3600, (span / 3600).toFixed(2) + ' h');
// 前 60 秒最多 1 辆进厂 + 1 辆出厂（开场不扎堆）
const earlyIn = inSpawn.filter(e => e.t < 60).length;
const earlyOut = outSpawn.filter(e => e.t < 60).length;
check('开场 60s 内进厂 ≤ 1 辆、出厂 ≤ 1 辆（不一次下完）', earlyIn <= 1 && earlyOut <= 1, `in=${earlyIn} out=${earlyOut}`);
// 把窗口切成 12 段，最多一段的进厂数不应独占（<40%），证明铺开而非爆发
const buckets = Array(12).fill(0);
for (const t of inTimes) buckets[Math.min(11, Math.floor(t / WIN * 12))]++;
const maxBucket = Math.max(...buckets);
check('进厂排产时间分布均匀（最大时段占比 < 40%）', maxBucket / inSpawn.length < 0.4, `max=${maxBucket}/${inSpawn.length} 桶=[${buckets.join(',')}]`);

console.log('== 阶段三：配置改大后排产提速（即时生效） ==');
sandbox.setDeviceParam('production', 'inPerDay', 480);   // 加倍多 -> 间隔变短
const before = inSpawn.length;
const t0 = sandbox.__dbg.simTime;
runTo(t0 + 3600);          // 再跑 1 小时
const after = (sandbox.__spawnLog || []).filter(e => e.type === 'in').length;
// 480/日 → 1h 约 20 辆；明显多于默认 150/日 的 1h≈6 辆
check('调大每日进厂后 1h 排产明显提速（>=12 辆）', after - before >= 12, `本小时 ${after - before} 辆`);
sandbox.restoreDefaultParams();

console.log('== 阶段四：恢复默认后继续运行，确认稳定 ==');
sandbox.restoreDefaultParams();
const before2 = (sandbox.__spawnLog || []).length;
const t1 = sandbox.__dbg.simTime;
runTo(t1 + 3600);          // 再跑 1 小时（默认 150/日 ≈ 6 辆进厂）
const inAfter = (sandbox.__spawnLog || []).filter(e => e.type === 'in' && e.t >= t1).length;
check('恢复默认后回归默认节奏（1h 进厂 3~10 辆）', inAfter >= 3 && inAfter <= 10, `本小时 ${inAfter} 辆`);
check('全程零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.slice(0, 3).join('|'));

console.log(failed === 0 ? '\n生产节奏自检通过 ✓' : `\n${failed} 项断言失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
