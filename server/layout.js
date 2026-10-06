// 库区布局生成：按现场平面图还原（图见 库房真实布局图.drawio，生成器 simulation/layout-diagram-gen.mjs）
// 91 库位 = 一跨 33 + 二跨 25（14~16/26~27/31~33 号区现场无库位）+ 三跨 33；
// 号区（1~33）沿厂房长向，垛位序号沿跨宽方向；每库位垛数 = 现场实际垛位列数
//（2/3/10，一跨 14~16 大棒头(制光钢)为整宽合并单垛），库房参数 stacksPerSlot 只能在此上限内收窄。

/** 三条竖向（横贯三跨）车辆进出通道列：5|6、16|17、27|28 号区边界，不设库位 */
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

/** 栅格列 -> 1~33 号区编号（通道列返回 null）；三跨共用同一长向坐标 */
export function areaOfCol(c) {
  const bx = c - 2;
  if (bx < 0) return null;
  if (bx <= 4) return bx + 1;             // 1~5 装棒筒区/扁钢杂/冀鲁扁钢（各跨端区）
  if (bx <= 16) return bx;                // 6~16
  if (bx <= 28) return bx >= 18 ? bx - 1 : null; // 17 为通道；18~28 -> 17~27
  return bx >= 30 ? bx - 2 : null;        // 29 为通道；30~35 -> 28~33
}

/** 分区表（现场平面图标注）：[起始号区, 截止号区, 分区名]，按跨（0=A/1=B/2=C）给出 */
export const SPAN_ZONES = [
  [ // 一跨 A（棒材跨）
    [1, 5, '装棒筒区'], [6, 13, '大棒区域'], [14, 16, '大棒头（制光钢）'],
    [17, 27, '中棒区域'], [28, 33, '备用区域'],   // 28~33 现场图上未标注分区，按备用区域计
  ],
  [ // 二跨 B（管材跨）
    [1, 5, '扁钢杂区域'], [6, 9, '219及钢管长钢区域（10米以上）'], [10, 12, '460管（9.5米左右）'],
    [13, 13, '高钢管'], [17, 17, '高钢管（临时）'], [18, 25, '小无缝及钢管短钢区域（8米以内）'],
    [28, 30, '钢管外贸区域'],
  ],
  [ // 三跨 C（外贸/内贸棒扁钢跨）
    [1, 5, '冀鲁扁钢区域'], [6, 10, '大棒外贸区域'], [11, 15, '小中棒外贸区域'],
    [16, 16, '外贸长钢区域'], [17, 22, '小棒内贸区域'], [23, 25, '待定'],
    [26, 27, '扁棒圆钢区域'], [28, 33, '商品坯'],
  ],
];

/** 二跨无库位号区（现场平面图为空白，不生成库位） */
export const SPAN_B_VACANT = new Set([14, 15, 16, 26, 27, 31, 32, 33]);

/** 号区 -> 分区（按跨）；无库位号区返回 null */
export function zoneOfSlot(span, area) {
  for (const [lo, hi, name] of SPAN_ZONES[span] || []) if (area >= lo && area <= hi) return name;
  return null;
}

/** 每库位物理垛数（跨宽方向实际垛位列数；生效垛数 = min(库房参数/逐库位覆盖, 物理垛数)） */
export function physicalRacks(span, area) {
  if (span === 0) {
    if (area >= 14 && area <= 16) return 1;   // 一跨 14~16 大棒头(制光钢)：整宽合并单垛
    return area <= 2 ? 2 : 3;                 // 一跨 1~2 号区 2 垛（中间为通道口），3~33 号区 3 垛
  }
  if (area <= 2) return 2;                    // 二/三跨端区 1~2 号区 2 个宽垛位
  if (area <= 5) return 3;                    // 二/三跨端区 3~5 号区 3 个宽垛位
  if (span === 2 && area >= 28) return 3;     // 三跨 28~33 商品坯：3 个宽垛位
  return 10;                                  // 二/三跨主区：10 垛
}

/**
 * 生成库位列表（与仿真沙盘 buildMap 一致）：
 *   span: 0=A跨(一跨) 1=B跨(二跨) 2=C跨(三跨)；
 *   一跨 14~16 为整宽合并库位（merged=1，仅此一跨设位，编码沿用现场「14/15/16」）；
 *   二跨 14~16/26~27/31~33 号区现场无库位，不生成；
 *   每库位 racks = 物理垛数（2/3/10，合并位 1）。
 */
export function generateSlots() {
  const slots = [];
  let id = 0;
  for (let c = 2; c <= 37; c++) {          // 36 个库位列
    if (LANE_COLS.includes(c)) continue;
    const area = areaOfCol(c);
    if (area == null) continue;
    for (let span = 0; span < 3; span++) {
      if (span === 1 && SPAN_B_VACANT.has(area)) continue;   // 二跨无库位号区（含 14~16，仅一跨设整宽合并位）
      const merged = span === 0 && area >= 14 && area <= 16 ? 1 : 0;
      const code = merged ? String(area) : `${area}-${span + 1}`;
      slots.push({ id: id++, code, zone: zoneOfSlot(span, area), area, span, merged,
        racks: physicalRacks(span, area) });
    }
  }
  return slots;
}

/** 库位编码 -> 物理垛数（默认上限）；未知编码回落 10 */
const RACKS_BY_CODE = new Map(generateSlots().map(s => [s.code, s.racks]));
export function physicalRacksOf(code) { return RACKS_BY_CODE.get(code) ?? 10; }

/** 分区库位计数 */
export function zoneCounts(slots) {
  const z = {};
  for (const s of slots) z[s.zone] = (z[s.zone] || 0) + 1;
  return z;
}
