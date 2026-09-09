// 沙盘自测公共注入：把页面内 /*@@core-seg-N@@*/ 占位替换为 shared/sandbox-core.mjs 对应片段，
// 与 simulation/serve.mjs 的注入逻辑保持一致（tool-split-sandbox.mjs 拆分产物生成前，
// 页面不含占位符、本函数原样返回，不改变现有自测行为）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function injectCoreSegs(code) {
  if (!code.includes('/*@@core-seg-')) return code;
  const core = readFileSync(join(here, 'shared', 'sandbox-core.mjs'), 'utf8');
  const parts = core.split(/\/\*@@core-seg-(\d+)@@\*\//);
  const map = new Map();
  for (let i = 1; i < parts.length; i += 2) map.set(+parts[i], parts[i + 1]);
  return code.replace(/\/\*@@core-seg-(\d+)@@\*\//g, (m, n) => map.get(+n) ?? '');
}
