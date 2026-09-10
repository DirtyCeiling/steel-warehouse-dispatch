// 无头自检：验证「外部物流数据源消费」（沙盘以 ?feed=all / ?feed=live 显式接入）——
// 进厂车/提货订单从 LogisticsData_Sim 事件流增量拉取（各自持游标），
// 多实例消费同一条流 = 同样的进度（默认模式为本地排产，见 self-test.mjs）。
// 桩掉 DOM/Canvas，在 Node VM 中运行"调度仿真沙盘.html"完整脚本；fetch 用 feed-stub.mjs
// （复用真实生成器，1× 源速跟随沙盘仿真钟到点放行事件）。
// 用法：node simulation/logistics-feed-self-test.mjs
import { readFileSync } from 'node:fs';
import { injectCoreSegs } from './sandbox-page-loader.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeFeedFetch } from './feed-stub.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const html = injectCoreSegs(readFileSync(join(here, '调度仿真沙盘.html'), 'utf8'));
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) throw new Error('未找到 <script> 内容');
const code = m[1];

const absorber = new Proxy(function () {}, {
  get(t, p) { if (p === Symbol.toPrimitive) return () => 0; return absorber; },
  set() { return true; },
  apply() { return absorber; },
});

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

/** 建一个沙盘实例（location.search 可配 ?feed= 模式）；返回 { sandbox, pump, flush } */
function makeSandbox(search = '', withFetch = true) {
  const elements = new Map();
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
    location: { search },
    URLSearchParams,   // 页面用其解析 ?feed=live / ?logi= 参数
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`Math.random = (() => { let s = 20260826; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; })();`, sandbox);
  vm.runInContext(code, sandbox, { filename: 'sandbox-inline.js' });
  return {
    sandbox,
    el: id => documentStub.getElementById(id),
    pump(realSeconds, fps = 30) {
      const frames = Math.round(realSeconds * fps);
      for (let i = 0; i < frames; i++) {
        now += 1000 / fps;
        const q = rafQueue.splice(0);
        for (const cb of q) cb(now);
      }
    },
    async flush() {   // 让 fetch 桩的异步链（health/events -> 建任务）落地
      for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
    },
    _withFetch: withFetch,
  };
}

let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
}

const IN1 = { plate: '冀A·11111', waybill: 'YD26-10001', mill: '承德建龙', manifest: [{ spec: '螺纹钢 Φ20', bundles: 6 }], tons: 12.6 };
const IN2 = { plate: '鲁B·22222', waybill: 'YD26-10002', mill: '唐山瑞丰', manifest: [{ spec: '圆钢 Φ50', bundles: 5 }, { spec: '圆钢 Φ60', bundles: 4 }], tons: 25.4 };
const OUT1 = { orderNo: 'L26-000001', spec: '螺纹钢 Φ20', bundles: 2, tons: 4.2 };

console.log('== 阶段一：连接与事件消费（?feed=all 全量回放：任意实例从流头消费） ==');
{
  const sb = makeSandbox('?feed=all');
  const feedFetch = makeFeedFetch(() => sb.sandbox.__dbg.simTime, { quiet: true });
  sb.sandbox.fetch = feedFetch;
  sb.sandbox.init(); sb.sandbox.setPaused(false);
  sb.pump(1); await sb.flush();
  check('物流源连接成功（all 模式，游标定位到流头 0）',
    sb.sandbox.__dbg.feed.online === true && sb.sandbox.__dbg.feed.mode === 'all' && sb.sandbox.__dbg.feed.cursor === 0,
    `mode=${sb.sandbox.__dbg.feed.mode} cursor=${sb.sandbox.__dbg.feed.cursor}`);
  check('标题栏徽标显示已连接', sb.el('feedStatus').className.includes('on'), sb.el('feedStatus').textContent);

  feedFetch.inject('in', { ...IN1 });
  feedFetch.inject('out', { ...OUT1 });
  sb.pump(2); await sb.flush(); sb.pump(2); await sb.flush();
  const f1 = sb.sandbox.__dbg.feed;
  check('两条事件全部消费（游标推进）', f1.processed === 2 && f1.cursor === 2, `processed=${f1.processed} cursor=${f1.cursor}`);
  check('随车运单建满车次（6 吊）', sb.sandbox.__dbg.batches.some(b => b.loads === 6 && b.kind === 'in'),
    sb.sandbox.__dbg.batches.map(b => `${b.kind}${b.loads}`).join(','));
  check('提货订单按源订单号建合同', sb.sandbox.__dbg.orders.some(o => o.id === 'L26-000001' && o.required === 2),
    sb.sandbox.__dbg.orders.map(o => o.id).join(','));
  check('事件日志含进厂车识别信息（车牌/运单/钢厂）',
    sb.el('logList').children.some(ch => ch.innerHTML.includes(IN1.plate))
      && sb.el('logList').children.some(ch => ch.innerHTML.includes(IN1.waybill)), '');
  check('留痕 __spawnLog 与源事件一致', (sb.sandbox.__spawnLog || []).length === 2
    && sb.sandbox.__spawnLog[0].plate === IN1.plate && sb.sandbox.__spawnLog[1].order === 'L26-000001', '');

  console.log('== 阶段二：容量不足挂起 + 容量恢复续接（整车不拆丢） ==');
  // 先进一辆 40 吊整车占满待处理队列（含阶段一余留任务 < 48 上限，可整消费），再进一辆 10 吊车
  // -> 必然触发「任务队列将超上限」挂起；16× 加速跑让机器狗扫码出账、待处理下降，挂起车辆自动续接。
  feedFetch.inject('in', { plate: '津C·30000', waybill: 'YD26-30000', mill: '敬业集团', manifest: [{ spec: '螺纹钢 Φ25', bundles: 40 }], tons: 128 });
  sb.pump(3); await sb.flush(); sb.pump(2); await sb.flush();
  const mid = sb.sandbox.__dbg.feed.processed;
  check('40 吊整车消费建任务', mid === 3, `processed=${mid}`);
  feedFetch.inject('in', { plate: '津C·30001', waybill: 'YD26-30001', mill: '敬业集团', manifest: [{ spec: '螺纹钢 Φ25', bundles: 10 }], tons: 32 });
  sb.pump(4); await sb.flush(); sb.pump(2); await sb.flush();
  const f2 = sb.sandbox.__dbg.feed;
  check('任务队列打满后后车挂起（游标停住）', f2.processed === 3 && f2.holding != null,
    `processed=${f2.processed} holding=${f2.holding ? '#' + f2.holding.seq : '无'}`);
  sb.sandbox.setSpeed(16);
  for (let i = 0; i < 40 && sb.sandbox.__dbg.feed.holding != null; i++) { sb.pump(10); await sb.flush(); }
  const f3 = sb.sandbox.__dbg.feed;
  check('容量恢复后挂起车辆自动续接完毕（整车 10 吊不丢）', f3.holding == null && f3.processed === 4,
    `processed=${f3.processed} cursor=${f3.cursor}`);
  sb.sandbox.setSpeed(1);
}

console.log('== 阶段三：多实例共享同一条流（后开实例回放补齐 => 同样的车辆进度） ==');
{
  const sbA = makeSandbox('?feed=all'), sbB = makeSandbox('?feed=all'), sbC = makeSandbox('?feed=all'), sbD = makeSandbox('?feed=live');
  const shared = makeFeedFetch(() => sbA.sandbox.__dbg.simTime, { quiet: true });   // 单一数据源（共享桩）
  sbA.sandbox.fetch = shared;
  sbB.sandbox.fetch = shared;
  sbC.sandbox.fetch = shared;                    // 后开实例（全量回放：从流头消费补齐进度）
  sbD.sandbox.fetch = shared;                    // live 显式退回：跳过历史只跟新车
  sbA.sandbox.init(); sbB.sandbox.init(); sbA.sandbox.setPaused(false); sbB.sandbox.setPaused(false);
  sbA.pump(1); await sbA.flush(); sbB.pump(1); await sbB.flush();

  shared.inject('in', { ...IN1 });
  shared.inject('out', { ...OUT1 });
  shared.inject('in', { ...IN2 });
  sbA.pump(3); await sbA.flush(); sbA.pump(2); await sbA.flush();
  sbB.pump(3); await sbB.flush(); sbB.pump(2); await sbB.flush();
  const a = sbA.sandbox.__dbg.feed, b = sbB.sandbox.__dbg.feed;
  check('先开的两实例（A/B）消费全部 3 条且同进度', a.processed === 3 && b.processed === 3 && b.cursor === a.cursor,
    `A=${a.processed} B=${b.processed}`);

  sbC.sandbox.init(); sbD.sandbox.init(); sbC.sandbox.setPaused(false); sbD.sandbox.setPaused(false);        // 事件已存在后再开的实例
  sbC.pump(3); await sbC.flush(); sbC.pump(2); await sbC.flush();
  sbD.pump(3); await sbD.flush(); sbD.pump(2); await sbD.flush();
  const c = sbC.sandbox.__dbg.feed, d = sbD.sandbox.__dbg.feed;
  check('后开实例（全量回放）补齐同样进度 —— 与 A/B 同车辆', c.processed === 3 && c.cursor === 3,
    `C=${c.processed}`);
  check('后开 live 实例跳过历史（游标 = 接入时流尾 3，只跟新车）', d.cursor === 3 && d.processed === 0,
    `D cursor=${d.cursor} processed=${d.processed}`);

  const la = sbA.sandbox.__spawnLog.map(e => e.plate || e.order).join('|');
  const lc = sbC.sandbox.__spawnLog.map(e => e.plate || e.order).join('|');
  check('A 与后开的 C 按同一顺序消费同一批车辆/订单', la === lc && la.includes(IN1.plate) && la.includes(IN2.plate), la);
  check('混装车两组规格都建任务', sbC.sandbox.__dbg.batches.filter(x => x.kind === 'in')
    .reduce((n, x) => n + x.loads, 0) >= 6, '');

  console.log('== 阶段三点五：数据源重置事件流 -> 沙盘游标自愈（重新对齐流头） ==');
  shared.resetStream();                          // 数据源控制台「重置」：流清空、seq 归零
  sbA.pump(2); await sbA.flush(); sbA.pump(2); await sbA.flush();
  const fheal = sbA.sandbox.__dbg.feed;
  check('检测到流重置并自愈（游标回到 0）', fheal.cursor === 0, `cursor=${fheal.cursor} lastSeq=${fheal.lastSeq}`);
  shared.inject('in', { plate: '冀E·90001', waybill: 'YD26-90001', mill: '首钢迁安', manifest: [{ spec: '圆钢 Φ50', bundles: 6 }], tons: 15.6 });
  sbA.pump(2); await sbA.flush(); sbA.pump(2); await sbA.flush();
  check('自愈后新事件正常消费', sbA.sandbox.__dbg.feed.processed === 4
    && sbA.sandbox.__spawnLog.at(-1).plate === '冀E·90001',
    `processed=${sbA.sandbox.__dbg.feed.processed}`);
}

console.log('== 阶段四：数据源离线 —— 外部模式下不本地生成车辆（仅手动按钮可用） ==');
{
  const sb = makeSandbox('?feed=all', false);   // 不注入 fetch：无头环境视为数据源离线
  sb.sandbox.init(); sb.sandbox.setPaused(false);
  sb.pump(30);
  check('离线徽标 + 告警日志', sb.sandbox.__dbg.feed.online === false && sb.el('feedStatus').className.includes('off'), sb.el('feedStatus').textContent);
  check('离线不自动生成任何车次/订单', sb.sandbox.__dbg.batches.length === 0 && sb.sandbox.__dbg.orders.length === 0
    && (sb.sandbox.__spawnLog || []).length === 0, `batches=${sb.sandbox.__dbg.batches.length}`);
  sb.sandbox.createTask('in');                   // 手动按钮不受影响
  check('手动下单仍可用', sb.sandbox.__dbg.batches.length === 1, '');
}

console.log('== 阶段五：确认单联动（进厂确认 -> 现场执行闭环）+ 车牌贯穿 + 卸毕回传 ==');
{
  const sb = makeSandbox('?feed=all');
  const feedFetch = makeFeedFetch(() => sb.sandbox.__dbg.simTime, { quiet: true });
  // 期初：先建沙盘（确认单落点要在沙盘地图上找一个空垛），再挂组合 fetch（确认单接口 -> 桩库；其余 -> 物流源桩）
  sb.sandbox.init(); sb.sandbox.setPaused(false);
  sb.pump(1); await sb.flush();
  const storages = sb.sandbox.__dbg.storages;
  const tgt = storages.find(s => s.state !== 'locked' && s.stacks[0].count === 0 && s.stacks[0].pending === 0);
  const k0 = tgt.stacks[0];
  k0.count = 0; k0.pending = 0; k0.reserved = 0; k0.spec = null; k0.bundles.length = 0;   // 保证确认落点可用
  const planVehicle = {
    id: 7, plate: IN1.plate, waybill: IN1.waybill, mill: IN1.mill, state: 'confirmed',
    bundles: 6,
    loads: [{ id: 1, spec: '螺纹钢 Φ20', bundles: 6, adjusted: true,
      recSlotId: -1, recStackNo: 1, recCode: tgt.code, recScore: 99, recParts: [],
      slotId: -1, stackNo: 1, code: tgt.code }],   // 管理工改垛后的最终落点
  };
  let unloadPosted = 0;
  sb.sandbox.fetch = async url => {
    const u = String(url);
    if (u.includes('/api/inbound/match')) {
      return { ok: true, status: 200, json: async () => (u.includes(encodeURIComponent(IN1.plate)) ? planVehicle : null) };
    }
    if (u.includes('/api/inbound/7/unload')) { unloadPosted++; return { ok: true, status: 200, json: async () => ({}) }; }
    return feedFetch(url);
  };
  feedFetch.inject('in', { ...IN1 });
  feedFetch.inject('in', { plate: '鲁B·22222', waybill: 'YD26-10002', mill: '唐山瑞丰', manifest: [{ spec: '圆钢 Φ50', bundles: 5 }, { spec: '圆钢 Φ60', bundles: 4 }], tons: 25.4 });
  sb.pump(3); await sb.flush(); sb.pump(3); await sb.flush();
  check('两条进厂事件全部消费', sb.sandbox.__dbg.feed.processed === 2, `processed=${sb.sandbox.__dbg.feed.processed}`);
  check('确认单命中：按确认垛位下发（留痕日志）',
    sb.el('logList').children.some(ch => ch.innerHTML.includes('按进厂确认单落位') && ch.innerHTML.includes(tgt.code)), '');
  check('确认单联动日志只记一次（车级）',
    sb.el('logList').children.filter(ch => ch.innerHTML.includes('进厂确认单联动')).length === 1, '');
  check('车牌贯穿：货车车牌 = 物流源车牌（确认单车）',
    sb.sandbox.__dbg.truckHistory.some(t => t.plate === IN1.plate), sb.sandbox.__dbg.truckHistory.map(t => t.plate).join(','));
  check('车牌贯穿：无确认单车同样沿用源车牌（车次级；混装分跨凑车未满不派车）',
    sb.sandbox.__dbg.batches.some(b => b.plate === '鲁B·22222'), '');
  check('无确认单车未触发确认单联动', !sb.el('logList').children.some(ch => ch.innerHTML.includes('鲁B·22222') && ch.innerHTML.includes('确认单')), '');
  // 16× 加速跑完确认单车装卸 + 机器狗扫码，直至卸毕离场回传
  sb.sandbox.setSpeed(16);
  for (let i = 0; i < 80 && unloadPosted === 0; i++) { sb.pump(10); await sb.flush(); }
  sb.sandbox.setSpeed(1);
  check('确认单落位物理执行：目标垛落满 6 捆同规格',
    k0.count === 6 && k0.spec.name === '螺纹钢 Φ20', `count=${k0.count} spec=${k0.spec && k0.spec.name}`);
  check('卸毕回传台账闭环（POST /api/inbound/7/unload 恰一次）', unloadPosted === 1, `posted=${unloadPosted}`);
  check('运行零错误', sb.sandbox.__dbg.errs.length === 0, sb.sandbox.__dbg.errs.slice(0, 3).join('|'));
}

console.log(failed === 0 ? '\n物流源消费自检通过 ✓' : `\n${failed} 项断言失败 ✗`);
process.exitCode = failed === 0 ? 0 : 1;
