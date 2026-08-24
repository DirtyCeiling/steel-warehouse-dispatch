// 库存数据库命令行工具
//   npm run db:init     初始化（建库 + 布局 + 初始库存）
//   npm run db:reset    重置为初始库存
//   npm run db:inspect  打印库存汇总与抽样库位
//   npm run db:serve    启动本地 HTTP API 服务
import { openDb, seed, getInventory, getSlot, DB_PATH } from './database.js';
import { startServer } from './index.js';

const cmd = process.argv[2] || 'help';

function printSummary(db) {
  const inv = getInventory(db);
  console.log(`库文件：${DB_PATH}`);
  console.log(`库位 ${inv.slotCount} 个 · 垛位 ${inv.slotCount * 8} 个 · 总库容 ${inv.totalCapacity} 捆`);
  console.log(`当前库存 ${inv.totalBundles} 捆（待扫码 ${inv.pending}）· 占用库位 ${inv.occupiedSlots} 个 · 利用率 ${(inv.utilization * 100).toFixed(2)}%`);
  console.log('分区统计：');
  for (const z of inv.perZone) {
    console.log(`  ${z.zone.padEnd(8)} 库位 ${String(z.slots).padStart(3)} · 捆 ${String(z.bundles).padStart(4)}`);
  }
  const s = getSlot(db, 0);
  if (s) {
    const occ = s.stacks.filter(k => k.count > 0);
    console.log(`抽样库位 ${s.code}（${s.zone}）：${occ.map(k => `第${k.stack_no}垛 ${k.spec}×${k.count}`).join('；') || '全空'}`);
  }
}

switch (cmd) {
  case 'init': {
    const db = openDb();
    seed(db);
    db.close();
    console.log('已初始化数据库（91 库位 × 8 垛 × 20 捆 + 初始库存 30 捆）');
    printSummary(openDb());
    break;
  }
  case 'reset': {
    const db = openDb();
    seed(db);
    db.close();
    console.log('已重置为初始库存');
    printSummary(openDb());
    break;
  }
  case 'inspect':
    printSummary(openDb());
    break;
  case 'serve':
    startServer();
    break;
  default:
    console.log(`用法：node server/cli.js <init|reset|inspect|serve>`);
    break;
}
