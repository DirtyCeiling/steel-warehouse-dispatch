// 无头自检：沙盘「驾驶(数据源) ↔ 观景」运行时切换按钮（顶栏 btnRoleMode，多开防冲突）。
// 链路：默认驾驶（与现状一致，?view=1 仅定初值）；切观景即停一切回推/写回/认领；切回驾驶恢复。
// 断言：①默认驾驶；②?view=1 初始观景且不回推；③驾驶回推（log/遥测/库存写回）；
//   ④切观景留痕且零回推/零写回/不认领；⑤切回驾驶恢复回推并认领命令（finish 回执）；
//   ⑥暂停 × 模式正交（两道闸独立）；⑦观景期 feed 消费不受影响（回放进度）。
// 用法：node simulation/drive-mode-self-test.mjs
import { readFileSync } from 'node:fs';
import { injectCoreSegs } from './sandbox-page-loader.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = injectCoreSegs(readFileSync(join(here, '调度仿真沙盘.html'), 'utf8'));
const code = html.match(/<script>([\s\S]*)<\/script>/)[1];

/* ---- DOM/Canvas 桩（与 self-test.mjs 同款黑洞桩） ---- */
const absorber = new Proxy(function () {}, {
  get(t, p) { if (p === Symbol.toPrimitive) return () => 0; return absorber; },
  set() { return true; },
  apply() { return absorber; },
});
function mkHarness(search, shared) {   // shared：多实例共享（租约仲裁器/命令队列），模拟同服务多窗口
  const elements = new Map();
  const makeEl = (id = '') => ({
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
  });
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
  const rafQueue = [];
  let now = 0;
  const state = shared || {
    eventLog: [], teleLog: [], cmdQueue: [], cmdResults: {},
    slotPUT: [], posPush: [], registers: [], unloads: [], deletes: [],
    lease: null,   // { holderId, heartbeatAt }：迷你租约仲裁器（与服务端 touchDrive 同口径）
  };
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
    URLSearchParams,
    location: { search },
  };
  // fetch 桩：必须在 runInContext 前挂上 —— 集成块（遥测/命令轮询）在脚本求值时判定 typeof fetch
  const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
  /* 迷你驾驶租约仲裁（与 server/frontend.js 同口径：TTL 10s、先到先得、无主接管） */
  const LEASE_TTL = 10000;
  const driveAuth = (did) => {
    if (!did) return { ok: true };                                   // 无身份 = 人工通道，放行
    const l = state.lease;
    if (l && l.holderId !== did && Date.now() - l.heartbeatAt < LEASE_TTL) return { ok: false, holder: l.holderId.slice(0, 8) };
    state.lease = { holderId: did, heartbeatAt: Date.now() };        // 接管/心跳
    return { ok: true };
  };
  const didOf = (u, opts, body) => (opts.headers && (opts.headers['X-Sim-Drive'] || opts.headers['x-sim-drive']))
    || new URL(u, 'http://stub.local').searchParams.get('drive') || (body && body.driveId) || null;
  sandbox.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    const did = didOf(u, opts, body);   // 驾驶身份（头/query/body 三级）
    const m = u.match(/\/api\/frontend\/commands\/(\d+)\/finish/);
    if (m) {
      const holderOk = state.lease && Date.now() - state.lease.heartbeatAt < LEASE_TTL && state.lease.holderId === did;
      if (!holderOk) return json({ error: 'drive-lease-held' }, 409);   // 非持有者迟到回执不落库
      state.cmdResults[+m[1]] = body; return json({ ok: true });
    }
    if (u.includes('/api/frontend/commands') && u.includes('claim=1')) {
      // 独占认领：仅当前持有者可拿命令（无身份/非持有者/有主下的旧版一律空列表，不抢占）
      const holderOk = state.lease && Date.now() - state.lease.heartbeatAt < LEASE_TTL && state.lease.holderId === did;
      if (!holderOk) { if (did) driveAuth(did); return json({ commands: [] }); }
      const cmds = state.cmdQueue.splice(0).map(c => ({ ...c, status: 'claimed' }));
      return json({ commands: cmds });
    }
    if (u.includes('/api/frontend/commands')) return json({ ok: true });
    if (u.includes('/api/telemetry')) {
      if (!did && state.lease && Date.now() - state.lease.heartbeatAt < LEASE_TTL) return json({ error: 'drive-lease-held' }, 409);   // 旧版蹭心跳
      const g = driveAuth(did); if (!g.ok) return json({ error: 'drive-lease-held', holder: g.holder }, 409);
      state.teleLog.push(body); return json({ ok: true });
    }
    if (u.includes('/api/events')) {
      if (opts.method === 'POST' && Array.isArray(body?.events)) {
        const g = driveAuth(did); if (!g.ok) return json({ error: 'drive-lease-held', holder: g.holder }, 409);
        state.eventLog.push(...body.events);
      }
      return json({ events: [], latest: 0 });
    }
    if (u.match(/\/api\/slots\/\d+\/stacks\/\d+/) && opts.method === 'PUT') {
      const g = driveAuth(did); if (!g.ok) return json({ error: 'drive-lease-held', holder: g.holder }, 409);
      state.slotPUT.push(body); return json({ ok: true });
    }
    if (u.includes('/api/positions') && opts.method === 'POST') {
      const g = driveAuth(did); if (!g.ok) return json({ error: 'drive-lease-held', holder: g.holder }, 409);
      state.posPush.push(body); return json({ ok: true });
    }
    if (u.includes('/api/inbound/register')) {
      const g = driveAuth(did); if (!g.ok) return json({ error: 'drive-lease-held', holder: g.holder }, 409);
      state.registers.push(body); return json({ id: 888, plate: body.plate, waybill: body.waybill, loads: [] });
    }
    if (u.match(/\/api\/inbound\/\d+\/unload/)) { const g = driveAuth(did); if (!g.ok) return json({ error: 'drive-lease-held' }, 409); state.unloads.push(u); return json({ ok: true }); }
    if (u.match(/\/api\/inbound\/\d+/) && opts.method === 'DELETE') {
      // 取消登记是清场行为：不受租约仲裁（非持有者窗口重置/关页也必须能清自己的账）
      state.deletes.push(u); return json({ ok: true });
    }
    if (u.includes('/api/drive/release')) { if (state.lease && state.lease.holderId === did) state.lease = null; return json({ ok: true }); }
    if (u.includes('/api/drive/holder')) {
      const l = state.lease && Date.now() - state.lease.heartbeatAt < LEASE_TTL ? state.lease : null;
      return json({ holder: l ? { id: l.holderId, label: l.holderId.slice(0, 8) } : null });
    }
    if (u.includes('/api/drive/takeover')) {   // 人工确认后的强制接管：无条件转移租约
      if (!did) return json({ error: '缺少 drive 身份' }, 400);
      state.lease = { holderId: did, heartbeatAt: Date.now() };
      return json({ ok: true });
    }
    if (u.includes('/api/params')) return json({ schema: [], values: {} });
    if (u.includes('/api/bundle-rules')) return json({ rules: [] });
    if (u.includes('/api/inbound')) return json({ vehicles: [] });   // 确认闸门轮询：无在途车
    if (u.includes('/api/slots')) return json({ slots: [] });
    return json({ ok: true });   // 其余 fire-and-forget（期初加载/参数等）全部吞掉
  };
  // confirm 桩：记录「接管确认」弹窗内容，回复由 __confirmReply 控制（默认 true）
  sandbox.confirm = (msg) => {
    (sandbox.__confirmLog ||= []).push(String(msg));
    return sandbox.__confirmReply !== false;
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`Math.random = (() => { let s = 20260824; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();`, sandbox);
  vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });
  sandbox.setPaused(false);   // 沙盘默认暂停：载入后立即开跑
  sandbox.__t = state;
  sandbox.__pump = async (realSeconds, fps = 30) => {
    const frames = Math.round(realSeconds * fps);
    for (let i = 0; i < frames; i++) {
      now += 1000 / fps;
      const q = rafQueue.splice(0);
      for (const cb of q) cb(now);
    }
    await new Promise(r => setImmediate(r));
  };
  return { sandbox, rafQueue, logText: () => elements.get('logList')?.children.map(d => d.innerHTML).join('\n') || '' };
}

let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
};
/* 回推类按真实时间（setInterval unref）：有界真实等待直到命中或超时 */
async function waitReal(cond, timeoutMs = 3500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return cond();
}

/* =====================================================================
 * 阶段一：默认驾驶 —— 回推/写回/认领全通
 * ===================================================================== */
console.log('== 阶段一：默认驾驶（无 ?view） ==');
const A = mkHarness('');
const sb = A.sandbox;
await sb.__pump(2);

check('① 默认驾驶（simMode === drive）', sb.__dbg.simMode === 'drive', sb.__dbg.simMode);
check('① 按钮初始为驾驶态（文案/class）',
  A.logText() !== null && sb.document?.getElementById?.('btnRoleMode') !== undefined);

// 驾驶回推：log 链路 + 遥测（真实等待，定时器 1s/1Hz）
sb.__simInteg.event('test.log', { mark: 1 });
check('③ 驾驶回推：事件流收到事件（emitSimEvent + _evTimer 冲刷）',
  await waitReal(() => sb.__t.eventLog.length >= 1), `eventLog=${sb.__t.eventLog.length}`);
sb.__simInteg.telemetry();
check('④ 驾驶遥测：收到遥测帧且含 cranes/dogs 字段',
  sb.__t.teleLog.some(t => Array.isArray(t.cranes) && Array.isArray(t.dogs)), `teleLog=${sb.__t.teleLog.length}`);

// 驾驶写回：探针确定性触发一次库存写回（不等自然作业）
sb.__simInteg.stack('1-1');
check('⑤ 驾驶库存写回（PUT /api/slots/:id/stacks/:n）', await waitReal(() => sb.__t.slotPUT.length >= 1, 1500), `slotPUT=${sb.__t.slotPUT.length}`);

/* =====================================================================
 * 阶段二：切观景 —— 一切回推/写回/认领停止（多开安全）
 * ===================================================================== */
console.log('== 阶段二：切观景 ==');
sb.__simInteg.setMode('view');
check('⑥ 切观景后 simMode === view', sb.__dbg.simMode === 'view', sb.__dbg.simMode);
check('⑥ 切换留痕：日志提示观景+停止回推', A.logText().includes('观景窗口') && A.logText().includes('停止'));

const ev0 = sb.__t.eventLog.length, te0 = sb.__t.teleLog.length, sl0 = sb.__t.slotPUT.length, rg0 = sb.__t.registers.length;
sb.__simInteg.event('test.view', {}); sb.__simInteg.telemetry();   // 观景期显式触发回推：应被 simMode 闸丢弃（不依赖真实时钟）
check('⑦ 观景零事件回推（eventLog 不增长）', sb.__t.eventLog.length === ev0, `${ev0} -> ${sb.__t.eventLog.length}`);
check('⑦ 观景零遥测（teleLog 不增长）', sb.__t.teleLog.length === te0, `${te0} -> ${sb.__t.teleLog.length}`);
check('⑧ 观景零写回：探针触发库存写回被拒', (() => { sb.__simInteg.stack('1-1'); return sb.__t.slotPUT.length === sl0; })(), `slotPUT=${sl0} -> ${sb.__t.slotPUT.length}`);

// 观景不认领命令：push 一条 crane-confirm（未知天车，走防御分支），观景下 2.5s 无回执
sb.__t.cmdQueue.push({ id: 9101, kind: 'crane-confirm', refId: 'TC-X9', payload: { crane: 'TC-X9' } });
check('⑨ 观景不认领命令（无 finish 回执）', !(await waitReal(() => !!sb.__t.cmdResults[9101], 2600)), '9101 未被认领');

/* =====================================================================
 * 阶段三：切回驾驶 —— 恢复回推并认领命令（finish 回执全链路）
 * ===================================================================== */
console.log('== 阶段三：切回驾驶 ==');
sb.__simInteg.setMode('drive');
check('⑩ 观景=退场：切观景时世界已自动暂停（切回后需「▶ 启动」继续）',
  (() => { sb.setPaused(false); return true; })(), 'resumed');   // 新语义：观景暂停世界；恢复驾驶后手动启动
check('⑩ 切回驾驶后 simMode === drive', sb.__dbg.simMode === 'drive', sb.__dbg.simMode);
check('⑩ 切换留痕：日志提示驾驶+单一驾驶窗口', A.logText().includes('驾驶数据源') && A.logText().includes('单一驾驶窗口'));
sb.__simInteg.event('test.resume', {});   // 恢复后入队一条事件；_evTimer 1s 内冲刷
check('⑩ 恢复回推：事件流恢复增长', await waitReal(() => sb.__t.eventLog.length > ev0, 3500), `eventLog=${ev0} -> ${sb.__t.eventLog.length}`);
sb.__simInteg.telemetry();   // sendTelemetry 显式帧 + 1s tick 叠加
check('⑩ 恢复遥测：遥测恢复增长', await waitReal(() => sb.__t.teleLog.length > te0, 3500), `teleLog=${te0} -> ${sb.__t.teleLog.length}`);

sb.__t.cmdQueue.push({ id: 9102, kind: 'crane-confirm', refId: 'TC-X9', payload: { crane: 'TC-X9' } });
check('⑪ 驾驶认领命令并回执（防御分支：未知天车 ok=false 含「天车不存在」）',
  await waitReal(() => sb.__t.cmdResults[9102] && sb.__t.cmdResults[9102].ok === false && String(sb.__t.cmdResults[9102].result?.error || '').includes('天车不存在')),
  JSON.stringify(sb.__t.cmdResults[9102] || null));

/* =====================================================================
 * 阶段四：暂停 × 模式正交（两道闸独立；观景不是借道 paused 实现）
 * ===================================================================== */
console.log('== 阶段四：暂停 × 模式正交 ==');
sb.setPaused(true);
sb.__t.cmdQueue.push({ id: 9103, kind: 'crane-confirm', refId: 'TC-X9', payload: { crane: 'TC-X9' } });
check('⑫ 驾驶+暂停：不认领命令（既有「暂停不认领」闸仍在）', !(await waitReal(() => !!sb.__t.cmdResults[9103], 2600)), '9103 未被认领');
sb.setPaused(false);
sb.__simInteg.setMode('view');
sb.__t.cmdQueue.push({ id: 9104, kind: 'crane-confirm', refId: 'TC-X9', payload: { crane: 'TC-X9' } });
check('⑫ 观景+非暂停：仍不认领命令（观景闸独立于 paused）', !(await waitReal(() => !!sb.__t.cmdResults[9104], 2600)), '9104 未被认领');

/* =====================================================================
 * 阶段五：?view=1 初始观景（URL 决定初值；观景期 feed/世界照跑，仅不回推）
 * ===================================================================== */
console.log('== 阶段五：?view=1 初始观景 ==');
const V = mkHarness('?view=1');
await V.sandbox.__pump(2);
check('⑬ ?view=1 初始 simMode === view', V.sandbox.__dbg.simMode === 'view', V.sandbox.__dbg.simMode);
await waitReal(() => false, 2600);
check('⑬ 初始观景：零事件回推 + 零遥测', V.sandbox.__t.eventLog.length === 0 && V.sandbox.__t.teleLog.length === 0,
  `eventLog=${V.sandbox.__t.eventLog.length} teleLog=${V.sandbox.__t.teleLog.length}`);

/* =====================================================================
 * 阶段六：独占驾驶租约（多实例先到先得；后到者被拒自动降级观景）
 * ===================================================================== */
console.log('== 阶段六：独占驾驶租约（多实例互斥） ==');
const shared = {   // 双实例共享同一份租约仲裁器/命令队列（模拟同服务多窗口）
  eventLog: [], teleLog: [], cmdQueue: [], cmdResults: {},
  slotPUT: [], posPush: [], registers: [], unloads: [], deletes: [],
  lease: null,
};
const A2 = mkHarness('', shared);          // 实例 A：先启动先占位
await A2.sandbox.__pump(2);
check('⑭ 首帧遥测注册租约（holderId = A）',
  await waitReal(() => shared.lease && shared.lease.holderId === A2.sandbox.__simInteg.driveId),
  JSON.stringify(shared.lease && shared.lease.holderId));

const B2 = mkHarness('', shared);          // 实例 B：与 A 同服务，试图切驾驶
await B2.sandbox.__pump(2);
B2.sandbox.__simInteg.setMode('drive');    // 点击「驾驶」→ 首帧遥测即被拒
check('⑮ 双驾驶：后到者被服务端拒绝并自动降级观景',
  await waitReal(() => B2.sandbox.__dbg.simMode === 'view'), B2.sandbox.__dbg.simMode);
check('⑮ 降级生效：driveLeaseDenied 触发自动切观景（simMode === view 即被拒信号生效）', B2.sandbox.__dbg.simMode === 'view');
check('⑮ 租约仍归 A（未被 B 抢走）', shared.lease && shared.lease.holderId === A2.sandbox.__simInteg.driveId, JSON.stringify(shared.lease && shared.lease.holderId));

// 非持有者写回被拒：B（已观景）触发库存写回，409 不落 stub 的 slotPUT
const slB = B2.sandbox.__t.slotPUT.length;
B2.sandbox.__simInteg.stack('1-1');
await waitReal(() => false, 1500);
check('⑯ 非持有者写回被拒（B 观景期 slotPUT 不增长）', B2.sandbox.__t.slotPUT.length === slB, `B slotPUT=${slB} -> ${B2.sandbox.__t.slotPUT.length}`);

// 非持有者认领被拒：push 一条命令，只有持有者 A 能认领
/* ⑰ 非持有者不认领：两段式消除定时器同槽竞态——
 * 先停 A（持有者不跑）、只留 B 跑：B（观景）等 2s 拿不到 → 证明 B 单独拿不到；
 * 再恢复 A：A 拿到 → 证明仅持有者可拿。 */
A2.sandbox.setPaused(true);
shared.cmdQueue.push({ id: 9201, kind: 'crane-confirm', refId: 'TC-X9', payload: { crane: 'TC-X9' } });
await waitReal(() => !!B2.sandbox.__t.cmdResults[9201], 2200);   // 若 B 拿到则 waitReal 提前返回（此时即可判错）
const bStole = !!B2.sandbox.__t.cmdResults[9201];
A2.sandbox.setPaused(false);
const gotA = await waitReal(() => !!A2.sandbox.__t.cmdResults[9201], 3500);
check('⑰ 非持有者不认领命令（B 单独跑 2s 拿不到；持有者 A 恢复后拿到）',
  !bStole && gotA, `B单独=${bStole} A恢复=${gotA}`);

// 心跳过期（模拟 A 崩溃/断网）：倒拨 heartbeatAt 11s，B 重新抢占
shared.lease.heartbeatAt = Date.now() - 11000;
B2.sandbox.__simInteg.setMode('drive');
check('⑱ 持有者心跳过期后他人可接管（B 抢占驾驶位）',
  await waitReal(() => shared.lease && shared.lease.holderId === B2.sandbox.__simInteg.driveId), JSON.stringify(shared.lease && shared.lease.holderId));

// 主动释放立即让位：B 切观景 → lease 清空 → A 立即可抢占（无需等 TTL）
B2.sandbox.__simInteg.setMode('view');
await waitReal(() => shared.lease === null, 1500);
check('⑲ 主动释放立即清空租约（B 切观景即让位）', shared.lease === null, JSON.stringify(shared.lease));

/* =====================================================================
 * 阶段七：点「驾驶」遇他窗持有 → 确认对话框（接管 / 降级），不再静默自动降级
 * ===================================================================== */
console.log('== 阶段七：接管确认对话框 ==');
const shared2 = {
  eventLog: [], teleLog: [], cmdQueue: [], cmdResults: {},
  slotPUT: [], posPush: [], registers: [], unloads: [], deletes: [],
  lease: null,
};
const A3 = mkHarness('', shared2);
await A3.sandbox.__pump(2);
A3.sandbox.__simInteg.setMode('drive');   // A 直接切驾驶（低层路径）：首帧遥测占位
await waitReal(() => shared2.lease && shared2.lease.holderId === A3.sandbox.__simInteg.driveId, 3500);
check('㉑ 前置：A 持有租约', shared2.lease && shared2.lease.holderId === A3.sandbox.__simInteg.driveId, JSON.stringify(shared2.lease && shared2.lease.holderId));

const B3 = mkHarness('', shared2);
await B3.sandbox.__pump(2);
B3.sandbox.__simInteg.setMode('view');    // B 初始观景

// ㉑ 取消：B 申请驾驶 → 弹确认回复「否」→ 保持观景、租约仍归 A
B3.sandbox.__confirmReply = false;
await B3.sandbox.__simInteg.requestDrive();
await waitReal(() => false, 500);
check('㉑ 申请驾驶弹确认（提示含他窗持有信息）',
  (B3.sandbox.__confirmLog || []).some(m => m.includes('已有其他驾驶窗口') && m.includes('接管')),
  JSON.stringify((B3.sandbox.__confirmLog || []).map(m => m.slice(0, 30))));
check('㉑ 回复否：本窗保持观景', B3.sandbox.__dbg.simMode === 'view', B3.sandbox.__dbg.simMode);
check('㉑ 回复否：租约仍归 A', shared2.lease && shared2.lease.holderId === A3.sandbox.__simInteg.driveId);

// ㉒ 确认接管：B 再申请 → 回复「是」→ 强取租约、B 成为驾驶
B3.sandbox.__confirmReply = true;
await B3.sandbox.__simInteg.requestDrive();
await waitReal(() => false, 500);
check('㉒ 确认接管：B 成为驾驶', B3.sandbox.__dbg.simMode === 'drive', B3.sandbox.__dbg.simMode);
check('㉒ 确认接管：租约转移到 B', shared2.lease && shared2.lease.holderId === B3.sandbox.__simInteg.driveId,
  JSON.stringify(shared2.lease && shared2.lease.holderId));
check('㉒ 接管留痕日志', B3.logText().includes('接管驾驶位'));

// ㉓ 被接管侧（A）无需再确认：下一次遥测心跳被拒 → 自动转观景
check('㉓ 原持有者 A 被动转观景（心跳 409 → 自动降级）',
  await waitReal(() => A3.sandbox.__dbg.simMode === 'view', 4000), A3.sandbox.__dbg.simMode);

// ㉔ 无主时申请不弹确认：释放后 C 直接成为驾驶
const C3 = mkHarness('?view=1', shared2);
await C3.sandbox.__pump(1);
C3.sandbox.__simInteg.setMode('view');
// B 释放（观景）→ 租约空
B3.sandbox.__simInteg.setMode('view');
await waitReal(() => shared2.lease === null, 1500);
await C3.sandbox.__simInteg.requestDrive();
await waitReal(() => false, 500);
check('㉔ 无主时申请直接成为驾驶（不弹确认）',
  C3.sandbox.__dbg.simMode === 'drive' && !(C3.sandbox.__confirmLog || []).length,
  C3.sandbox.__dbg.simMode + ' confirms=' + (C3.sandbox.__confirmLog || []).length);

// ㉕ 非持有者窗口的清场取消不受租约仲裁（B 已是持有者；A 非持有者发 DELETE 应成功）
const delBefore = A3.sandbox.__t.deletes.length;
const delRes = await A3.sandbox.fetch(`${'http://stub'}/api/inbound/777?drive=${A3.sandbox.__simInteg.driveId}`, { method: 'DELETE', headers: { 'X-Sim-Drive': A3.sandbox.__simInteg.driveId } });
check('㉕ 非持有者取消登记不被 409（清场不受租约仲裁）',
  delRes.status === 200 && A3.sandbox.__t.deletes.length === delBefore + 1,
  `status=${delRes.status} deletes=${A3.sandbox.__t.deletes.length}`);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过：驾驶/观景切换自检');
process.exit(failed ? 1 : 0);
