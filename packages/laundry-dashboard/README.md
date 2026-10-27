# hkust-laundry-dashboard

HKUST 洗衣房监控的**只读前端服务**：读取采集服务写入的 SQLite，展示当前状态与历史图表。

- **服务端零依赖**：只用 `node:http` + `node:sqlite`，没有构建步骤；前端唯一运行时脚本是本地 vendor 的 Chart.js（MIT），不需要 CDN、不需要打包。
- **与采集服务解耦**：不调用采集服务的任何接口，只读同一个数据库文件；两个进程可分别启停。
- **聚合在浏览器端**：后端只把「每台机器每天 1,440 字节的分钟状态序列」发给前端，星期 × 分钟热力图、时间剖面、状态占比全部由 `public/aggregate.js` 在本地计算；选星期、拖时段、点分钟、勾机器都不会再请求后端。
- 数据库不存在或还没数据时也能启动（页面显示"等待数据"）。

## 启动

```bash
cd packages/laundry-dashboard
npm start                       # http://127.0.0.1:8787
# 或：node bin/serve.mjs --config dashboard.config.json
```

```bash
node bin/serve.mjs --db ../laundry-monitor/data/laundry.sqlite \
  --series ../laundry-monitor/data/laundry-series.sqlite --port 8787
```

打开 <http://127.0.0.1:8787> 即可；局域网访问用 `http://<电脑 IP>:8787`。

## 页面内容（界面为英文）

| 区块 | 说明 |
|---|---|
| 顶栏 | **Database updated**（数据库最后更新时间，绝对 + 相对）、Refresh now、自动刷新倒计时 |
| 当前状态 Current status | 分为 **Washers / Dryers 两个区域**，各自显示 `x/y free` 统计；卡片按 Free / In use / Unavailable 着色，在用显示预计剩余时间，洗衣机显示已运行时长；**洗衣机额外标注 "With detergent / No detergent"，在卡片最下方独立一行显示**（来自 `service_type.value`，烘干机不显示） |
| Date range | 选择开始 / 结束日期（本地日期，含首尾两天），留空 = 全部历史；**选 All dates 时两个日期框会显示数据实际覆盖的日期范围**（不再是 mm/dd/yyyy 占位，内部仍按全部历史处理）；**热力图 / Inspection / State breakdown 都跟随**；变化时只向后台补还没缓存的「机器·天」 |
| 机器筛选 | 每台机器一个可勾选 chip，**Washers / Dryers 分两栏显示**；右侧 **Select all / Clear all** 一键全选或清空；**热力图 / 剖面 / State breakdown 都跟随**（清空选择时显示占位）；新勾选的机器只补它缺的天 |
| State breakdown | 横向堆叠柱状图：每台机器**各种状态的占比**，**从左到右顺序为 In use → On hold → Maintenance → Offline → Disabled → Unknown → Free（Free 固定最右）**，**图例始终显示全部 7 种状态**（无样本的状态为 0），分母为该机器的全部已观测分钟；tooltip 显示总样本数；样本范围 = Date range + Machines selected + 勾选的星期 + 热力图选中的时段；**右上角始终显示「星期 · 时段」**（如 `Mon–Sun · 06:00–11:59`；没选星期时显示全部 `Mon–Sun`，没选时段时显示 `00:00–23:59`；星期连续时合并为 `Mon–Wed`，不连续则分开写 `Mon, Wed, Fri`；显式选了 Date range 才追加日期范围）；**在浏览器端计算** |
| Usage heatmap | Canvas 绘制的 7 行（周一…周日）× **1440 列（1 分钟）** 热力图，**压缩到视口宽度、无需滚动**；颜色 = 该星期几该分钟的平均使用率（只统计可运营样本：available + in_use + on_hold，其中 in_use/on_hold(+in_use) 算占用）；跟随 Date range 与机器选择；点行标签可多选星期；**热力图内部点击/悬停只弹标签显示该点信息（不改变选择）**；**顶部时间轴拖动选择时段：桌面 30 分钟粒度、移动端 1 小时粒度；移动端可用手指在时间轴上滑动选择**；**在浏览器端计算** |
| Inspection | 热力图剖面：勾选一个或多个星期 → 合并的 1 分钟使用率线图（**图例始终包含 Washers in use / Dryers in use 两条线**，未选某类机型时该线无数据；按样本加权；**横轴标签间距限定为 15 / 30 / 60 / 120 分钟**，按容器宽度自动选择）；点分钟 / 拖选时段 → 按星期统计的柱状图（**横轴始终显示 Mon–Sun 全部 7 个标签**，窄屏也不会被抽稀）；**点击柱状图的某根柱子 → 等效于在热力图左侧选中该星期，切换到那一天的 1 分钟线图**；跟随 Date range 与机器选择；百分比同样**只统计可运营样本**；**在浏览器端计算**；默认线图的右上角**始终显示星期范围**（默认 `Mon–Sun`，连续的天合并为 `Mon–Wed`，不连续分开写） |

图表使用 **Chart.js 4**（本地 vendor，`public/vendor/chart.umd.js`，MIT），折线/堆叠柱/柱状图都由 Chart.js 渲染；悬停/触摸 tooltip、图例由库提供，主题颜色取自 CSS 变量。数据每 30 秒自动刷新，窗口尺寸变化时按新宽度重建图表。

### 数据流与取数策略（只请求 diff）

后端只提供一个历史数据接口（强约束：`machines` 必填，日期二选一）：

```
GET /api/days?machines=<id,id>&from=YYYY-MM-DD&to=YYYY-MM-DD
# 或
GET /api/days?machines=<id,id>&days=YYYY-MM-DD,YYYY-MM-DD
→ { available, source, fromDay, toDay, count, days: [{ machineId, day, seq(base64 1440B), updatedAt }] }
```

不传 `machines`、缺日期范围、`from`/`to` 与 `days` 同时使用等情况一律返回 **400**（不会无参数拉全库）。`/api/state` 和 `/api/meta` 的 `meta.span` 都会返回数据覆盖的本地日期范围 `{ firstDay, lastDay }`，前端用它在"全部历史"时换算出 /api/days 必填的 `from`/`to`。

`seq` 的每个字节是当天第 N 分钟的状态（编码见下）。前端把这些序列按 `(machineId, day)` 缓存在内存里：

| 操作 | 是否请求后端 | 请求内容 |
|---|---|---|
| 首次加载 | 是 | `span` 范围 × 当前已选机器（默认全选），带 `from`/`to` |
| Date range 变化 | **只补 diff** | 把选择换算成 span 内的明确 `from`/`to`，只请求里**还没缓存过**的机器·天；缺失日期按连续区间分组，已缓存的一律不重复请求；全部已缓存或与数据无交集时不发请求 |
| 机器从不选变成选 | **只补 diff** | 这台机器在当前范围里还没缓存过的天；已缓存时不会请求 |
| 机器取消选择 / 选星期 / 拖时段 / 点分钟 / 切换主题 / 改窗口大小 | 否 | 纯本地重算 + 重绘 |
| 自动 / 手动刷新 | 是（仅今天） | 只重取**今天**、已选机器的序列（今天的字节还在增长）；Date range 不包含今天时不请求 |

历史数据优先读监控服务的**日序列库**（`machine_days`，每台机器每天 1,440 字节）；序列库不存在或还没覆盖某天时，自动回退到**原始快照库**即时生成同样的日序列，因此只跑过采集、还没执行过 `laundry-monitor rebuild` 的库也能直接看。`/api/days` 的 JSON 会按需 gzip（实测当前 1 天 × 12 台：JSON 24.6 KB → gzip 后约 0.8 KB），历史天数变多时首屏体积也不会等比膨胀。

状态字节编码（实现见 `packages/shared/contracts.js`，浏览器端 `public/aggregate.js` 由契约测试保证一致）：

| 字节 | 含义 | 计入使用率 |
|---|---|---|
| `0x00` | in_use 占用 | 是（分子 + 分母） |
| `0x01` | available 空闲 | 是（仅分母） |
| `0x02` | maintenance 维护 | 否（但计入 State breakdown） |
| `0x03` | disabled 停用 | 否（但计入 State breakdown） |
| `0x04` | offline 离线 | 否（但计入 State breakdown） |
| `0x05` | on_hold（旧编码，仅解码兼容） | 是（按 on_hold + in_use 处理） |
| `0x06` | on_hold + in_use | 是（分子 + 分母） |
| `0x07` | on_hold + available | 是（仅分母） |
| `0x08` | on_hold + offline | 否（但计入 State breakdown 的 On hold） |
| `0x09` | on_hold + unknown | 否（但计入 State breakdown 的 On hold） |
| `0xfe` | unknown 无法识别 | 否（计入 State breakdown 的 Unknown） |
| `0xff` | no_data 该分钟没有成功轮询 | 否（不计入任何统计） |

> 热力图 / Inspection 的可运营样本 = `available` + `in_use` + `on_hold(+in_use)` + `on_hold(+available)`；其中 `in_use` 与 `on_hold(+in_use)` 计入分子，`on_hold(+available)` 只进分母。`State breakdown` 仍把 5 种 on_hold 字节统一归入 `On hold` 段。

### 前端脚本

| 文件 | 职责 |
|---|---|
| `public/app.js` | 页面渲染、Chart.js 图表、选择交互；数据装载与刷新调度 |
| `public/aggregate.js` | 纯函数聚合：`buildHeatmap` / `buildProfile` / `buildStateBreakdown`（node 测试可直接用 vm 执行） |
| `public/history.js` | 纯函数取数计划：`planDiff`（只补缓存缺的机器·天）、日期工具 |
| `public/vendor/chart.umd.js` | 本地 Chart.js 4.6.1（MIT） |

### 图表库（Chart.js）

- 版本与许可见 `public/vendor/VERSION.txt`（当前为 Chart.js 4.6.1，MIT），许可证全文在 `public/vendor/CHARTJS-LICENSE.md`；
- 使用 `scripts/vendor-chartjs.mjs` 从 `node_modules` 复制 UMD 构建到 `public/vendor/`，**不依赖外部 CDN**，局域网/离线可用；
- 升级方式：`npm update chart.js && node scripts/vendor-chartjs.mjs`；
- 文件约 205 KB（未压缩），页面里通过 `<script src="/vendor/chart.umd.js">` 加载；
- 图表配置都在 `public/app.js` 的 `renderBarsChart()` / `renderHeatmap()` / `renderProfile()` 里。

### 移动端适配

- `≤ 720px`：顶栏改为静态（不吸顶）、控件竖排、机器卡片两列起、图表自动切紧凑参数（更少刻度标签、更矮画布、更短机器名）；
- `≤ 420px`：机器卡片固定两列，洗粉徽标换行显示；
- 图表在 `resize`/横竖屏切换时按容器实际宽度重建；窄屏下"状态占比"柱状图使用短机器名（去掉 `UG4` 前缀）；
- 触摸屏：Chart.js 自带触摸 tooltip，按住/滑动图表即可查看对应数值。

**手机上打开**：`dashboard.config.json` 监听 `0.0.0.0`，手机/平板与电脑在同一局域网时，访问 `http://<电脑 IP>:8787` 即可；本机仍可用 `http://127.0.0.1:8787`。

### 深浅色主题

- 默认 **Auto**：跟随浏览器/系统的 `prefers-color-scheme`，系统切换时页面实时跟随；
- 顶栏按钮循环切换 **Auto → Light → Dark**，选择写入 `localStorage["laundry.theme"]`，刷新后保持；
- 首屏由 `<head>` 内联脚本先确定主题，避免深色系统下闪白；
- 图表颜色也跟主题走：网格/坐标轴/状态颜色均取自 CSS 变量。

## 配置

`dashboard.config.json`：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `database` | `../laundry-monitor/data/laundry.sqlite` | 原始快照库路径（相对本配置文件）；当前状态与回退日序列用 |
| `seriesDatabase` | `../laundry-monitor/data/laundry-series.sqlite` | 日序列库路径（序列库缺失时自动回退 `database`） |
| `host` | `127.0.0.1`（默认值）；仓库配置为 `0.0.0.0` | 监听地址；`0.0.0.0` = 局域网可访问，`127.0.0.1` = 仅本机 |
| `port` | `8787` | 监听端口 |

## HTTP API（只读）

| 接口 | 说明 |
|---|---|
| `GET /api/meta` | 数据最早/最后更新时间、最近一次轮询结果、轮询次数、机器数、快照数、数据覆盖日期范围 `span` |
| `GET /api/state` | meta（含 `span`）+ `machines`（机器维度 + **已合并的最新状态**；页面首屏用这一个请求） |
| `GET /api/machines` | 机器维度 + 最新状态合并后的 `machines` 数组（含 `serviceValue` / `serviceLabel` / `powder` / `available` / `state` / 剩余时间等） |
| `GET /api/days?machines=id1,id2&from=YYYY-MM-DD&to=YYYY-MM-DD` | **历史图表唯一数据源**：每台机器每天的 1440 字节分钟状态序列（`seq` 为 base64）。`machines` **必填**；日期用 `from`+`to`（含首尾）或 `days=YYYY-MM-DD,YYYY-MM-DD` 日期列表（互斥，列表最多 366 天）；优先读序列库、缺失时回退原始快照；返回 `source`（`series`/`raw`/`mixed`）与 `encoding` 编码表；参数缺失/非法返回 **400** |

- `/api/days` 的参数校验错误统一返回 `400 { error: "..." }`（例如缺 `machines`、缺日期、`from` 晚于 `to`、`days` 含非法日期、`from/to` 与 `days` 同时存在）；
- `meta` 不返回服务器数据库绝对路径（`database`），`lastPoll` 不返回轮询耗时（`durationMs`）；
- `powder` 字段：`washing_machine_with_powder` → `"with"`，`washing_machine_without_powder` → `"without"`，烘干机为 `null`；
- 响应带 4 秒内存缓存，避免多个浏览器标签重复查询大表；
- 响应体 ≥ 1 KB 且请求头 `Accept-Encoding` 含 gzip 时自动 gzip（JSON 与 `.html/.js/.css/.svg` 静态文件），响应带 `Vary: accept-encoding`；静态文件的压缩结果按 `path + mtime + size` 缓存，不会每次重复压缩；
- 数据库以**只读**方式打开（失败时退回 `PRAGMA query_only`），绝不会写入采集数据。
- 已删除：`/api/series`（旧趋势图的服务端分桶聚合）、`/api/latest`（已并入 `machines`）、`/api/bars`、`/api/heatmap`、`/api/profile`、`/api/profile/days`、`/api/hourly`——图表聚合改由浏览器端完成，交互不再触发后端计算。

## 测试

```bash
npm test                    # 数据层 + HTTP API + 聚合/取数纯函数 + jsdom 前端

# 端到端（需要采集服务也在跑）
node scripts/e2e-check.mjs          # 页面 + 各 API 全量校验
```

- `test/frontend.dom.test.mjs` 用 jsdom 真实加载 `public/` 页面并执行 `app.js`（含 Chart.js）：校验状态卡片、两张 Chart.js 图表、热力图 Canvas、机器/日期/星期交互，并断言**只有 data range 变化 / 新选机器缺数据时才会请求 `/api/days`，自动刷新只请求今天**；页面不应有 JS 错误。
- `test/aggregate.test.mjs` / `test/history.test.mjs` 用 `node:vm` 直接执行浏览器端纯函数，覆盖热力图/剖面/状态占比与「只补 diff」的取数计划。
- 测试用 jsdom + 轻量 Canvas 2D context stub 让 Chart.js 能初始化；**Canvas 的实际绘制由 Chart.js 自身保证**，测试断言的是喂给它的数据与配置。

> 开发依赖：`jsdom`（测试）与 `chart.js`（仅用于 `scripts/vendor-chartjs.mjs` 复制 UMD 构建，部署时不需要 `node_modules`）。

## 与采集服务的关系

```
laundry-monitor（写）
   ├─► data/laundry.sqlite          原始快照库（真相源）
   └─► data/laundry-series.sqlite   日序列库（1,440 字节/机器·天，由 raw 回填/双写）
                │
                ▼
laundry-dashboard（只读）
   ├─ /api/state            → 当前状态卡片
   └─ /api/days             → 原始日序列 → 浏览器端 aggregate.js 做热力图/剖面/占比
```

- 序列库是派生数据：任何时候都能用 `node bin/cli.mjs rebuild --config monitor.config.json` 从原始库重建；
- 已验证：停掉看板，采集继续；停掉采集，看板仍可访问（只显示最后一次采集的数据）。
