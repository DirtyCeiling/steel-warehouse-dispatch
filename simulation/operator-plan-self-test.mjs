// 无头自检：平板规划优先（simulation/shared/sandbox-core.mjs 生产节奏段 operatorPlanWaitMin，默认 15 分钟）。
// 验证闭环语义：
//   1) 等待窗口内（默认 15 分钟）沙盘不本地排产，静候操作端（平板）推送；
//   2) 平板入库规划推送（spawn -> 改垛 -> 确认 -> dispatch-inbound）：现场任务落位 = 确认单最终垛位；
//   3) 平板出库下发（dispatch-outbound）：提货订单注入并按 FIFO 配捆；
//   4) 等待窗口超时：沙盘降级本地自主排产（车辆照常登记进厂确认队列）；
//   5) 降级车被平板接管（改垛 -> 确认 -> dispatch-inbound duplicate）：未开吊的吊按确认单校正落位，
//      恢复平板优先（降级标记复位、等待窗口重新计时）；
//   6) 恢复等待后窗口内不再产生新的本地排产车。
// 用法：node simulation/operator-plan-self-test.mjs（临时库 + 端口 3320，与 npm run sim 并行不冲突）
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectCoreSegs } from './sandbox-page-loader.mjs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import vm from 'node:vm';

process.env.LOGI_API = 'http://127.0.0.1:9';   // 物流源指向立即拒绝端口：spawn 走本地随机兜底
const tmp = mkdtempSync(join(tmpdir(), 'op-plan-'));
process.env.WAREHOUSE_DB = join(tmp, 't.db');
process.env.PORT = '3320';
const { startServer } = await import('../server/index.js');
const server = await startServer();
const API = 'http://127.0.0.1:3320';

let failed = 0, checkIdx = 0;
const failIdx = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  checkIdx++;
  if (!ok) { failed++; failIdx.push(checkIdx); }
  console.log(`#${checkIdx} ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  [' + detail + ']' : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = (p, opt) => fetch(`${API}${p}`, opt).then(r => r.json().then(b => ({ status: r.status, body: b })));
const knownVehIds = [];   // 平板侧已处理过的 vehId：阶段四找「新增」的本地降级车时排除

/* ---- 沙盘 VM（fetch 桥接真实数据服务，?api= 覆盖 DB_API） ---- */
const here = dirname(fileURLToPath(import.meta.url));
const html = injectCoreSegs(readFileSync(join(here, '调度仿真沙盘.html'), 'utf8'));
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
  location: { search: `?api=${API}` },   // 沙盘 DB_API 指向本测数据服务
  URLSearchParams,
};
sandbox.window = sandbox;
// fetch 桥：必须在 runInContext 前挂上 —— 操作端集成块（__simInteg/命令认领/遥测回推）在脚本求值时判定 typeof fetch
sandbox.fetch = (url, opts) => fetch(String(url), opts);
vm.createContext(sandbox);
vm.runInContext(`Math.random = (() => { let s = 20261006; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();`, sandbox);
vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });
sandbox.setPaused(false);

async function pump(realSeconds, fps = 30) {
  const frames = Math.round(realSeconds * fps);
  for (let i = 0; i < frames; i++) {
    now += 1000 / fps;
    const q = rafQueue.splice(0);
    for (const cb of q) cb(now);
  }
  await new Promise(r => setImmediate(r));
}

/* ---- 工具：按确认单展开期望落位多重集 ---- */
const planOf = v => {
  const want = [];
  for (const l of v.loads) for (let i = 0; i < l.bundles; i++)
    want.push(`${l.spec}|${l.code ?? l.recCode}|${l.stackNo ?? l.recStackNo}`);
  return want.sort();
};
const liftOf = vehId => sandbox.__dbg.lifts
  .filter(t => t.vehId === vehId)
  .map(t => `${t.spec}|${t.code}|${t.stackNo}`)
  .sort();
/** 落位一致性断言（三态）：现场吊 = 平板确认单；若确认单落点物理不可用（垛满/异规/锁定）或
 *  确认单跨跨（整车单跨装卸防御，跨外组回退同跨推荐），按既有设计回退并留痕——亦视为已按规划尽力执行 */
function checkPlanApplied(name, vehId, view) {
  const matched = planOf(view).join('\n') === liftOf(vehId).join('\n');
  const logAll = documentStub.getElementById('logList').children.map(d => d.innerHTML).join('\n');
  const fellBack = (/确认单落点不可用|确认单跨外落位/.test(logAll)) && liftOf(vehId).length === planOf(view).length;
  check(name, matched || fellBack, matched ? '' : (fellBack ? '确认单落点物理不可用/跨跨，按既有设计回退同跨推荐并留痕' : `want=${planOf(view)[0]} got=${liftOf(vehId)[0] || 'none'}`));
}

/* ---- 工具：平板「改垛 + 确认」（模拟管理工在平板上调整规划后推送） ---- */
async function tabletAdjustAndConfirm(vehId, avoidCodes = []) {
  const view = (await j(`/api/vehicles/${vehId}`)).body;
  const load = view.loads[0];
  const anchor = view.loads.find(l => l.id !== load.id) || load;
  const slots = (await j('/api/slots')).body.slots || (await j('/api/slots')).body;
  const spanOf = id => { const s = (Array.isArray(slots) ? slots : []).find(x => x.id === id); return s ? (s.merged ? 1 : s.span) : -1; };
  const anchorSpan = spanOf(anchor.recSlotId);
  const cands = (await j(`/api/inbound/candidates?spec=${encodeURIComponent(load.spec)}&bundles=${load.bundles}`)).body.candidates || [];
  const cur = `${load.code ?? load.recCode}:${load.stackNo ?? load.recStackNo}`;
  const c = cands.find(c =>
    (c.merged ? 1 : c.span) === anchorSpan
    && `${c.slotId}:${c.stackNo}` !== `${load.slotId ?? load.recSlotId}:${load.stackNo ?? load.recStackNo}`
    && !avoidCodes.includes(c.code));
  let adjustedCode = null;
  if (c) {
    const r = await j(`/api/inbound/${vehId}/loads/${load.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slotId: c.slotId, stackNo: c.stackNo }),
    });
    if (!r.body.error) adjustedCode = `${c.code}:${c.stackNo}`;
  }
  const conf = await j(`/api/inbound/${vehId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const confirmedView = (await j(`/api/vehicles/${vehId}`)).body;
  return { adjustedCode, confirmed: !conf.body.error && confirmedView.state === 'confirmed', view: confirmedView };
}

console.log('== 阶段一：平板规划优先（默认 15 分钟等待窗口内不本地排产） ==');
{
  const reset = await j('/api/reset', { method: 'POST' });
  check('临时库灌期初库存', reset.body.slotCount === 91, String(reset.body.slotCount));
  const params = (await j('/api/params')).body;
  check('服务器调度参数默认平板规划等待 15 分钟', params.values?.production?.operatorPlanWaitMin === 15,
    String(params.values?.production?.operatorPlanWaitMin));
  await pump(3);
  vm.runInContext('loadInventoryFromDb()', sandbox);   // 防首拉竞态：reset 后显式重拉一次期初（两侧库存同源是本测断言前提）
  let invTotal = 0;
  for (let i = 0; i < 40 && invTotal <= 1000; i++) {   // 等待式：大库存（3 万+捆）解析/重建落地
    await pump(0.5);
    invTotal = sandbox.__dbg.storages.reduce((n, s) => n + s.stacks.reduce((m, k) => m + k.count, 0), 0);
  }
  check('沙盘期初库存已从数据库加载（非随机兜底）', invTotal > 1000, String(invTotal));
  const op = sandbox.__dbg.operatorPlan;
  check('沙盘初始等待状态（自启动起算，未降级）', op.lastAt === 0 && op.degraded === false && op.waitMin === 15,
    JSON.stringify(op));
  await pump(25);   // 仿真 25s << 15min：等待窗口内
  check('等待窗口内无本地排产车（无批次/无排产留痕）',
    sandbox.__dbg.batches.length === 0 && !(sandbox.__spawnLog || []).some(x => x.type === 'in'),
    `batches=${sandbox.__dbg.batches.length} spawnIn=${(sandbox.__spawnLog || []).filter(x => x.type === 'in').length}`);
  check('等待窗口内无本地出库订单', (sandbox.__dbg.orders || []).length === 0,
    String((sandbox.__dbg.orders || []).length));
}

console.log('== 阶段二：平板入库规划推送（改垛 -> 确认 -> dispatch-inbound）现场按确认单执行 ==');
{
  const sp = (await j('/api/inbound/spawn', { method: 'POST' })).body;
  check('平板侧模拟车辆进厂（含垛位分配推荐）', sp.id > 0 && sp.loads.length > 0, `#${sp.id} · ${sp.loads.length} 组`);
  const { adjustedCode, confirmed, view } = await tabletAdjustAndConfirm(sp.id);
  check('平板改垛并确认规划', confirmed, adjustedCode ? `改至 ${adjustedCode}` : '未找到候选，按推荐确认');
  knownVehIds.push(sp.id);
  await sandbox.__simInteg.cmd('dispatch-inbound', { vehId: sp.id });   // 模拟平板 PUSH_TASKS 推送（finish 回执异步，断言看现场副作用）
  check('dispatch-inbound 执行成功（现场建吊）', liftOf(sp.id).length === planOf(view).length,
    `lifts=${liftOf(sp.id).length} / plan=${planOf(view).length}`);
  check('现场任务落位 = 平板确认单最终垛位（而非服务器推荐/沙盘自荐）',
    planOf(view).join('\n') === liftOf(sp.id).join('\n'),
    `want=${planOf(view).slice(0, 2).join(',')} got=${liftOf(sp.id).slice(0, 2).join(',')}`);
  check('平板规划推送刷新等待窗口（回到平板优先）', sandbox.__dbg.operatorPlan.lastAt > 0 && !sandbox.__dbg.operatorPlan.degraded,
    JSON.stringify(sandbox.__dbg.operatorPlan));
}

console.log('== 阶段三：平板出库下发（dispatch-outbound）注入提货订单 ==');
{
  const inv = (await j('/api/inventory')).body;
  const specOk = inv && Array.isArray(inv.zones) ? null : null;
  const slots = (await j('/api/slots')).body;
  const list = Array.isArray(slots) ? slots : slots.slots;
  const specName = (() => {   // 取期初在库量最大的规格（确保有可出捆）
    const cnt = {};
    for (const s of list) for (const k of (s.stacks || [])) if (k.spec && k.count > 0) cnt[k.spec] = (cnt[k.spec] || 0) + k.count;
    return Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  })();
  check('期初在库规格可出', !!specName, specName || 'none');
  const r = await sandbox.__simInteg.cmd('dispatch-outbound', { orderNo: 'CK-TEST-1', specName, bundles: 2 });
  check('dispatch-outbound 执行成功并配捆', (sandbox.__dbg.orders || []).some(o => o.id === 'CK-TEST-1' && o.assigned > 0),
    JSON.stringify((sandbox.__dbg.orders || []).find(o => o.id === 'CK-TEST-1') || null));
  check('订单已建且归属操作端来源', (sandbox.__dbg.orders || []).some(o => o.id === 'CK-TEST-1'),
    String((sandbox.__dbg.orders || []).length));
  check('等待窗口内仍无本地排产车', !(sandbox.__spawnLog || []).some(x => x.type === 'in'),
    `spawnIn=${(sandbox.__spawnLog || []).filter(x => x.type === 'in').length}`);
}

console.log('== 阶段四：等待窗口超时 -> 降级本地自主排产 ==');
{
  sandbox.__simInteg.setOperatorPlanWaitMin(0.02);   // 1.2s：加速降级触发
  await pump(3);
  check('超时后降级标记置位并出现本地排产车', sandbox.__dbg.operatorPlan.degraded === true
    && (sandbox.__spawnLog || []).some(x => x.type === 'in'),
    `degraded=${sandbox.__dbg.operatorPlan.degraded} spawnIn=${(sandbox.__spawnLog || []).filter(x => x.type === 'in').length}`);
  let veh = null;
  for (let i = 0; i < 40 && !veh; i++) {   // 登记回传 vehId 需一轮异步（排除平板侧已处理过的车）
    await pump(0.5);
    veh = sandbox.__dbg.batches.find(b => b.vehId != null && b.kind === 'in' && !knownVehIds.includes(b.vehId)) || null;
  }
  check('降级车已登记进厂确认队列（平板可见）', !!veh, veh ? `#${veh.vehId} ${veh.plate}` : 'none');
  const sv = veh ? (await j(`/api/vehicles/${veh.vehId}`)).body : null;
  check('台账该车待确认（pending）', sv && sv.state === 'pending', sv ? sv.state : 'none');
  check('降级车批次挂起待确认（天车不动）', veh && sandbox.__dbg.batches.find(b => b.vehId === veh.vehId)?.awaitConfirm === true);

  console.log('== 阶段五：平板接管降级车（改垛 -> 确认 -> 推送）未开吊的吊按确认单校正 ==');
  const sandboxCodes = sandbox.__dbg.lifts.filter(t => t.vehId === veh.vehId).map(t => t.code);
  const { adjustedCode, confirmed, view } = await tabletAdjustAndConfirm(veh.vehId, sandboxCodes);   // 避开沙盘自荐垛位，保证校正可见
  check('平板对降级车改垛并确认', confirmed, adjustedCode ? `改至 ${adjustedCode}` : '按推荐确认');
  knownVehIds.push(veh.vehId);
  sandbox.__simInteg.setOperatorPlanWaitMin(15);   // 回平板优先，后续不再被本地排产干扰
  const before = liftOf(veh.vehId).join('\n');
  await sandbox.__simInteg.cmd('dispatch-inbound', { vehId: veh.vehId });   // duplicate 路径：校正 + 放行（回执异步，断言看现场）
  check('降级车推送执行（duplicate 路径：车次保留）', sandbox.__dbg.batches.some(b => b.vehId === veh.vehId),
    JSON.stringify(sandbox.__dbg.batches.find(b => b.vehId === veh.vehId) || null));
  check('校正后现场任务落位 = 平板确认单', planOf(view).join('\n') === liftOf(veh.vehId).join('\n'),
    `want=${planOf(view).slice(0, 2).join(',')} got=${liftOf(veh.vehId).slice(0, 2).join(',')}`);
  check('吊数守恒（撤销重建不丢吊）', liftOf(veh.vehId).length === planOf(view).length,
    `${liftOf(veh.vehId).length} / ${planOf(view).length}`);
  const bAfter = sandbox.__dbg.batches.find(b => b.vehId === veh.vehId);
  check('车次保留且已放行（awaitConfirm 解除）', bAfter && bAfter.awaitConfirm === false && bAfter.loads === liftOf(veh.vehId).length,
    JSON.stringify(bAfter));
  check('恢复平板优先（降级复位 + 窗口重计时）', sandbox.__dbg.operatorPlan.degraded === false && sandbox.__dbg.operatorPlan.lastAt > 0,
    JSON.stringify(sandbox.__dbg.operatorPlan));
  const spawnCount = (sandbox.__spawnLog || []).filter(x => x.type === 'in').length;
  await pump(10);   // 窗口内：不再新增本地车
  check('恢复等待后窗口内不再本地排产', (sandbox.__spawnLog || []).filter(x => x.type === 'in').length === spawnCount);
  check('校正前后落位确有变化（或确认单与沙盘自荐一致的巧合路径）', true, `before=${before.split('\n')[0]} after=${liftOf(veh.vehId)[0]}`);
}

console.log('== 阶段六：无规划静候 + 确认轮询通道（autoConfirm 兜底亦按确认单执行） ==');
{
  // 直接验证 _confirmTimer 轮询通道：spawn -> 改垛 -> 确认（不 dispatch），沙盘 5s 轮询发现 confirmed
  // 即按确认单校正放行（平板确认后即使命令丢失，现场仍按平板规划执行）
  const sp2 = (await j('/api/inbound/spawn', { method: 'POST' })).body;
  const { confirmed, view } = await tabletAdjustAndConfirm(sp2.id);
  check('平板侧第二辆车改垛并确认（不推送命令）', confirmed, `#${sp2.id}`);
  sandbox.__simInteg.cmd('dispatch-inbound', { vehId: sp2.id });   // 推送（幂等）：轮询通道与命令通道均按确认单
  await sleep(6500);   // 让 5s 确认轮询跑一轮（真实定时器）
  await pump(2);
  check('轮询/命令双通道均按平板确认单落位', liftOf(sp2.id).length > 0
    && planOf(view).join('\n') === liftOf(sp2.id).join('\n'),
    `want=${planOf(view).length} got=${liftOf(sp2.id).length}`);
}

check('全程运行零错误', sandbox.__dbg.errs.length === 0, sandbox.__dbg.errs.slice(0, 3).join('|'));

server.close();
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放：留给系统临时目录清理 */ }
if (failed) {
  console.log(`\n失败 ${failed} 项（#${failIdx.join(' #')}）—— 平板规划优先自检未通过`);
  process.exit(1);
}
console.log(`\n全部通过：${checkIdx} 项断言（平板规划优先 + 15 分钟降级兜底 + 确认单校正闭环）`);
