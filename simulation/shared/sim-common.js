/* 全站公共工具（经典脚本 + 全局 SIM 命名空间，保持 file:// 双击与 VM 无头自测兼容）。
 * 页面用法：主脚本开头解构 const { DB_API, api, esc } = SIM;（其余代码零改动）。
 * 仅收编各页**逐字等价**的定义；同名不同义的工具（如仿真世界时钟 fmtClock/fmtDur）
 * 由页面自持，避免公共层语义混淆。 */
window.SIM = (function () {
  'use strict';
  const qs = new URLSearchParams(location.search);
  // 库存数据库 API；本地多实例调试可用 ?api=http://127.0.0.1:3101 覆盖
  const DB_API = qs.get('api') || 'http://127.0.0.1:3001';
  // 外部物流数据源（沙盘 ?feed= 模式）；?logi= 覆盖
  const LOGISTICS_API = qs.get('logi') || 'http://127.0.0.1:5288';

  /** 带错误封装的 fetch JSON：非 2xx 时抛 ({data.error} || errLabel + HTTP 状态) */
  async function api(path, opts, errLabel) {
    const res = await fetch(DB_API + path, opts);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || (errLabel + '：HTTP ' + res.status));
    return data;
  }

  // 规格配色全集：车辆记录/进厂确认（5 种棒材）与库房参数设计/三维查看（10 种含管材）共用的超集
  const SPEC_COLORS = {
    '螺纹钢 Φ20': '#f59e0b', '螺纹钢 Φ25': '#fb923c', '圆钢 Φ50': '#38bdf8', '圆钢 Φ60': '#7dd3fc',
    '方钢 40×40': '#a78bfa', '管材 Φ50': '#2dd4bf', '管材 Φ100': '#34d399',
    '管材 Φ200': '#4ade80', '管材 Φ400': '#a3e635', '管材 Φ600': '#16a34a',
  };
  const specColor = s => SPEC_COLORS[s] || '#94a3b8';

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** ISO 时间戳 -> 短日期时间（带兜底 '-'，进厂确认页旧版无兜底、行为一致故统一） */
  const fmtFull = iso => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
  /** ISO 时间戳 -> 时钟 HH:MM */
  const fmtClock = iso => iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '-';

  /** 延时着色阈值（扫描时效/仿真场次共用）：120s 内绿 / 300s 内黄 / 超出红 */
  const delayCls = v => v == null ? 't-dim' : v <= 120 ? 'd-ok' : v <= 300 ? 'd-mid' : 'd-bad';

  /** 消息条：SIM.msg(msgEl, ok, text, onRetry)——onRetry 为「重试」按钮回调（页面自己的 load） */
  function msg(el, ok, text, onRetry) {
    el.innerHTML = '';
    if (!text) return;
    const div = document.createElement('div');
    div.className = 'msg ' + (ok ? 'ok' : 'err');
    div.textContent = text;
    if (onRetry) {
      const b = document.createElement('button');
      b.textContent = '重试';
      b.onclick = onRetry;
      div.appendChild(b);
    }
    el.appendChild(div);
  }

  return { DB_API, LOGISTICS_API, api, SPEC_COLORS, specColor, esc, fmtFull, fmtClock, delayCls, msg };
})();
