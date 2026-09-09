// 调度规划参数模式（schema）：主系统「调度参数」页与仿真沙盘共用这一份定义。
// GET /api/params 返回 { schema, values }：前端按 schema 渲染滑杆/数字输入；
// 仿真沙盘启动时读取 values 覆盖内置默认，沙盘内调整也会 PUT 写回（两端同源）。
// 注意：sec/key/min/max 与 simulation/调度仿真沙盘.html 的 PARAM_DEFS 保持一致。
export const PARAM_SCHEMA = [
  {
    sec: 'production', secLabel: '生产节奏',
    desc: '每日进厂 / 出厂车辆数，订单全天均匀铺开（不一次性下完）；进厂确认页超时未确认的车辆按推荐方案自动确认下发（0 = 关闭）',
    defs: [
      { key: 'inPerDay',  label: '每日进厂车辆', min: 1, max: 600, step: 1, unit: '辆/日', def: 150 },
      { key: 'outPerDay', label: '每日出厂车辆', min: 1, max: 600, step: 1, unit: '辆/日', def: 100 },
      { key: 'autoConfirmMin', label: '确认超时自动下发', min: 0, max: 60, step: 1, unit: '分钟', def: 5 },
    ],
  },
  {
    sec: 'truck', secLabel: '组车规则',
    desc: '一车最少/最多吊数（同跨装卸）：出库一单一车，物流订单全部配捆装满才发车（不设等待超时）；入库凑满最少吊数即发车；进厂车按规格整车配载，仅「混装车比例」的车混装第二种规格',
    defs: [
      { key: 'minLoads',     label: '每车最少吊数', min: 2,   max: 10,  step: 1,   unit: '吊', def: 6 },
      { key: 'maxLoads',     label: '每车最多吊数', min: 4,   max: 16,  step: 1,   unit: '吊', def: 10 },
      { key: 'mixedSpecPct', label: '混装车比例',   min: 0,   max: 100, step: 5,   unit: '%',  def: 25 },
      { key: 'plateScanTime', label: '车牌识别时间', min: 0.5, max: 8,  step: 0.1, unit: '秒', def: 2.0 },
      { key: 'manifestTime',  label: '运单吊取时间', min: 0.3, max: 6,  step: 0.1, unit: '秒', def: 1.2 },
      { key: 'verifyTime',    label: '出场复验时间', min: 0.5, max: 8,  step: 0.1, unit: '秒', def: 1.5 },
    ],
  },
  {
    sec: 'placement', secLabel: '归堆策略权重',
    desc: '卸货推荐评分权重：同车同规格始终归并同一垛（垛满才另荐）；其余入库按下述权重综合评分，权重越大越优先',
    defs: [
      { key: 'sameSpecBase', label: '同规格归堆基础分', min: 0, max: 200, step: 5, unit: '分', def: 60 },
      { key: 'sameSpecFill', label: '填充率加励系数',   min: 0, max: 100, step: 5, unit: '分', def: 20 },
      { key: 'emptyBase',    label: '空垛兜底基础分',   min: 0, max: 100, step: 5, unit: '分', def: 20 },
      { key: 'emptyPenalty', label: '空垛扣减/垛',      min: 0, max: 20,  step: 1, unit: '分', def: 3 },
      { key: 'famBonus',     label: '库位同族加励/垛',  min: 0, max: 30,  step: 1, unit: '分', def: 5 },
      { key: 'mixPenalty',   label: '库位异族惩罚/垛',  min: 0, max: 50,  step: 1, unit: '分', def: 8 },
      { key: 'nearBonus',    label: '邻位聚簇加励/垛',  min: 0, max: 20,  step: 1, unit: '分', def: 4 },
      { key: 'nearCap',      label: '邻位聚簇上限',     min: 0, max: 60,  step: 5, unit: '分', def: 20 },
      { key: 'pendPenalty',  label: '扫码干扰扣减/垛',  min: 0, max: 20,  step: 1, unit: '分', def: 3 },
      { key: 'spanBonus',    label: '跨匹配加分',       min: 0, max: 50,  step: 1, unit: '分', def: 10 },
    ],
  },
  {
    sec: 'robot', secLabel: '机器狗（扫码核验）',
    desc: '台数（D-01 起编号，1-6 台）与监测范围：仅监测范围内由机器狗扫码核验，范围外免检直通；仅开启部分监测范围时，运输车辆与出入库作业均限定在监测范围内（如仅开「监测 A 跨」：所有车辆均前往一跨 A，库满/无货则暂缓待回补）；每跨用「起始/截止号区」配置跨内具体区域（1~33 号区，如 17~33=右侧中棒区域、18~25=中棒区域局部）；台数变更即时重建机队；充电桩集中布置在 A 跨北端厂房外，可设 1-3 个',
    defs: [
      { key: 'count',       label: '机器狗数量', min: 1,   max: 6,  step: 1,   unit: '台', def: 3 },
      { key: 'chargerCount', label: '充电桩数量', min: 1, max: 3, step: 1, unit: '个', def: 1 },
      { key: 'chargerC1',   label: '充电桩#1 列位', min: 1, max: 37, step: 1, unit: '列', def: 3 },
      { key: 'chargerC2',   label: '充电桩#2 列位', min: 1, max: 37, step: 1, unit: '列', def: 5 },
      { key: 'chargerC3',   label: '充电桩#3 列位', min: 1, max: 37, step: 1, unit: '列', def: 7 },
      { key: 'speed',       label: '行进速度',     min: 1,   max: 10, step: 0.1, unit: 'm/s',  def: 5.0 },
      { key: 'scanTime',    label: '扫码核验时间', min: 0.5, max: 60, step: 0.1, unit: '秒',   def: 60 },
      { key: 'endurance',   label: '满电续航',     min: 0.5, max: 8,  step: 0.5, unit: '小时', def: 3 },
      { key: 'chargeHours', label: '充满电时间',   min: 0,   max: 6,  step: 0.5, unit: '小时', def: 2 },
      { key: 'spanA',       label: '监测 A 跨',   min: 0,   max: 1,  step: 1,   unit: '开/关', def: 1, toggle: true },
      { key: 'fromA',       label: 'A 跨监测起始号区', min: 1, max: 33, step: 1, unit: '号区', def: 1 },
      { key: 'toA',         label: 'A 跨监测截止号区', min: 1, max: 33, step: 1, unit: '号区', def: 33 },
      { key: 'spanB',       label: '监测 B 跨',   min: 0,   max: 1,  step: 1,   unit: '开/关', def: 1, toggle: true },
      { key: 'fromB',       label: 'B 跨监测起始号区', min: 1, max: 33, step: 1, unit: '号区', def: 1 },
      { key: 'toB',         label: 'B 跨监测截止号区', min: 1, max: 33, step: 1, unit: '号区', def: 33 },
      { key: 'spanC',       label: '监测 C 跨',   min: 0,   max: 1,  step: 1,   unit: '开/关', def: 1, toggle: true },
      { key: 'fromC',       label: 'C 跨监测起始号区', min: 1, max: 33, step: 1, unit: '号区', def: 1 },
      { key: 'toC',         label: 'C 跨监测截止号区', min: 1, max: 33, step: 1, unit: '号区', def: 33 },
    ],
  },
  {
    sec: 'crane', secLabel: '天车（吊运装卸）',
    desc: '6 台（每跨 2 台，TC-A1~TC-C2）：行进速度（大车）/ 小车运行速度 / 吊取 / 放下耗时',
    defs: [
      { key: 'speed',     label: '行进速度', min: 0.5, max: 10, step: 0.1, unit: 'm/s', def: 4.0 },
      { key: 'trolleySpeed', label: '小车运行速度', min: 0.2, max: 4, step: 0.1, unit: 'm/s', def: 1.0 },
      { key: 'hoistTime', label: '吊取时间', min: 0.5, max: 180, step: 0.1, unit: '秒', def: 2.0 },
      { key: 'lowerTime', label: '放下时间', min: 0.5, max: 180, step: 0.1, unit: '秒', def: 1.8 },
    ],
  },
  {
    sec: 'abnormal', secLabel: '异常注入',
    desc: '异常事件概率（0 = 关闭）：扫码失败原地重扫、运单差异以现场扫码为准、复验异常人工复核放行',
    defs: [
      { key: 'scanFailPct',        label: '扫码失败率', min: 0, max: 50, step: 1, unit: '%', def: 4 },
      { key: 'manifestMismatchPct', label: '运单差异率', min: 0, max: 50, step: 1, unit: '%', def: 5 },
      { key: 'verifyIssuePct',     label: '复验异常率', min: 0, max: 50, step: 1, unit: '%', def: 3 },
    ],
  },
  {
    sec: 'assess', secLabel: '效率评估阈值',
    desc: '机器狗扫描能力评估的判定线（首页「扫描能力评估」卡与场次「效率评估」共用）：需求/能力利用率 = 每日需扫码捆数 ÷ 机队理论服务能力；利用率或忙碌占比超线判「紧张」，利用率或扫码延时 P95 严重超线判「不满足」',
    defs: [
      { key: 'tightRho',     label: '利用率「紧张」阈值',   min: 30, max: 100, step: 1,  unit: '%', def: 70 },
      { key: 'failRho',      label: '利用率「不满足」阈值', min: 40, max: 100, step: 1,  unit: '%', def: 90 },
      { key: 'tightBusyPct', label: '忙碌占比「紧张」阈值', min: 50, max: 100, step: 1,  unit: '%', def: 85 },
      { key: 'failDelayP95', label: 'P95 延时「不满足」阈值', min: 60, max: 1800, step: 10, unit: '秒', def: 300 },
    ],
  },
  {
    sec: 'warehouse', secLabel: '库房参数',
    desc: '库房尺寸/码放/垛容（「库房参数设计」页提供完整编辑与捆制规则）：料架限高与垛内铺宽实时改变垛容与落位；捆径口径 = 一捆合起来的外接圆直径上下限（细棒材自动增支成大捆、超上限自动单支吊运）；「每垛捆数上限」与「库容装载比例」变更后在「库房参数设计」页重建库区生效',
    defs: [
      { key: 'rackH',     label: '料架限高',     min: 2,    max: 6,    step: 0.1,  unit: 'm',  def: 3.0 },
      { key: 'pileW',     label: '垛内铺宽',     min: 1.5,  max: 4,    step: 0.05, unit: 'm',  def: 2.7 },
      { key: 'railTop',   label: '垫梁顶标高',   min: 0,    max: 1,    step: 0.01, unit: 'm',  def: 0.41 },
      { key: 'packShim',  label: '层间垫木厚',   min: 5,    max: 50,   step: 1,    unit: 'mm', def: 15 },
      { key: 'packGap',   label: '捆间通风缝',   min: 20,   max: 80,   step: 1,    unit: 'mm', def: 30 },
      { key: 'diaKw',     label: '截面宽向系数', min: 1.0,  max: 1.2,  step: 0.01, unit: '×',  def: 1.08 },
      { key: 'diaKh',     label: '截面高向系数', min: 1.0,  max: 1.2,  step: 0.01, unit: '×',  def: 1.06 },
      { key: 'bundlesPerStack', label: '每垛捆数上限', min: 50, max: 400, step: 10, unit: '捆', def: 400 },
      { key: 'minDiaCm',  label: '捆径下限',     min: 5,    max: 30,   step: 1,    unit: 'cm', def: 15 },
      { key: 'maxDiaCm',  label: '捆径上限',     min: 30,   max: 80,   step: 1,    unit: 'cm', def: 50 },
      { key: 'fillRatio', label: '库容装载比例', min: 10,   max: 95,   step: 1,    unit: '%',  def: 22 },
    ],
  },
];

/** 全部参数的默认值：{ sec: { key: value } } */
export function paramDefaults() {
  const values = {};
  for (const s of PARAM_SCHEMA) {
    values[s.sec] = {};
    for (const d of s.defs) values[s.sec][d.key] = d.def;
  }
  return values;
}

const DEF_INDEX = new Map();
for (const s of PARAM_SCHEMA) for (const d of s.defs) DEF_INDEX.set(`${s.sec}.${d.key}`, d);

/** 按 schema 夹取参数值；未知参数返回 null */
export function clampParam(sec, key, value) {
  const d = DEF_INDEX.get(`${sec}.${key}`);
  if (!d) return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  return Math.min(d.max, Math.max(d.min, v));
}
