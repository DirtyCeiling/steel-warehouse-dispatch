// 库房真实布局图生成器：按现场 Excel 平面图（一跨/二跨/三跨三张表）还原，
// 生成 drawio 原生 XML。用法：node simulation/layout-diagram-gen.mjs
// 布局口径：号区（1~33）沿厂房长向（x），垛位序号沿跨宽方向（y）；
// 三条汽车通道位于 5|6、16|17、27|28 号区边界，横贯三跨。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const POS_W = 44, LANE_W = 22, X0 = 110;
const Y_TITLE = 6, Y_HDR = 34, Y_A = 56, RH_A = 24, Y_ZA = Y_A + 3 * RH_A + 4;
const RH_B = 14, Y_B = Y_ZA + 20, Y_ZB = Y_B + 10 * RH_B + 4;
const Y_C = Y_ZB + 20, Y_ZC = Y_C + 10 * RH_B + 4;
const Y_NOTE = Y_ZC + 26;
const LANES_AFTER = [5, 16, 27];            // 汽车通道所在的号区边界
const laneX = after => xOfPos(after) + POS_W;
function xOfPos(p) {
  let x = X0 + (p - 1) * POS_W;
  for (const l of LANES_AFTER) if (p > l) x += LANE_W;
  return x;
}

const C = {                                 // 配色（取自现场 Excel）
  yellow: '#FFFF00', orange: '#FFC000', gray: '#D6DCE4', green: '#92D050',
  blue: '#9DC3E6', pipe: '#00B0F0', lblue: '#BDD7EE', white: '#FFFFFF', none: '#F2F2F2',
};

/* 每跨：号区 -> 垛位格（rows = 跨宽方向行区间 [r0,r1]） */
function cellsA(p) {
  const L = (rows, label, color) => [{ rows, label, color }];
  if (p <= 2) return L([0, 0], `${p}-1`, C.yellow).concat(L([2, 2], `${p}-2`, C.yellow));
  if (p <= 4) return L([0, 0], `${p}-1`, C.orange).concat(L([1, 1], `${p}-2`, C.orange), L([2, 2], `${p}-3`, C.orange));
  if (p === 5) return L([0, 0], '5-1', C.orange).concat(L([1, 1], '5-2', C.orange), L([2, 2], '5-3', C.orange));
  if (p <= 13) return [0, 1, 2].map(i => ({ rows: [i, i], label: `${p}-${i + 1}`, color: C.gray }));
  if (p <= 16) return [{ rows: [0, 2], label: String(p), color: C.green }];          // 整宽合并垛位
  if (p <= 27) return [0, 1, 2].map(i => ({ rows: [i, i], label: `${p}-${i + 1}`, color: C.blue }));
  if (p === 28) return [0, 1, 2].map(i => ({ rows: [i, i], label: `28-${i + 1}`, color: C.green }));
  return [0, 1, 2].map(i => ({ rows: [i, i], label: `${p}-${i + 1}`, color: C.white }));
}
function cellsBC(p, mid) {                  // mid: 6~33 号区每垛一格的填充色；null = 该号区无库位
  const L = (rows, label, color) => [{ rows, label, color }];
  if (p <= 2) return L([0, 2], `${p}-1`, mid.end).concat(L([7, 9], `${p}-2`, mid.end));
  if (p <= 5) return L([0, 2], `${p}-1`, mid.end).concat(L([3, 6], `${p}-2`, mid.end), L([7, 9], `${p}-3`, mid.end));
  if (mid.color == null) return [];
  return Array.from({ length: 10 }, (_, i) => ({ rows: [i, i], label: `${p}-${i + 1}`, color: mid.color(p) }));
}
const SPANS = [
  {
    key: 'A', name: '一跨 A', rows: 3, rh: RH_A, y: Y_A, fs: 9,
    cells: cellsA,
    endLane: p => (p <= 2 ? [{ rows: [1, 1], label: '通道' }] : []),
    zones: [
      ['装棒筒区', 1, 5, C.orange], ['大棒区域', 6, 13, C.gray], ['大棒头(制光钢)', 14, 16, C.green],
      ['中棒区域', 17, 27, C.blue], ['备用区域(原图未标注)', 28, 33, C.white],
    ],
  },
  {
    key: 'B', name: '二跨 B', rows: 10, rh: RH_B, y: Y_B, fs: 7,
    cells: p => cellsBC(p, {
      end: C.lblue,
      color: p => (p <= 9 ? C.yellow : p <= 12 ? C.orange : p === 13 ? C.pipe : p === 17 ? C.pipe
        : p <= 25 ? C.yellow : p <= 30 ? C.yellow : null),
    }),
    endLane: p => (p <= 2 ? [{ rows: [3, 6], label: '车辆进出通道' }] : []),
    missing: [14, 15, 16, 26, 27, 31, 32, 33],
    zones: [
      ['扁钢杂区域', 1, 5, C.lblue], ['219及钢管长钢区域(>10米)', 6, 9, C.yellow], ['460管(9.5米左右)', 10, 12, C.orange],
      ['高钢管', 13, 13, C.pipe], ['高钢管(临时)', 17, 17, C.pipe], ['小无缝及钢管短钢区域(<8米)', 18, 25, C.yellow],
      ['钢管外贸区域', 28, 30, C.yellow],
    ],
  },
  {
    key: 'C', name: '三跨 C', rows: 10, rh: RH_B, y: Y_C, fs: 7,
    cells: p => cellsBC(p, {
      end: C.yellow,
      color: p => (p <= 10 ? C.lblue : p <= 15 ? C.yellow : p === 16 ? C.pipe : p <= 22 ? C.lblue
        : p <= 25 ? C.yellow : p <= 27 ? C.orange : C.white),
    }),
    endLane: p => (p <= 2 ? [{ rows: [3, 6], label: '车辆进出通道' }] : []),
    zones: [
      ['冀鲁扁钢区域', 1, 5, C.yellow], ['大棒外贸区域', 6, 10, C.lblue], ['小中棒外贸区域', 11, 15, C.yellow],
      ['外贸长钢区域', 16, 16, C.pipe], ['小棒内贸区域', 17, 22, C.lblue], ['待定', 23, 25, C.yellow],
      ['扁棒圆钢区域', 26, 27, C.orange], ['商品坯', 28, 33, C.white],
    ],
  },
];
/* 三跨 C 28~33 号区为 3 个宽合并垛位（商品坯），覆盖 cellsBC 的 10 格细划 */
SPANS[2].cells = p => {
  if (p >= 28) return [[0, 2], [3, 6], [7, 9]].map((rows, i) => ({ rows, label: `${p}-${i + 1}`, color: C.yellow }));
  return cellsBC(p, {
    end: C.yellow,
    color: q => (q <= 10 ? C.lblue : q <= 15 ? C.yellow : q === 16 ? C.pipe : q <= 22 ? C.lblue
      : q <= 25 ? C.yellow : q <= 27 ? C.orange : C.white),
  });
};

let id = 0;
const cells = [];
const rect = (x, y, w, h, value, style) =>
  cells.push(`<mxCell id="c${id++}" value="${value}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`);
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cellStyle = (color, fs, extra = '') =>
  `rounded=0;html=1;align=center;verticalAlign=middle;fontSize=${fs};fillColor=${color};strokeColor=#808080;${extra}`;

const W = xOfPos(33) + POS_W + 20, H = Y_NOTE + 92;
rect(10, Y_TITLE, 700, 24, '钢厂成品库房真实布局（一跨 / 二跨 / 三跨）—— 按现场平面图还原',
  'text;html=1;fontSize=16;fontStyle=1;align=left;verticalAlign=middle;');
for (let p = 1; p <= 33; p++)
  rect(xOfPos(p), Y_HDR, POS_W, 14, String(p), 'text;html=1;fontSize=8;align=center;verticalAlign=middle;');

for (const sp of SPANS) {
  rect(10, sp.y, 92, sp.rows * sp.rh, esc(sp.name),
    'rounded=0;html=1;fontSize=13;fontStyle=1;align=center;verticalAlign=middle;horizontal=0;fillColor=#EDEDED;strokeColor=#808080;');
  for (let p = 1; p <= 33; p++) {
    const x = xOfPos(p);
    if (sp.missing && sp.missing.includes(p)) {
      rect(x, sp.y, POS_W, sp.rows * sp.rh, '无库位', cellStyle(C.none, 7, 'fontColor=#999999;dashed=1;'));
      continue;
    }
    for (const cl of sp.cells(p)) {
      const y = sp.y + cl.rows[0] * sp.rh, h = (cl.rows[1] - cl.rows[0] + 1) * sp.rh;
      rect(x, y, POS_W, h, esc(cl.label), cellStyle(cl.color, sp.fs));
    }
    for (const cl of sp.endLane(p)) {
      const y = sp.y + cl.rows[0] * sp.rh, h = (cl.rows[1] - cl.rows[0] + 1) * sp.rh;
      rect(x, y, POS_W, h, esc(cl.label), cellStyle(C.green, 7));
    }
  }
  const zy = sp.key === 'A' ? Y_ZA : sp.key === 'B' ? Y_ZB : Y_ZC;
  for (const [name, from, to, color] of sp.zones) {
    const x = xOfPos(from), w = xOfPos(to) + POS_W - x;
    rect(x, zy, w, 16, esc(`${name} ${from}~${to}`), cellStyle(color, 8, 'fontStyle=1;'));
  }
  for (const l of LANES_AFTER)
    rect(laneX(l), zy, LANE_W, 16, '', cellStyle(C.green, 7));
}
for (const [i, l] of LANES_AFTER.entries())
  rect(laneX(l), Y_A, LANE_W, Y_C + 10 * RH_B - Y_A, `${i + 1}号车辆进出通道`,
    cellStyle(C.green, 9, 'horizontal=0;fontStyle=1;'));

const notes = [
  '图例：每格 = 一个垛位（编号 = 号区-垛位序）；绿色 = 车辆进出通道；绿色整宽格（一跨 14/15/16）= 大棒头(制光钢)整宽合并垛位。',
  '一跨：1~2 号区各 2 垛（中间被通道隔开）、3~5 号区各 3 垛（装棒筒区）；6~13 大棒区域、17~27 中棒区域、28~33 备用区域各 3 垛。',
  '二跨：6~30 号区各 10 垛（扁钢杂区域 1~5 为 2~3 个宽垛位）；14~16、26~27、31~33 号区无库位。',
  '三跨：6~27 号区各 10 垛；28~33 商品坯各 3 个宽垛位；1~5 号区（冀鲁扁钢）2~3 个宽垛位；1|2 号区中间为纵向车辆通道。',
];
notes.forEach((t, i) => rect(10, Y_NOTE + i * 20, W - 20, 18, esc(t), 'text;html=1;fontSize=11;align=left;verticalAlign=middle;'));

const xml = `<mxGraphModel dx="1000" dy="600" grid="0" gridSize="10" guides="1" tooltips="1" connect="0" arrows="0" fold="1" page="1" pageScale="1" pageWidth="${W + 20}" pageHeight="${H + 20}" math="0" shadow="0" adaptiveColors="auto"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel>`;
const out = join(dirname(fileURLToPath(import.meta.url)), '..', '库房真实布局图.drawio');
writeFileSync(out, xml, 'utf8');
console.log(`written: ${out} (${cells.length} shapes)`);
