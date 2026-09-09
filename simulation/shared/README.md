# simulation/shared/ 公共层说明

前端零构建约束下的公共代码层：**经典脚本 + 全局 SIM 命名空间 + 纯 CSS 文件**，
不经任何打包工具，由 `simulation/serve.mjs`（5199 端口）直接托管。

## 文件

| 文件 | 内容 | 引用方式 |
|---|---|---|
| `tokens.css` | 全站设计令牌（:root 颜色/字体变量）+ `html.embed` 嵌入模式规则 | `<link rel="stylesheet" href="./shared/tokens.css">`（页面 `<style>` 之前） |
| `base.css` | 工作台类页面公共布局（header/nav/button/消息条/空态等逐字重复部分） | 同上，跟在 tokens.css 后；页面 `<style>` 同名选择器可覆盖 |
| `nav.js` | 顶部导航注入（统一 7 项链接表 + 当前页高亮 + `?embed=1` 处理） | `<nav data-sim-nav="页面键" title="..."></nav>` + `</header>` 后 `<script src="./shared/nav.js"></script>` |
| `sim-common.js` | 全局 `SIM` 工具：`DB_API`/`LOGISTICS_API`（支持 `?api=`/`?logi=` 覆盖）、`api()`、`SPEC_COLORS`（10 规格全集）、`specColor`、`esc`、`fmtFull`/`fmtClock`（ISO 时间戳）、`delayCls`、`SIM.msg()` 消息条 | `<script src="./shared/sim-common.js"></script>` 后页面解构 `const { DB_API, api, esc } = SIM;` |
| `sandbox-core.mjs` | （待生成）2D/3D 沙盘两页公共字节序列片段库，serve.mjs 按 `/*@@core-seg-N@@*/` 占位原位注入 | 由 `tool-split-sandbox.mjs` 生成，见下 |

## 页面键（nav.js 高亮用）

`sandbox`（/）、`inbound`（/inbound）、`vehicles`、`scans`、`params`、`whcfg`、`runs`。
沙盘页（2D/3D）有自己的顶部导航结构，不用 nav.js。

## 命名不同义工具（保留在页面，勿并入公共层）

- 扫描时效/仿真场次页的 `fmtClock(s)`/`fmtDur(s)`/`fmtSim*` 是**仿真世界时钟**
  （秒 → 08:00 起算），与 `SIM.fmtClock(iso)`（ISO 时间戳 → HH:MM）同名不同义。

## 2D/3D 沙盘合并（sandbox-core.mjs 生成）

两页 96%+ 代码相同，公共部分抽取为本目录 `sandbox-core.mjs` 片段库，页面内以
`/*@@core-seg-N@@*/` 占位，`serve.mjs` 响应时原位注入（顺序与原文逐行一致，无重排）。

**生成方式**（在两页编辑稳定、无编辑器占用时执行）：

```bash
cd simulation
node tool-split-sandbox.mjs
```

工具自带：文件稳定预检（150ms 双采样）、git diff 行号 + 原文件切片、
全量还原校验（占位注入 == 原文，逐行），**校验不通过不落盘**。
生成后 `npm run sim` 的 serve.mjs 自动注入；沙盘自测
（`simulation/*-self-test.mjs`、`recommend-probe.mjs`）经
`sandbox-page-loader.mjs` 的 `injectCoreSegs()` 同步适配。

注意：`file://` 直接双击打开沙盘页面不生效（需经 5199 服务器访问）；
其余轻页面引用的 shared 文件在 file:// 下同样可用。
