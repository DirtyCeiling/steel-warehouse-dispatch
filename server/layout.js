// 库区布局生成：与仿真「调度仿真沙盘.html」的 buildMap 完全一致
// 91 库位（36 库位列 × 三跨，含 14~16 整跨合并位），每库位 8 垛 × 每垛 400 捆（通用上限，实际按限高收窄）

/** 三条竖向（横贯三跨）车辆进出通道列：不设库位 */
export const LANE_COLS = [7, 19, 31];

/** 棒材/管材规格（与仿真 SPECS 一致；weight = 9m 基准单捆吨位，按捆内支数 × 理论米重核算） */
export const SPECS = [
  { name: '螺纹钢 Φ20', weight: 0.47, color: '#f59e0b' },   // 21 支 × 2.47kg/m × 9m ≈ 0.47t
  { name: '螺纹钢 Φ25', weight: 0.52, color: '#fb923c' },   // 15 支 × 3.85kg/m × 9m ≈ 0.52t
  { name: '圆钢 Φ50', weight: 0.56, color: '#38bdf8' },     // 4 支 × 15.41kg/m × 9m ≈ 0.56t
  { name: '圆钢 Φ60', weight: 0.6, color: '#7dd3fc' },      // 3 支 × 22.20kg/m × 9m ≈ 0.60t
  { name: '方钢 40×40', weight: 0.57, color: '#a78bfa' },   // 5 支 × 12.56kg/m × 9m ≈ 0.57t
  // 管材（无缝钢管，Φ50~Φ600；小口径成捆、Φ200 起单支吊运不打带）
  { name: '管材 Φ50', weight: 0.3, color: '#2dd4bf' },
  { name: '管材 Φ100', weight: 0.8, color: '#34d399' },
  { name: '管材 Φ200', weight: 1.1, color: '#4ade80' },
  { name: '管材 Φ400', weight: 0.9, color: '#a3e635' },
  { name: '管材 Φ600', weight: 1.8, color: '#16a34a' },
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
