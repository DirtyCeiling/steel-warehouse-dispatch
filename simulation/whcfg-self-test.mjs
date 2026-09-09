// 无头自检：「库房参数设计」页（/whcfg）+ 捆制规则 API。
// 验证：/api/bundle-rules 形状与覆盖/自动/预置三态；warehouse 参数即时改变垛容；
//       页面五卡片渲染、支数覆盖保存（含越界警示与吨位重算）、充电位示意、重建库区按钮。
// 用法：node simulation/whcfg-self-test.mjs（端口 3321，与 npm run sim 并行运行会端口冲突）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

process.env.WAREHOUSE_DB = join(mkdtempSync(join(tmpdir(), 'whcfg-')), 't.db');
process.env.PORT = '3321';

const { startServer } = await import('../server/index.js');
await startServer();
const API = 'http://127.0.0.1:3321';
await (await fetch(`${API}/api/reset`, { method: 'POST' })).json();   // 临时库灌期初（specs 表需有吨位基准）

let failed = 0;
const check = (name, cond, detail = '') => {
  const ok = !!cond;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  [' + detail + ']' : ''}`);
};

console.log('== 捆制规则 API ==');
let r = await (await fetch(`${API}/api/bundle-rules`)).json();
check('GET /api/bundle-rules 返回 10 个规格', r.rules.length === 10, String(r.rules.length));
check('期初全部为预置规则且含捆径/垛容/吨位核算',
  r.rules.every(x => x.source === 'preset' && x.diaCm > 0 && x.cap > 0 && x.rows.length >= 1 && x.weight > 0),
  r.rules[0].spec);
check('Φ600 判定为单支吊运（single）', r.rules.find(x => x.spec === '管材 Φ600').single === true, '');

r = await (await fetch(`${API}/api/bundle-rules`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ rules: [{ spec: '螺纹钢 Φ20', rods: 10 }] }),
})).json();
check('PUT 覆盖支数生效（Φ20 -> 10 支/捆）', r.rules.find(x => x.spec === '螺纹钢 Φ20').rods === 10, '');
check('越界覆盖返回警示（10 支 Φ20 捆径低于下限）', r.warnings.length === 1 && r.warnings[0].includes('13.2'), r.warnings[0] || '');
check('棒材吨位随支数自动重算（Φ20 0.47 -> 0.22t）',
  r.weights.some(w => w.spec === '螺纹钢 Φ20' && w.from === 0.47 && w.to === 0.22), JSON.stringify(r.weights));
await fetch(`${API}/api/bundle-rules`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ rules: [{ spec: '螺纹钢 Φ20', rods: null }] }),
});

await fetch(`${API}/api/params`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ values: { warehouse: { rackH: 4 } } }),
});
r = await (await fetch(`${API}/api/bundle-rules`)).json();
check('warehouse 限高即时改变垛容（rackH 3->4：Φ600 12 -> 18 捆）',
  r.rules.find(x => x.spec === '管材 Φ600').cap === 18, String(r.rules.find(x => x.spec === '管材 Φ600').cap));
await fetch(`${API}/api/params`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ values: { warehouse: { rackH: 3 } } }),
});

r = await (await fetch(`${API}/api/params`)).json();
const fillDef = r.schema.find(s => s.sec === 'warehouse').defs.find(d => d.key === 'fillRatio');
check('库房参数 schema 含库容装载比例（默认 22%）',
  !!fillDef && fillDef.def === 22 && r.values.warehouse.fillRatio === 22, JSON.stringify(fillDef));
r = await (await fetch(`${API}/api/params`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ values: { warehouse: { fillRatio: 200 } } }),
})).json();
check('库容装载比例越界夹取（200 -> 95）', r.values.warehouse.fillRatio === 95, String(r.values.warehouse.fillRatio));
await fetch(`${API}/api/params`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ values: { warehouse: { fillRatio: 22 } } }),
});

console.log('== 页面（VM 无头渲染） ==');
const { readFileSync } = await import('node:fs');
const html = readFileSync(new URL('./库房参数设计.html', import.meta.url), 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const code = blocks.find(b => b.includes('DB_API'));   // 主脚本（首个为 embed 模式片段）

const byId = new Map();
const created = [];
/* Canvas 2D 黑洞桩：吞掉全部绘图调用（与其他沙盘自测同构） */
const absorber = new Proxy(function () {}, {
  get(t, p) { if (p === Symbol.toPrimitive) return () => 0; return absorber; },
  set() { return true; },
  apply() { return absorber; },
});
function makeEl(tag = 'div') {
  const el = {
    tag, textContent: '', className: '', value: '', title: '', type: '',
    min: null, max: null, step: null, placeholder: '', dataset: {}, children: [], style: {},
    clientWidth: 900, clientHeight: 400,
    get innerHTML() { return this._html || ''; },
    set innerHTML(v) { this._html = v; this.children = []; },   // 与真实 DOM 一致：重设 innerHTML 清空子节点
    _cls: new Set(),
    get id() { return this._id; },
    set id(v) { this._id = v; byId.set(v, this); },
    get classList() {
      const self = this;
      return {
        add: (...cs) => cs.forEach(c => self._cls.add(c)),
        remove: (...cs) => cs.forEach(c => self._cls.delete(c)),
        toggle: (c, on) => (on === undefined ? (self._cls.has(c) ? self._cls.delete(c) : self._cls.add(c)) : on ? self._cls.add(c) : self._cls.delete(c)),
        contains: c => self._cls.has(c),
      };
    },
    set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get className() { return [...this._cls].join(' '); },
    appendChild(ch) { this.children.push(ch); if (ch && ch._id) byId.set(ch._id, ch); return ch; },
    append(...cs) { cs.forEach(c => this.appendChild(c)); },
    prepend(ch) { this.children.unshift(ch); },
    removeChild(ch) { this.children = this.children.filter(x => x !== ch); },
    remove() { },
    get firstChild() { return this.children[0]; },
    addEventListener() {},
  };
  if (tag === 'canvas') el.getContext = () => absorber;
  created.push(el);
  return el;
}
const app = makeEl('#app');
byId.set('app', app);
const btnSave = makeEl('button');
byId.set('btnSave', btnSave);
const btnReset = makeEl('button');
byId.set('btnReset', btnReset);
const documentStub = {
  documentElement: makeEl('html'),
  getElementById: id => byId.get(id) || null,
  createElement: makeEl,
  querySelector(sel) {
    if (sel === '.msg') return created.findLast(e => e._cls.has('msg')) || null;
    return null;
  },
  querySelectorAll(sel) {
    const m = sel.match(/\[data-sec="([^"]+)"\]\[data-key="([^"]+)"\]/);
    if (!m) return [];
    return created.filter(e => e.dataset && e.dataset.sec === m[1] && e.dataset.key === m[2]);
  },
  prepend() {},
};
const sandbox = {
  document: documentStub,
  location: { search: `?api=${API}` },   // 页面 DB_API 取 ?api= 覆盖 -> 指向测试服务器
  URLSearchParams,
  console,
  fetch,
  confirm: () => true,
  devicePixelRatio: 1,
  addEventListener() {},
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimeout,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
// 页面共享工具已外置为 ./shared/sim-common.js（页面主脚本开头从 SIM 解构）——先注入再跑页面
const simCommon = readFileSync(new URL('./shared/sim-common.js', import.meta.url), 'utf8');
vm.runInContext(simCommon, sandbox, { filename: 'sim-common.js' });
vm.runInContext(code, sandbox, { filename: 'whcfg-page.js' });

// 等待 load() 完成（Promise.all 三个接口 + 渲染）
for (let i = 0; i < 100 && (!byId.get('rulesTbl') || byId.get('rulesTbl').children.length < 11); i++) {
  await new Promise(r2 => setImmediate(r2));
  await new Promise(r2 => setTimeout(r2, 20));
}
const cards = created.filter(e => e.tag === 'section' && e._cls.has('cat'));
check('渲染 8 张卡片（库房总览/3D/2D 预览 + 捆制/尺寸/垛容/充电/结构）', cards.length === 8, String(cards.length));
const yardPrev = byId.get('yardPrev'), yardParams = byId.get('yardParams');
const pilePrev = byId.get('pilePrev'), pileParams = byId.get('pileParams');
check('库房布局块：左=库房总览，右=结构/充电/垛容 3 卡',
  yardPrev && yardParams && yardPrev.children.length === 1 && yardPrev.children[0]._cls.has('c-yard')
  && yardParams.children.length === 3
  && yardParams.children[0]._cls.has('c-ro') && yardParams.children[1]._cls.has('c-chg') && yardParams.children[2]._cls.has('c-stack'),
  `左 ${yardPrev?.children.length} · 右 ${yardParams?.children.length}`);
check('货架块：左=3D/2D 预览 2 卡，右=捆制/尺寸 2 卡',
  pilePrev && pileParams && pilePrev.children.length === 2 && pileParams.children.length === 2
  && pilePrev.children[0]._cls.has('c-prev3d') && pilePrev.children[1]._cls.has('c-prev')
  && pileParams.children[0]._cls.has('c-steel') && pileParams.children[1]._cls.has('c-dims'),
  `左 ${pilePrev?.children.length} · 右 ${pileParams?.children.length}`);
const tbodyOf = t => t.children.find(c => c.tag === 'tbody');
check('规格规则表渲染 10 行（thead+tbody 结构）',
  byId.get('rulesTbl')?.children.length === 2 && tbodyOf(byId.get('rulesTbl'))?.children.length === 10,
  String(tbodyOf(byId.get('rulesTbl'))?.children.length));
check('垛容联动预览表渲染 10 行（thead+tbody 结构）',
  byId.get('dimsTbl')?.children.length === 2 && tbodyOf(byId.get('dimsTbl'))?.children.length === 10,
  String(tbodyOf(byId.get('dimsTbl'))?.children.length));
const strip = byId.get('chgStrip');
check('充电位示意 37 列', strip?.children.length === 37, String(strip?.children.length));
const chgCells = strip.children.filter(c => c._cls.has('chg'));
check('示意条标出 3 个充电桩（默认 3/5/7 列）', chgCells.length === 3 && chgCells.map(c => c.textContent).join(',') === '⚡1,⚡2,⚡3',
  chgCells.map(c => c.textContent).join(','));

console.log('== 库房二维总览（预览联动） ==');
const yardCv = byId.get('yardCv');
check('库房总览画布已创建且完成绘制', !!yardCv && yardCv.width === 900 && yardCv.height === 250,
  `${yardCv?.width}x${yardCv?.height}`);
check('库位数据已加载（91 库位）', sandbox.__whcfgDbg.slotCount === 91, String(sandbox.__whcfgDbg.slotCount));
const draws0 = sandbox.__whcfgDbg.yardDraws;
const chgInputs = documentStub.querySelectorAll('[data-sec="robot"][data-key="chargerC1"]');
const chgSlider = chgInputs.find(e => e.type === 'range');
chgSlider.value = '10';
chgSlider.oninput({ target: chgSlider });
check('充电桩列位调整触发库房图重绘（充电位移联动）', sandbox.__whcfgDbg.yardDraws > draws0, `${draws0} -> ${sandbox.__whcfgDbg.yardDraws}`);
check('充电位示意条同步刷新（#1 移到列 10）',
  strip.children.filter(c => c._cls.has('chg')).length === 3, '');
chgSlider.value = '3';
chgSlider.oninput({ target: chgSlider });

console.log('== 垛体预览（2D/3D） ==');
// 料架几何与三维沙盘 buildRack 同口径（len=9m 普通垛格）
const rd9 = sandbox.__whcfgDbg.rackDimsOf(9);
check('料架垛格 8.333×3.75m（库位列宽 × 跨深/8）', rd9.cw > 8.33 && rd9.cw < 8.34 && rd9.cd === 3.75,
  `${rd9.cw.toFixed(3)}×${rd9.cd}`);
check('立柱四角 ≈±3.717/±1.525（沙盘 buildRack 口径）', Math.abs(rd9.px - 3.7167) < 0.001 && rd9.pz === 1.525, `${rd9.px.toFixed(3)}/${rd9.pz}`);
check('垫梁 0.20 高 × 2.55 深、位于捆端下方 X≈±3.617',
  Math.abs(rd9.beamH - 0.2) < 1e-6 && rd9.beamD === 2.55 && Math.abs(rd9.rx - 3.6167) < 0.001, `rx=${rd9.rx.toFixed(3)} h=${rd9.beamH.toFixed(3)} d=${rd9.beamD}`);
const pileCv = byId.get('pileCv');
check('二维预览画布已创建且完成绘制（DPR 尺寸已设置）', !!pileCv && pileCv.width === 900 && pileCv.height === 400,
  `${pileCv?.width}x${pileCv?.height}`);
const selEl = byId.get('specSel');
check('规格选择器含 10 个规格且默认选中螺纹钢 Φ20', selEl?.children.length === 10 && selEl.value === '螺纹钢 Φ20', selEl?.value);
check('捆数滑杆范围 = 当前垛容（Φ20：336）', byId.get('pileCount')?.max === 336, String(byId.get('pileCount')?.max));
check('捆数读数显示当前/垛容', /336 \/ 336 捆/.test(byId.get('pileCountTxt')?.textContent || ''), byId.get('pileCountTxt')?.textContent);
const glErr = byId.get('glErr');
check('无 three.js 时三维预览降级提示（页面其余功能不受影响）',
  glErr && glErr.style.display === 'block' && glErr.innerHTML.includes('三维预览不可用'), glErr?.style.display);
// 规格切换 -> 垛容联动：Φ600 单支垛容 12
selEl.value = '管材 Φ600';
selEl.onchange();
check('切换单支管 Φ600：捆数滑杆范围联动为 12', byId.get('pileCount')?.max === 12, String(byId.get('pileCount')?.max));
// 库房尺寸联动：料架限高 3->2m，Φ600 层数 4->3，垛容 12->9
const rackInputs = documentStub.querySelectorAll('[data-sec="warehouse"][data-key="rackH"]');
const rackSlider = rackInputs.find(e => e.type === 'range');
rackSlider.value = '2';
rackSlider.oninput({ target: rackSlider });
check('限高 3m->2m 联动：Φ600 垛容滑杆范围 12 -> 9', byId.get('pileCount')?.max === 9, String(byId.get('pileCount')?.max));
rackSlider.value = '3';
rackSlider.oninput({ target: rackSlider });
check('限高恢复 3m：Φ600 垛容滑杆范围回到 12', byId.get('pileCount')?.max === 12, String(byId.get('pileCount')?.max));
// 捆制表行点击 -> 预览规格联动
tbodyOf(byId.get('rulesTbl')).children[0].onclick();
check('点击捆制表首行：预览规格联动回 Φ20（滑杆 336）',
  byId.get('specSel')?.value === '螺纹钢 Φ20' && byId.get('pileCount')?.max === 336, byId.get('specSel')?.value);

// 支数覆盖：第 1 行（螺纹钢 Φ20）输入 10 -> 保存 -> 库内生效 + 越界警示展示
const rodsInputs = tbodyOf(byId.get('rulesTbl')).children
  .map(tr => tr.children[3]?.children[0]).filter(el => el && el._cls && el._cls.has('rods'));
check('每规格一个支数输入框（当前表格）', rodsInputs.length === 10, String(rodsInputs.length));
rodsInputs[0].value = '10';
rodsInputs[0].oninput();
check('支数编辑触发保存按钮可用', btnSave.disabled === false, String(btnSave.disabled));
await btnSave.onclick();
const after = await (await fetch(`${API}/api/bundle-rules`)).json();
check('保存后 Φ20 覆盖写入数据库（10 支/捆 · override）',
  after.rules.find(x => x.spec === '螺纹钢 Φ20').rods === 10
  && after.rules.find(x => x.spec === '螺纹钢 Φ20').source === 'override', '');
const msgEl = documentStub.querySelector('.msg');
check('保存反馈展示越界警示与吨位重算', msgEl && msgEl.textContent.includes('捆径越界警示') && msgEl.textContent.includes('0.22t'),
  msgEl && msgEl.textContent.slice(0, 60));

// 重建库区按钮：confirm 桩放行 -> 重灌期初并回显汇总
const btnRebuild = byId.get('btnRebuild');
check('重建库区按钮存在且可用', !!btnRebuild && btnRebuild.disabled !== true, '');
await btnRebuild.onclick();
const msgEl2 = documentStub.querySelector('.msg');
check('重建完成回显库存汇总', msgEl2 && msgEl2.textContent.includes('库区已按当前参数重建'), msgEl2 && msgEl2.textContent.slice(0, 50));

// 库容装载比例滑杆 + 重建联动：装载比例与未保存的捆制规则编辑在重建时一并生效
const fillInputs = documentStub.querySelectorAll('[data-sec="warehouse"][data-key="fillRatio"]');
check('页面渲染库容装载比例滑杆（range+number）', fillInputs.length === 2, String(fillInputs.length));
const inv0 = (await (await fetch(`${API}/api/inventory`)).json()).totalBundles;
const fillSlider = fillInputs.find(e => e.type === 'range');
fillSlider.value = '90';
fillSlider.oninput({ target: fillSlider });
const rodsNow = tbodyOf(byId.get('rulesTbl')).children
  .map(tr => tr.children[3]?.children[0]).filter(el => el && el._cls && el._cls.has('rods'));
rodsNow[2].value = '6';   // 圆钢 Φ50 -> 6 支/捆：不点「保存修改」，直接重建
rodsNow[2].oninput();
await btnRebuild.onclick();
const rulesAfterRebuild = await (await fetch(`${API}/api/bundle-rules`)).json();
check('重建时未保存的捆制规则编辑一并落库（圆钢 Φ50 -> 6 支/捆 override）',
  rulesAfterRebuild.rules.find(x => x.spec === '圆钢 Φ50').rods === 6
  && rulesAfterRebuild.rules.find(x => x.spec === '圆钢 Φ50').source === 'override', '');
const inv1 = (await (await fetch(`${API}/api/inventory`)).json()).totalBundles;
check('装载比例 22% -> 90% 重建后库存显著上升（>2 倍）', inv1 > inv0 * 2, `${inv0} -> ${inv1}`);
const msgEl3 = documentStub.querySelector('.msg');
check('重建回显新期初利用率', msgEl3 && /利用率 \d+(\.\d)?%/.test(msgEl3.textContent), msgEl3 && msgEl3.textContent.slice(0, 50));

// 恢复默认按钮：参数回 schema 默认 + 规则全部标记恢复预置
btnReset.onclick();
check('恢复默认后保存按钮可用（规则待恢复预置）', btnSave.disabled === false, '');
await btnSave.onclick();
const restored = await (await fetch(`${API}/api/bundle-rules`)).json();
check('恢复预置保存后全部规格 source=preset 且吨位回写', restored.rules.every(x => x.source === 'preset')
  && restored.rules.find(x => x.spec === '螺纹钢 Φ20').weight === 0.47, '');

try { rmSync(join(process.env.WAREHOUSE_DB, '..'), { recursive: true, force: true }); } catch { /* Windows 下服务进程仍持句柄，忽略 */ }
console.log(failed === 0 ? '\n库房参数设计自检通过 ✓' : `\n${failed} 项断言失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
