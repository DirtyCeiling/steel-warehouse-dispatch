// 无头探针：复现「4 小时只进出 4 辆车」——本地排产模式 + 数据库当前库存 + 库内 sim_params，
// 跑 4 仿真小时（16× 速泵帧），逐段记录排产/派车/进场/离场/补配队列/扫码积压/天车吞吐，
// 定位车辆进出卡点（排产节奏 vs 落位库满 vs 扫码/倒垛能力）。
// 用法：node simulation/throughput-probe.mjs [仿真小时数=4]
import { readFileSync } from 'node:fs';
import { injectCoreSegs } from './sandbox-page-loader.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import { PARAM_SCHEMA, paramDefaults } from '../server/params.js';

const here = dirname(fileURLToPath(import.meta.url));
const SIM_HOURS = Number(process.argv[2]) || 4;
const db = new Database(join(here, '..', 'server', 'warehouse.db'), { readonly: true });

// —— 数据库桩：/api/params（库内 sim_params）+ /api/slots（当前库存）+ 其余一律空应答 ——
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

// —— 页面加载与 VM 沙箱（与 vehicle-panel-self-test 同构）——
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
  location: { search: '' },   // 无 ?feed= -> 本地排产模式；DB_API 默认 127.0.0.1:3001（由 stubFetch 应答）
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

// —— 启动：init（异步加载库内参数与库存）后开跑 16× ——
sandbox.init();
for (let i = 0; i < 10; i++) await pump(0.1);   // 让 /api/params、/api/slots 异步链落地
sandbox.setSpeed(16);
sandbox.setPaused(false);

const fmtT = s => `${(s / 3600).toFixed(1)}h`;
const D = sandbox.__dbg;
const sampled = [];
let lastSampleSim = 0;

console.log(`== 复现运行：本地排产 + 库内参数与库存（A跨 ${D.storages.filter(s => s.goalR != null).length ? '' : ''}库存详见末尾）→ 跑 ${SIM_HOURS} 仿真小时 ==`);
const p = simParamsFromDb();
console.log(`参数：进厂 ${p.production.inPerDay}/日 · 出厂 ${p.production.outPerDay}/日 · 机器狗 ${p.robot.count} 台(${p.robot.speed}m/s · 扫码 ${p.robot.scanTime}s) · 天车吊/放 ${p.crane.hoistTime}/${p.crane.lowerTime}s · 监测 A跨=${p.robot.spanA} B跨=${p.robot.spanB} C跨=${p.robot.spanC}（号区 ${p.robot.fromA}~${p.robot.toA}）· FIFO=${p.task.fifoPick ?? 1}`);

function sample(tag) {
  const t = D.simTime;
  const trucks = D.trucks;
  const byState = {};
  for (const tk of trucks) {
    const key = `${tk.kind === 'in' ? '进' : '出'}:${tk.state}`;
    byState[key] = (byState[key] || 0) + 1;
  }
  const log = sandbox.__spawnLog || [];
  const row = {
    tag, t: fmtT(t),
    排产进: log.filter(e => e.type === 'in').length,
    排产出: log.filter(e => e.type === 'out').length,
    已离场: D.trucksDone,
    在场车: JSON.stringify(byState),
    补配队列: D.inDebtLen,
    待扫码: D.scanBacklog,
    pending: D.kpiSeriesLast ? D.kpiSeriesLast.pend : '-',
    库存捆: D.kpiSeriesLast ? D.kpiSeriesLast.inv : '-',
    天车吊数: D.craneStates.map(c => c.jobsDone).join('+'),
    狗: D.robots.map(r => `${r.state}/${r.battery | 0}%/扫${r.scans}`).join(' '),
    在办单: D.orders.filter(o => o.done < o.required).length,
  };
  sampled.push(row);
  console.log(`[${tag} ${row.t}] 排产 进${row.排产进}/出${row.排产出} · 离场 ${row.已离场} · 在场 ${row.在场车}`);
  console.log(`    补配队列 ${row.补配队列} · 待扫码 ${row.待扫码} · pending ${row.pending} · 天车吊 ${row.天车吊数} · 狗[${row.狗}] · 在办订单 ${row.在办单}`);
}

sample('0h');
while (D.simTime < SIM_HOURS * 3600) {
  await pump(1);   // 1 墙秒 = 16 仿真秒（16×）
  if (D.simTime - lastSampleSim >= 1800) { lastSampleSim = D.simTime; sample(fmtT(D.simTime)); }
  if (D.errs.length) { console.log('运行错误：', D.errs.slice(0, 3)); break; }
}

// —— 末尾汇总 ——
console.log('\n== 汇总 ==');
const log = sandbox.__spawnLog || [];
const inSp = log.filter(e => e.type === 'in'), outSp = log.filter(e => e.type === 'out');
console.log(`排产：进厂 ${inSp.length} 辆（成功落位吊数 ${inSp.map(e => e.made).join(',')}）、出厂单 ${outSp.length} 张`);
const hist = D.truckHistory;
const everTruck = hist.length;
const left = hist.filter(t => !t.inScene).length;
console.log(`派车：累计 ${everTruck} 辆（进 ${hist.filter(t => t.kind === 'in').length} / 出 ${hist.filter(t => t.kind === 'out').length}），已离场 ${left}，仍在场 ${everTruck - left}`);
for (const t of hist) {
  console.log(`  ${t.taskId} ${t.kind === 'in' ? '进' : '出'} ${t.loads}吊 完成${t.done} ${t.inScene ? `在场(${t.state})` : '已离场'}${t.orderId ? ` 单${t.orderId}(${t.done}/${t.orderRequired})` : ''}`);
}
// 进厂排产间隔 vs 名义 86400/25=3456s（抖动 0.55~1.45 -> 1900~5011s）
const gaps = inSp.slice(1).map((e, i) => e.t - inSp[i].t);
const nominal = 86400 / Math.max(1, p.production.inPerDay);
const stalled = gaps.filter(g => g > nominal * 1.45 + 1);
console.log(`进厂排产间隔：名义 ${nominal | 0}s（抖动 0.55~1.45×），实测超上限 ${stalled.length} 次${stalled.length ? '：' + stalled.map(g => (g / 60) | 0 + 'min').join(', ') : ''}`);
// 库存落位面：A 跨（唯一作业跨）垛占用
const scope = D.storages.filter(s => s.goalR === 1);
let empty = 0, sameSpecRoom = 0, fullish = 0, bundles = 0;
for (const s of scope) for (const k of s.stacks) {
  bundles += k.count;
  if (k.count === 0 && k.pending === 0) empty++;
  else if (k.count < 20) sameSpecRoom++;
  else fullish++;
}
console.log(`A跨垛况（${scope.length} 库位 × 8 垛）：空垛 ${empty} · 未满(<20捆) ${sameSpecRoom} · 满/超容(≥20捆) ${fullish} · 共 ${bundles} 捆`);
console.log(`全程零错误: ${D.errs.length === 0 ? '是' : '否 ' + D.errs.slice(0, 3).join('|')}`);
