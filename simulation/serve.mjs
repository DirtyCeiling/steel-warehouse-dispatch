// 极简静态服务器：托管 simulation 目录，用于预览仿真沙盘（单文件页面无其它依赖）
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = 5199;
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

http.createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // 根路径直接返回沙盘页面；同时提供英文短路径 /sandbox
  const target = (url === '/' || url === '' || url === '/sandbox' || url === '/sandbox.html')
    ? '/调度仿真沙盘.html' : url;
  const file = normalize(join(ROOT, target));
  if (file !== ROOT && !file.startsWith(ROOT + '\\') && !file.startsWith(ROOT + '/')) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not Found');
  }
}).listen(PORT, () => console.log(`simulation preview: http://localhost:${PORT}/`));
