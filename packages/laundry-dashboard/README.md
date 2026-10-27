# hkust-laundry-dashboard

HKUST 洗衣房监控的**只读前端服务**：读取采集服务写入的 SQLite，展示当前状态与历史图表。

- **服务端零依赖**：只用 `node:http` + `node:sqlite`，没有构建步骤；前端唯一运行时脚本是本地 vendor 的 Chart.js（MIT），不需要 CDN、不需要打包。
- **与采集服务解耦**：不调用采集服务的任何接口，只读同一个数据库文件；两个进程可分别启停。
- 数据库不存在或还没数据时也能启动（页面显示"等待数据"）。

## 启动

```bash
cd packages/laundry-dashboard
npm start                       # http://127.0.0.1:8787
# 或双击 run.cmd / 直接 node bin/serve.mjs --config dashboard.config.json
```

```bash
node bin/serve.mjs --db ../laundry-monitor/data/laundry.sqlite --port 8787
```

打开 <http://127.0.0.1:8787> 即可。

## 页面内容（界面为英文）

| 区块 | 说明 |
|---|---|
| 顶栏 | **Database updated**（数据库最后更新时间，绝对 + 相对）、Refresh now、自动刷新倒计时 |
| 当前状态 Current status | 分为 **Washers / Dryers 两个区域**，各自显示 `x/y free` 统计；卡片按 Free / In use / Unavailable 着色，在用显示预计剩余时间，洗衣机显示已运行时长；**洗衣机额外标注 "With detergent / No detergent"**（来自 `service_type.value`，烘干机不显示） |
| 时间跨度 Time range | 1 hour / 6 hours / 24 hours / 7 days / 30 days / All |
| 机器筛选 | 每台机器一个可勾选 chip（带颜色），**Washers / Dryers 分两栏显示**；右侧 **Select all / Clear all** 一键全选或清空 |
| Overall trend | 折线图：**Washers / Dryers 各一条线**，显示所选机器中在用台数随时间变化（Y 轴按峰值自适应） |
| State breakdown in window | 横向堆叠柱状图：每台机器 In use / Free / Unavailable 的时间占比（按此顺序堆叠）；**始终显示全部机器，只跟随时间范围变化**，右上角显示实际时段（开始 – 结束，如 `10-26 13:30 – 10-27 13:30`） |
| Usage rate by hour | 24 根柱状图（本地时间），每小时 in use 机器占比，柱子越高代表该时段越忙 |
| Usage heatmap · weekday × hour | 7 行（周一…周日）× 24 列热力图，格子颜色 = 该星期几该小时的平均使用率；**始终基于全部历史样本**（不随时间跨度 / 机器筛选变化），空格为无数据，样本过少的格子变淡，悬停显示百分比与样本数；点击行或列可查看剖面 |
| Historical profile | 热力图的剖面图：点周几行 → 该天 24 小时使用率；点小时列 → 该小时一周 7 天的使用率；都不选时显示全部历史按小时（样本加权）的剖面；再点一次取消选择 |

图表使用 **Chart.js 4**（本地 vendor，`public/vendor/chart.umd.js`，MIT），折线/堆叠柱/柱状图都由 Chart.js 渲染；悬停/触摸 tooltip、图例由库提供，主题颜色取自 CSS 变量。数据每 30 秒自动刷新，窗口尺寸变化时按新宽度重建图表。

### 图表库（Chart.js）

- 版本与许可见 `public/vendor/VERSION.txt`（当前为 Chart.js 4.6.1，MIT），许可证全文在 `public/vendor/CHARTJS-LICENSE.md`；
- 使用 `scripts/vendor-chartjs.mjs` 从 `node_modules` 复制 UMD 构建到 `public/vendor/`，**不依赖外部 CDN**，局域网/离线可用；
- 升级方式：`npm update chart.js && node scripts/vendor-chartjs.mjs`；
- 文件约 205 KB（未压缩），页面里通过 `<script src="/vendor/chart.umd.js">` 加载；
- 三张图的配置都在 `public/app.js` 的 `renderTrendChart()` / `renderBarsChart()` / `renderHourlyChart()` 里。

### 移动端适配

- `≤ 720px`：顶栏改为静态（不吸顶）、控件竖排、机器卡片两列起、图表自动切紧凑参数（更少刻度标签、更矮画布、更短机器名）；
- `≤ 420px`：机器卡片固定两列，洗粉徽标换行显示；
- 图表在 `resize`/横竖屏切换时按容器实际宽度重建；窄屏下"状态占比"柱状图使用短机器名（去掉 `UG4` 前缀）；
- 触摸屏：Chart.js 自带触摸 tooltip，按住/滑动图表即可查看对应数值。

**手机上打开**：默认只监听 `127.0.0.1`，手机需要把 `dashboard.config.json` 的 `host` 改成 `0.0.0.0`
（或直接 `node bin/serve.mjs --host 0.0.0.0`），然后用电脑的局域网 IP 访问，例如 `http://192.168.1.23:8787`。
服务没有登录鉴权，只暴露洗衣房状态（只读），请只在可信网络（家里/宿舍 WiFi）里这样开，看完可改回 `127.0.0.1`。

### 深浅色主题

- 默认 **Auto**：跟随浏览器/系统的 `prefers-color-scheme`，系统切换时页面实时跟随；
- 顶栏按钮循环切换 **Auto → Light → Dark**，选择写入 `localStorage["laundry.theme"]`，刷新后保持；
- 首屏由 `<head>` 内联脚本先确定主题，避免深色系统下闪白；
- 图表颜色也跟主题走：深色主题下机器 chip 使用更亮的色板，网格/坐标轴/状态颜色均取自 CSS 变量。

## 配置

`dashboard.config.json`：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `database` | `../laundry-monitor/data/laundry.sqlite` | 监控数据库路径（相对本配置文件） |
| `host` | `127.0.0.1` | 监听地址（只在本机访问） |
| `port` | `8787` | 监听端口 |
| `refreshSeconds` | `30` | 前端自动刷新间隔（前端实际固定 30s 轮询，字段保留给后续使用） |

## HTTP API（只读）

| 接口 | 说明 |
|---|---|
| `GET /api/meta` | 数据最后更新时间、最近一次轮询结果、轮询次数、机器数、快照数 |
| `GET /api/state` | meta + 机器维度 + 最新一轮全部机器状态（页面首屏用这一个请求） |
| `GET /api/machines` | 机器维度表（含 `serviceValue` / `serviceLabel` / `powder`） |
| `GET /api/latest` | 最新一轮每台机器的状态（含 `powder`：`"with"` / `"without"` / `null`） |
| `GET /api/series?since=24h&machines=id1,id2` | 时间序列（自动分桶，返回 `buckets` + 每台机器的 `availableRatio`/`inUseRatio` + 聚合 `totals` + 按机型的 `totalsByKind.washer/dryer`） |
| `GET /api/bars?since=24h&machines=...` | 时间窗内每台机器的状态占比 |
| `GET /api/hourly?since=7d&machines=...` | 按本地小时聚合的使用率 / 空闲率（24 桶，含 `usageRatio` / `freeRatio`） |
| `GET /api/heatmap?since=30d&machines=...` | 星期 × 小时热力图数据：`cells[]`（`weekday` 0=周一 … 6=周日、`hour`、`samples`、`usageRatio`）+ 覆盖时段 `since`/`until` |

- `since` 支持 `1h` / `6h` / `24h` / `7d` / `30d` / `all` / ISO 时间；
- 分桶粒度按窗口自动选择（目标 ≤ 240 点，最小 30 秒）；
- `powder` 字段：`washing_machine_with_powder` → `"with"`，`washing_machine_without_powder` → `"without"`，烘干机为 `null`；
- 响应带 4 秒内存缓存，避免多个浏览器标签重复查询大表；
- 数据库以**只读**方式打开（失败时退回 `PRAGMA query_only`），绝不会写入采集数据。

## 测试

```bash
npm run test:in-process     # 16 个用例：数据层 + HTTP API + jsdom 前端渲染（node）
bun test                    # 15 个用例（jsdom 渲染测试只在 node 下跑）

# 端到端（需要采集服务也在跑）
node scripts/e2e-check.mjs          # 页面 + 各 API 全量校验
node scripts/probe-services.mjs     # 探针：数据库尾部数据 + 看板可达性
```

`test/frontend.dom.test.mjs` 用 jsdom 真实加载 `public/` 页面并执行 `app.js`（含 Chart.js）：
校验状态卡片、三张 Chart.js 图表（数据/配置/主题色板）、机器勾选/时间跨度切换、页面无 JS 错误。
本环境装不上原生 `canvas`（沙箱禁止 install 脚本 spawn），测试里用一个轻量 2D context stub 让 Chart.js 能初始化；
**Canvas 的实际绘制由 Chart.js 自身保证**，我们断言的是喂给它的数据与配置。

> 开发依赖：`jsdom`（测试）与 `chart.js`（仅用于 `scripts/vendor-chartjs.mjs` 复制 UMD 构建，部署时不需要 `node_modules`）。

> 本环境不允许启动子进程，`npm test`（默认多进程）会被 `spawn EPERM` 拦住，用 `test:in-process`；
> 普通机器上 `npm test` / `bun test` 均可。

## 与采集服务的关系

```
laundry-monitor（写）──► data/laundry.sqlite ──► laundry-dashboard（只读）
        │                                              │
   60s 轮询一次                                   每 30s 读一次
   Ctrl+C 停止后数据库不再增长                    停止后页面仍可查看历史数据
```

已验证：停掉看板，采集继续；停掉采集，看板仍可访问（只显示最后一次采集的数据）。
