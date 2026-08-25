// 数据库自检：建库 -> 断言布局 -> 写入某垛 -> 重开库验证持久化
// 用法：npm run db:test  或  node server/check.js
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openDb, seed, getInventory, getSlots, getSlot, setStack,
  STACKS_PER_SLOT, BUNDLES_PER_STACK,
} from './database.js';

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
check(`总库容 91×${STACKS_PER_SLOT}×${BUNDLES_PER_STACK}=${91 * STACKS_PER_SLOT * BUNDLES_PER_STACK}`, inv.totalCapacity === 14560, String(inv.totalCapacity));
check('初始库存为实际钢材分布（>3000 捆，利用率 30~60%，均已入账）',
  inv.totalBundles > 3000 && inv.utilization > 0.3 && inv.utilization < 0.6 && inv.pending === 0,
  `${inv.totalBundles} 捆 · ${(inv.utilization * 100).toFixed(1)}%`);
check('存在空闲库位（入库缓冲位）', inv.occupiedSlots < inv.slotCount, `${inv.slotCount - inv.occupiedSlots} 个空库位`);
check('分区统计齐全', inv.perZone.length === 4, JSON.stringify(inv.perZone.map(z => `${z.zone}:${z.slots}`)));

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

console.log('== 持久化（关闭后重开） ==');
db.close();
const db2 = openDb(dbPath);
const inv2 = getInventory(db2);
check('重开后库位仍 91', inv2.slotCount === 91, String(inv2.slotCount));
check('重开后初始库存仍存在', inv2.totalBundles > 0, String(inv2.totalBundles));
const s2 = getSlot(db2, slotId);
check('重开后写入内容已持久化', s2.stacks[0].count === 0 && s2.state === 'free', JSON.stringify({ count: s2.stacks[0].count, state: s2.state }));
db2.close();
rmSync(dir, { recursive: true, force: true });

console.log(failed === 0 ? '\n数据库自检通过 ✓' : `\n${failed} 项断言失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
