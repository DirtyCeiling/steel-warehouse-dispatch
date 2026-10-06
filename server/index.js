// 本地库存数据库 HTTP 服务（Node 内置 http，零额外依赖）
// 监听 127.0.0.1:3001，带 CORS（*），供 React 应用 / 仿真页后续直接调用。
// 用法：node server/index.js  或  npm run db:serve
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  openDb, seed, getInventory, getSlots, getSlot, getSpecs, setStack,
  syncBundlePositions, getBundlePositions, getSeedSlots,
  getAppData, seedAppData, createTask, updateTaskStatus, getSimParams, setSimParams, DB_PATH,
  getBundleRules, applyBundleRules, getSlotRacks, applySlotRacks, globalStacksPerSlot,
  getSteelLedger, getSteelLedgerEntry, upsertSteelLedgerMeta, steelLedgerCsv,
} from './database.js';
import { PARAM_SCHEMA } from './params.js';
import {
  spawnIncomingVehicle, registerIncomingVehicle, listInboundVehicles, getVehicleView, listVehicleViews,
  adjustLoad, confirmVehicle, deleteVehicle, listCandidates, feedbackStats,
  matchConfirmedVehicle, completeVehicle, autoConfirmExpired, pollInboundFromSource,
} from './inbound.js';
import {
  getFrontendSnapshot, bumpRev, appendEvents, listEvents, latestEventSeq,
  setTelemetry, createCommand, listCommands, finishCommand,
  touchDrive, driveHolder, checkDriveAuth, releaseDrive, takeoverDrive,
} from './frontend.js';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3001);

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Sim-Drive',
    'Access-Control-Max-Age': '600',
  });
  res.end(body);
}

/* ---- 驾驶租约（独占驾驶位仲裁）：沙盘写回/回推/认领须持租约，非沙盘（人工页/操作端）放行 ---- */
function driveIdOf(req, url, body) {
  return req.headers['x-sim-drive'] || url.searchParams.get('drive') || (body && body.driveId) || null;
}
/** 租约仲裁门：拒绝回 409 { error:'drive-lease-held', holder }；放行返回 true */
function guardDrive(req, res, url, body) {
  const r = checkDriveAuth(driveIdOf(req, url, body));
  if (r.ok) return true;
  json(res, 409, { error: 'drive-lease-held', holder: r.holder });
  return false;
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
      // 操作端快照（kg-dispatch-frontend 2s 轮询）：轻量垛级数据 + 车辆 + 汇总；
      // ?with=bundles 附带捆级明细（前端比对 rev 变化才重拉全量）
      if (req.method === 'GET' && p === '/api/frontend/snapshot') {
        return json(res, 200, getFrontendSnapshot(db, { withBundles: url.searchParams.get('with') === 'bundles' }));
      }

      // —— P2 事件流（沙盘回推 / 操作端游标拉取，协议同 LogisticsData_Sim）——
      if (req.method === 'GET' && p === '/api/events') {
        if (url.searchParams.get('latest') === '1') return json(res, 200, { seq: latestEventSeq(db) });
        const after = Number(url.searchParams.get('after')) || 0;
        const limit = Number(url.searchParams.get('limit')) || 50;
        return json(res, 200, { events: listEvents(db, after, limit) });
      }
      if (req.method === 'POST' && p === '/api/events') {
        const body = await readBody(req);
        if (!guardDrive(req, res, url, body)) return;   // 沙盘事件回推须持驾驶租约（操作端读事件无身份，不受影响）
        return json(res, 200, { appended: appendEvents(db, body.events || []) });
      }

      // —— 驾驶租约释放（切观景/关页主动让位；query 传身份免预检）——
      if (req.method === 'POST' && p === '/api/drive/release') {
        const released = releaseDrive(driveIdOf(req, url, null));
        return json(res, released ? 200 : 409, { ok: released });
      }
      // —— 驾驶租约心跳（暂停中的驾驶窗：不推遥测但保住租约，操作端会话数据不清空）——
      if (req.method === 'POST' && p === '/api/drive/heartbeat') {
        touchDrive(driveIdOf(req, url, null));
        return json(res, 200, { ok: true });
      }

      // —— 驾驶租约查询/接管（点「驾驶·数据源」时：先查持有者，他窗持有时经人工确认后强取）——
      if (req.method === 'GET' && p === '/api/drive/holder') {
        const h = driveHolder();
        return json(res, 200, { holder: h ? { id: h.holderId, label: h.holderLabel } : null });
      }
      if (req.method === 'POST' && p === '/api/drive/takeover') {
        const body = await readBody(req);
        const did = driveIdOf(req, url, body);
        if (!did) return json(res, 400, { error: '缺少 drive 身份' });
        takeoverDrive(did, (body && body.driveLabel) || '');
        return json(res, 200, { ok: true });
      }

      // —— P2 遥测（沙盘 1Hz 回推天车/机器狗实时状态；内存驻留，快照携带下发；帧即租约心跳）——
      if (req.method === 'POST' && p === '/api/telemetry') {
        const body = await readBody(req);
        const did = driveIdOf(req, url, body);
        // 有主时无身份的帧（旧版沙盘页）直接拒绝，防止旧实例蹭心跳之外还覆写遥测
        // 遥测是租约的「唯一注册/接管点」：无主时首个带身份帧接管；有主时仅持有者放行
        // （其余写回端点仅判持有者，无主时不再顺带接管——防止非遥测写抢在遥测前占位）
        if (!did && driveHolder()) return json(res, 409, { error: 'drive-lease-held', holder: driveHolder().holderLabel });   // 旧版沙盘页蹭心跳
        // 无主/过期：本帧接管；有主且非持有者：409（checkDriveAuth 对已收紧为「非遥测写不接管」）
        const h = driveHolder();
        if (did && h && h.holderId !== did) return json(res, 409, { error: 'drive-lease-held', holder: h.holderLabel || h.holderId.slice(0, 8) });
        if (did) touchDrive(did, body.driveLabel);
        setTelemetry(body, m => console.log(m));
        return json(res, 200, { ok: true });
      }

      // —— P3 命令通道：操作端写入 → 沙盘认领执行 → finish 回写 ——
      if (req.method === 'POST' && p === '/api/frontend/commands') {
        const body = await readBody(req);
        const cmd = createCommand(db, { kind: body.kind, refId: body.refId, payload: body.payload });
        return cmd ? json(res, 200, cmd) : json(res, 400, { error: '缺少 kind' });
      }
      if (req.method === 'GET' && p === '/api/frontend/commands') {
        const claim = url.searchParams.get('claim') === '1';
        const did = driveIdOf(req, url, null);
        // 认领是写行为：有身份须持租约（过期先接管）；无身份且有主时（旧版沙盘页）返回空列表——不得抢命令
        if (claim) {
          // 独占认领：仅当前持有者可拿命令（无身份/非持有者/无主下的先到者一律空列表——接管走遥测帧）
          const h = driveHolder();
          if (!did || !h || h.holderId !== did) return json(res, 200, { commands: [], driveLease: h ? { holder: h.holderLabel || h.holderId.slice(0, 8) } : null });
          touchDrive(did);
        }
        const r = listCommands(db, {
          status: url.searchParams.get('status') || 'pending',
          claim,
          limit: Number(url.searchParams.get('limit')) || 10,
        });
        return json(res, 200, { commands: r });
      }
      const mCmd = p.match(/^\/api\/frontend\/commands\/(\d+)\/finish$/);
      if (mCmd && req.method === 'POST') {
        const body = await readBody(req);
        if (!guardDrive(req, res, url, body)) return;   // 回执是写行为：非持有者迟到回执不落库
        const r = finishCommand(db, +mCmd[1], body || {});
        return r ? json(res, 200, r) : json(res, 404, { error: '命令不存在' });
      }
      if (req.method === 'GET' && p === '/api/inventory') return json(res, 200, getInventory(db));
      // ?variant=seed：期初种子分布（纯函数重建，与 /api/slots 行形状一致）——
      // 沙盘 ?feed=all 全量回放以此为期初，避免在数据库当前值上重放历史事件导致重复计数
      if (req.method === 'GET' && p === '/api/slots') {
        if (url.searchParams.get('variant') === 'seed') return json(res, 200, { slots: getSeedSlots(db) });
        return json(res, 200, { slots: getSlots(db) });
      }
      if (req.method === 'GET' && p === '/api/specs') return json(res, 200, getSpecs(db));

      // 调度规划参数：主系统「调度参数」页与仿真沙盘共用（含 schema，前端按此渲染调节控件）
      if (req.method === 'GET' && p === '/api/params') {
        return json(res, 200, { schema: PARAM_SCHEMA, values: getSimParams(db) });
      }
      if (req.method === 'PUT' && p === '/api/params') {
        const body = await readBody(req);
        return json(res, 200, { schema: PARAM_SCHEMA, values: setSimParams(db, body.values || body) });
      }

      // 捆制规则（「库房参数设计」页）：每规格每捆支数（覆盖/自动/预置）+ 捆径/垛容核算 + 吨位
      if (req.method === 'GET' && p === '/api/bundle-rules') {
        return json(res, 200, { rules: getBundleRules(db) });
      }
      if (req.method === 'PUT' && p === '/api/bundle-rules') {
        const body = await readBody(req);
        const { warnings, weights } = applyBundleRules(db, body.rules || []);
        return json(res, 200, { rules: getBundleRules(db), warnings, weights });
      }

      // 每库位垛数（「库房参数设计」页）：全局统一值（warehouse.stacksPerSlot 参数）+
      // 逐库位覆盖（racks = { 库位编码: 垛数|null }，null = 清除覆盖跟随全局）
      if (req.method === 'GET' && p === '/api/slot-racks') {
        return json(res, 200, { global: globalStacksPerSlot(), racks: getSlotRacks(db) });
      }
      if (req.method === 'PUT' && p === '/api/slot-racks') {
        const body = await readBody(req);
        const r = applySlotRacks(db, body.racks || {});
        return json(res, 200, r);
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
        bumpRev();
        return json(res, 200, r);
      }
      // 沙盘本地进厂车登记（本地排产模式）：生成即登记，操作端 P10 待办与沙盘车辆同源一致
      if (req.method === 'POST' && p === '/api/inbound/register') {
        const body = await readBody(req);
        const r = registerIncomingVehicle(db, body || {});
        if (r) bumpRev();
        return r ? json(res, 200, r) : json(res, 400, { error: '缺少 plate/waybill/groups 或规格非法' });
      }
      if (req.method === 'GET' && p === '/api/inbound/stats') {
        return json(res, 200, feedbackStats(db));
      }
      if (req.method === 'GET' && p === '/api/inbound/candidates') {
        const spec = url.searchParams.get('spec') || '';
        const bundles = Math.max(1, Number(url.searchParams.get('bundles')) || 1);
        return json(res, 200, { candidates: listCandidates(db, spec, bundles) });
      }
      // 确认单 -> 沙盘执行闭环：沙盘按车牌+运单匹配已确认分配单（未命中返回 null，回退本地推荐）
      if (req.method === 'GET' && p === '/api/inbound/match') {
        const v = matchConfirmedVehicle(db, url.searchParams.get('plate') || '', url.searchParams.get('waybill') || '');
        return json(res, 200, v);
      }
      const mUnload = p.match(/^\/api\/inbound\/(\d+)\/unload$/);
      if (mUnload && req.method === 'POST') {
        const r = completeVehicle(db, +mUnload[1]);
        if (!r.error) bumpRev();
        return r.error ? json(res, 400, { error: r.error }) : json(res, 200, r);
      }
      const mLoad = p.match(/^\/api\/inbound\/(\d+)\/loads\/(\d+)$/);
      if (req.method === 'PUT' && mLoad) {
        const body = await readBody(req);
        const r = adjustLoad(db, +mLoad[1], +mLoad[2], Number(body.slotId), Number(body.stackNo));
        if (!r.error) bumpRev();
        return r.error ? json(res, 400, { error: r.error }) : json(res, 200, r.vehicle);
      }
      const mInbound = p.match(/^\/api\/inbound\/(\d+)$/);
      if (mInbound && req.method === 'POST') {
        const r = confirmVehicle(db, +mInbound[1]);
        if (!r.error) bumpRev();
        return r.error ? json(res, 400, { error: r.error }) : json(res, 200, r);
      }
      if (mInbound && req.method === 'DELETE') {
        // 取消登记不受驾驶租约仲裁：清「自己登记的死账」是清场行为，非持有者窗口（重置/关页）也必须能取消，
        // 否则换驾驶位后旧窗口重置 → DELETE 被 409 → 台账幽灵车（P10 永远显示已不存在 World 的车）
        const did = driveIdOf(req, url, null);
        const r = deleteVehicle(db, +mInbound[1]);
        if (!r.error) {
          bumpRev();
          console.log(`[台账] 取消车辆 #${mInbound[1]}（来源 ${did ? '沙盘 ' + did.slice(0, 8) : '人工'}）`);
        } else {
          console.log(`[台账] 取消车辆 #${mInbound[1]} 失败：${r.error}（来源 ${did ? '沙盘 ' + did.slice(0, 8) : '人工'}）`);
        }
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

        const vehicles = listVehicleViews(db, db.prepare(query).all(...params).map(r => r.id));

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
        if (!guardDrive(req, res, url, body)) return;   // 垛级库存写回须持驾驶租约（多实例防互踩的权威闸）
        const s = setStack(db, +mStack[1], +mStack[2], body);
        if (s) bumpRev();
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
        if (!guardDrive(req, res, url, body)) return;   // 捆级落位写回须持驾驶租约
        const r = syncBundlePositions(db, body || {});
        bumpRev();
        return json(res, 200, r);
      }

      // —— 钢材台账（steel_ledger：一捆一行，与捆标签一一对应）——
      // 字段 = Excel「钢材入库数据-近3个月」全 18 列 + 标签附加（供应商/PO号/材料号）；
      // 落位写库自动建账/倒垛随迁/出库闭环（见 syncBundlePositions），此处为查询/导出/扫码补录。
      const ledgerFilters = () => {
        const q = url.searchParams, f = {};
        for (const k of ['bundleId', 'heatNo', 'contractNo', 'plate', 'spec', 'grade', 'buyer', 'supplier', 'state', 'from', 'to']) {
          const v = q.get(k); if (v) f[k] = v;
        }
        return f;
      };
      if (req.method === 'GET' && p === '/api/ledger') {
        const f = ledgerFilters();
        f.limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        f.offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        return json(res, 200, getSteelLedger(db, f));
      }
      // CSV 导出（UTF-8 BOM，Excel 直开；列序与「钢材入库数据-近3个月 需收集」模板一致）
      if (req.method === 'GET' && p === '/api/ledger/export.csv') {
        const f = ledgerFilters();
        f.limit = Math.min(50000, Math.max(1, Number(url.searchParams.get('limit')) || 50000));
        const { rows, total } = getSteelLedger(db, f);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('钢材出入库台账.csv')}`,
          'Access-Control-Allow-Origin': '*',
          'X-Total-Count': String(total),
        });
        return res.end('﻿' + steelLedgerCsv(rows));
      }
      // 扫码补录/修正标签元数据（真实场景对接捆标签二维码枪）：按捆号更新在库行，无则立未落位新行
      if (req.method === 'POST' && p === '/api/ledger') {
        const body = await readBody(req);
        const r = upsertSteelLedgerMeta(db, body || {});
        return r ? json(res, 200, r) : json(res, 400, { error: '缺少 bundleId' });
      }
      const mLedger = p.match(/^\/api\/ledger\/([^/]+)$/);
      if (mLedger && req.method === 'GET') {
        const r = getSteelLedgerEntry(db, decodeURIComponent(mLedger[1]));
        return r ? json(res, 200, r) : json(res, 404, { error: '捆号无台账记录' });
      }

      if (req.method === 'POST' && p === '/api/reset') {
        seed(db);
        bumpRev();
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
      startAutoConfirmTimer(db);
      startInboundFeedPoller(db);
      resolve(server);
    });
  });
}

/** 进厂确认超时自动下发：每 15s 扫一次待确认车辆，超时（默认 5 分钟，可调 / 0 关闭）按推荐方案确认。
 *  确认失败（如库位被任务占用）保持待确认并只记一次日志，避免刷屏；车辆回到可确认状态即自动放行。 */
function startAutoConfirmTimer(db) {
  const failed = new Set();
  const timer = setInterval(() => {
    try {
      for (const r of autoConfirmExpired(db)) {
        if (r.error) {
          if (!failed.has(r.id)) console.log(`[进厂确认] 车辆 #${r.id} 超时自动确认失败：${r.error}`);
          failed.add(r.id);
        } else {
          failed.delete(r.id);
          console.log(`[进厂确认] 车辆 #${r.id}（${r.plate} / ${r.waybill}）超时未确认，已按推荐方案自动确认下发`);
        }
      }
    } catch (e) {
      console.error('[进厂确认] 超时自动确认异常：', e && e.message || e);
    }
  }, 15000);
  timer.unref();   // 不阻塞进程退出（测试环境起停服务时）
}

/** 物流源自动进厂轮询：每 2s 从 LogisticsData_Sim 增量拉取进厂车事件，登记为待确认车辆。
 *  沙盘（?feed 模式）消费同一条事件流——确认队列/车辆记录与三维仿真因此同源同步；
 *  与「模拟车辆进厂」按钮共用 inbound-confirm 游标，互不重复。源离线时空转（静默）。 */
function startInboundFeedPoller(db) {
  let busy = false;   // 上一轮未返回（源响应慢）时跳过本轮，防重入
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await pollInboundFromSource(db); }
    catch { /* pollInboundFromSource 内部已兜底，此处双保险 */ }
    finally { busy = false; }
  }, 2000);
  timer.unref();
}

// 直接运行本文件则启动服务（跨平台判断：import.meta.url 与 argv[1] 转成同一 file:// 形式比较）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startServer();
