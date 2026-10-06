// 数据库自检：建库 -> 断言布局 -> 写入某垛 -> 重开库验证持久化
// 用法：npm run db:test  或  node server/check.js
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb, seed, getInventory, getSlots, getSlot, setStack,
  syncBundlePositions, getBundlePositions,
  getSteelLedger, getSteelLedgerEntry, upsertSteelLedgerMeta, steelLedgerCsv,
  bundleDiaCm, bundleRods, getBundleRules, applyBundleRules, getGeoCfg, deriveRods,
  getSlotRacks, applySlotRacks, effectiveRacks, setSimParams,
  STACKS_PER_SLOT,
} from './database.js';
import { SPECS, physicalRacksOf } from './layout.js';

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
const slots0 = getSlots(db);
const stackCount = slots0.reduce((s, x) => s + x.racks, 0);
check(`每库位垛数 = 现场物理垛数（一跨 2/3、二跨主区 10、三跨 10/3、合并位 1）-> 物理总垛数 555`,
  stackCount === 555 && slots0.every(x => x.racks === physicalRacksOf(x.code)), String(stackCount));
const bps = getGeoCfg().bundlesPerStack;
check(`总库容 555×${bps}=${555 * bps}`,
  inv.totalCapacity === 555 * bps, String(inv.totalCapacity));
check('初始库存为实际钢材分布（每垛上限 100：约 3.6 万捆，利用率 ~64%，均已入账）',
  inv.totalBundles > 30000 && inv.totalBundles < 42000 && inv.utilization > 0.55 && inv.utilization < 0.75 && inv.pending === 0,
  `${inv.totalBundles} 捆 · ${(inv.utilization * 100).toFixed(1)}%`);
check('存在空闲库位（入库缓冲位）', inv.occupiedSlots < inv.slotCount, `${inv.slotCount - inv.occupiedSlots} 个空库位`);
check('分区统计齐全（现场 20 个分区）', inv.perZone.length === 20, JSON.stringify(inv.perZone.map(z => `${z.zone}:${z.slots}`)));

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

console.log('== 每库位垛数（物理上限 + 全局 stacksPerSlot + 逐库位覆盖 slot_racks） ==');
const rack1 = applySlotRacks(db, { '17-2': 4, '不存在位': 6 });
check('覆盖写入生效（17-2 -> 4 垛；未知库位忽略）', effectiveRacks('17-2') === 4 && rack1.racks['17-2'] === 4 && !('不存在位' in rack1.racks), JSON.stringify(rack1.racks));
check('覆盖不超过物理垛数（1-1 物理 2 垛，覆盖 9 -> 2）',
  applySlotRacks(db, { '1-1': 9 }).racks['1-1'] === 2 && effectiveRacks('1-1') === 2, `1-1=${effectiveRacks('1-1')}`);
applySlotRacks(db, { '1-1': null });
let s172 = getSlots(db).find(x => x.code === '17-2');
check('getSlots 下发生效垛数（17-2 racks=4；旧期初高位存货保留显示）', s172.racks === 4 && s172.stacks.length >= 4, `racks=${s172.racks} 行=${s172.stacks.length}`);
setSimParams(db, { warehouse: { stacksPerSlot: 6 } });
check('全局垛数参数生效（无覆盖位 17-3 -> 6；覆盖位 17-2 仍 4；物理 3 垛位 6-1 -> 3）',
  effectiveRacks('17-3') === 6 && effectiveRacks('17-2') === 4 && effectiveRacks('6-1') === 3,
  `17-3=${effectiveRacks('17-3')} 17-2=${effectiveRacks('17-2')} 6-1=${effectiveRacks('6-1')}`);
let invR = getInventory(db);
check(`库容按逐库位垛数汇总（Σmin(6,物理) - 2 = 385）× ${getGeoCfg().bundlesPerStack}`, invR.totalCapacity === 385 * getGeoCfg().bundlesPerStack, String(invR.totalCapacity));
seed(db);   // 重建：期初按新垛数重灌（覆盖保留）
s172 = getSlots(db).find(x => x.code === '17-2');
const s173 = getSlots(db).find(x => x.code === '17-3');
check('重建后 17-2 最多 4 垛、17-3 最多 6 垛且 racks 字段一致',
  s172.racks === 4 && s172.stacks.length === 4 && s173.racks === 6 && s173.stacks.length === 6,
  `17-2=${s172.stacks.length} 17-3=${s173.stacks.length}`);
check('覆盖跨重建保留', getSlotRacks(db)['17-2'] === 4, JSON.stringify(getSlotRacks(db)));
applySlotRacks(db, { '17-2': null });
setSimParams(db, { warehouse: { stacksPerSlot: STACKS_PER_SLOT } });
seed(db);
check(`清除覆盖并恢复全局 ${STACKS_PER_SLOT} 后回到物理总垛数 555`,
  effectiveRacks('1-1') === 2 && effectiveRacks('17-2') === 10 && getSlots(db).every(x => x.racks === physicalRacksOf(x.code)), '');

console.log('== 写入 / 状态同步 ==');
// 选一个初始为空闲的库位做写入测试，保证状态同步断言不受随机撒点影响
const freeSlot = getSlots(db).find(x => x.state === 'free');
check('存在空闲库位可测写入', !!freeSlot, freeSlot && freeSlot.code);
const slotId = freeSlot.id;
let s = getSlot(db, slotId);
check(`库位 ${s.code} 垛行与物理垛数一致（racks=${physicalRacksOf(s.code)}）`, s.racks === physicalRacksOf(s.code) && s.stacks.length === s.racks, `${s.code}`);
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

console.log('== 钢材台账（steel_ledger：Excel 入库数据 18 列 + 捆标签附加字段） ==');
// 前述流程的台账联动结果：replace 建账 5 行 -> 倒垛迁 1 行 -> 出库 2 行 -> 垛清零清 2 行（B-T007/8 随 setStack 清零）
const ledIn = getSteelLedger(db2, { state: 'in' });
check('落位写库自动建账：在库行 = B-T002/3/4（垛清零的 B-T007/8 已随垛清除，非出库）',
  JSON.stringify(ledIn.rows.map(r => r.bundleId).sort()) === JSON.stringify(['B-T002', 'B-T003', 'B-T004']),
  ledIn.rows.map(r => r.bundleId).join(','));
const ledOut = getSteelLedger(db2, { state: 'out' });
check('出库历史保留：B-T000/B-T001 已出库且行保留', ledOut.total === 2
  && ['B-T000', 'B-T001'].every(id => ledOut.rows.some(r => r.bundleId === id && r.outboundTime)), String(ledOut.total));
const eT0 = getSteelLedgerEntry(db2, 'B-T000');
check('倒垛随迁只改位置（B-T000 出库前已迁第 3 垛，行保留迁移后位置）', eT0.stackNo === 3 && eT0.layer === 1, `垛${eT0.stackNo} 层${eT0.layer}`);

// 标签元数据随落位写库（沙盘 bundlePosRow 全字段；期初捆 putTime<0 无入库时刻）
syncBundlePositions(db2, { upserts: [
  { bundleId: 'B-L100', slotId, stackNo: 2, layer: 0, seat: 9, spec: '圆钢 Φ50', len: 6,
    grade: '45#', heatNo: 'HT250317', rods: 6, weightKg: 1424, produceDate: '2026-02-13',
    contractNo: 'YTDEU25226MON-01-001', standard: 'GB/T 702', supplier: '大冶特殊钢',
    poNo: '4500169907/89501801', materialNo: 'T426000120', plate: '鲁Q·12345', putTime: 200 },
  { bundleId: 'B-L101', slotId, stackNo: 2, layer: 0, seat: 8, spec: '管材 Φ600', len: 12,
    grade: '20G', heatNo: 'HT250318', rods: 1, weightKg: 2560, putTime: -1 },
] });
const e1 = getSteelLedgerEntry(db2, 'B-L100');
check('新捆入账全字段（钢材类型按规格族推导/牌号/炉号/合同号/标准/供应商/PO号/材料号/生产日期/支数/重量）',
  e1 && e1.steelType === '圆钢' && e1.grade === '45#' && e1.heatNo === 'HT250317'
  && e1.contractNo === 'YTDEU25226MON-01-001' && e1.standard === 'GB/T 702' && e1.supplier === '大冶特殊钢'
  && e1.poNo === '4500169907/89501801' && e1.materialNo === 'T426000120' && e1.produceDate === '2026-02-13'
  && e1.rods === 6 && e1.weightKg === 1424, JSON.stringify({ type: e1?.steelType, supplier: e1?.supplier }));
check('入库时间/进厂车牌入账，库位编码随库位表联动', !!e1.inboundTime && e1.inboundPlate === '鲁Q·12345' && e1.slotCode === getSlot(db2, slotId).code, `${e1.slotCode} ${e1.inboundPlate}`);
const e101 = getSteelLedgerEntry(db2, 'B-L101');
check('期初捆（putTime<0）入库时间为空、钢材类型推导管材', e101.inboundTime === null && e101.steelType === '管材', '');

// 倒垛迁移：位置更新、身份与入库信息以首次入账为准
syncBundlePositions(db2, { upserts: [{ bundleId: 'B-L100', slotId, stackNo: 3, layer: 2, seat: 0, spec: '圆钢 Φ50', len: 6, heatNo: 'HT不应覆盖' }] });
const e2 = getSteelLedgerEntry(db2, 'B-L100');
check('倒垛随迁：位置更新、行 id 不变、炉号/合同号/进厂车牌保留',
  e2.stackNo === 3 && e2.layer === 2 && e2.id === e1.id && e2.heatNo === 'HT250317'
  && e2.contractNo === 'YTDEU25226MON-01-001' && e2.inboundPlate === '鲁Q·12345', `垛${e2.stackNo} 层${e2.layer}`);

// 出库吊走：出库时间/出厂车牌/采购商回填
syncBundlePositions(db2, { deletes: [{ bundleId: 'B-L100', plate: '豫A·88888', buyer: '中建三局' }] });
const e3 = getSteelLedgerEntry(db2, 'B-L100');
check('出库闭环：出库时间/出厂车牌/采购商回填，台账行保留',
  !!e3.outboundTime && e3.outboundPlate === '豫A·88888' && e3.buyer === '中建三局' && !getBundlePositions(db2, { slotId, stackNo: 3 }).some(p => p.bundleId === 'B-L100'), '');

// 多条件查询
check('车牌模糊查（进厂+出厂双列匹配）', getSteelLedger(db2, { plate: '鲁Q·12345' }).total === 1 && getSteelLedger(db2, { plate: '豫A' }).rows.some(r => r.bundleId === 'B-L100'), '');
check('炉号/合同号/规格/供应商查询', getSteelLedger(db2, { heatNo: 'HT250317' }).total === 1
  && getSteelLedger(db2, { contractNo: 'YTDEU' }).total === 1
  && getSteelLedger(db2, { spec: '圆钢 Φ50' }).rows.every(r => r.spec === '圆钢 Φ50')
  && getSteelLedger(db2, { supplier: '大冶' }).total === 1, '');
check('采购商查询（出库回填后命中）', getSteelLedger(db2, { buyer: '中建三局' }).total === 1, '');

// 扫码补录：在库行更新 / 未知捆立未落位新行 / 缺 bundleId 拒绝
const m1 = upsertSteelLedgerMeta(db2, { bundleId: 'B-T002', grade: 'GCr15', poNo: '4500000001/89000001' });
check('扫码补录：在库行字段更新（其余字段不动）', m1.grade === 'GCr15' && m1.poNo === '4500000001/89000001' && m1.spec === '圆钢 Φ50', '');
const m2 = upsertSteelLedgerMeta(db2, { bundleId: 'B-X999', heatNo: 'HT999999', spec: '螺纹钢 Φ20' });
check('扫码补录：未知捆立未落位新行（钢材类型随规格推导，无库位）', m2.slotId === null && m2.steelType === '螺纹钢' && m2.heatNo === 'HT999999', '');
check('补录缺 bundleId 返回 null', upsertSteelLedgerMeta(db2, {}) === null, '');

// CSV 导出：列序与 Excel 模板一致，期初捆入库时间标注「期初」
const csv = steelLedgerCsv(getSteelLedger(db2, { limit: 5000 }).rows);
check('CSV 表头列序与 Excel 模板一致（前置捆号，后置供应商/PO号/材料号）',
  csv.split('\r\n')[0] === '捆号,钢材类型,钢材材质,炉号,长度,支数,重量,日期,采购商,合同号,规格/直径,标准,库位,垛位,垛位层,入库时间,进厂车牌,出库时间,出厂车牌,供应商,PO号,材料号',
  csv.split('\r\n')[0]);
check('CSV 含标签数据行，期初捆入库时间标注「期初」',
  csv.split('\r\n').some(l => l.startsWith('B-L100') && l.includes('YTDEU25226MON-01-001') && l.includes('豫A·88888'))
  && csv.split('\r\n').some(l => l.startsWith('B-L101') && l.includes('期初')), '');

// 期初全量对齐（replace）：已落位在库行清除（捆号随沙盘重启复用，身份重建非出库）；
// 未落位扫码补录行与已出库历史保留
const outBefore = getSteelLedger(db2, { state: 'out' }).total;
syncBundlePositions(db2, { replace: true, upserts: [{ bundleId: 'B-L200', slotId, stackNo: 2, layer: 0, seat: 0, spec: '方钢 40×40', len: 9, putTime: -1, heatNo: 'HT200000' }] });
const inAfter = getSteelLedger(db2, { state: 'in' });
check('replace 对齐：已落位在库行清除、未落位补录行保留、新期初行入账',
  inAfter.rows.some(r => r.bundleId === 'B-L200') && inAfter.rows.some(r => r.bundleId === 'B-X999')
  && !inAfter.rows.some(r => /^B-T/.test(r.bundleId) || r.bundleId === 'B-L101'), inAfter.rows.map(r => r.bundleId).join(','));
check('replace 对齐不影响已出库历史', getSteelLedger(db2, { state: 'out' }).total === outBefore, String(outBefore));
db2.close();
rmSync(dir, { recursive: true, force: true });

console.log(failed === 0 ? '\n数据库自检通过 ✓' : `\n${failed} 项断言失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
