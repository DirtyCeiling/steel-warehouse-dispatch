// 本地库存数据库 HTTP 服务（Node 内置 http，零额外依赖）
// 监听 127.0.0.1:3001，带 CORS（*），供 React 应用 / 仿真页后续直接调用。
// 用法：node server/index.js  或  npm run db:serve
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  openDb, seed, getInventory, getSlots, getSlot, getSpecs, setStack,
  getAppData, seedAppData, createTask, updateTaskStatus, DB_PATH,
} from './database.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3001);

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

export function startServer({ host = HOST, port = PORT } = {}) {
  const db = openDb(); // 自动建库（不存在则创建 warehouse.db）
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}:${port}`);
    const p = url.pathname;
    try {
      if (req.method === 'OPTIONS') return json(res, 204, {});
      if (req.method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, db: DB_PATH });
      if (req.method === 'GET' && p === '/api/inventory') return json(res, 200, getInventory(db));
      if (req.method === 'GET' && p === '/api/slots') return json(res, 200, { slots: getSlots(db) });
      if (req.method === 'GET' && p === '/api/specs') return json(res, 200, getSpecs(db));

      // 主应用（三维库区）数据接口：前端启动时从这里加载全量数据
      if (req.method === 'GET' && p === '/api/app/data') {
        const data = getAppData(db);
        return data ? json(res, 200, data) : json(res, 404, { error: '主应用数据未初始化，请先执行 npm run db:init-app' });
      }
      if (req.method === 'POST' && p === '/api/app/reset') {
        seedAppData(db);
        return json(res, 200, getAppData(db));
      }
      if (req.method === 'POST' && p === '/api/app/tasks') {
        const body = await readBody(req);
        const t = createTask(db, body);
        return t ? json(res, 200, t) : json(res, 400, { error: '任务参数不完整（需 id、type、steelCoilId）或钢卷不存在' });
      }
      const mTask = p.match(/^\/api\/app\/tasks\/([^/]+)$/);
      if (req.method === 'PUT' && mTask) {
        const body = await readBody(req);
        if (!body.status) return json(res, 400, { error: '缺少 status 字段' });
        const t = updateTaskStatus(db, decodeURIComponent(mTask[1]), body.status);
        return t ? json(res, 200, t) : json(res, 404, { error: '任务不存在' });
      }

      const mSlot = p.match(/^\/api\/slots\/(\d+)$/);
      if (req.method === 'GET' && mSlot) {
        const s = getSlot(db, +mSlot[1]);
        return s ? json(res, 200, s) : json(res, 404, { error: '库位不存在' });
      }
      const mStack = p.match(/^\/api\/slots\/(\d+)\/stacks\/(\d+)$/);
      if (req.method === 'PUT' && mStack) {
        const body = await readBody(req);
        const s = setStack(db, +mStack[1], +mStack[2], body);
        return s ? json(res, 200, s) : json(res, 404, { error: '垛位不存在' });
      }
      if (req.method === 'POST' && p === '/api/reset') {
        seed(db);
        return json(res, 200, { ok: true, ...getInventory(db) });
      }
      json(res, 404, { error: '接口不存在' });
    } catch (e) {
      json(res, 500, { error: String((e && e.message) || e) });
    }
  });
  return new Promise(resolve => {
    server.listen(port, host, () => {
      console.log(`[库存数据库] 已启动：http://${host}:${port}  （库文件 ${DB_PATH}）`);
      resolve(server);
    });
  });
}

// 直接运行本文件则启动服务（跨平台判断：import.meta.url 与 argv[1] 转成同一 file:// 形式比较）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startServer();
