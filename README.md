# Hall Laundry Usage

产出一套**只读**的洗衣房工具链：

- 数据采集服务（`packages/laundry-monitor`）：按 60s 轮询，写原始快照库 + 日级压缩序列库
- 只读API服务（`packages/laundry-dashboard-api`）：当前状态与历史分钟序列，只发数据不渲染页面
- 独立前端（`packages/laundry-dashboard-webpage`）：静态页面

## 快速开始

要求：**Node.js ≥ 22.5**（`node:sqlite`），包管理器 **npm**。

### 1. 准备 token

1. 登录 <https://laundry.ust.hk/ldr/app/tickets>；
2. DevTools → Application → Local Storage → `ldr_student`，复制其中的 `token`（用于稍后填入`monitor.config.json`）；

token 会在网页重新登录后失效；失效时看板会显示错误，重新复制即可。

### 2. 启动

首次运行先准备本地配置（都不会入库，模板见各目录 `*.config.example.json`）：

```bash
cp packages/laundry-monitor/monitor.config.example.json packages/laundry-monitor/monitor.config.json
cp packages/laundry-dashboard-api/dashboard-api.config.example.json packages/laundry-dashboard-api/dashboard-api.config.json
cp packages/laundry-dashboard-webpage/dashboard-webpage.config.example.json packages/laundry-dashboard-webpage/dashboard-webpage.config.json
# 编辑 monitor.config.json，把 bearer 换成 token；或在启动前设置 LDR_TOKEN 环境变量
# dashboard-api / dashboard-webpage 一般用默认配置即可；局域网或 Pages 时再改 host / corsOrigins / apiTarget
cd packages/laundry-monitor && npm install
```

两个后端 + 一个前端互相独立，分别启动即可：

```bash
# 终端 1：数据采集服务（每 60s 一次，写SQLite数据库）
cd packages/laundry-monitor && npm start

# 终端 2：只读API服务（读SQLite数据库，响应前端API调用）
cd packages/laundry-dashboard-api && npm start

# 终端 3：前端静态服务 + /api 反向代理
cd packages/laundry-dashboard-webpage && npm start
```

| 服务 | 作用 | 地址 |
|---|---|---|
| `laundry-monitor` | 采集（每 60s 一次，写两个 SQLite） | 无（后台写库） |
| `laundry-dashboard-api` | 为前端提供只读 JSON API | <http://127.0.0.1:8787>（只给前端/程序调用） |
| `laundry-dashboard-webpage` | 前端页面 + 反向代理 | <http://127.0.0.1:8788> / `http://<本机局域网 IP>:8788` |

- 停采集：看板仍可访问，只是数据停在最后一次采集；
- 停 `laundry-dashboard-api`：页面能打开，但图表/状态请求失败；
- 停 `laundry-dashboard-webpage`：API 仍在，但浏览器无页面可访问；
- 采集周期 / token / 数据保留天数在 `packages/laundry-monitor/monitor.config.json`；
- dashboard 端口/数据库路径在 `packages/laundry-dashboard-api/dashboard-api.config.json`；
- 前端端口 / API 反代地址在 `packages/laundry-dashboard-webpage/dashboard-webpage.config.json`。

### 3. 局域网 / 手机访问

前端监听 `0.0.0.0`，同一局域网内的手机/平板用电脑 IP 访问即可，例如
`http://<电脑 IP>:8788`（用系统工具查看本机局域网 IP）。API 默认只监听 `127.0.0.1`，由前端本地反代访问。

### 4. 可选：前端发布到 GitHub Pages

前端是纯静态的，可以用仓库内的 `.github/workflows/pages.yml` 发布到 GitHub Pages；页面用
`?api=https://<API 地址>` 指定公网 API。API 需要在 `laundry-dashboard-api` 的 `dashboard-api.config.json`
里配置允许 Pages 的 `corsOrigins`（例如 `["https://<user>.github.io"]`），并且是可用的 HTTPS 地址。
采集与 API 仍需一台常开机器，Pages 只负责静态页面。

## Docker 部署

仓库自带 `Dockerfile` + `compose.yaml`，一条命令启动采集 + API + 前端：

```bash
cp .env.example .env      # 填 LDR_TOKEN（网页 localStorage["ldr_student"].token）
docker compose up -d --build
# 打开 http://127.0.0.1:8788
```

- `web`：唯一对外端口（默认 `8788`，可用 `.env` 的 `WEB_PORT` 修改）；
- `api`：只在 compose 内部网络监听 `8787`，由 `web` 反向代理；
- `monitor`：写 named volume `hall-laundry-usage_laundry-data`；
- 容器配置在 `deploy/docker/*.json`，token 由 `.env` 的 `LDR_TOKEN` 注入（monitor 配置里写的是 `${LDR_TOKEN}`）；
- `TZ` 默认 `Asia/Hong_Kong`（香港时间，影响序列按天切分），可在 `.env` 修改；
- GitHub Pages 需要跨域时，改 `deploy/docker/dashboard-api.config.json` 的 `corsOrigins`。

常用命令：

```bash
docker compose logs -f monitor
docker compose down                 # 停止（保留数据）
docker compose down -v              # 连数据卷一起删除

# 在容器里重建序列库
docker compose run --rm monitor node packages/laundry-monitor/bin/cli.mjs rebuild --config /config/monitor.config.json
```

## 采集与数据

采集服务每 60s 拉一次机器状态，写入两个 SQLite：

| 文件 | 内容 |
|---|---|
| `data/laundry.sqlite` | 原始库：`poll_runs`、`machines`、`machine_snapshots`、`machine_transitions`；默认保留 30 天 |
| `data/laundry-series.sqlite` | 日级序列库（派生）：`machine_days(machine_id, day, seq BLOB 1440B)`，按本地日期切天，长期保留 |

序列库可随时从原始库重建：

```bash
cd packages/laundry-monitor
node bin/cli.mjs rebuild --config monitor.config.json
node bin/cli.mjs series  --config monitor.config.json   # 查看序列库统计
npm run stats -- --since 24h                            # 汇总：可用率/使用次数/平均时长
npm run once                                            # 只采一次（手动补采/排查）
```

序列库的分钟字节编码与使用率口径（含 on_hold 细分）详见
[monitor README](packages/laundry-monitor/README.md) 与 [dashboard README](packages/laundry-dashboard-api/README.md)。

| 需求 | 接口 |
|---|---|
| 机器状态 | `GET https://laundry.ust.hk/ldr/api/app/laundry-rooms/machines` |
| Tickets | `GET https://laundry.ust.hk/ldr/api/app/tickets`（本地过滤 `usage_status`） |

鉴权：`Authorization: Bearer <token>`；业务错误也返回 HTTP 200，检查 `meta.code`
（`4031` 缺 token / `4032` token 失效 / `4034` 参数错）。完整字段与示例见
[docs/API.md](docs/API.md) 与 [docs/openapi.json](docs/openapi.json)。

## 看板 HTTP API（内部）

| 接口 | 说明 |
|---|---|
| `GET /api/state` | 首屏 + 刷新：`{ meta, machines }` |
| `GET /api/days?machines=…&from=YYYY-MM-DD&to=YYYY-MM-DD` | 历史图表唯一数据源；`machines` 必填，日期用 `from`+`to` 或 `days=` 列表（互斥），否则 400 |
| `GET /api/meta` | 元信息 |
| `GET /api/machines` | 机器维度 + 最新状态 |

- 服务端只发原始日序列，所有聚合在浏览器端；
- JSON ≥1KB 自动 gzip；响应带 4 秒内存缓存；
- [packages/laundry-dashboard-api/README.md](packages/laundry-dashboard-api/README.md)

## 看板 webpage

浏览器端单页看板

详细行为与交互说明见 [packages/laundry-dashboard-webpage/README.md](packages/laundry-dashboard-webpage/README.md)。

## 目录结构

```
Dockerfile                    Docker 镜像（三个服务共用）
compose.yaml                  docker compose 编排
deploy/docker/                容器内配置（monitor / api / webpage）
docs/API.md                   站点 API 文档
docs/openapi.json             OpenAPI 3.0 规格
packages/laundry-monitor/     采集服务：轮询、原始库、序列库、stats/export/rebuild
packages/laundry-dashboard-api/   看板 API 服务
packages/laundry-dashboard-webpage/         独立前端：静态页面 + Chart.js + /api 反向代理
packages/shared/              跨包共享契约：序列字节编码、本地日界、洗粉映射
```

各包的详细说明、配置项和设计细节见各自的 README：

- [packages/laundry-monitor/README.md](packages/laundry-monitor/README.md)
- [packages/laundry-dashboard-webpage/README.md](packages/laundry-dashboard-webpage/README.md)

## 机器查询 CLI

```bash
cd packages/laundry-monitor
node bin/machines.mjs          # 机器实时状态 + 倒计时（表格）
node bin/machines.mjs --json   # 原始 JSON
```

tickets / rooms 查询请参考 [docs/API.md](docs/API.md) 里的 HTTP 示例。

## 测试与自检

```bash
# 采集 / 存储 / 序列 / 上游客户端
cd packages/laundry-monitor && npm test && npm run typecheck

# 只读 API（数据层 + HTTP）
cd packages/laundry-dashboard-api && npm test

# 前端（静态托管/反代 + 浏览器端聚合 + jsdom）
cd packages/laundry-dashboard-webpage && npm test

# 端到端（需要采集 + dashboard + web 都在跑）
cd packages/laundry-dashboard-api && node scripts/e2e-check.mjs
#   DASHBOARD_URL / WEB_URL 可覆盖默认的 8787 / 8788
```

## 注意事项

- 看板只读 SQLite，不会写采集数据；
- 采样粒度为 **1 分钟/台**：同一分钟多次轮询只保留最后一次；历史图表以此为最小单位；
- 原始库默认只保留 30 天（`retentionDays`），序列库长期保留；
- 站点若改字段/接口，采集会记录错误码（`poll_runs.ok=0`），看板顶栏会显示连接/加载失败；
- 站点未公布限流策略，轮询建议 ≥ 15s（当前 60s）。
