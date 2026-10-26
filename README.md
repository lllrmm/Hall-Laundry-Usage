# LaundryAgent — HKUST 洗衣房系统信息获取

对 <https://laundry.ust.hk/ldr/app/tickets> 的 SPA 做逆向 + 真实 token 实测，产出
**信息获取类 API 文档**与**零依赖命令行工具**。

> 只做只读查询：机器状态、Available Tickets、Used Tickets。不含购券/支付/预约等写操作。

## 文档

- **[docs/API.md](docs/API.md)** — 完整 API 文档（鉴权、错误码、三个接口、字段表、判定规则、代码示例）
- **[docs/openapi.json](docs/openapi.json)** — OpenAPI 3.0 规格，可导入 Postman / 生成客户端

## Node.js 库

**[packages/laundry-machines](packages/laundry-machines/README.md)** — 只做机器状态查询的 npm 包：
零运行时依赖、纯 ESM、自带 TypeScript 类型、CLI 和测试。

```bash
cd packages/laundry-machines
npm install              # 只有 typescript 一个 devDependency
npm run typecheck        # 校验 index.d.ts
npm run test:in-process  # 沙箱环境（不允许 spawn 子进程）；普通环境用 npm test 或 bun test
npm run smoke            # 打真实接口的冒烟测试（需要 token）
```

```js
import { createClient } from 'hkust-laundry-machines';

const client = createClient({ token: process.env.LDR_TOKEN });
const status = await client.getMachines();

status.counts;                    // { total: 12, available: 7, inUse: 4, unavailable: 1 }
status.machines.filter((m) => m.kind === 'dryer' && m.available);
status.machines.find((m) => m.inUse && m.remainingSeconds > 0)?.remainingSeconds;
```

也可以作为依赖安装（已验证可 `npm install file:./packages/laundry-machines`）：

```bash
npm install hkust-laundry-machines
bun add hkust-laundry-machines
```

## 状态监控工具

**[packages/laundry-monitor](packages/laundry-monitor/README.md)** — 按配置文件里的周期和 bearer 反复抓取机器状态，
把每次观测写入 SQLite（`poll_runs` / `machine_snapshots` / `machine_transitions`），用于长期分析；
自带 `stats` / `export` 命令，零原生依赖（`node:sqlite`）。

```bash
cd packages/laundry-monitor
npm install
cp monitor.config.example.json monitor.config.json   # 填 bearer（或 ${LDR_TOKEN}）、轮询周期
npm run once     # 采一次，验证配置
npm start        # 常驻监控（Ctrl+C 优雅退出）
npm run stats    # 24h / 7d 汇总：可用率、使用次数、平均时长
```

## 结论速览

| 需求 | 接口 | 说明 |
|---|---|---|
| 当前机器状态 | `GET /ldr/api/app/laundry-rooms/machines` | 一次返回全部机器；可用 = `status==="enabled" && state==="available"` |
| Available Tickets | `GET /ldr/api/app/tickets` | 同一接口返回全部券，本地过滤 `usage_status==="available" && expire_at>now` |
| Used Tickets | 同上 | 本地过滤 `usage_status==="used"`，按 `used_at` 倒序 |

鉴权：`Authorization: Bearer <token>`，token 存在网页 `localStorage["ldr_student"].token`。
业务错误也返回 HTTP 200，需检查 `meta.code`（`4031` 缺 token / `4032` token 失效 / `4034` 参数错）。

## 快速开始

1. 登录 <https://laundry.ust.hk/ldr/app/tickets>，DevTools → Application → Local Storage → `ldr_student`，复制 `token`；
2. 写入 `token.txt`（或设置环境变量 `LDR_TOKEN`）；
3. 运行：

```bash
node laundry.mjs machines        # 机器实时状态 + 倒计时
node laundry.mjs available       # Available Tickets
node laundry.mjs used 10         # Used Tickets（最近 10 张）
node laundry.mjs machines --json # 原始 JSON
```

Node 18+ 即可，无需 `npm install`。

## 今晚运行（两个服务，互相独立）

轮询服务与看板服务是两个进程，**可以分别启停**，只通过 SQLite 文件耦合：

```bash
# 方式一：一键打开两个窗口（Windows）
start-all.cmd
#   采集窗口关闭 = 停止采集；看板窗口关闭 = 停止看板，互不影响

# 方式二：手动分别启动
# 终端 1：采集（每 30 秒一次，写入 data/laundry.sqlite）
cd packages/laundry-monitor && npm start
#   或双击 packages/laundry-monitor/run.cmd

# 终端 2：看板（只读数据库，http://127.0.0.1:8787）
cd packages/laundry-dashboard && npm start
#   或双击 packages/laundry-dashboard/run.cmd
```

- 停掉看板：采集继续（数据库照常增长）；重新启动看板即可看到最新数据。
- 停掉采集：看板仍可访问，只显示最后一次采集到的数据（页面上会显示"数据更新"时间）。
- 看板端口/数据库路径在 `packages/laundry-dashboard/dashboard.config.json`；采集周期/bearer 在 `packages/laundry-monitor/monitor.config.json`（含 token，已被 git 忽略）。

## 测试与自检

```bash
# 库
cd packages/laundry-machines && npm run test:in-process && npm run typecheck

# 采集 + 存储
cd packages/laundry-monitor && npm run test:in-process

# 看板（数据层 + HTTP API）
cd packages/laundry-dashboard && npm run test:in-process

# 端到端（需要两个服务都起来）
cd packages/laundry-dashboard && node scripts/e2e-check.mjs
cd packages/laundry-dashboard && node scripts/probe-services.mjs   # 探针：数据库尾部 + 看板可达性
```

> 本环境不允许启动子进程，所以 `npm test`（Node 测试运行器的默认多进程模式）会被 `spawn EPERM` 拦住，
> 统一用 `npm run test:in-process`；普通机器上直接 `npm test` 或 `bun test` 即可。

## 目录结构

```
start-all.cmd          一键启动采集 + 看板两个窗口（也可分别用各自的 run.cmd）
laundry.mjs            只读 API 客户端 + CLI（可直接 import 复用）
packages/laundry-machines/  npm 包：机器状态查询库（ESM + TS 类型 + CLI + 测试）
packages/laundry-monitor/   采集服务：按配置周期轮询并写入 SQLite（stats/export/run）
packages/laundry-dashboard/ 看板服务：只读 SQLite，图表 + 当前状态（零依赖 HTTP）
token.txt              Bearer token（勿提交到 git）
docs/API.md            API 文档
docs/openapi.json      OpenAPI 3.0 规格
scripts/               逆向探测脚本（内嵌本机 token，仅本地保留、不入库）
browser/               真实浏览器（Edge headless + CDP）抓包尝试的记录
```

## 安全提示

- `token.txt`、券的 `token` 字段、响应中的邮箱/楼层都属于敏感信息，不要提交或外传；
- 站点未公布限流策略，轮询建议 ≥ 15 s（当前配置 30 s）；
- 本文档不含写操作接口的用法，请勿在未确认后果的情况下调用购券/预约接口。
