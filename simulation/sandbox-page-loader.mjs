// 沙盘自测公共注入：把页面内 /*@@core-seg-N@@*/ 占位替换为 shared/sandbox-core.mjs 对应片段，
// 与 simulation/serve.mjs 的注入逻辑保持一致（tool-split-sandbox.mjs 拆分产物生成前，
// 页面不含占位符、本函数原样返回，不改变现有自测行为）。
// 另把 /*@@stack-alloc@@*/ 占位替换为垛位推荐算法包浏览器版（StackAlloc 独立项目，
// 无头自测与浏览器经同一 bundle 运行同一份算法源码）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBrowserBundle } from '../../StackAlloc/browser.js';

const here = dirname(fileURLToPath(import.meta.url));

export function injectCoreSegs(code) {
  if (code.includes('/*@@core-seg-')) {
    const core = readFileSync(join(here, 'shared', 'sandbox-core.mjs'), 'utf8');
    const parts = core.split(/\/\*@@core-seg-(\d+)@@\*\//);
    const map = new Map();
    for (let i = 1; i < parts.length; i += 2) map.set(+parts[i], parts[i + 1]);
    code = code.replace(/\/\*@@core-seg-(\d+)@@\*\//g, (m, n) => map.get(+n) ?? '');
  }
  if (code.includes('/*@@stack-alloc@@*/')) {
    code = code.replace(/\/\*@@stack-alloc@@\*\//g, () => buildBrowserBundle());
  }
  return code;
}
