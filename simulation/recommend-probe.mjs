// 定向探针：验证「数据库实际钢材分布加载 + 卸货推荐算法归堆」
// 1) 用 stub fetch 把真实 warehouse.db 的 /api/slots 注入沙盘，验证期初加载成功；
// 2) 跑仿真产生入库卸货任务，验证推荐结果：同垛不混规格、优先码入同规格垛（归堆率）。
// 用法：node simulation/recommend-probe.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeFeedFetch } from './feed-stub.mjs';
import { openDb, getSlots } from '../server/database.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '调度仿真沙盘.html'), 'utf8');
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];

/* ---- DOM/Canvas 黑洞桩（与 self-test.mjs 同构） ---- */
const absorber = new Proxy(function () {}, {
  get(t, p) { if (p === Symbol.toPrimitive) return () => 0; return absorber; },
  set() { return true; }, apply() { return absorber; },
});
const elements = new Map();
function makeEl(id = '') {
  return {
    id, textContent: '', innerHTML: '', className: '', checked: false, value: '', style: {},
    children: [],
    appendChild(ch) { this.children.push(ch); return ch; },
    removeChild(ch) { const i = this.children.indexOf(ch); if (i >= 0) this.children.splice(i, 1); return ch; },
    get firstChild() { return this.children[0]; },
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1680, height: 980 }),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    clientWidth: 1680, clientHeight: 620, scrollTop: 0, scrollHeight: 0,
  };
}
const documentStub = {
  visibilityState: 'visible',
  getElementById(id) { if (!elements.has(id)) { const el = makeEl(id); if (id === 'cv') el.getContext = () => absorber; elements.set(id, el); } return elements.get(id); },
  createElement(tag) { return makeEl('<' + tag + '>'); },
  querySelectorAll() { return []; }, addEventListener() {},
};

const rafQueue = []; let now = 0;
const sandbox = {
  document: documentStub, performance: { now: () => now },
  requestAnimationFrame: cb => { rafQueue.push(cb); return rafQueue.length; },
  devicePixelRatio: 1, ResizeObserver: class { observe() {} disconnect() {} },
  addEventListener() {}, console,
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimeout, setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; }, clearInterval,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(`Math.random = (() => { let s = 20260824; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();`, sandbox);

/* ---- stub fetch：把真实 warehouse.db 的库位/垛数据当作 /api/slots 返回 ---- */
const db = openDb();
const realSlots = getSlots(db);
db.close();
let fetchHits = 0;
const feedStub = makeFeedFetch(() => sandbox.__dbg.simTime);   // 车辆物流数据源桩（沙盘不再本地生成车辆）
sandbox.fetch = async url => {
  fetchHits++;
  const u = String(url);
  if (u.includes('/api/slots')) {
    return { ok: true, status: 200, json: async () => ({ slots: realSlots }) };
  }
  if (u.includes('/api/health') || u.includes('/api/events')) return feedStub(url);
  return { ok: false, status: 404, json: async () => ({}) };
};
vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });
sandbox.setPaused(false);   // 沙盘默认暂停：无头自检载入后立即开跑

async function pump(simSeconds, fps = 30) {
  const frames = Math.round(simSeconds * fps);
  for (let i = 0; i < frames; i++) { now += 1000 / fps; const q = rafQueue.splice(0); for (const cb of q) cb(now); }   // performance.now() 单位 = 毫秒
  await flushAsync();   // 让物流源桩的异步链（事件消费 -> 建任务）落地
}
const flushAsync = () => new Promise(r => setImmediate(r));   // 让 fetch 异步加载的 microtask 落地

let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond; if (!ok) failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
}

console.log('== 期初库存：从数据库加载实际钢材分布 ==');
await flushAsync();   // init 中的异步加载落地后再断言
check('沙盘已请求 /api/slots', fetchHits >= 1, String(fetchHits));
const storages = sandbox.__dbg.storages;
const totalBundles = storages.reduce((s, st) => s + st.stacks.reduce((x, k) => x + k.count, 0), 0);
const expectedBundles = realSlots.reduce((s, r) => s + (r.stacks || []).reduce((x, k) => x + (k.count || 0), 0), 0);
check(`期初库存 = 数据库库存（${expectedBundles} 捆 · 以探针启动时快照为准）`, totalBundles === expectedBundles, String(totalBundles));
check('期初全部同垛单规格（无混垛）',
  storages.every(st => st.stacks.every(k => k.bundles.every(b => b.specIdx === k.bundles[0].specIdx))), '');
const logText = () => elements.get('logList').children.map(d => d.innerHTML).join('\n');
check('日志已提示实际钢材分布来源', logText().includes('实际钢材分布'), '');
check('分区归堆正确：铁姆肯区全为圆钢',
  storages.filter(s => s.zone === '铁姆肯区').every(s => s.stacks.every(k => !k.spec || k.spec.name.startsWith('圆钢'))), '');
check('分区归堆正确：大棒区域全为螺纹钢',
  storages.filter(s => s.zone === '大棒区域').every(s => s.stacks.every(k => !k.spec || k.spec.name.startsWith('螺纹钢'))), '');

console.log('== 卸货推荐算法：16× 跑 1 个仿真小时 ==');
sandbox.setSpeed(16);
for (let i = 0; i < 45; i++) await pump(5);   // 225s 实时 × 16 = 3600 仿真秒（分段泵：物流源事件持续落地）
check('运行零 JS 错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.slice(0, 2).join('|'));
const recLog = sandbox.__dbg.recLog;   // 结构化留痕：日志窗口仅留近 260 条，长时运行时文本日志易被挤出
check('卸货推荐已产生（含评分分解）', recLog.length > 0 && recLog.every(r => Array.isArray(r.parts) && r.parts.length > 0), `${recLog.length} 条`);
check('推荐次选已产生（多候选对比）', recLog.some(r => !!r.runners), '');

// 核心断言：所有垛仍然同垛单规格（推荐算法硬规则：同垛不混异规格）
check('运行后仍无混规格垛（硬规则生效）',
  storages.every(st => st.stacks.every(k => k.count === 0 || k.bundles.every(b => b.specIdx === k.bundles[0].specIdx))), '');

// 归堆率统计：期初之后新入账捆中，落在「该库位已有同规格垛」的比例
// （通过库存三维调试接口收集全部捆，取 inTime >= 0 的运行期入库捆）
const recs = sandbox.__invDbg.collect();
const inbound = recs.filter(w => w.b.inTime >= 0);
check('运行期有卸货入账捆', inbound.length > 0, `${inbound.length} 捆`);
let sameCluster = 0;
for (const { b, s } of inbound) {
  const slotSpecs = new Set(s.stacks.flatMap(k => k.bundles.map(x => x.specIdx)));
  if (slotSpecs.has(b.specIdx)) sameCluster++;   // 落点库位含同规格 -> 归堆成功
}
check('卸货归堆率 >= 90%（落点库位含同规格）', inbound.length && sameCluster / inbound.length >= 0.9,
  `${sameCluster}/${inbound.length} = ${(100 * sameCluster / Math.max(1, inbound.length)).toFixed(1)}%`);

// 同质性：入库后各库位规格族纯度（主规格占比）
let pureSlots = 0, occSlots = 0;
for (const st of storages) {
  const fams = new Set();
  for (const k of st.stacks) if (k.count > 0 && k.spec) fams.add(k.spec.name.replace(/ Φ.*| 40.*/, ''));
  if (fams.size === 0) continue;
  occSlots++; if (fams.size === 1) pureSlots++;
}
check('库位规格族纯度 >= 85%（相似货物放一起）', pureSlots / occSlots >= 0.85,
  `${pureSlots}/${occSlots} = ${(100 * pureSlots / occSlots).toFixed(1)}%`);

console.log('== 同车同规格归并：整车同规格集中码入同一垛 ==');
const mergeLog = sandbox.__dbg.mergeLog;
check('同车归并已生效（同车次同规格沿用已配垛位）', mergeLog.length > 0, `${mergeLog.length} 次`);
check('同车归并规格正确（沿用垛不混异规格）', mergeLog.every(m => {
  const st = storages.find(s => s.code === m.code);
  const k = st && st.stacks[m.stackIdx];
  return !k || !k.spec || k.spec.name === m.spec;
}), '');
check('归并不超垛容（每垛 <= 通用上限 400 捆）',
  storages.every(st => st.stacks.every(k => k.count <= 400)), '');
check('归堆权重快照可用（CFG.placement 参数化）',
  typeof sandbox.__dbg.placementCfg.sameSpecBase === 'number', JSON.stringify(sandbox.__dbg.placementCfg));

console.log(failed === 0 ? '\n推荐算法探针全部通过 ✓' : `\n${failed} 项断言失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
