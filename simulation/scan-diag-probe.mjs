// 深挖探针：世界推进/任务创建/狗接单诊断（scan-event-probe 失败时用）
import { readFileSync } from 'node:fs';
import { injectCoreSegs } from './sandbox-page-loader.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = injectCoreSegs(readFileSync(join(here, '调度仿真沙盘.html'), 'utf8'));
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];
const absorber = new Proxy(function () {}, { get(t, p) { if (p === Symbol.toPrimitive) return () => 0; return absorber; }, set() { return true; }, apply() { return absorber; } });
const elements = new Map();
const makeEl = (id = '') => ({ id, textContent: '', innerHTML: '', className: '', checked: false, value: '', style: {}, children: [], appendChild(ch) { this.children.push(ch); return ch; }, removeChild(ch) { const i = this.children.indexOf(ch); if (i >= 0) this.children.splice(i, 1); return ch; }, get firstChild() { return this.children[0]; }, addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1680, height: 980 }), classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, clientWidth: 1680, clientHeight: 620, scrollTop: 0, scrollHeight: 0 });
const documentStub = { visibilityState: 'visible', getElementById(id) { if (!elements.has(id)) { const el = makeEl(id); if (id === 'cv' || id === 'dogCv') el.getContext = () => absorber; elements.set(id, el); } return elements.get(id); }, createElement(t) { return makeEl('<' + t + '>'); }, querySelectorAll() { return []; }, addEventListener() {} };
const rafQueue = []; let now = 0;
const state = { events: [] };
const sandbox = { document: documentStub, performance: { now: () => now }, requestAnimationFrame: cb => { rafQueue.push(cb); return rafQueue.length; }, devicePixelRatio: 1, ResizeObserver: class { observe() {} disconnect() {} }, addEventListener() {}, console, setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimeout, setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; }, clearInterval, URLSearchParams, location: { search: '' } };
sandbox.fetch = async (u, o = {}) => {
  const url = String(u); const b = o.body ? JSON.parse(o.body) : null;
  if (url.includes('/api/events') && o.method === 'POST' && Array.isArray(b?.events)) { state.events.push(...b.events); return { ok: true, status: 200, json: async () => ({ appended: b.events.length }) }; }
  if (url.includes('/api/events')) return { ok: true, status: 200, json: async () => ({ events: [], latest: 0 }) };
  if (url.includes('/api/inbound/register')) return { ok: true, status: 200, json: async () => ({ id: 4242, plate: 'P-PROBE', waybill: 'Y-P', loads: [] }) };
  if (url.includes('/api/inbound')) return { ok: true, status: 200, json: async () => ({ vehicles: [] }) };
  return { ok: true, status: 200, json: async () => ({}) };
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'sb.js' });
sandbox.setPaused(false); sandbox.setSpeed(16);
const pump = async (s, fps = 30) => { const f = Math.round(s * fps); for (let i = 0; i < f; i++) { now += 1000 / fps; const q = rafQueue.splice(0); for (const cb of q) cb(now); } await new Promise(r => setImmediate(r)); };

for (let r = 0; r < 90; r++) {
  await pump(5);
  const d = sandbox.__dbg;
  const tasks = d.tasks || [];
  const done = tasks.filter(t => t.state === 'done').length;
  const scanReady = tasks.filter(t => t.type === 'in' && t.materialReady && t.state !== 'done').length;
  const dbgBatches = (d.batches || []);
  const gated = dbgBatches.filter(b => b.awaitConfirm).length;
  const working = dbgBatches.filter(b => b.truck && b.truck.state === 'WORKING').length;
  const craneJobsN = (d.craneJobsDebug || []).length;
  const tkInfo = (d.trucks || []).map(x => x.taskId + ':' + x.kind + ':' + x.state + (x.craneSrv ? '@' + x.craneSrv.name : '')).join(' ');
  const jobSpans = (d.craneJobsDebug || []).map(x => x.taskId).join(',');
  const b1 = (dbgBatches.find(b => b.id === 'B-0001'));
  const b1info = b1 ? b1.id + ' loads=' + b1.loads + ' dispatched=' + b1.dispatched : 'B-0001 gone';
  const inTasks = tasks.filter(t => t.type === 'in');
  const inStates = {};
  for (const t of inTasks) inStates[t.state] = (inStates[t.state] || 0) + 1;
  const inJobIds = (d.craneJobsDebug || []).filter(x => String(x.taskId).startsWith('T')).map(x => x.taskId + '@' + x.kind).join(',');
  const inPushed = inTasks.filter(t => t.cranePushed).length;
  const inBatchInfo = inTasks.slice(0, 2).map(t => (t.batch ? (t.batch.id + ':gate=' + (t.batch.awaitConfirm ? 1 : 0) + ':tk=' + (t.batch.truck ? t.batch.truck.state : 'null')) : 'nobatch')).join(' ');
  const inCrane = inTasks.filter(t => t.state === 'crane').length;
  const crew = (d.crewStates || []).map(x => x.name + ':' + x.state + (x.req ? ':req' : '')).join(' ');
  const tk1 = (d.trucks || []).find(x => x.taskId === 'B-0001');
  const tk1x = tk1 ? 'B0001 plateScan=' + tk1.plateScanned + ' manifest=' + tk1.manifestFetched + ' craneSrv=' + (tk1.craneSrv && tk1.craneSrv.name) : '';
  const crStates = (d.craneStates || []).map(x => x.name + ':' + x.state).join(' ');
  if (r % 3 === 0) console.log('round', r, 'gated=', gated, 'working=', working, 'craneJobs=', craneJobsN, 'trucks=', tkInfo, 'jobIds=', inJobIds || jobSpans, b1info, 'inStates=', JSON.stringify(inStates), 'pushed=', inPushed, inBatchInfo, 'crane=', inCrane, tk1x, 'crew=', crew, '| cranes=', crStates, '| simTime=', Math.round(d.simTime), 'tasks=', tasks.length, 'done=', done, 'materialReady=', scanReady, 'scanQ=', (d.scanQueue || []).length, 'robots=', (d.robots || []).map(x => x.state).join(','));
  const doneIn = tasks.filter(t => t.state === 'done' && t.type === 'in');
  if (doneIn.length > 0) {
    const dt = doneIn[0];
    console.log('DONE IN task:', JSON.stringify({ id: dt.id, vehId: dt.vehId, plate: dt.plate, bundleId: dt.bundleId, scanRobot: dt.scanRobot }));
    break;
  }
  if (r >= 89) {
    // 快照末态：任务类型分布 + 事件类型
    const byType = {};
    for (const t of tasks) byType[t.type + ':' + t.state] = (byType[t.type + ':' + t.state] || 0) + 1;
    console.log('trucks:', (d.trucks || []).map(x => x.taskId + ':' + x.state).join(','), '| batches:', (d.batches || []).map(b => b.id + (b.dispatched ? '✓' : '…')).join(','));
    console.log('END state:', JSON.stringify(byType));
    console.log('event types:', [...new Set(state.events.map(e => e.type))].join(','));
  }
  await new Promise(res => setTimeout(res, 200));
}
const scans = state.events.filter(e => e.type === 'inbound.scan').length;
console.log('scans:', scans, '| lifts:', state.events.filter(e => e.type === 'inbound.lift').length);
