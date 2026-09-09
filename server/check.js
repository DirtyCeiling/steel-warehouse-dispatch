// 数据库自检：建库 -> 断言布局 -> 写入某垛 -> 重开库验证持久化
// 用法：npm run db:test  或  node server/check.js
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb, seed, getInventory, getSlots, getSlot, setStack,
  syncBundlePositions, getBundlePositions,
  bundleDiaCm, bundleRods, getBundleRules, applyBundleRules, getGeoCfg, deriveRods,
  STACKS_PER_SLOT, BUNDLES_PER_STACK,
} from './database.js';
import { SPECS } from './layout.js';

let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
}

// 用临时库文件，避免污染正式 warehouse.db
const dir = mkdtempSync(join(tmpdir(), 'whdb-'));
const dbPath = join(dir, 'test.db');

// 固定随机种子，保证初始库存撒点确定性（与仿真自检一致）
let seedState = 20260824;
Math.random = () => {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState / 2147483648;
};

const db = openDb(dbPath);
seed(db);

console.log('== 布局/库存 ==');
const inv = getInventory(db);
check('库位总数 91', inv.slotCount === 91, String(inv.slotCount));
const stackCount = getSlots(db).reduce((s, x) => s + x.stacks.length, 0);
check(`每库位 ${STACKS_PER_SLOT} 垛 -> 垛位总数 ${91 * STACKS_PER_SLOT}`, stackCount === 91 * STACKS_PER_SLOT, String(stackCount));
check(`总库容 91×${STACKS_PER_SLOT}×${BUNDLES_PER_STACK}=${91 * STACKS_PER_SLOT * BUNDLES_PER_STACK}`, inv.totalCapacity === 91 * STACKS_PER_SLOT * getGeoCfg().bundlesPerStack, String(inv.totalCapacity));
check('初始库存为实际钢材分布（捆径 15~50cm 口径约 4.7 万捆，利用率 ~16%，均已入账）',
  inv.totalBundles > 40000 && inv.totalBundles < 52000 && inv.utilization > 0.13 && inv.utilization < 0.2 && inv.pending === 0,
  `${inv.totalBundles} 捆 · ${(inv.utilization * 100).toFixed(1)}%`);
check('存在空闲库位（入库缓冲位）', inv.occupiedSlots < inv.slotCount, `${inv.slotCount - inv.occupiedSlots} 个空库位`);
check('分区统计齐全', inv.perZone.length === 4, JSON.stringify(inv.perZone.map(z => `${z.zone}:${z.slots}`)));

console.log('== 捆径口径（一捆合起来的直径，参数化上下限） ==');
const diaMin = getGeoCfg().minDiaCm, diaMax = getGeoCfg().maxDiaCm;
for (const sp of SPECS) {
  const rods = bundleRods(sp.name), d = bundleDiaCm(sp.name);
  const ok = d != null && (rods === 1 ? d >= diaMin : d >= diaMin && d <= diaMax);
  check(`${sp.name}：${rods === 1 ? '单支吊运不打带' : `${rods} 支/捆`} · 捆径 ${d?.toFixed(1)}cm（${rods === 1 ? `管径本身 ≥ ${diaMin}` : `须 ${diaMin}~${diaMax}`}）`,
    ok, d?.toFixed(1));
}
check('规则引擎自动推导（Φ12 杆径 -> 三角数最小合规支数）', deriveRods(12) >= 3, `${deriveRods(12)} 支`);
check('规则引擎单支判定（Φ200 单支达标 / Φ600 单支物理下限）', deriveRods(200) === 1 && deriveRods(600) === 1, '');

console.log('== 捆制规则覆盖（spec_rules） ==');
const rulesBefore = getBundleRules(db);
const r20 = rulesBefore.find(r => r.spec === '螺纹钢 Φ20');
check('期初全部为预置规则（无覆盖）', rulesBefore.every(r => r.source === 'preset'), rulesBefore.filter(r => r.source !== 'preset').map(r => r.spec).join(','));
const ap = applyBundleRules(db, [{ spec: '螺纹钢 Φ20', rods: 10 }, { spec: '圆钢 Φ50', rods: 0 }]);
check('覆盖支数生效（Φ20 -> 10 支/捆）', bundleRods('螺纹钢 Φ20') === 10, String(bundleRods('螺纹钢 Φ20')));
check('越界覆盖返回警示（10 支 Φ20 捆径 < 下限）', ap.warnings.length === 1 && ap.warnings[0].includes('螺纹钢 Φ20'), ap.warnings[0] || '');
check('自动推导来源生效（圆钢 Φ50 -> auto）', bundleRods('圆钢 Φ50') === deriveRods(50) && getBundleRules(db).find(r => r.spec === '圆钢 Φ50').source === 'auto', `${bundleRods('圆钢 Φ50')} 支`);
check('棒材吨位随支数重算（Φ20 2.1 基准 -> 按米重）', ap.weights.some(w => w.spec === '螺纹钢 Φ20'), JSON.stringify(ap.weights));
const ap2 = applyBundleRules(db, [{ spec: '螺纹钢 Φ20', rods: null }, { spec: '圆钢 Φ50', rods: null }]);
check('清除覆盖恢复预置（Φ20 -> 21 支、吨位回写）',
  bundleRods('螺纹钢 Φ20') === r20.rods && getBundleRules(db).every(r => r.source === 'preset')
  && getBundleRules(db).find(r => r.spec === '螺纹钢 Φ20').weight === r20.weight, String(bundleRods('螺纹钢 Φ20')));

console.log('== 写入 / 状态同步 ==');
// 选一个初始为空闲的库位做写入测试，保证状态同步断言不受随机撒点影响
const freeSlot = getSlots(db).find(x => x.state === 'free');
check('存在空闲库位可测写入', !!freeSlot, freeSlot && freeSlot.code);
const slotId = freeSlot.id;
let s = getSlot(db, slotId);
check(`库位 ${s.code} 含 8 垛`, s.stacks.length === STACKS_PER_SLOT, `${s.code}`);
setStack(db, slotId, 1, { spec: '螺纹钢 Φ20', count: 5, pending: 1, in_time: 100 });
s = getSlot(db, slotId);
check('写入第 1 垛 5 捆', s.stacks[0].count === 5 && s.stacks[0].spec === '螺纹钢 Φ20', `count=${s.stacks[0].count}`);
check('库位状态同步为 occupied', s.state === 'occupied', s.state);
setStack(db, slotId, 1, { count: 0 });
s = getSlot(db, slotId);
check('清零后垛 spec=null/pending=0', s.stacks[0].count === 0 && s.stacks[0].spec === null && s.stacks[0].pending === 0, JSON.stringify(s.stacks[0]));
check('清零后库位状态回 free', s.state === 'free', s.state);
check('写入不存在的垛返回 null', setStack(db, slotId, 99, { count: 1 }) === null, '');

console.log('== 捆级三维落位（bundle_positions） ==');
// 模拟天车落料：同垛连续落 5 捆，层内座位应按固定网格展开（每层并排数按规格自适应）
const mk = (i) => ({
  bundleId: `B-T${String(i).padStart(3, '0')}`, slotId, stackNo: 2,
  layer: 0, seat: i, spec: '圆钢 Φ50', len: 6,
  dx: 0.01 * (i % 3 - 1), y: 0.41, dz: 0.138 * (i - 1.5), yaw: 0.003, putTime: 100 + i,
});
let r = syncBundlePositions(db, { replace: true, upserts: [0, 1, 2, 3, 4].map(mk) });
check('全量对齐写入 5 条落位坐标', r.upserted === 5 && r.total === 5, JSON.stringify(r));
let rows = getBundlePositions(db, { slotId, stackNo: 2 });
check('按库位+垛过滤查询命中 5 条', rows.length === 5 && rows[0].bundleId === 'B-T000', `${rows.length} 条`);
check('坐标字段完整（层/座位/dx/y/dz/yaw/落位时刻）',
  rows[0].layer === 0 && rows[0].seat === 0 && Math.abs(rows[0].y - 0.41) < 1e-9 && rows[0].putTime === 100
  && rows[0].spec === '圆钢 Φ50', JSON.stringify(rows[0]));
// 倒垛迁移：同捆换垛 upsert 覆盖（layer/seat/stack_no 更新，不产生重复行）
syncBundlePositions(db, { upserts: [{ ...mk(9), bundleId: 'B-T000', stackNo: 3, layer: 1, seat: 2, y: 0.53 }] });
rows = getBundlePositions(db, { slotId });
check('倒垛迁移按捆号覆盖（总行数不变）', rows.length === 5, String(rows.length));
const moved = rows.find(x => x.bundleId === 'B-T000');
check('迁移后坐标更新（第 3 垛 第 2 层 第 3 位）', moved.stackNo === 3 && moved.layer === 1 && moved.seat === 2, JSON.stringify(moved));
// 出库吊走：按捆号删除
r = syncBundlePositions(db, { deletes: ['B-T000', 'B-T001', '不存在的捆'] });
check('出库删除落位坐标（剩余 3 条）', r.total === 3, JSON.stringify(r));
// 垛清零联动：setStack count=0 应清空该垛坐标
syncBundlePositions(db, { upserts: [mk(7), mk(8)].map(p => ({ ...p, stackNo: 4 })) });
setStack(db, slotId, 4, { count: 0 });
check('垛清零联动清空该垛落位坐标', getBundlePositions(db, { slotId, stackNo: 4 }).length === 0, '');
check('其余垛坐标不受影响', getBundlePositions(db, { slotId, stackNo: 2 }).length === 3, '');

console.log('== 持久化（关闭后重开） ==');
db.close();
const db2 = openDb(dbPath);
const inv2 = getInventory(db2);
check('重开后库位仍 91', inv2.slotCount === 91, String(inv2.slotCount));
check('重开后初始库存仍存在', inv2.totalBundles > 0, String(inv2.totalBundles));
const s2 = getSlot(db2, slotId);
check('重开后写入内容已持久化', s2.stacks[0].count === 0 && s2.state === 'free', JSON.stringify({ count: s2.stacks[0].count, state: s2.state }));
check('重开后捆级落位坐标已持久化（3 条）', getBundlePositions(db2, { slotId, stackNo: 2 }).length === 3, '');
db2.close();
rmSync(dir, { recursive: true, force: true });

console.log(failed === 0 ? '\n数据库自检通过 ✓' : `\n${failed} 项断言失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
