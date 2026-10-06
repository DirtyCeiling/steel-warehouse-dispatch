// 无头探针：验证「机器狗扫码完成 → inbound.scan 事件」（真实引擎代码，VM 沙箱 + fetch 桩）
// 用法：node simulation/scan-event-probe.mjs
import { readFileSync } from 'node:fs';
import { injectCoreSegs } from './sandbox-page-loader.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = injectCoreSegs(readFileSync(join(here, '调度仿真沙盘.html'), 'utf8'));
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];

const absorber = new Proxy(function () {}, {
  get(t, p) { if (p === Symbol.toPrimitive) return () => 0; return absorber; },
  set() { return true; }, apply() { return absorber; },
});
const elements = new Map();
const makeEl = (id = '') => ({
  id, textContent: '', innerHTML: '', className: '', checked: false, value: '', style: {}, children: [],
  appendChild(ch) { this.children.push(ch); return ch; },
  removeChild(ch) { const i = this.children.indexOf(ch); if (i >= 0) this.children.splice(i, 1); return ch; },
  get firstChild() { return this.children[0]; },
  addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1680, height: 980 }),
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  clientWidth: 1680, clientHeight: 620, scrollTop: 0, scrollHeight: 0,
});
const documentStub = {
  visibilityState: 'visible',
  getElementById(id) {
    if (!elements.has(id)) { const el = makeEl(id); if (id === 'cv' || id === 'dogCv') el.getContext = () => absorber; elements.set(id, el); }
    return elements.get(id);
  },
  createElement(tag) { return makeEl('<' + tag + '>'); }, querySelectorAll() { return []; }, addEventListener() {},
};
const rafQueue = []; let now = 0;
const state = { eventLog: [] };
const sandbox = {
  document: documentStub, performance: { now: () => now },
  requestAnimationFrame: cb => { rafQueue.push(cb); return rafQueue.length; },
  devicePixelRatio: 1, ResizeObserver: class { observe() {} disconnect() {} }, addEventListener() {}, console,
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimeout,
  setInterval: (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; }, clearInterval,
  URLSearchParams, location: { search: '?scanst=1' },
};
const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
sandbox.fetch = async (url, opts = {}) => {
  const u = String(url); const body = opts.body ? JSON.parse(opts.body) : null;
  if (u.includes('/api/events') && opts.method === 'POST' && Array.isArray(body?.events)) { state.eventLog.push(...body.events); return json({ appended: body.events.length }); }
  if (u.includes('/api/events')) return json({ events: [], latest: 0 });
  if (u.includes('/api/telemetry')) return json({ ok: true });
  if (u.includes('/api/params')) return json({ schema: [], values: {} });
  if (u.includes('/api/bundle-rules')) return json({ rules: [] });
  if (u.includes('/api/slots')) return json({ slots: [] });
  if (u.includes('/api/inbound')) return json({ vehicles: [] });
  return json({ ok: true, id: 900 });
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });
sandbox.setPaused(false);
sandbox.setSpeed(16);
const pump = async (realSeconds, fps = 30) => {
  const frames = Math.round(realSeconds * fps);
  for (let i = 0; i < frames; i++) { now += 1000 / fps; const q = rafQueue.splice(0); for (const cb of q) cb(now); }
  await new Promise(r => setImmediate(r));
};

// 等第一捆落位 + 机器狗扫码完成（16x 下 120 仿真秒扫描 + 狗走路，轮询泵帧）
let sawScan = false;
for (let round = 0; round < 40 && !sawScan; round++) {
  await pump(5);
  sawScan = state.eventLog.some(e => e.type === 'inbound.scan');
  await new Promise(r => setTimeout(r, 1100));   // 等事件队列冲刷（1s interval）
}
const scans = state.eventLog.filter(e => e.type === 'inbound.scan');
const lifts = state.eventLog.filter(e => e.type === 'inbound.lift').length;
if (scans.length) {
  console.log(`✓ inbound.scan 事件 x${scans.length}（前置 inbound.lift x${lifts}）`);
  console.log('  样例:', JSON.stringify(scans[0].payload));
  process.exit(0);
} else {
  console.log(`✗ 未见 inbound.scan（lift x${lifts}）——机器狗扫码完成未发事件`);
  process.exit(1);
}
