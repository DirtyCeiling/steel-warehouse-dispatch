// 极简静态服务器：托管 simulation 目录，站点包含三个页面：
//   /          仿真沙盘（调度仿真沙盘.html）
//   /inbound   进厂确认（管理工垛位分配确认/调整，含人工反馈→算法优化面板）
//   /params    调度参数（全系统唯一的参数设置页；沙盘每 5 秒自动同步）
// 同时自动启动库存数据库 API（127.0.0.1:3001）：沙盘/页面期初数据从数据库加载、
// 确认与参数写回，两端口需同时在线——用本命令一站式拉起（npm run sim）。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SIM_PORT || 5199);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// 页面短路径 -> 实际文件（其余路径按 simulation 目录内文件解析）
const PAGES = {
  '/': '/调度仿真沙盘.html',
  '/sandbox': '/调度仿真沙盘.html',
  '/sandbox.html': '/调度仿真沙盘.html',
  '/inbound': '/进厂确认.html',
  '/inbound.html': '/进厂确认.html',
  '/vehicles': '/车辆记录.html',
  '/vehicles.html': '/车辆记录.html',
  '/scans': '/扫描时效记录.html',
  '/scans.html': '/扫描时效记录.html',
  '/runs': '/仿真场次记录.html',
  '/runs.html': '/仿真场次记录.html',
  '/params': '/调度参数.html',
  '/params.html': '/调度参数.html',
};

http.createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const target = PAGES[url] || url;
  const file = normalize(join(ROOT, target));
  if (file !== ROOT && !file.startsWith(ROOT + '\\') && !file.startsWith(ROOT + '/')) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not Found');
  }
}).listen(PORT, () => console.log(`simulation preview: http://localhost:${PORT}/  （/inbound 进厂确认 · /params 调度参数）`));

// 一并启动库存数据库 API（沙盘/页面数据加载 + 确认与参数写回依赖此服务）；
// 端口被占（已在别处启动）时仅告警，静态站点继续可用。
try {
  const { startServer } = await import('../server/index.js');
  await startServer();
} catch (e) {
  console.warn(`[库存数据库] 启动失败（可能已在别处运行，沙盘将回退内置随机库存）：${e.message}`);
}
