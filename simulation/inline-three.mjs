// 把 node_modules/three/build/three.module.min.js（纯 ESM、自包含、无 import）
// 转换成可内联进单文件 HTML 的经典脚本：
//   export{ A as Foo, B as Bar };  ->  var THREE={Foo:A,Bar:B,...};window.THREE=THREE;
// 并整体包进 IIFE：压缩版顶层有大量短名 const（如 M/T），若留在全局词法作用域
// 会与其它经典脚本顶层声明撞名（SyntaxError: Identifier 'M' has already been declared）。
// 用法：node simulation/inline-three.mjs   （生成 simulation/vendor/three.inline.js）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = readFileSync(join(root, 'node_modules/three/build/three.module.min.js'), 'utf8');

const i = src.indexOf('export{');
if (i < 0 || !src.slice(i).trim().endsWith('};')) throw new Error('未找到预期的 export 语句');
const body = src.slice(0, i);
const stmt = src.slice(i).trim();                       // export{...};
const inner = stmt.slice('export{'.length, -2);         // 去掉 export{ 和 };
const entries = inner.split(',').map(e => {
  const m = e.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
  if (!m) throw new Error('无法解析导出项: ' + e);
  return `${m[2] || m[1]}:${m[1]}`;                     // 导出名:内部名
});
const out = `;(function(){\n${body}\nvar THREE={${entries.join(',')}};\nwindow.THREE=THREE;\n})();\n`;
const dest = join(here, 'vendor');
mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, 'three.inline.js'), out);
console.log(`生成 ${join(dest, 'three.inline.js')}（${(out.length / 1024).toFixed(0)} KB，导出 ${entries.length} 个符号，IIFE 包裹）`);
