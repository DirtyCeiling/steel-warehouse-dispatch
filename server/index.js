// 本地库存数据库 HTTP 服务（Node 内置 http，零额外依赖）
// 监听 127.0.0.1:3001，带 CORS（*），供 React 应用 / 仿真页后续直接调用。
// 用法：node server/index.js  或  npm run db:serve
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  openDb, seed, getInventory, getSlots, getSlot, getSpecs, setStack,
  syncBundlePositions, getBundlePositions,
  getAppData, seedAppData, createTask, updateTaskStatus, getSimParams, setSimParams, DB_PATH,
} from './database.js';
import { PARAM_SCHEMA } from './params.js';
import {
  spawnIncomingVehicle, listInboundVehicles, getVehicleView,
  adjustLoad, confirmVehicle, deleteVehicle, listCandidates, feedbackStats,
} from './inbound.js';

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
    req.on('data', c => {
      raw += c;
      // 上限 32MB：期初全量对齐的捆级落位坐标（~7000 捆）单次 POST 约 1.5MB
      if (raw.length > 32e6) req.destroy();
    });
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

      // 调度规划参数：主系统「调度参数」页与仿真沙盘共用（含 schema，前端按此渲染调节控件）
      if (req.method === 'GET' && p === '/api/params') {
        return json(res, 200, { schema: PARAM_SCHEMA, values: getSimParams(db) });
      }
      if (req.method === 'PUT' && p === '/api/params') {
        const body = await readBody(req);
        return json(res, 200, { schema: PARAM_SCHEMA, values: setSimParams(db, body.values || body) });
      }

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

      // 进厂确认（管理工）：车牌/运单识别 -> 垛位分配推荐 -> 人工确认/调整（调整沉淀为权重优化）
      if (req.method === 'GET' && p === '/api/inbound') {
        return json(res, 200, { vehicles: listInboundVehicles(db) });
      }
      if (req.method === 'POST' && p === '/api/inbound/spawn') {
        const r = await spawnIncomingVehicle(db);   // 优先取物流数据源下一辆进厂车，离线回退本地随机
        return json(res, 200, r);
      }
      if (req.method === 'GET' && p === '/api/inbound/stats') {
        return json(res, 200, feedbackStats(db));
      }
      if (req.method === 'GET' && p === '/api/inbound/candidates') {
        const spec = url.searchParams.get('spec') || '';
        const bundles = Math.max(1, Number(url.searchParams.get('bundles')) || 1);
        return json(res, 200, { candidates: listCandidates(db, spec, bundles) });
      }
      const mLoad = p.match(/^\/api\/inbound\/(\d+)\/loads\/(\d+)$/);
      if (req.method === 'PUT' && mLoad) {
        const body = await readBody(req);
        const r = adjustLoad(db, +mLoad[1], +mLoad[2], Number(body.slotId), Number(body.stackNo));
        return r.error ? json(res, 400, { error: r.error }) : json(res, 200, r.vehicle);
      }
      const mInbound = p.match(/^\/api\/inbound\/(\d+)$/);
      if (mInbound && req.method === 'POST') {
        const r = confirmVehicle(db, +mInbound[1]);
        return r.error ? json(res, 400, { error: r.error }) : json(res, 200, r);
      }
      if (mInbound && req.method === 'DELETE') {
        const r = deleteVehicle(db, +mInbound[1]);
        return r.error ? json(res, 400, { error: r.error }) : json(res, 200, r);
      }

      // 车辆记录页面：获取所有车辆记录（支持分页和筛选）
      if (req.method === 'GET' && p === '/api/vehicles') {
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const status = url.searchParams.get('status') || '';
        const plate = url.searchParams.get('plate') || '';
        const time = url.searchParams.get('time') || '';

        let query = 'SELECT id FROM inbound_vehicles WHERE 1=1';
        const params = [];

        if (status) {
          query += ' AND state = ?';
          params.push(status);
        }
        if (plate) {
          query += ' AND plate LIKE ?';
          params.push(`%${plate}%`);
        }
        if (time === 'today') {
          query += ' AND arrive_time >= date(\'now\')';
        } else if (time === 'week') {
          query += ' AND arrive_time >= date(\'now\', \'-7 days\')';
        } else if (time === 'month') {
          query += ' AND arrive_time >= date(\'now\', \'-30 days\')';
        }

        // 获取总数
        const countQuery = query.replace('SELECT id', 'SELECT COUNT(*) as total');
        const totalResult = db.prepare(countQuery).get(...params);
        const total = totalResult ? totalResult.total : 0;

        // 获取分页数据
        query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const vehicles = db.prepare(query).all(...params)
          .map(r => getVehicleView(db, r.id));

        return json(res, 200, { vehicles, total, limit, offset });
      }

      // 车辆记录页面：获取单个车辆详情
      const mVehicle = p.match(/^\/api\/vehicles\/(\d+)$/);
      if (mVehicle && req.method === 'GET') {
        const vehicle = getVehicleView(db, +mVehicle[1]);
        return vehicle ? json(res, 200, vehicle) : json(res, 404, { error: '车辆不存在' });
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

      // 捆级三维落位（天车落垛实际坐标）：仿真落料/倒垛/出库增量同步，期初加载 replace 全量对齐；
      // GET 支持 ?slotId=&stackNo= 过滤（外部系统按捆号查具体三维位置）
      if (req.method === 'GET' && p === '/api/positions') {
        const slotId = url.searchParams.get('slotId');
        const stackNo = url.searchParams.get('stackNo');
        return json(res, 200, { positions: getBundlePositions(db, {
          slotId: slotId != null && slotId !== '' ? +slotId : undefined,
          stackNo: stackNo != null && stackNo !== '' ? +stackNo : undefined,
        }) });
      }
      if (req.method === 'POST' && p === '/api/positions') {
        const body = await readBody(req);
        return json(res, 200, syncBundlePositions(db, body || {}));
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
  return new Promise((resolve, reject) => {
    server.once('error', e => reject(e));
    server.listen(port, host, () => {
      console.log(`[库存数据库] 已启动：http://${host}:${port}  （库文件 ${DB_PATH}）`);
      resolve(server);
    });
  });
}

// 直接运行本文件则启动服务（跨平台判断：import.meta.url 与 argv[1] 转成同一 file:// 形式比较）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startServer();
