// 本地库存数据库（Node + SQLite / better-sqlite3）
// 存储钢厂棒材库区库存/库位数据：库位 -> 8 垛 -> 每垛 20 捆
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateSlots, SPECS } from './layout.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const STACKS_PER_SLOT = 8;          // 每库位垛数（竖着排列）
export const BUNDLES_PER_STACK = 20;       // 每垛最多捆数
export const INIT_INVENTORY = 30;          // 初始库存捆数
export const DB_PATH = process.env.WAREHOUSE_DB || join(__dirname, 'warehouse.db');

/** 打开（不存在则创建）数据库并建表 */
export function openDb(path = DB_PATH) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS specs (
      name   TEXT PRIMARY KEY,
      weight REAL NOT NULL,
      color  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS storage_slots (
      id     INTEGER PRIMARY KEY,
      code   TEXT NOT NULL UNIQUE,
      zone   TEXT NOT NULL,
      area   INTEGER NOT NULL,
      span   INTEGER NOT NULL,          -- 0=A跨 1=B跨 2=C跨；3=整跨合并位
      merged INTEGER NOT NULL DEFAULT 0,
      state  TEXT NOT NULL DEFAULT 'free'   -- free / occupied / locked
    );
    CREATE TABLE IF NOT EXISTS stacks (
      slot_id  INTEGER NOT NULL REFERENCES storage_slots(id),
      stack_no INTEGER NOT NULL CHECK (stack_no BETWEEN 1 AND ${STACKS_PER_SLOT}),
      spec     TEXT,                    -- 同垛单一规格；空垛为 NULL
      count    INTEGER NOT NULL DEFAULT 0 CHECK (count BETWEEN 0 AND ${BUNDLES_PER_STACK}),
      pending  INTEGER NOT NULL DEFAULT 0,  -- 待扫码捆数
      in_time  REAL,                    -- 垛内最早捆入库时间（仿真时钟秒，FIFO 用）
      PRIMARY KEY (slot_id, stack_no)
    );
  `);
}

/** 重建数据：写入规格 + 91 库位 + 728 垛，并随机预置初始库存（均已扫码入账） */
export function seed(db, { inventory = INIT_INVENTORY } = {}) {
  const slots = generateSlots();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM stacks').run();
    db.prepare('DELETE FROM storage_slots').run();
    db.prepare('DELETE FROM specs').run();

    const insSpec = db.prepare('INSERT INTO specs (name, weight, color) VALUES (?, ?, ?)');
    for (const s of SPECS) insSpec.run(s.name, s.weight, s.color);

    const insSlot = db.prepare(
      'INSERT INTO storage_slots (id, code, zone, area, span, merged, state) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const s of slots) {
      insSlot.run(s.id, s.code, s.zone, s.area, s.span, s.merged, 'free');
      for (let n = 1; n <= STACKS_PER_SLOT; n++) {
        db.prepare('INSERT INTO stacks (slot_id, stack_no, spec, count, pending, in_time) VALUES (?, ?, NULL, 0, 0, NULL)')
          .run(s.id, n);
      }
    }

    // 初始库存：随机撒 inventory 捆到各垛，均已扫码入账（pending=0）
    const insBundle = db.prepare(
      'INSERT INTO stacks (slot_id, stack_no, spec, count, pending, in_time) VALUES (?, ?, ?, 1, 0, ?) ' +
      'ON CONFLICT(slot_id, stack_no) DO UPDATE SET count = count + 1');
    const touchSlot = db.prepare("UPDATE storage_slots SET state='occupied' WHERE id=?");
    for (let i = 0; i < inventory; i++) {
      const slot = slots[Math.floor(Math.random() * slots.length)];
      const stackNo = 1 + Math.floor(Math.random() * STACKS_PER_SLOT);
      const spec = SPECS[Math.floor(Math.random() * SPECS.length)];
      insBundle.run(slot.id, stackNo, spec.name, -(600 + Math.random() * 6600));
      touchSlot.run(slot.id);
    }
  });
  tx();
}

/** 库存汇总 */
export function getInventory(db) {
  const slotCount = db.prepare('SELECT COUNT(*) n FROM storage_slots').get().n;
  const totalBundles = db.prepare('SELECT COALESCE(SUM(count), 0) n FROM stacks').get().n;
  const pending = db.prepare('SELECT COALESCE(SUM(pending), 0) n FROM stacks').get().n;
  const occupiedSlots = db.prepare("SELECT COUNT(*) n FROM storage_slots WHERE state='occupied'").get().n;
  const totalCapacity = slotCount * STACKS_PER_SLOT * BUNDLES_PER_STACK;
  const perZone = db.prepare(`
    SELECT s.zone,
           COUNT(DISTINCT s.id)          AS slots,
           COALESCE(SUM(k.count), 0)     AS bundles,
           COALESCE(SUM(k.pending), 0)   AS pending
    FROM storage_slots s
    LEFT JOIN stacks k ON k.slot_id = s.id
    GROUP BY s.zone`).all();
  return {
    slotCount, totalBundles, pending, occupiedSlots, totalCapacity,
    utilization: totalCapacity ? totalBundles / totalCapacity : 0,
    perZone,
  };
}

/** 全部库位（含各垛） */
export function getSlots(db) {
  return db.prepare('SELECT * FROM storage_slots ORDER BY id').all()
    .map(s => ({ ...s, stacks: getStacks(db, s.id) }));
}

/** 单个库位（含各垛）；不存在返回 null */
export function getSlot(db, id) {
  const s = db.prepare('SELECT * FROM storage_slots WHERE id=?').get(id);
  if (!s) return null;
  return { ...s, stacks: getStacks(db, s.id) };
}

function getStacks(db, slotId) {
  return db.prepare('SELECT * FROM stacks WHERE slot_id=? ORDER BY stack_no').all(slotId);
}

/** 规格列表 */
export function getSpecs(db) {
  return db.prepare('SELECT * FROM specs ORDER BY name').all();
}

/**
 * 更新某一垛（spec/count/pending/in_time），并同步库位状态。
 * 垛清零时强制清空 spec 与 pending；库位所有垛清零后状态置 free。
 * 垛不存在返回 null。
 */
export function setStack(db, slotId, stackNo, patch = {}) {
  const cur = db.prepare('SELECT * FROM stacks WHERE slot_id=? AND stack_no=?').get(slotId, stackNo);
  if (!cur) return null;
  let spec = patch.spec !== undefined ? patch.spec : cur.spec;
  let count = patch.count !== undefined ? patch.count : cur.count;
  let pending = patch.pending !== undefined ? patch.pending : cur.pending;
  const in_time = patch.in_time !== undefined ? patch.in_time : cur.in_time;
  if (!count || count <= 0) { spec = null; pending = 0; count = 0; }
  db.prepare('UPDATE stacks SET spec=?, count=?, pending=?, in_time=? WHERE slot_id=? AND stack_no=?')
    .run(spec, count, pending, in_time, slotId, stackNo);
  const total = db.prepare('SELECT COALESCE(SUM(count), 0) n FROM stacks WHERE slot_id=?').get(slotId).n;
  db.prepare("UPDATE storage_slots SET state=? WHERE id=?").run(total > 0 ? 'occupied' : 'free', slotId);
  return getSlot(db, slotId);
}
