// 无头逻辑自检：在 Node VM 中运行"库存三维查看.html"的主脚本（不加载 three.js，
// 三维部分自动降级），断言库存数据模型 / 筛选 / 视图状态机 / 列表渲染正确。
// 用法：node simulation/inventory-self-test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '库存三维查看.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!scripts.length) throw new Error('未找到内联 <script>');

/* ---- DOM 桩（同 self-test.mjs 风格） ---- */
const elements = new Map();
function makeEl(id = '') {
  const el = {
    id, textContent: '', innerHTML: '', value: '', checked: false, style: {}, dataset: {},
    children: [], listeners: {},
    appendChild(ch) { this.children.push(ch); return ch; },
    removeChild(ch) { const i = this.children.indexOf(ch); if (i >= 0) this.children.splice(i, 1); return ch; },
    get firstChild() { return this.children[0]; },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); },
    querySelector() { return null; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1200, height: 800 }),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    clientWidth: 430, clientHeight: 560, scrollTop: 0, scrollHeight: 0,
    closest() { return null; },
  };
  return el;
}
const documentStub = {
  visibilityState: 'visible',
  getElementById(id) {
    if (!elements.has(id)) { const el = makeEl(id); elements.set(id, el); }
    return elements.get(id);
  },
  createElement(tag) { return makeEl('<' + tag + '>'); },
  querySelectorAll() { return []; },
  addEventListener() {},
};
const sandbox = {
  document: documentStub,
  performance: { now: () => 0 },
  requestAnimationFrame: () => 0,
  devicePixelRatio: 1,
  addEventListener() {},
  console,
  setTimeout: fn => { fn(); return 0; },
  clearTimeout() {},
};
sandbox.window = sandbox;   // 不设 THREE -> 三维降级路径
vm.createContext(sandbox);
vm.runInContext(scripts[scripts.length - 1], sandbox, { filename: 'inventory-inline.js' });

let failed = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
}
const dbg = sandbox.__dbg;
const el = id => documentStub.getElementById(id);

console.log('== 阶段一：布局与库位（与调度沙盘同源） ==');
check('库位总数 91', dbg.slots === 91, String(dbg.slots));
const zc = dbg.zoneCounts;
check('分区 中棒51/大棒33/长钢3/铁姆肯4',
  zc['中棒区域'] === 51 && zc['大棒区域'] === 33 && zc['大棒单支和长钢'] === 3 && zc['铁姆肯区'] === 4,
  JSON.stringify(zc));
const codes = dbg.slots && (() => sandbox.__probe)();

console.log('== 阶段二：捆级库存快照 ==');
const B = dbg.bundles;
const SPECS = dbg.specs;
const SPECS_NAMES = SPECS.map(s => s.name);
check('库存捆数在合理区间', B.length >= 20000 && B.length <= 55000, B.length + ' 捆');
check('捆号唯一且格式 B-xxxx', new Set(B.map(b => b.id)).size === B.length && /^B-\d{4}$/.test(B[0].id));
check('每捆字段完整（钢种/长度/直径/支数/吨位/入库时间/二维码）',
  B.every(b => b.grade && b.len > 0 && b.rods > 0 && b.wt > 0 && b.inDay && b.inTime && b.qr.includes(b.id)));
check('长度/钢种/支数与所属规格定义一致',
  B.every(b => SPECS[b.specIdx].lengths.includes(b.len) && SPECS[b.specIdx].grades.includes(b.grade)
    && b.rods === SPECS[b.specIdx].rods));
check('每垛捆数 1..400 且垛内规格/钢种/长度一致',
  (() => {
    const stMap = new Map();
    for (const b of B) {
      const k = `${b.slotId}|${b.stackIdx}`;
      const st = stMap.get(k) || (stMap.set(k, { n: 0, spec: b.specIdx, grade: b.grade, len: b.len, layers: [] }), stMap.get(k));
      st.n++;
      if (st.spec !== b.specIdx || st.grade !== b.grade || st.len !== b.len) return false;
      st.layers.push(b.layer);
    }
    for (const [, st] of stMap) {
      if (st.n > 400) return false;
      if (st.layers.some((l, i) => l !== i)) return false;   // 层号 = 垛内序号
    }
    return true;
  })());
check('垛内金字塔码放：排数与捆数守恒、底排 ≤ 3、排/列坐标有效',
  (() => {
    for (const s of dbg.slotList) for (const st of s.stacks) {
      if (!st) continue;
      if (!Array.isArray(st.rows) || st.rows.reduce((a, x) => a + x, 0) !== st.bundles.length) return false;
      if (st.rows[0] > 3 || st.rows.some(w => w < 1 || w > st.rows[0])) return false;
      for (const b of st.bundles) {
        if (!(b.prow >= 0 && b.prow < st.rows.length && b.pcol >= 0 && b.pcol < st.rows[b.prow])) return false;
        const p = dbg.bundlePilePos(s, b.stackIdx, b);          // 嵌槽格点必须有限且落在垛格进深附近
        if (!isFinite(p.y) || !isFinite(p.z) || Math.abs(p.z) > 4) return false;
      }
    }
    return true;
  })());
check('捆截面为类圆形密排（圆钢/螺纹钢排距 √3·r，方钢平铺）',
  dbg.specs.every(sp => {
    const rows = dbg.rodRowsOf(sp);
    if (rows.reduce((a, x) => a + x, 0) !== sp.rods) return false;
    return sp.shape === 'square' ? true : rows.every((w, i) => i === 0 || Math.abs(w - rows[i - 1]) === 1);
  }));
check('垛格坐标有限且落在库区范围内（含合并库位）',
  (() => {
    for (const s of dbg.slotList) for (let si = 0; si < 8; si++) {
      const c = dbg.stackCell(s, si);
      if (!isFinite(c.x) || !isFinite(c.z) || c.x < 0 || c.x > 300 || c.z < 0 || c.z > 101) return false;
      if (Math.abs(c.x - s.x) > s.w / 2 + .1 || Math.abs(c.z - s.z) > s.d / 2 + .1) return false;
    }
    return true;
  })());

console.log('== 阶段三：统计 / 规格分布 / KPI ==');
const st = dbg.stats;
check('统计口径一致（捆数 = 明细长度）', st.bundles === B.length);
check('支数/吨位累计为正', st.rods > 0 && st.tons > 0, `${st.rods} 支 · ${st.tons.toFixed(0)} t`);
check('有料库位/垛位在区间内', st.slotsOcc >= 30 && st.slotsOcc <= 91 && st.stacksOcc >= st.slotsOcc);
check('规格分布含全部 5 个规格名', SPECS_NAMES.every(n => dbg.specBarsHTML.includes(n)));
check('KPI 六项均已渲染', dbg.kpis.every(x => x && x !== '–'), dbg.kpis.join(' | '));

console.log('== 阶段四：筛选与列表 ==');
dbg.refreshList();
check('默认无筛选 -> 列表 = 全量', dbg.listData.length === B.length, dbg.listData.length + ' 捆');
const oneGrade = B[0].grade;
sandbox.__setFilt = f => Object.assign(sandbox.__dbg.filt, f);   // filt 为只读快照，改用下法
// 通过 UI 事件驱动筛选（fGrade change）
const fGrade = el('fGrade');
fGrade.value = oneGrade;
(fGrade.listeners.change || []).forEach(fn => fn({ target: fGrade }));
check('钢种筛选生效且结果 > 0', dbg.listData.length > 0 && dbg.listData.length <= B.length
  && dbg.listData.every(b => b.grade === oneGrade), `${oneGrade} -> ${dbg.listData.length} 捆`);
check('列表窗口已渲染（含捆号/钢种列）', dbg.listHTML.includes('B-') && dbg.listHTML.includes(oneGrade));
const fReset = el('fReset');
(fReset.listeners.click || []).forEach(fn => fn({}));
check('重置后恢复全量', dbg.listData.length === B.length);
const fQ = el('fQ');
fQ.value = B[0].id;
(fQ.listeners.input || []).forEach(fn => fn({ target: fQ }));
check('按捆号搜索命中唯一', dbg.listData.length === 1 && dbg.listData[0].id === B[0].id);
fQ.value = '';
(fQ.listeners.input || []).forEach(fn => fn({ target: fQ }));

console.log('== 阶段五：视图状态机（面包屑/详情/返回） ==');
check('初始为库区总览', dbg.view.level === 'yard' && dbg.crumbHTML.includes('库区总览'));
const first = B.find(b => b.stackIdx >= 0);
dbg.gotoBundle(first.id);
check('下钻到捆视图', dbg.view.level === 'bundle' && dbg.view.bundleId === first.id);
check('面包屑含 库位/垛/捆号', dbg.crumbHTML.includes('库位') && dbg.crumbHTML.includes('垛') && dbg.crumbHTML.includes(first.id));
check('捆详情卡含钢种/直径/长度/支数/炉号',
  ['钢种', '直径', '长度', '支数', '炉号'].every(k => dbg.detailHTML.includes(k)));
dbg.back();
check('Esc/返回 -> 垛视图', dbg.view.level === 'stack' && dbg.view.stackIdx === first.stackIdx);
check('垛详情卡含捆数/支数/吨位/炉号',
  ['捆数', '支数', '吨位', '炉号'].every(k => dbg.detailHTML.includes(k)));
check('垛详情卡列出本垛全部捆（每捆一行可下钻）',
  (() => {
    const st = dbg.slotList[first.slotId].stacks[first.stackIdx];
    return st.bundles.every(b => dbg.detailHTML.includes(`data-bid="${b.id}"`))
      && dbg.detailHTML.includes('捆号') && dbg.detailHTML.includes('入库时间');
  })());
check('垛视图下右侧列表聚焦本垛全部捆',
  (() => {
    const ld = dbg.listData;
    const st = dbg.slotList[first.slotId].stacks[first.stackIdx];
    return ld.length === st.bundles.length
      && ld.every(b => b.slotId === first.slotId && b.stackIdx === first.stackIdx);
  })(), `${dbg.listData.length} 捆`);
dbg.back();
check('再返回 -> 库位视图', dbg.view.level === 'slot');
check('库位详情卡含分区/垛位/在库', ['分区', '垛位', '在库'].every(k => dbg.detailHTML.includes(k)));
check('库位视图下列表聚焦本库位', dbg.listData.length > 0 && dbg.listData.every(b => b.slotId === dbg.view.slotId));
dbg.back();
check('再返回 -> 库区总览', dbg.view.level === 'yard');
check('总览下列表恢复全量', dbg.listData.length === B.length);
dbg.gotoSlot(0);
check('直达库位视图（含库位编码）', dbg.view.level === 'slot' && dbg.crumbHTML.includes('库位'));
dbg.gotoYard();

console.log('== 阶段六：降级模式 ==');
check('three 未加载时显示降级提示', el('glErr').innerHTML.includes('三维视图不可用'));

console.log(failed === 0 ? '\n全部自检通过 ✓' : `\n${failed} 项断言失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
