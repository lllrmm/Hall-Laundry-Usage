# hkust-laundry-dashboard

HKUST 洗衣房监控的**只读前端服务**：读取采集服务写入的 SQLite，展示当前状态与历史图表。

- **零依赖**：只用 `node:http` + `node:sqlite`，没有构建步骤、没有 npm 依赖。
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

## 页面内容

| 区块 | 说明 |
|---|---|
| 顶栏 | 数据最后更新时间（绝对 + 相对）、最近一次采集是否成功/耗时、数据库路径、立即刷新、自动刷新倒计时 |
| 当前状态 | 12 台机器卡片，按 空闲 / 在用 / 不可用 着色；在用显示预计剩余时间，洗衣机显示已运行时长；**洗衣机额外标注「带洗衣粉 / 不带洗衣粉」**（来自 `service_type.value`，烘干机不显示） |
| 时间跨度 | 1 小时 / 6 小时 / 24 小时 / 7 天 / 30 天 / 全部 |
| 机器筛选 | 每台机器一个可勾选 chip（带颜色）；快捷选择：全部 / 仅洗衣机 / 仅烘干机 / 当前空闲 / 当前在用 |
| 整体趋势 | 折线图：所选机器中"可用 / 在用"台数随时间变化 |
| 每台机器空闲率 | 多系列折线图：每台机器在时间桶内的空闲采样占比（阶梯线），颜色与 chip 一致 |
| 时间窗内状态占比 | 横向堆叠柱状图：每台机器 空闲 / 在用 / 不可用 的时间占比 |
| 按小时的空闲率 | 24 根柱状图（本地时间），越高越容易抢到机器，并标出最佳时段 |

图表全部用原生 SVG 手绘（无图表库），鼠标悬停显示该时刻数值；数据每 30 秒自动刷新，窗口 resize 自动重绘。

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
| `GET /api/series?since=24h&machines=id1,id2` | 时间序列（自动分桶，返回 `buckets` + 每台机器的 `availableRatio`/`inUseRatio` + 聚合 `totals`） |
| `GET /api/bars?since=24h&machines=...` | 时间窗内每台机器的状态占比 |
| `GET /api/hourly?since=7d&machines=...` | 按本地小时聚合的空闲率（24 桶） |

- `since` 支持 `1h` / `6h` / `24h` / `7d` / `30d` / `all` / ISO 时间；
- 分桶粒度按窗口自动选择（目标 ≤ 240 点，最小 30 秒）；
- `powder` 字段：`washing_machine_with_powder` → `"with"`，`washing_machine_without_powder` → `"without"`，烘干机为 `null`；
- 响应带 4 秒内存缓存，避免多个浏览器标签重复查询大表；
- 数据库以**只读**方式打开（失败时退回 `PRAGMA query_only`），绝不会写入采集数据。

## 测试

```bash
npm run test:in-process     # 14 个用例：数据层 + HTTP API + jsdom 前端渲染（node）
bun test                    # 13 个用例（jsdom 渲染测试只在 node 下跑）

# 端到端（需要采集服务也在跑）
node scripts/e2e-check.mjs          # 页面 + 各 API 全量校验
node scripts/probe-services.mjs     # 探针：数据库尾部数据 + 看板可达性
```

`test/frontend.dom.test.mjs` 用 jsdom 真实加载 `public/` 页面并执行 `app.js`：
校验状态卡片、四张 SVG 图表、机器勾选/时间跨度切换、页面无 JS 错误。
（本环境无法启动 Chromium，所以用 jsdom 做 DOM 级验证。）

> 本环境不允许启动子进程，`npm test`（默认多进程）会被 `spawn EPERM` 拦住，用 `test:in-process`；
> 普通机器上 `npm test` / `bun test` 均可。

## 与采集服务的关系

```
laundry-monitor（写）──► data/laundry.sqlite ──► laundry-dashboard（只读）
        │                                              │
   30s 轮询一次                                   每 30s 读一次
   Ctrl+C 停止后数据库不再增长                    停止后页面仍可查看历史数据
```

已验证：停掉看板，采集继续；停掉采集，看板仍可访问（只显示最后一次采集的数据）。
