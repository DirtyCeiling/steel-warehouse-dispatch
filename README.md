# 钢厂库区调度系统

## 项目简介

这是一个基于 React + Three.js 的钢厂库区三维可视化调度系统，用于管理和调度2.7万平方米厂区内的钢卷库存。系统采用三跨布局（每跨30m×300m），提供实时库存监控、库位管理和调度优化功能。

## 技术栈

- **前端框架**: React 18 + TypeScript
- **3D渲染**: Three.js + @react-three/fiber + @react-three/drei
- **状态管理**: Zustand
- **路由**: React Router DOM
- **样式**: Tailwind CSS
- **构建工具**: Vite

## 主要功能

### 1. 三维库区总览
- 三跨库区三维可视化展示
- 实时库位状态显示
- 钢卷信息查看
- 支持旋转、缩放、平移操作

### 2. 库存管理
- 钢卷列表展示
- 搜索和筛选功能
- 材质分类统计

### 3. 调度任务
- 任务列表管理
- 任务状态跟踪（待执行、执行中、已完成）
- 入库/出库/移库任务

### 4. 数据分析
- 库位利用率统计
- 库存总量分析
- 材质分布图表

## 安装和运行

### 1. 克隆项目
```bash
git clone <你的仓库URL>
cd steel-warehouse-dispatch
```

### 2. 安装依赖
```bash
npm install
```

### 3. 启动开发服务器
```bash
npm run dev
```

访问 http://localhost:5173/ 查看应用

### 4. 构建生产版本
```bash
npm run build
```

## 本地数据库（库存/库位）

基于 Node + SQLite（better-sqlite3）的本地库存数据库，存储钢厂棒材库区「库位 → 8 垛 → 每垛 20 捆」的库存/库位数据。数据库文件为 `server/warehouse.db`（不提交 git，可用命令随时重建）。

### 常用命令
```bash
npm run sim         # 一站式启动：沙盘预览(5199) + 库存数据库API(3001)
npm run db:init     # 初始化：建库 + 91 库位 × 8 垛 + 分区归堆实际钢材分布
npm run db:reset    # 重置为初始钢材分布
npm run db:inspect  # 打印库存汇总与抽样库位
npm run db:serve    # 仅启动本地 HTTP API（http://127.0.0.1:3001）
npm run db:test     # 自检：建库/写入/持久化
```

> 仿真沙盘（`http://localhost:5199/`）期初库存自动从数据库加载，出入库/倒垛实时写回；
> 数据库服务未启动时回退内置随机库存（事件日志会提示）。刷新/重启页面即恢复上次库存。

### 表结构
- `specs` — 棒材规格（名称/单捆吨重/渲染色）
- `storage_slots` — 库位（编码/分区/号区/跨/是否整跨合并/状态）
- `stacks` — 垛（库位+垛号，同垛单一规格，count 0~20，pending 待扫码，in_time 最早入库时间）

### HTTP 接口（带 CORS）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 存活检查 |
| GET | `/api/inventory` | 库存汇总（总捆数/总库容/利用率/分区统计） |
| GET | `/api/slots` | 全部库位（含各垛） |
| GET | `/api/slots/:id` | 单个库位详情 |
| GET | `/api/specs` | 棒材规格列表 |
| PUT | `/api/slots/:id/stacks/:no` | 更新某一垛（spec/count/pending/in_time） |
| POST | `/api/reset` | 重置为初始库存 |

## 项目结构

```
src/
├── components/          # React组件
│   ├── 3d/             # 3D场景组件
│   │   ├── WarehouseScene.tsx  # 3D仓库场景
│   │   ├── Span.tsx           # 库区跨组件
│   │   ├── Location.tsx       # 库位组件
│   │   └── SteelCoil.tsx      # 钢卷3D模型
│   └── layout/         # 布局组件
│       ├── Header.tsx         # 头部导航
│       ├── Sidebar.tsx        # 侧边栏
│       └── InfoPanel.tsx      # 信息面板
├── pages/              # 页面组件
│   ├── Dashboard.tsx   # 三维库区总览
│   ├── Inventory.tsx   # 库存管理
│   ├── Tasks.tsx       # 调度任务
│   └── Analytics.tsx   # 数据分析
├── store/              # 状态管理
│   └── warehouseStore.ts
├── data/               # Mock数据
│   ├── warehouse.json
│   ├── locations.json
│   ├── coils.json
│   └── tasks.json
└── types/              # TypeScript类型定义
    └── index.ts
```

## 3D场景说明

### 库区布局
- 总面积: 27,000平方米
- 三跨布局，每跨: 30m × 300m
- 每跨包含多个库位

### 钢卷状态颜色
- 🟢 绿色: 在库 (in-stock)
- 🟠 橙色: 预留 (reserved)
- 🔴 红色: 发货中 (shipping)

### 操作说明
- **旋转**: 鼠标左键拖拽
- **缩放**: 鼠标滚轮
- **平移**: 鼠标右键拖拽
- **查看详情**: 点击钢卷或库位

## 数据模型

### 库区 (Warehouse)
```typescript
{
  id: string;
  name: string;
  totalArea: number;      // 总面积 (m²)
  numberOfSpans: number;   // 跨数
}
```

### 库位 (Location)
```typescript
{
  id: string;
  spanId: string;          // 所属跨ID
  row: number;             // 行号
  column: number;          // 列号
  status: 'empty' | 'occupied' | 'reserved';
  capacity: number;         // 容量 (吨)
}
```

### 钢卷 (SteelCoil)
```typescript
{
  id: string;
  coilNumber: string;      // 钢卷号
  specification: string;   // 规格
  weight: number;          // 重量 (吨)
  diameter: number;        // 直径 (mm)
  material: string;        // 材质
  status: 'in-stock' | 'reserved' | 'shipping';
}
```

### 调度任务 (Task)
```typescript
{
  id: string;
  type: 'inbound' | 'outbound' | 'transfer';
  status: 'pending' | 'executing' | 'completed' | 'failed';
  steelCoilId: string;
  fromLocationId?: string;
  toLocationId?: string;
  createTime: string;
}
```

## 部署

项目可部署到任何静态托管服务，如：
- Vercel
- Netlify
- GitHub Pages
- 任意Web服务器

构建输出在 `dist/` 目录。

## 许可证

MIT License

## 作者

[你的名字]
