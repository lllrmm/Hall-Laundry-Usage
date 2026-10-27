# hkust-laundry-dashboard

HKUST 洗衣房监控的**只读 JSON API**：读取采集服务写入的 SQLite，给独立部署的前端提供当前状态与历史分钟序列。

- **服务端零依赖**：只用 `node:http` + `node:sqlite`，没有构建步骤；
- **只做 API**：页面/静态资源由 [`laundry-web`](../laundry-web) 独立托管，并通过反向代理调用本服务；
- **聚合在浏览器端**：本服务只发「每台机器每天 1,440 字节的分钟状态序列」，热力图/剖面/占比全部由前端计算；
- 数据库不存在或还没数据时也能启动（API 返回 `available: false`）。

## 与采集服务、前端的关系

```
laundry.ust.hk API
        │ 轮询
        ▼
laundry-monitor（写）
   ├─► data/laundry.sqlite          原始快照库（真相源）
   └─► data/laundry-series.sqlite   日序列库（1,440 字节/机器·天）
                 │
                 ▼ 只读
laundry-dashboard（本服务，JSON API，默认 :8787）
                 ▲
                 │ /api/* 反向代理
laundry-web（静态前端 + 转发，默认 :8788）◄── 浏览器
```

- 序列库是派生数据：任何时候都能用 `node bin/cli.mjs rebuild --config monitor.config.json` 从原始库重建；
- 停掉本服务：前端页面还能打开，但 API 请求失败；停掉采集：本服务仍返回最后一次采集到的数据。

## 启动

```bash
cd packages/laundry-dashboard
npm start                       # http://127.0.0.1:8787（只读 API）
# 或：node bin/serve.mjs --config dashboard.config.json
```

浏览器请访问前端服务（默认 <http://127.0.0.1:8788>），不要直接打开 8787。

## 数据源

历史日序列优先读**序列库**（`machine_days`）；序列库缺失或还没覆盖某天时，回退到**原始快照库**即时生成，因此只跑过采集、还没执行过 `laundry-monitor rebuild` 的库也能直接看。

状态字节编码（实现见 [`packages/shared/contracts.js`](../shared/contracts.js)）：

| 字节 | 含义 | 计入使用率 |
|---|---|---|
| `0x00` | in_use 占用 | 是（分子 + 分母） |
| `0x01` | available 空闲 | 是（仅分母） |
| `0x02` | maintenance 维护 | 否（State breakdown 单独展示） |
| `0x03` | disabled 停用 | 否（State breakdown 单独展示） |
| `0x04` | offline 离线 | 否（State breakdown 单独展示） |
| `0x05` | on_hold（旧编码，仅兼容） | 按 on_hold + in_use 处理 |
| `0x06` | on_hold + state=in_use | 是（分子 + 分母） |
| `0x07` | on_hold + state=available | 是（仅分母） |
| `0x08` | on_hold + state=offline | 否（归入 On hold） |
| `0x09` | on_hold + state 无法识别 | 否（归入 On hold） |
| `0xfe` | unknown | 否（State breakdown 的 Unknown） |
| `0xff` | no_data | 不计入任何统计 |

> 热力图 / Inspection 的可运营样本 = `available` + `in_use` + `on_hold(+in_use)` + `on_hold(+available)`；`in_use` 与 `on_hold(+in_use)` 计入分子，`on_hold(+available)` 只进分母。

## HTTP API

所有接口只读，`GET`/`HEAD`；JSON 响应 ≥ 1 KB 且请求头 `Accept-Encoding` 含 gzip 时自动压缩，响应带 `Vary: accept-encoding` 和 4 秒内存缓存。

| 接口 | 说明 |
|---|---|
| `GET /api/state` | 首屏 + 刷新：`{ meta, machines }`；`meta.span` 是数据覆盖的本地日期范围，`machines` 已合并最新状态 |
| `GET /api/meta` | 数据最早/最后更新时间、最近一次轮询结果、轮询次数、机器数、快照数、日期范围 `span` |
| `GET /api/machines` | 机器维度 + 最新状态合并后的 `machines` 数组 |
| `GET /api/days` | 历史图表唯一数据源：每台机器每天 1,440 字节的 base64 序列 |

`/api/days` 参数是**强约束**的，避免无参数拉全库：

- `machines` 必填（逗号分隔的机器 id，也支持重复参数）；
- 日期二选一：
  - `from=YYYY-MM-DD&to=YYYY-MM-DD`（含首尾，`from` 不能晚于 `to`）；
  - 或 `days=YYYY-MM-DD,YYYY-MM-DD,...`（最多 366 天）；
- `from`/`to` 与 `days` **不能同时使用**；缺参数、非法日期、同时使用等一律 **400**。

响应字段：`{ available, source: 'series'|'raw'|'mixed'|null, fromDay, toDay, firstDay, lastDay, count, encoding, days: [{ machineId, day, seq(base64), updatedAt }] }`。

## 配置

`dashboard.config.json`（已被 git 忽略；模板见 `dashboard.config.example.json`）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `database` | `../laundry-monitor/data/laundry.sqlite` | 原始快照库路径（必需） |
| `seriesDatabase` | `../laundry-monitor/data/laundry-series.sqlite` | 日序列库路径；缺失时回退 raw |
| `host` | `127.0.0.1`（默认值；仓库配置也是 `127.0.0.1`） | 监听地址；本服务只提供 API |
| `port` | `8787` | 监听端口 |
| `corsOrigins` | `[]` | 允许跨域访问 API 的浏览器 origin 列表；同源/反代部署留空，GitHub Pages 填 `["https://<user>.github.io"]` 或 `["*"]` |

> GitHub Pages 前端通过 `?api=https://your-api.example.com` 访问本服务，此时必须配置 `corsOrigins`（origin 不要带仓库路径）；API 还需支持 HTTPS。

## 测试

```bash
npm test                    # 数据层 + HTTP API

# 端到端（需要采集服务、本 API、laundry-web 都在跑）
node scripts/e2e-check.mjs
#   DASHBOARD_URL / WEB_URL 可覆盖默认的 8787 / 8788
```

- `test/days.test.mjs`：序列读取、raw 回退、日期校验、编码；
- `test/queries.test.mjs`：meta / machines / latest 合并 / 洗粉标注 / 空库降级；
- `test/server.test.mjs`：4 个 API、强约束参数、gzip、未知路由 404、非 API 路径提示。

## 目录结构

```
bin/serve.mjs              CLI 入口（--config / --host / --port）
src/config.js              配置读取与校验
src/queries.js             只读原始库访问（meta / machinesWithLatest）
src/days.js                日序列读取 + raw 回退（复用 shared 契约）
src/server.js              node:http JSON API
scripts/e2e-check.mjs      前后端 e2e 自检
test/                      node:test 测试
```

## License

MIT
