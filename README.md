# LaundryAgent — HKUST 洗衣房监控与分析

对 <https://laundry.ust.hk/ldr/app/tickets> 的逆向 + 实测，产出一套**只读**的洗衣房工具链：

- 机器状态查询库 / CLI（`packages/laundry-machines`、`laundry.mjs`）
- 常驻采集服务（`packages/laundry-monitor`）：按 60s 轮询，写原始快照库 + 日级压缩序列库
- 实时看板（`packages/laundry-dashboard`）：当前状态、使用率热力图、时间剖面、状态占比；图表聚合全部在浏览器端完成

> 只做查询：机器状态、Available Tickets、Used Tickets。不含购券/支付/预约等写操作。

## 快速开始

要求：**Node.js ≥ 22.5**（`node:sqlite`），Windows 可直接双击 `.cmd`。

### 1. 准备 token

1. 登录 <https://laundry.ust.hk/ldr/app/tickets>；
2. DevTools → Application → Local Storage → `ldr_student`，复制其中的 `token`；
3. 写入仓库根目录 `token.txt`（已被 git 忽略），或设置环境变量 `LDR_TOKEN`，
   或写进 `packages/laundry-monitor/monitor.config.json` 的 `bearer` 字段。

token 会在网页重新登录后失效；失效时看板会显示错误，重新复制即可。

### 2. 启动（Windows 一把梭）

```bat
start-all.cmd
```

会打开两个独立窗口：

| 窗口 | 服务 | 地址 |
|---|---|---|
| `laundry-monitor` | 采集（每 60s 一次，写两个 SQLite） | 无（后台写库） |
| `laundry-dashboard` | 只读看板 | <http://127.0.0.1:8787> / `http://<本机局域网 IP>:8787` |

也可以手动分别启动：

```bash
# 终端 1：采集
cd packages/laundry-monitor && npm install && npm start

# 终端 2：看板
cd packages/laundry-dashboard && npm start
```

- 停采集：看板仍可访问，只是数据停在最后一次采集；
- 停看板：采集继续，数据库继续增长；
- 采集周期 / token / 数据保留天数在 `packages/laundry-monitor/monitor.config.json`；
- 看板端口 / 监听地址 / 数据库路径在 `packages/laundry-dashboard/dashboard.config.json`。

### 3. 局域网 / 手机访问

看板当前配置为 `"host": "0.0.0.0"`，同一局域网内的手机/平板可直接访问电脑 IP，例如
`http://192.168.10.68:8787`（Windows 用 `ipconfig` 查看 IPv4 地址）。

如果其他设备打不开，通常是 **Windows 防火墙**拦了入站 8787，管理员 PowerShell 放行一次：

```powershell
netsh advfirewall firewall add rule name="Laundry Dashboard 8787" dir=in action=allow protocol=TCP localport=8787
```

> 看板没有登录鉴权（只读数据），只在可信网络里开；不用时把 `host` 改回 `127.0.0.1` 并重启。

## 看板功能

| 区块 | 说明 |
|---|---|
| Current status | Washers / Dryers 分区卡片：Free / In use / Unavailable、剩余时间、已运行时长；洗衣机在卡片最下方显示 `With detergent` / `No detergent` |
| Date range | 本地日期范围（含首尾）；选 **All dates** 时两个日期框显示数据实际覆盖范围（内部仍按全部历史处理） |
| Machines | 12 台机器 chip，可多选；新勾选的机器只补它缺的「机器·天」数据 |
| Usage heatmap | 7 天 × 1440 分钟的 Canvas 热力图，压缩到视口宽；颜色 = 可运营样本中的使用率；顶部时间轴（00–23）拖动选择时段：**桌面 30 分钟粒度、移动端 1 小时粒度，支持手指滑动**；点行标签多选星期；热力图内部点击只弹 tooltip |
| Inspection | 热力图剖面：1 分钟使用率线图（始终显示 Washers / Dryers 两条图例，横轴 `HH:mm` 时间刻度）；点分钟/拖时段后变为 Mon–Sun 柱状图（横轴固定 7 个标签），**点某根柱子会跳到该星期的线图** |
| State breakdown | 每台机器的状态占比（横向堆叠柱），图例固定 7 项、顺序为 `In use → On hold → Maintenance → Offline → Disabled → Unknown → Free`；右上角显示「星期 · 时段」筛选范围 |

- 主题：Auto / Light / Dark（Auto 跟随系统）；
- 响应式：≤720px 顶栏静态、控件竖排、图表切紧凑参数；
- 所有交互（选星期、拖时段、勾机器、切日期）都**只重算内存数据**，不经后端；
- 看板刷新仍只取**今天**已选机器的序列。

### 取数策略（只补 diff）

历史图表唯一数据源是 `GET /api/days`：每台机器每天一条 1440 字节的分钟状态序列。
浏览器按 `(machineId, day)` 缓存：

| 触发 | 请求内容 |
|---|---|
| 首次加载 | 数据覆盖范围（`/api/state` 的 `meta.span`）× 当前已选机器 |
| Date range 变化 | 只补新范围里还没缓存的机器·天（连续日期合并，已缓存的跳过） |
| 机器从不选变选 | 只补该机器在当前范围里还没缓存的天 |
| 自动 / 手动刷新 | 只重取**今天**、已选机器的序列 |

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
npm run once                                            # 只采一次（cron / 排查）
```

### 分钟字节编码

| 字节 | 含义 | 使用率 |
|---|---|---|
| `0x00` | in_use | 分子 + 分母 |
| `0x01` | available | 仅分母 |
| `0x02` | maintenance | 否 |
| `0x03` | disabled | 否 |
| `0x04` | offline | 否 |
| `0x05` | on_hold（旧编码，仅兼容） | 按 on_hold + in_use 处理 |
| `0x06` | on_hold + state=in_use | 分子 + 分母 |
| `0x07` | on_hold + state=available | 仅分母 |
| `0x08` | on_hold + state=offline | 否 |
| `0x09` | on_hold + 未知 state | 否 |
| `0xfe` | unknown（轮询成功但无法识别） | 否 |
| `0xff` | no_data（该分钟没有成功轮询） | 不计入任何统计 |

- 热力图 / Inspection 的「可运营样本」= available + in_use + on_hold(+in_use) + on_hold(+available)；
- State breakdown 的分母是全部已观测分钟（含维护/离线/停用等），并按状态单独显示。

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
start-all.cmd                 一键启动采集 + 看板两个窗口
laundry.mjs                   只读 CLI：machines / available / used（见 docs/API.md）
token.txt                     Bearer token（git 忽略）
docs/API.md                   站点 API 文档
docs/openapi.json             OpenAPI 3.0 规格
packages/laundry-machines/    机器状态查询库（ESM + TS 类型 + CLI，Node ≥18）
packages/laundry-monitor/     采集服务：轮询 + 原始快照库 + 日序列库（stats/export/rebuild）
packages/laundry-dashboard/   只读看板：零依赖 HTTP + 浏览器端聚合 + Chart.js
browser/                      逆向阶段的浏览器抓包/调试记录（不含 token）
```

各包的详细说明、配置项和设计细节见各自的 README：

- [packages/laundry-machines/README.md](packages/laundry-machines/README.md)
- [packages/laundry-monitor/README.md](packages/laundry-monitor/README.md)
- [packages/laundry-dashboard/README.md](packages/laundry-dashboard/README.md)

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
cd packages/laundry-machines && npm run test:in-process && npm run typecheck

# 采集 / 存储 / 序列
cd packages/laundry-monitor && npm run test:in-process

# 看板：数据层 + HTTP API + 聚合/取数纯函数 + jsdom 前端
cd packages/laundry-dashboard && npm run test:in-process

# 端到端（需要采集 + 看板都在跑）
cd packages/laundry-dashboard && node scripts/e2e-check.mjs
cd packages/laundry-dashboard && node scripts/probe-services.mjs
```

> 当前沙箱不允许启动子进程，Node 测试要用 `test:in-process`（单进程）；
> 普通机器上 `npm test` / `bun test` 均可。

## 注意事项

- 看板只读 SQLite，不会写采集数据；
- 采样粒度为 **1 分钟/台**：同一分钟多次轮询只保留最后一次；历史图表以此为最小单位；
- 原始库默认只保留 30 天（`retentionDays`），序列库长期保留；
- 站点若改字段/接口，采集会记录错误码（`poll_runs.ok=0`），看板顶栏会显示连接/加载失败；
- token、券的 `token` 字段、邮箱/楼层等属于敏感信息，不要提交或外传；
- 站点未公布限流策略，轮询建议 ≥ 15s（当前 60s）；
- 本文档不含写操作接口说明，请勿在未确认后果的情况下调用购券/预约接口。
