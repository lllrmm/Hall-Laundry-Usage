# hkust-laundry-dashboard-webpage

HKUST 洗衣房看板的**纯静态前端**：HTML/CSS/JS + 本地 Chart.js，无框架、无构建。

- 页面与所有图表聚合都在浏览器端完成（`public/aggregate.js`、`public/history.js`、`public/app.js`）；
- 数据来自只读 API（[`laundry-dashboard-api`](../laundry-dashboard-api)）；
- 部署方式：把 `public/` 整个目录放到 GitHub Pages、Nginx、CDN 或任意静态托管即可。

## 部署

### GitHub Pages（仓库自带 workflow）

1. 仓库 Settings → Pages → Source 选 **GitHub Actions**；
2. 推 `main` 后 `.github/workflows/pages.yml` 会把 `public/` 发布到 Pages；
3. 访问：
   `https://<user>.github.io/<repo>/?api=https%3A%2F%2Fyour-api.example.com`

### 其他静态托管

把 `public/` 作为站点根目录。API 地址通过下面任一方式指定：

1. URL 参数：`?api=https://your-api.example.com`（优先级最高）；
2. 编辑 `public/config.js`：
   ```js
   window.__LAUNDRY_API_BASE__ = 'https://your-api.example.com';
   ```
3. 都不设置时按同源 `/api/*` 请求（纯静态托管下会失败，需要显式配置 API 地址）。

API 地址只写 **origin**，不要带 `/api` 后缀（前端会自己拼 `/api/state` 等路径）。

## API 要求

- 必须是 **HTTPS**（Pages 是 HTTPS，浏览器会拦截 HTTPS→HTTP 混合内容）；
- API 必须允许 Pages 的 origin 跨域：
  ```json
  { "corsOrigins": ["https://<user>.github.io"] }
  ```
  origin 只到 `https://<user>.github.io`，不要带仓库路径；
- 本地调试可临时用 `"corsOrigins": ["*"]`，生产不要这么做。

> 在跑后端的同一台电脑上打开 Pages 时，可以直接用
> `?api=http://127.0.0.1:8787`。Chrome/Edge 会对「公网 HTTPS 页面 → localhost」做 Private Network Access 预检，
> dashboard 已返回 `Access-Control-Allow-Private-Network: true`；Firefox/Safari 可能直接拦截 HTTPS→HTTP localhost，
> 这种情况下请改用 HTTPS 隧道/反代暴露 API。

> Pages 只托管静态文件；采集与 API 仍需在常开机器上运行，并通过 HTTPS 隧道/反代暴露。

## 页面内容（界面为英文）

- **Current status**：Washers / Dryers 分区卡片，Free / In use / Unavailable、剩余时间/已运行时长；洗衣机在卡片最下方显示 `With detergent` / `No detergent`；
- **Date range**：本地日期范围（含首尾）；选 **All dates** 时日期框显示数据实际覆盖范围（内部仍按全部历史处理）；
- **Machines**：12 台机器 chip，可多选；只补缺失的「机器·天」；
- **Usage heatmap**：7 天 × 1440 分钟的 Canvas 热力图；顶部时间轴（00–23）拖动选时段（桌面 30 分钟粒度、移动端 1 小时粒度，支持触摸滑动）；点行标签多选星期；
- **Inspection**：1 分钟使用率线图（始终显示 Washers/Dryers 两条图例），点分钟/拖时段后切为 Mon–Sun 柱状图（横轴固定 7 个标签），点柱子跳到该星期的线图；
- **State breakdown**：每台机器状态占比（横向堆叠柱），图例固定 7 项：`In use → On hold → Maintenance → Offline → Disabled → Unknown → Free`；
- 支持 Auto/Light/Dark 主题、`≤720px` 响应式布局；所有交互只重算内存数据，不请求后端。

### 取数策略（浏览器端）

历史数据按 `(machineId, day)` 缓存在浏览器，`history.js` 的 `planDiff` 只请求缓存缺失的机器·天：

| 触发 | 请求内容 |
|---|---|
| 首次加载 | `/api/state` 的 `span` × 当前已选机器 |
| Date range 变化 | 只补新范围里没缓存的机器·天 |
| 机器从不选变选 | 只补该机器在当前范围里没缓存的天 |
| 自动 / 手动刷新 | 只重取**今天**、已选机器的序列 |

## 前端脚本

| 文件 | 职责 |
|---|---|
| `public/index.html` | 页面结构、首屏主题初始化 |
| `public/app.js` | 页面渲染、Chart.js 图表、选择/拖动交互、刷新调度 |
| `public/aggregate.js` | 纯函数聚合：`buildHeatmap` / `buildProfile` / `buildStateBreakdown` |
| `public/history.js` | 纯函数取数计划：`planDiff`、日期工具 |
| `public/config.js` | 运行时 API 地址解析（`?api=` > `config.js` > 同源） |
| `public/vendor/chart.umd.js` | 本地 Chart.js（MIT），不依赖 CDN |

升级 Chart.js：`npm update chart.js && node scripts/vendor-chartjs.mjs`。

## 测试

```bash
npm test
# 或：node --test-isolation=none --test test/config.test.mjs test/aggregate.test.mjs test/history.test.mjs test/frontend.dom.test.mjs test/contract.test.mjs
```

- `test/config.test.mjs`：`?api=` / `config.js` / 同源回退的地址解析；
- `test/aggregate.test.mjs` / `test/history.test.mjs`：用 `node:vm` 直接执行浏览器端纯函数；
- `test/frontend.dom.test.mjs`：jsdom 真跑页面与 Chart.js（Canvas 用 2D stub），覆盖状态卡片、图表、日期/星期/时段交互与只补 diff 的请求行为；测试内用临时静态服务器模拟 Pages，不经过任何反代；
- `test/contract.test.mjs`：校验浏览器端字节常量/分类与 [`packages/shared/contracts.js`](../shared/contracts.js) 完全一致。

## License

MIT
