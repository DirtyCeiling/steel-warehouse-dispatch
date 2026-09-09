// 一次性生成器 v4（git diff 行号版）：把 2D/3D 沙盘两页的公共行抽取为 shared/sandbox-core.mjs 片段，
// 两页原位的公共行替换为 /*@@core-seg-N@@*/ 占位符（serve.mjs/自测按占位原位注入，顺序与原文完全一致）。
// 用法：node simulation/tool-split-sandbox.mjs
// 行号来源：git diff --no-index --unified=0（execSync 同进程调用，未经 shell 重定向，不受 MSYS/autocrlf 文本转换污染）；
// 内容一律按行号从原文件切片；全量还原校验（占位注入 == 原文）通过才落盘。
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const A_NAME = '调度仿真沙盘.html';
const B_NAME = '调度仿真沙盘3D.html';

// ---- 稳定预检：两次读取（间隔 150ms）mtime+尺寸一致才继续 ----
async function stableCheck(file) {
  const s1 = statSync(file);
  await new Promise(r => setTimeout(r, 150));
  const s2 = statSync(file);
  if (s1.mtimeMs !== s2.mtimeMs || s1.size !== s2.size) {
    throw new Error(`${file} 正在被外部修改（请保存后重试）`);
  }
}
await stableCheck(join(here, A_NAME));
await stableCheck(join(here, B_NAME));

const A = readFileSync(join(here, A_NAME), 'utf8').split('\n');
const B = readFileSync(join(here, B_NAME), 'utf8').split('\n');

// ---- git diff（同进程，统一输出格式解析） ----
let diffOut;
try {
  diffOut = execFileSync('git', ['diff', '--no-index', '--unified=0', A_NAME, B_NAME], { encoding: 'utf8' });
} catch (e) {
  diffOut = e.stdout || '';   // git 有差异时 exit 1；输出仍有效
}
const hunks = [];
let cur = null;
const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
for (const ln of diffOut.split('\n')) {
  const m = ln.match(re);
  if (m) {
    cur = { oldS: +m[1], oldCount: m[2] ? +m[2] : 1, newS: +m[3], newCount: m[4] ? +m[4] : 1, gotOld: 0, gotNew: 0 };
    hunks.push(cur);
  } else if (cur) {
    if (ln.startsWith('-') && !ln.startsWith('---')) cur.gotOld++;
    else if (ln.startsWith('+')) cur.gotNew++;
  }
}
const spanBad = hunks.filter(h => h.gotOld !== h.oldCount || h.gotNew !== h.newCount);
if (spanBad.length) {
  console.log('git diff 行数与内容不一致（', spanBad.length, ' 个 hunk），中止。');
  process.exit(1);
}

// ---- 块序列 ----
// ed/unified 行号语义：a 型（oldCount=0）插入点在 A 的 oldS 行之后（A 无差异行，公共区含 0-based oldS）；
// d 型（newCount=0）同理在 B 侧；c 型两侧差异行分别从 oldS/newS 起（0-based 再 -1）。
const blocks = [];
let apos = 0, bpos = 0;
for (const h of hunks) {
  const aStart = h.oldCount === 0 ? h.oldS : h.oldS - 1;
  const bStart = h.newCount === 0 ? h.newS : h.newS - 1;
  if (aStart > apos) blocks.push({ kind: 'common', aStart: apos, aCount: aStart - apos });
  if (h.oldCount > 0) blocks.push({ kind: 'aonly', aStart, aCount: h.oldCount });
  if (h.newCount > 0) blocks.push({ kind: 'bonly', bStart, bCount: h.newCount });
  apos = aStart + h.oldCount;
  bpos = bStart + h.newCount;
}
const tailA = A.slice(apos), tailB = B.slice(bpos);
let tailCommon = tailA.length === tailB.length && tailA.length > 0;
if (tailCommon) for (let k = 0; k < tailA.length; k++) if (tailA[k] !== tailB[k]) { tailCommon = false; break; }
if (tailCommon) blocks.push({ kind: 'common', aStart: apos, aCount: tailA.length });
else {
  if (tailA.length) blocks.push({ kind: 'aonly', aStart: apos, aCount: tailA.length });
  if (tailB.length) blocks.push({ kind: 'bonly', bStart: bpos, bCount: tailB.length });
}

const stat = { blocks: blocks.length, common: 0, aOnly: 0, bOnly: 0 };
for (const b of blocks) {
  if (b.kind === 'common') stat.common += b.aCount;
  if (b.kind === 'aonly') stat.aOnly += b.aCount;
  if (b.kind === 'bonly') stat.bOnly += b.bCount;
}
console.log(JSON.stringify({ ...stat, aLines: A.length, bLines: B.length, hunks: hunks.length }, null, 2));

// ---- 生成 core 段 + 页面占位 ----
let coreText = '// 沙盘 2D/3D 两页公共字节序列（tool-split-sandbox.mjs 生成）：serve.mjs 响应页面时按\n' +
  '// /*@@core-seg-N@@*/ 占位原位注入，段顺序与页面占位一一对应——两页的公共代码只在本文件维护一份。\n' +
  '// 注意：该文件是混入 HTML/CSS/JS 的共享片段库，不是可独立运行的 JS。\n';
const aRows = [], bRows = [], segSpans = [];
let counter = 0;
for (const blk of blocks) {
  if (blk.kind === 'common') {
    counter++;
    const seg = A.slice(blk.aStart, blk.aStart + blk.aCount);
    coreText += `/*@@core-seg-${counter}@@*/\n${seg.join('\n')}\n`;
    aRows.push(`/*@@core-seg-${counter}@@*/`);
    bRows.push(`/*@@core-seg-${counter}@@*/`);
    segSpans.push({ n: counter, aStart: blk.aStart, count: blk.aCount });
  } else if (blk.kind === 'aonly') {
    aRows.push(...A.slice(blk.aStart, blk.aStart + blk.aCount));
  } else {
    bRows.push(...B.slice(blk.bStart, blk.bStart + blk.bCount));
  }
}

// ---- 全量还原校验（占位注入 == 原文） ----
function restore(rows) {
  const out = [];
  for (const r of rows) {
    if (typeof r === 'string' && r.startsWith('/*@@core-seg-')) {
      const n = +r.match(/^\/\*@@core-seg-(\d+)@@\*\/$/)[1];
      const s = segSpans.find(x => x.n === n);
      out.push(...A.slice(s.aStart, s.aStart + s.count));
    } else out.push(r);
  }
  return out;
}
const A2 = restore(aRows), B2 = restore(bRows);
const eqA = A2.length === A.length && A2.every((l, idx) => l === A[idx]);
const eqB = B2.length === B.length && B2.every((l, idx) => l === B[idx]);
console.log(`校验 2D 还原 ${eqA ? '✓' : '✗'}`);
console.log(`校验 3D 还原 ${eqB ? '✓' : '✗'}`);
if (!eqA || !eqB) {
  if (!eqA) { const i = A2.findIndex((l, n) => n < A.length && l !== A[n]); console.log('2D 首个不一致(idx):', i, JSON.stringify(A2[i]?.slice(0, 40)), 'vs', JSON.stringify(A[i]?.slice(0, 40))); }
  if (!eqB) { const i = B2.findIndex((l, n) => n < B.length && l !== B[n]); console.log('3D 首个不一致(idx):', i, JSON.stringify(B2[i]?.slice(0, 40)), 'vs', JSON.stringify(B[i]?.slice(0, 40))); }
  throw new Error('还原校验失败，保留原文件不落盘。');
}

// ---- 落盘 ----
mkdirSync(join(here, 'shared'), { recursive: true });
writeFileSync(join(here, 'shared', 'sandbox-core.mjs'), coreText);
writeFileSync(join(here, A_NAME), aRows.join('\n'));
writeFileSync(join(here, B_NAME), bRows.join('\n'));
console.log(`产物：shared/sandbox-core.mjs（${coreText.split('\n').length} 行 · ${counter} 段）`);
console.log(`产物：${A_NAME}（${aRows.length} 行）· ${B_NAME}（${bRows.length} 行）`);
