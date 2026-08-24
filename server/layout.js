// 库区布局生成：与仿真「调度仿真沙盘.html」的 buildMap 完全一致
// 91 库位（36 库位列 × 三跨，含 14~16 整跨合并位），每库位 8 垛 × 每垛 20 捆

/** 三条竖向（横贯三跨）车辆进出通道列：不设库位 */
export const LANE_COLS = [7, 19, 31];

/** 棒材规格（与仿真 SPECS 一致） */
export const SPECS = [
  { name: '螺纹钢 Φ20', weight: 2.1, color: '#f59e0b' },
  { name: '螺纹钢 Φ25', weight: 3.2, color: '#fb923c' },
  { name: '圆钢 Φ50', weight: 2.6, color: '#38bdf8' },
  { name: '圆钢 Φ60', weight: 3.5, color: '#7dd3fc' },
  { name: '方钢 40×40', weight: 1.9, color: '#a78bfa' },
];

/** 栅格列 -> 1~33 号区编号（通道列返回 null） */
export function areaOfCol(c) {
  const bx = c - 2;
  if (bx < 0) return null;
  if (bx <= 4) return bx + 1;             // 1~5 铁姆肯区
  if (bx <= 16) return bx;                // 6~16 大棒区域 + 单支/长钢
  if (bx <= 28) return bx >= 18 ? bx - 1 : null; // 17 为通道；18~28 -> 17~27 中棒
  return bx >= 30 ? bx - 2 : null;        // 29 为通道；30~35 -> 28~33 中棒
}

/** 号区 -> 分区 */
export function zoneOfArea(a) {
  if (a >= 17) return '中棒区域';
  if (a >= 14) return '大棒单支和长钢';
  if (a >= 3) return '大棒区域';
  return '铁姆肯区';
}

/**
 * 生成库位列表（与仿真一致）：
 *   span: 0=A跨 1=B跨 2=C跨；14~16 整跨合并位 span=3（跨越 A~C 三跨），merged=1
 *   1、2 号区 B 跨为车辆通道，故只生成 A/C 两跨库位
 */
export function generateSlots() {
  const slots = [];
  let id = 0;
  for (let c = 2; c <= 37; c++) {          // 36 个库位列
    if (LANE_COLS.includes(c)) continue;
    const area = areaOfCol(c);
    if (area == null) continue;
    const zone = zoneOfArea(area);
    if (area >= 14 && area <= 16) {        // 大棒单支和长钢：整跨合并库位
      slots.push({ id: id++, code: String(area), zone, area, span: 3, merged: 1 });
      continue;
    }
    for (let i = 0; i < 3; i++) {
      if (area <= 2 && i === 1) continue;  // 1、2 号区 B 跨为车辆通道
      const suffix = area <= 2 ? (i === 0 ? 1 : 2) : i + 1;
      slots.push({ id: id++, code: `${area}-${suffix}`, zone, area, span: i, merged: 0 });
    }
  }
  return slots;
}

/** 分区库位计数 */
export function zoneCounts(slots) {
  const z = {};
  for (const s of slots) z[s.zone] = (z[s.zone] || 0) + 1;
  return z;
}
