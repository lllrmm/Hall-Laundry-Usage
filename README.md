# LaundryAgent — HKUST 洗衣房监控与分析

对 <https://laundry.ust.hk/ldr/app/tickets> 的逆向 + 实测，产出一套**只读**的洗衣房工具链：

- 机器状态查询库 / CLI（`packages/laundry-machines`、`laundry.mjs`）
- 常驻采集服务（`packages/laundry-monitor`）：按 60s 轮询，写原始快照库 + 日级压缩序列库
- 只读 API 服务（`packages/laundry-dashboard`）：当前状态与历史分钟序列，只发数据不渲染页面
- 独立前端（`packages/laundry-web`）：静态页面 + 本地 Chart.js + 图表聚合，通过反向代理调用 API

> 只做查询：机器状态、Available Tickets、Used Tickets。不含购券/支付/预约等写操作。

## 快速开始

要求：**Node.js ≥ 22.5**（`node:sqlite`），包管理器用 **npm**。

### 1. 准备 token

1. 登录 <https://laundry.ust.hk/ldr/app/tickets>；
2. DevTools → Application → Local Storage → `ldr_student`，复制其中的 `token`；
3. token 的用法：填进采集配置 `monitor.config.json` 的 `bearer` 字段（下一步创建），
   或设置 `LDR_TOKEN` 环境变量；根目录 `laundry.mjs` CLI 也可以读取 `./token.txt`。

token 会在网页重新登录后失效；失效时看板会显示错误，重新复制即可。

### 2. 启动

首次运行先准备采集配置（已被 git 忽略）：

```bash
cp packages/laundry-monitor/monitor.config.example.json packages/laundry-monitor/monitor.config.json
# 编辑 monitor.config.json，把 bearer 换成 token；或在启动前设置 LDR_TOKEN 环境变量
cd packages/laundry-monitor && npm install
```

两个后端 + 一个前端互相独立，分别启动即可：

```bash
# 终端 1：采集（每 60s 一次，写两个 SQLite）
cd packages/laundry-monitor && npm start

# 终端 2：只读 API
cd packages/laundry-dashboard && npm start

# 终端 3：前端静态服务 + /api 反向代理
cd packages/laundry-web && npm start
```

| 服务 | 作用 | 地址 |
|---|---|---|
| `laundry-monitor` | 采集（每 60s 一次，写两个 SQLite） | 无（后台写库） |
| `laundry-dashboard` | 只读 JSON API | <http://127.0.0.1:8787>（只给前端/程序调用） |
| `laundry-web` | 前端页面 + 反向代理 | <http://127.0.0.1:8788> / `http://<本机局域网 IP>:8788` |

- 停采集：看板仍可访问，只是数据停在最后一次采集；
- 停 `laundry-dashboard`：页面能打开，但图表/状态请求失败；
- 停 `laundry-web`：API 仍在，但浏览器无页面可访问；
- 采集周期 / token / 数据保留天数在 `packages/laundry-monitor/monitor.config.json`；
- dashboard 端口/数据库路径在 `packages/laundry-dashboard/dashboard.config.json`；
- 前端端口 / API 反代地址在 `packages/laundry-web/web.config.json`。

### 3. 局域网 / 手机访问

前端监听 `0.0.0.0`，同一局域网内的手机/平板用电脑 IP 访问即可，例如
`http://<电脑 IP>:8788`（用系统工具查看本机局域网 IP）。API 默认只监听 `127.0.0.1`，由前端本地反代访问。

## 看板

浏览器端单页看板，主要包含：

- **Current status**：洗衣机 / 烘干机实时状态、倒计时、洗粉标注；
- **Usage heatmap**：星期 × 分钟使用率热力图，可多选星期、拖动时间轴筛选时段；
- **Inspection**：1 分钟使用率线图，按星期柱状图，点柱子可下钻到某一天；
- **State breakdown**：每台机器各种状态的堆叠占比；
- 支持日期范围 / 机器筛选、深浅色主题、移动端触摸操作；所有图表聚合在浏览器端完成，交互不再请求后端。

详细行为与交互说明见 [packages/laundry-web/README.md](packages/laundry-web/README.md)。

## 采集与数据

采集服务每 60s 拉一次机器状态，写入两个 SQLite：

| 文件 | 内容 |
|---|---|
| `data/laundry.sqlite` | 原始库（真相源）：`poll_runs`、`machines`、`machine_snapshots`、`machine_transitions`；默认保留 30 天 |
| `data/laundry-series.sqlite` | 日级序列库（派生）：`machine_days(machine_id, day, seq BLOB 1440B)`，按本地日期切天，长期保留 |

序列库可随时从原始库重建（幂等）：

```bash
cd packages/laundry-monitor
node bin/cli.mjs rebuild --config monitor.config.json
node bin/cli.mjs series  --config monitor.config.json   # 查看序列库统计
npm run stats -- --since 24h                            # 汇总：可用率/使用次数/平均时长
npm run once                                            # 只采一次（手动补采/排查）
```

序列库的分钟字节编码与使用率口径（含 on_hold 细分）详见
[monitor README](packages/laundry-monitor/README.md) 与 [dashboard README](packages/laundry-dashboard/README.md)。

## HTTP API（站点侧，只读）

| 需求 | 接口 |
|---|---|
| 机器状态 | `GET https://laundry.ust.hk/ldr/api/app/laundry-rooms/machines` |
| Tickets | `GET https://laundry.ust.hk/ldr/api/app/tickets`（本地过滤 `usage_status`） |

鉴权：`Authorization: Bearer <token>`；业务错误也返回 HTTP 200，检查 `meta.code`
（`4031` 缺 token / `4032` token 失效 / `4034` 参数错）。完整字段与示例见
[docs/API.md](docs/API.md) 与 [docs/openapi.json](docs/openapi.json)。

## 看板 HTTP API（内部，只读）

| 接口 | 说明 |
|---|---|
| `GET /api/state` | 首屏 + 刷新：`{ meta（含 span）, machines（维度 + 最新状态） }` |
| `GET /api/days?machines=…&from=YYYY-MM-DD&to=YYYY-MM-DD` | 历史图表唯一数据源；`machines` 必填，日期用 `from`+`to` 或 `days=` 列表（互斥），否则 400 |
| `GET /api/meta` | 元信息（含数据覆盖范围 `span`） |
| `GET /api/machines` | 机器维度 + 最新状态 |

- 服务端只发原始日序列，所有聚合在浏览器端；
- JSON ≥1KB 自动 gzip；响应带 4 秒内存缓存；
- 旧的 `/api/series`、`/api/latest`、`/api/bars`、`/api/heatmap`、`/api/profile`、`/api/profile/days`、`/api/hourly` 已删除。

## 目录结构

```
laundry.mjs                   只读 CLI：machines / available / used（见 docs/API.md）
token.txt                     Bearer token（git 忽略）
docs/API.md                   站点 API 文档
docs/openapi.json             OpenAPI 3.0 规格
packages/laundry-machines/    机器状态查询库（ESM + TS 类型 + CLI，Node ≥18）
packages/laundry-monitor/     采集服务：轮询 + 原始快照库 + 日序列库（stats/export/rebuild）
packages/laundry-dashboard/   只读 JSON API：meta / state / machines / days
packages/laundry-web/         独立前端：静态页面 + Chart.js + /api 反向代理
packages/shared/              跨包共享契约：序列字节编码、本地日界、洗粉映射
```

各包的详细说明、配置项和设计细节见各自的 README：

- [packages/laundry-machines/README.md](packages/laundry-machines/README.md)
- [packages/laundry-monitor/README.md](packages/laundry-monitor/README.md)
- [packages/laundry-dashboard/README.md](packages/laundry-dashboard/README.md)
- [packages/laundry-web/README.md](packages/laundry-web/README.md)

## CLI 快速查询

```bash
node laundry.mjs machines          # 机器实时状态 + 倒计时
node laundry.mjs available         # Available Tickets
node laundry.mjs used 10           # Used Tickets（最近 10 张）
node laundry.mjs machines --json   # 原始 JSON
```

## 测试与自检

```bash
# 机器状态库
cd packages/laundry-machines && npm test && npm run typecheck

# 采集 / 存储 / 序列
cd packages/laundry-monitor && npm test

# 只读 API（数据层 + HTTP）
cd packages/laundry-dashboard && npm test

# 前端（静态托管/反代 + 浏览器端聚合 + jsdom）
cd packages/laundry-web && npm test

# 端到端（需要采集 + dashboard + web 都在跑）
cd packages/laundry-dashboard && node scripts/e2e-check.mjs
#   DASHBOARD_URL / WEB_URL 可覆盖默认的 8787 / 8788
```

## 注意事项

- 看板只读 SQLite，不会写采集数据；
- 采样粒度为 **1 分钟/台**：同一分钟多次轮询只保留最后一次；历史图表以此为最小单位；
- 原始库默认只保留 30 天（`retentionDays`），序列库长期保留；
- 站点若改字段/接口，采集会记录错误码（`poll_runs.ok=0`），看板顶栏会显示连接/加载失败；
- 站点未公布限流策略，轮询建议 ≥ 15s（当前 60s）。
