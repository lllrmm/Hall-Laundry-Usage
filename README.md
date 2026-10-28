# Hall Laundry Usage

产出一套**只读**的洗衣房工具链：

- 数据采集服务（`packages/laundry-monitor`）：按 60s 轮询，写原始快照库 + 日级压缩序列库
- 只读API服务（`packages/laundry-dashboard-api`）：当前状态与历史分钟序列，只发数据不渲染页面
- 纯静态前端（`packages/laundry-dashboard-webpage`）：HTML/CSS/JS，部署到 GitHub Pages 或任意静态托管

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
# 编辑 monitor.config.json，把 bearer 换成 token；或在启动前设置 LDR_TOKEN 环境变量
# dashboard-api 的 corsOrigins 模板已填 Pages origin，按需修改
cd packages/laundry-monitor && npm install
```

两个服务互相独立，分别启动即可；前端是纯静态文件，不需要启动（见第 3 节）：

```bash
# 终端 1：数据采集服务（每 60s 一次，写SQLite数据库）
cd packages/laundry-monitor && npm start

# 终端 2：只读API服务（读SQLite数据库，响应前端API调用）
cd packages/laundry-dashboard-api && npm start
```

| 服务 | 作用 | 地址 |
|---|---|---|
| `laundry-monitor` | 采集（每 60s 一次，写两个 SQLite） | 无（后台写库） |
| `laundry-dashboard-api` | 为静态前端提供只读 JSON API | <http://127.0.0.1:8787>（给浏览器/程序调用） |

- 停采集：看板仍可访问，只是数据停在最后一次采集；
- 停 `laundry-dashboard-api`：页面能打开，但图表/状态请求失败；
- 采集周期 / token / 数据保留天数在 `packages/laundry-monitor/monitor.config.json`；
- dashboard 端口/数据库路径/CORS 在 `packages/laundry-dashboard-api/dashboard-api.config.json`；
- 前端没有运行时配置：API 地址通过 URL 参数 `?api=` 或 `public/config.js` 指定。

### 3. 前端部署

前端是**纯静态文件**（`packages/laundry-dashboard-webpage/public`）：

1. 把整个 `public/` 目录部署到 GitHub Pages、Nginx、CDN 或任意静态托管；
2. 访问时用 `?api=` 指向 API origin，例如：
   `https://<host>/?api=https%3A%2F%2Fyour-api.example.com`
   （只写 origin，不要带 `/api` 后缀）；
3. API 必须是 **HTTPS**，并在 `dashboard-api.config.json` 的 `corsOrigins` 里允许前端 origin
   （模板默认是 `["https://lllrmm.github.io"]`，origin 不要带仓库路径）。

仓库自带 `.github/workflows/pages.yml`，推 `main` 会自动把 `public/` 发布到 GitHub Pages。
采集与 API 仍需一台常开机器，Pages 只负责静态页面。

### 4. 推荐：用 Cloudflare Tunnel 暴露 API

GitHub Pages 是 HTTPS，浏览器不允许它请求 HTTP API；如果不想开放公网端口/自己签证书，推荐用 **Cloudflare Tunnel**：

```bash
# 快速试用：得到一个临时 HTTPS 地址
cloudflared tunnel --url http://127.0.0.1:8787

# 长期使用：创建 named tunnel，把固定域名 (如 laundry-api.example.com)
# 指向 http://127.0.0.1:8787
```

然后把拿到的 HTTPS 地址填到 Pages 的 `?api=`：

```
https://lllrmm.github.io/Hall-Laundry-Usage/?api=https%3A%2F%2Flaundry-api.example.com
```

`corsOrigins` 仍然只填 Pages 的 origin（`https://lllrmm.github.io`）；Tunnel 只负责 HTTPS 入口。
quick tunnel 每次重启域名会变，长期用建议创建 named tunnel 绑定固定域名。

## Docker 部署

仓库自带 `Dockerfile` + `compose.yaml`，一条命令启动采集 + API（前端是纯静态文件，不在镜像里）：

```bash
cp .env.example .env      # 填 LDR_TOKEN（网页 localStorage["ldr_student"].token）
docker compose up -d --build
# API: http://127.0.0.1:8787
```

- `api`：唯一对外端口（默认 `8787`，可用 `.env` 的 `API_PORT` 修改），给静态前端跨域调用；
- `monitor`：写 named volume `hall-laundry-usage_laundry-data`；
- 容器配置在 `deploy/docker/*.json`，token 由 `.env` 的 `LDR_TOKEN` 注入（monitor 配置里写的是 `${LDR_TOKEN}`）；
- `TZ` 默认 `Asia/Hong_Kong`（香港时间，影响序列按天切分），可在 `.env` 修改；
- `corsOrigins` 默认已允许 `https://lllrmm.github.io`（见 `deploy/docker/dashboard-api.config.json`）；
- compose 暴露的是 HTTP；如果给 HTTPS 的 GitHub Pages 用，推荐在外层加 **Cloudflare Tunnel**（见第 4 节），把 `http://127.0.0.1:8787` 映射成 HTTPS 域名。

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

纯静态浏览器端单页看板（HTML/CSS/JS + Chart.js）；把 `public/` 部署到静态托管即可。

详细行为与交互说明见 [packages/laundry-dashboard-webpage/README.md](packages/laundry-dashboard-webpage/README.md)。

## 目录结构

```
Dockerfile                    Docker 镜像（采集 + API）
compose.yaml                  docker compose 编排
deploy/docker/                容器内配置（monitor / api）
docs/API.md                   站点 API 文档
docs/openapi.json             OpenAPI 3.0 规格
packages/laundry-monitor/     采集服务：轮询、原始库、序列库、stats/export/rebuild
packages/laundry-dashboard-api/   看板 API 服务
packages/laundry-dashboard-webpage/  纯静态前端：HTML/CSS/JS + Chart.js（GitHub Pages/静态托管）
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

# 前端（纯静态资源 + 浏览器端聚合 + jsdom）
cd packages/laundry-dashboard-webpage && npm test

# 端到端（只测 API，需要采集 + API 在跑）
cd packages/laundry-dashboard-api && node scripts/e2e-check.mjs
#   DASHBOARD_URL 可覆盖默认的 http://127.0.0.1:8787
```

## 注意事项

- 看板只读 SQLite，不会写采集数据；
- 采样粒度为 **1 分钟/台**：同一分钟多次轮询只保留最后一次；历史图表以此为最小单位；
- 原始库默认只保留 30 天（`retentionDays`），序列库长期保留；
- 站点若改字段/接口，采集会记录错误码（`poll_runs.ok=0`），看板顶栏会显示连接/加载失败；
- 站点未公布限流策略，轮询建议 ≥ 15s（当前 60s）。
