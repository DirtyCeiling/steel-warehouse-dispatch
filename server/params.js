// 调度规划参数模式（schema）：主系统「调度参数」页与仿真沙盘共用这一份定义。
// GET /api/params 返回 { schema, values }：前端按 schema 渲染滑杆/数字输入；
// 仿真沙盘启动时读取 values 覆盖内置默认，沙盘内调整也会 PUT 写回（两端同源）。
// 注意：sec/key/min/max 与 simulation/调度仿真沙盘.html 的 PARAM_DEFS 保持一致。
export const PARAM_SCHEMA = [
  {
    sec: 'production', secLabel: '生产节奏',
    desc: '每日进厂 / 出厂车辆数，订单全天均匀铺开（不一次性下完）',
    defs: [
      { key: 'inPerDay',  label: '每日进厂车辆', min: 10, max: 600, step: 5, unit: '辆/日', def: 150 },
      { key: 'outPerDay', label: '每日出厂车辆', min: 10, max: 600, step: 5, unit: '辆/日', def: 100 },
    ],
  },
  {
    sec: 'truck', secLabel: '组车规则',
    desc: '一车最少/最多吊数（同跨装卸，凑满或超时放行）；进厂车按规格整车配载，仅「混装车比例」的车混装第二种规格',
    defs: [
      { key: 'minLoads',     label: '每车最少吊数', min: 2,   max: 10,  step: 1,   unit: '吊', def: 6 },
      { key: 'maxLoads',     label: '每车最多吊数', min: 4,   max: 16,  step: 1,   unit: '吊', def: 10 },
      { key: 'maxWait',      label: '组车等待上限', min: 30,  max: 600, step: 10,  unit: '秒', def: 150 },
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
    desc: '3 台（D-01 ~ D-03）：行进速度 / 扫码耗时 / 续航与充电',
    defs: [
      { key: 'speed',       label: '行进速度',     min: 1,   max: 10, step: 0.1, unit: 'm/s',  def: 5.0 },
      { key: 'scanTime',    label: '扫码核验时间', min: 0.5, max: 10, step: 0.1, unit: '秒',   def: 3.0 },
      { key: 'endurance',   label: '满电续航',     min: 0.5, max: 8,  step: 0.5, unit: '小时', def: 3 },
      { key: 'chargeHours', label: '充满电时间',   min: 0.5, max: 6,  step: 0.5, unit: '小时', def: 2 },
    ],
  },
  {
    sec: 'crane', secLabel: '天车（吊运装卸）',
    desc: '6 台（每跨 2 台，TC-A1~TC-C2）：行进速度 / 吊取 / 放下耗时',
    defs: [
      { key: 'speed',     label: '行进速度', min: 0.5, max: 10, step: 0.1, unit: 'm/s', def: 4.0 },
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
