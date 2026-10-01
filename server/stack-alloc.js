// 垛位推荐算法包接入（独立项目 F:\Robot_Project\StackAlloc）：
// 入库归堆评分 / 出库选捆 / 倒垛落点 / 垛容几何 / 监测范围的唯一实现，
// 服务端（本目录）与仿真沙盘（经 serve.mjs 注入的浏览器包）共用同一份源码。
// 本文件只做路径适配——算法包位置变化时只需改这里。
export * from '../../StackAlloc/src/index.js';
