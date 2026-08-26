// 物流数据源桩（无头自检共用）：复用真实生成器 ../LogisticsData_Sim/server/generator.js（零依赖），
// 以 1× 源速映射——源时钟跟随沙盘仿真钟推进，事件"到点放行"，实现 /api/health 与 /api/events。
// 其余 URL 一律 404 形状：沙盘对 /api/params、/api/slots 等按"服务不可达"走既有兜底。
// 用法：sandbox.fetch = makeFeedFetch(() => sandbox.__dbg.simTime)；或 opts.events 传固定剧本。
import { createGenerator, advance, reschedule } from '../../LogisticsData_Sim/server/generator.js';

export function makeFeedFetch(getSimTime, opts = {}) {
  // quiet=true：不自排产（班次排到无穷远），仅 inject() 注入的事件存在 —— 供剧本式断言精确控制
  const gen = opts.quiet
    ? createGenerator({ params: opts.params, nextInAt: Infinity, nextOutAt: Infinity })
    : createGenerator({ params: opts.params });
  const events = [];
  let seq = 0;
  // 与真实 API 一致：负载扁平展开（消费方直接读 ev.plate / ev.manifest / ev.orderNo）
  const push = (type, simTime, payload) => events.push({ seq: ++seq, type, simTime, ...payload });
  const pumpSource = () => {                    // 源时钟追平沙盘仿真钟（1×），生成到期事件
    const target = getSimTime();
    if (target > gen.simTime) advance(gen, target - gen.simTime, push);
  };
  const stub = async url => {
    const u = String(url);
    pumpSource();
    if (u.includes('/api/health')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, service: 'logistics-data-sim', lastSeq: seq, simTime: gen.simTime }) };
    }
    if (u.includes('/api/events')) {
      const q = new URL(u, 'http://stub.local');
      const after = Number(q.searchParams.get('after') || 0);
      const type = q.searchParams.get('type');
      return { ok: true, status: 200, json: async () => ({ lastSeq: seq, events: events.filter(e => e.seq > after && (!type || e.type === type)) }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  stub.setParams = p => { Object.assign(gen.params, p); if (!opts.quiet) reschedule(gen); };
  stub.inject = (type, payload) => { pumpSource(); push(type, getSimTime(), payload); };   // 剧本注入
  stub.resetStream = () => { events.length = 0; seq = 0; };                                // 模拟数据源「重置事件流」
  stub.events = events;
  stub.gen = gen;
  return stub;
}
