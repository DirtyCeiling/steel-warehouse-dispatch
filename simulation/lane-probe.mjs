// 无头探针：通道占用统计——包一层 pickLaneForBatch，记录每车次吊点号区分布、
// 各通道可服务性（天车可达过滤）与实际选道，复现「车辆不走 3 号通道」。
// 用法：node simulation/lane-probe.mjs [仿真小时数=12]
import { readFileSync } from 'node:fs';
import { injectCoreSegs } from './sandbox-page-loader.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import { PARAM_SCHEMA, paramDefaults } from '../server/params.js';

const here = dirname(fileURLToPath(import.meta.url));
const SIM_HOURS = Number(process.argv[2]) || 12;
const db = new Database(join(here, '..', 'server', 'warehouse.db'), { readonly: true });

function simParamsFromDb() {
  const values = paramDefaults();
  for (const r of db.prepare('SELECT key, value FROM sim_params').all()) {
    const dot = String(r.key).indexOf('.');
    if (dot < 0) continue;
    const sec = r.key.slice(0, dot), key = r.key.slice(dot + 1);
    if (values[sec] && key in values[sec]) values[sec][key] = r.value;
  }
  return values;
}
function slotsFromDb() {
  const slots = db.prepare('SELECT * FROM storage_slots ORDER BY id').all().map(s => ({ ...s, stacks: [] }));
  const byId = new Map(slots.map(s => [s.id, s]));
  for (const k of db.prepare('SELECT * FROM stacks ORDER BY slot_id, stack_no').all()) {
    const st = byId.get(k.slot_id);
    if (st) st.stacks.push(k);
  }
  return slots;
}
const stubFetch = async (url, opts = {}) => {
  const u = String(url);
  const json = obj => ({ ok: true, status: 200, json: async () => obj });
  if (u.includes('/api/params')) {
    if ((opts.method || 'GET') === 'PUT') return json({ values: simParamsFromDb() });
    return json({ schema: PARAM_SCHEMA, values: simParamsFromDb() });
  }
  if (u.includes('/api/slots')) return json({ slots: slotsFromDb() });
  if (u.includes('/api/bundle-rules')) return json({ rules: [] });
  return json({});
};

const html = injectCoreSegs(readFileSync(join(here, '调度仿真沙盘.html'), 'utf8'));
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) throw new Error('未找到 <script> 内容');
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
  location: { search: '' },
  URLSearchParams,
};
sandbox.window = sandbox;
sandbox.fetch = stubFetch;
vm.createContext(sandbox);
vm.runInContext(`Math.random = (() => { let s = 20260824; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();`, sandbox);
vm.runInContext(m[1], sandbox, { filename: 'sandbox-inline.js' });

async function pump(realSeconds, fps = 30) {
  const frames = Math.round(realSeconds * fps);
  for (let i = 0; i < frames; i++) {
    now += 1000 / fps;
    const q = rafQueue.splice(0);
    for (const cb of q) cb(now);
  }
  await new Promise(r => setImmediate(r));
}

// —— 包 pickLaneForBatch：记录每次选道的吊点列 / 号区 / 可选通道 / 中位列 ——
const CELL_L = 300 / 36;
const cellCX = c => (c - 1.5) * CELL_L;
const LANE_COLS = [7, 19, 31];
const servable = (lane, cols) => {
  const tx = cellCX(lane);
  return cols.every(c => {
    const sx = cellCX(c);
    return Math.max(tx, sx) <= 219 || Math.min(tx, sx) >= 81;
  });
};
const laneCalls = [];
const origPick = sandbox.pickLaneForBatch;
sandbox.pickLaneForBatch = cols => {
  const sorted = [...cols].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const lane = origPick(cols);
  laneCalls.push({
    cols: sorted, med,
    eligible: LANE_COLS.filter(l => servable(l, sorted)),
    lane,
  });
  return lane;
};
const origSummon = sandbox.summonTruck;
sandbox.summonTruck = (batch, force) => {
  const t = origSummon(batch, force);
  const last = laneCalls[laneCalls.length - 1];
  if (last) { last.kind = batch.kind; last.spec = batch.tasks[0] && batch.tasks[0].spec ? batch.tasks[0].spec.name : '?'; }
  return t;
};

sandbox.init();
for (let i = 0; i < 10; i++) await pump(0.1);
sandbox.setSpeed(16);
sandbox.setPaused(false);

const D = sandbox.__dbg;
console.log(`== 通道占用探针：${SIM_HOURS} 仿真小时（本地排产 + 库内参数/库存）==`);
const p = simParamsFromDb();
console.log(`监测：A=${p.robot.spanA}(${p.robot.fromA}~${p.robot.toA}) B=${p.robot.spanB}(${p.robot.fromB}~${p.robot.toB}) C=${p.robot.spanC}(${p.robot.fromC}~${p.robot.toC}) · fifoPick=${p.task.fifoPick ?? 1}`);

while (D.simTime < SIM_HOURS * 3600) {
  await pump(1);
  if (D.errs.length) { console.log('运行错误：', D.errs.slice(0, 3)); break; }
}

console.log(`\n== 选道统计（共 ${laneCalls.length} 次派车）==`);
const areaOfCol = c => { const bx = c - 2; if (bx < 0) return null; if (bx <= 4) return bx + 1; if (bx <= 16) return bx; if (bx <= 28) return bx >= 18 ? bx - 1 : null; return bx >= 30 ? bx - 2 : null; };
const laneCount = { 1: 0, 2: 0, 3: 0 };
for (const c of laneCalls) laneCount[LANE_COLS.indexOf(c.lane) + 1]++;
console.log(`通道占用：1号=${laneCount[1]} · 2号=${laneCount[2]} · 3号=${laneCount[3]}`);
console.log('\n逐车次（方向/规格 · 吊点号区 min~max · 中位列 · 可选通道 · 实选）：');
for (const c of laneCalls.slice(-60)) {
  const areas = c.cols.map(areaOfCol).filter(a => a != null);
  const eligible = c.eligible.map(l => LANE_COLS.indexOf(l) + 1).join('/');
  console.log(`  ${c.kind === 'in' ? '入' : '出'} ${c.spec} · 号区${Math.min(...areas)}~${Math.max(...areas)} · ${c.cols.length}吊 · 中位列${c.med} · 可选${eligible} -> ${LANE_COLS.indexOf(c.lane) + 1}号`);
}
// 3 号通道不可选原因分布
const noLane3 = laneCalls.filter(c => !c.eligible.includes(31));
const westBlock = noLane3.filter(c => c.cols.some(col => cellCX(col) < 81)).length;
const medBlock = noLane3.length - westBlock;
console.log(`\n3号通道未选 ${noLane3.length}/${laneCalls.length} 次：吊点含西侧(列<12,即<10号区) ${westBlock} 次 · 全东侧但中位列未偏向3号 ${medBlock} 次`);
console.log(`全程零错误: ${D.errs.length === 0 ? '是' : '否 ' + D.errs.slice(0, 3).join('|')}`);
