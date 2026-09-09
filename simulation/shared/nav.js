/* 顶部导航注入：页面 header 内放 <nav data-sim-nav="页面键" title="..."></nav>，
 * 本脚本（紧跟 </header> 后同步引入）填充统一链接表——当前页高亮、其余新标签打开；
 * 同时处理 ?embed=1 页内工作台嵌入模式（html.embed class，由 tokens.css 隐藏导航）。
 * 沙盘类页面有独立导航结构，不用本文件。 */
(function () {
  'use strict';
  if (new URLSearchParams(location.search).get('embed') === '1') {
    document.documentElement.classList.add('embed');
  }
  const nav = document.querySelector('nav[data-sim-nav]');
  if (!nav) return;
  const active = nav.dataset.simNav;
  const LINKS = [
    ['sandbox', '/', '🗺 仿真沙盘'],
    ['inbound', '/inbound', '🚚 进厂确认'],
    ['vehicles', '/vehicles', '📋 车辆记录'],
    ['scans', '/scans', '⏱ 扫描时效'],
    ['params', '/params', '⚙ 调度参数'],
    ['whcfg', '/whcfg', '🏗 库房参数'],
    ['runs', '/runs', '📊 仿真场次'],
  ];
  for (const [key, href, label] of LINKS) {
    const a = document.createElement('a');
    if (key !== active) { a.href = href; a.target = '_blank'; }
    else a.className = 'on';
    a.textContent = label;
    nav.appendChild(a);
  }
})();
