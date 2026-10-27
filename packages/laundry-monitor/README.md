# hkust-laundry-monitor

按固定周期抓取 HKUST 洗衣房机器状态，把**每一次观测**写进 SQLite，供之后做占用率、使用时长、空闲时段等分析。

写入两个库：**原始库**（每次轮询的完整记录，用于精确分析与排查）和**序列库**（每台机器每天 1,440 字节的分钟状态，用于快速历史规律查询）。原始库是真相源，序列库随时可由它重建。

依赖 [`hkust-laundry-machines`](../laundry-machines) 做接口调用与归一化；存储用 Node 内置的 `node:sqlite`（Node ≥ 22.5，**零原生依赖**）。

## 工作方式

```
monitor.config.json
        │  bearer / 轮询周期 / 数据库路径
        ▼
   startMonitor ──► 每 N 秒调一次 GET /app/laundry-rooms/machines
        │                │
        │                ├─ 成功：写 poll_runs + machines + machine_snapshots + machine_transitions
        │                │        └─ 同时更新序列库（machine_days / machine_latest）
        │                └─ 失败：写 poll_runs(ok=0, error_code=...)，不中断循环
        ▼
   data/laundry.sqlite（WAL）──► stats / export / 任意 SQL 分析
   data/laundry-series.sqlite ──► 看板只读：热力图 / 剖面 / 状态占比
```

## 快速开始

```bash
cd packages/laundry-monitor
npm install                 # 只装本地依赖 hkust-laundry-machines
cp monitor.config.example.json monitor.config.json
# 编辑 monitor.config.json，把 bearer 换成你的 token
npm run once                # 先采一次，确认能通
npm start                   # 常驻轮询（Ctrl+C 优雅退出）
npm run stats               # 看汇总
```

token 获取：登录 <https://laundry.ust.hk/ldr/app/> → DevTools → Application → Local Storage →
`ldr_student` → 复制 `token`。

> 也可以让配置文件读环境变量：`"bearer": "${LDR_TOKEN}"`，或写 `"bearerEnv": "LDR_TOKEN"`。
> 两者都没有时会回退到环境变量 `LDR_TOKEN`。

## 配置

`monitor.config.json`（JSON，字符串支持 `${ENV_VAR}` 展开）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `bearer` | *必填* | Bearer token；可写 `${LDR_TOKEN}` 引用环境变量 |
| `bearerEnv` | — | 环境变量名，`bearer` 为空时使用 |
| `baseUrl` | `https://laundry.ust.hk/ldr/api` | API 基址 |
| `pollIntervalSeconds` | `60` | 轮询间隔，最小 5，建议 ≥ 15（站点未公开限流） |
| `timeoutMs` | `15000` | 单次请求超时 |
| `database` | `./data/laundry.sqlite` | 原始库路径；相对路径以**配置文件所在目录**为基准 |
| `seriesDatabase` | `./data/laundry-series.sqlite` | 序列库路径（日级压缩派生层） |
| `retentionDays` | `30` | 保留天数；`null` 表示不清理 |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error` / `silent` |

## 命令

```bash
laundry-monitor run    --config monitor.config.json     # 常驻采集
laundry-monitor once   --config monitor.config.json     # 单次采集（cron / systemd timer）
laundry-monitor stats  --config monitor.config.json [--since 24h] [--json]
laundry-monitor export --config monitor.config.json [--since 7d] [--format csv|jsonl] [--out file]
laundry-monitor series --config monitor.config.json [--json]   # 序列库统计
laundry-monitor rebuild --config monitor.config.json [--since 30d]  # 从原始库重建序列库
```

`--since` 支持 `30m` / `24h` / `7d` 或 ISO 时间。`stats`、`export`、`series`、`rebuild` 不需要 token（可以分析历史库）。

## 序列库（分钟字节）

每台机器每天一行 `machine_days(machine_id, day, seq BLOB)`，`seq` 固定 **1,440 字节**，索引 = 本地时间第几分钟（编码实现见 `packages/shared/contracts.js`，monitor / dashboard 共用）：

| byte | 含义 |
|---|---|
| `0x00` | in_use（占用） |
| `0x01` | available（空闲） |
| `0x02` | maintenance（维护） |
| `0x03` | disabled（停用） |
| `0x04` | offline（离线） |
| `0x05` | on_hold（旧编码，仅解码兼容，不再写入） |
| `0x06` | on_hold + underlying state=in_use |
| `0x07` | on_hold + underlying state=available |
| `0x08` | on_hold + underlying state=offline |
| `0x09` | on_hold + underlying state 无法识别 |
| `0xfe` | unknown（状态无法识别） |
| `0xff` | no_data（该分钟没有成功轮询） |

- 存储量：12 台机器 ≈ **17 KB/天、6 MB/年**（原始库约 3.4 MB/天）；
- 同一分钟多次轮询以**最后一条**为准；跨天按本地日期切行；
- 同样保存 `machine_latest`（最新状态/剩余时间，CLI 展示用）；
- 序列库写失败只告警、不影响原始库；
- 误删/重建：`laundry-monitor rebuild` 从原始库回填（可重复执行，幂等）。

### 定时执行

不想常驻时，可以用系统自带的计划任务（cron / systemd / 任务计划程序等）定时执行一次采集：

```bash
cd packages/laundry-monitor
node bin/cli.mjs once --config monitor.config.json
```

## 数据库结构

文件默认在 `data/laundry.sqlite`（WAL 模式）。

| 表 | 一行代表 | 主要字段 |
|---|---|---|
| `poll_runs` | 一次轮询 | `started_at`、`duration_ms`、`ok`、`error_code`、`machine_count`、`available_count`、`in_use_count`、`unavailable_count` |
| `machines` | 一台机器（维度表） | `id`、`name`、`kind`(washer/dryer)、`service_type_id`、`room_name`、`first_seen_at`、`last_seen_at` |
| `machine_snapshots` | 某次轮询中某台机器的状态 | `run_id`、`machine_id`、`observed_at`、`status`、`state`、`available`、`planned_minutes`、`remaining_seconds`、`elapsed_seconds`、`finished_but_not_emptied` |
| `machine_transitions` | 一次状态跳变 | `machine_id`、`observed_at`、`from_state`/`to_state`、`from_status`/`to_status` |
| `machine_last_state` | 上一轮状态缓存 | 用于判断跳变，避免全表扫描 |

索引：`machine_snapshots(machine_id, observed_at)`、`machine_snapshots(observed_at)`、`poll_runs(started_at)`、`machine_transitions(machine_id, observed_at)`。

时间统一存 **ISO 8601 UTC 字符串**（`2026-10-27T02:00:00.000Z`），可直接按字典序范围查询。

> `machine_transitions` 里 `from_state = NULL` 的那条代表"首次见到这台机器"的初始状态记录，
> 统计使用次数时会排除，不会虚增。

## 分析示例（sqlite3 / DB Browser / Python）

```sql
-- 每台机器最近 24 小时的可用率
SELECT m.name, m.kind,
       ROUND(AVG(s.available) * 100, 1) AS available_pct,
       COUNT(*) AS samples
FROM machine_snapshots s
JOIN machines m ON m.id = s.machine_id
WHERE s.observed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
GROUP BY m.id
ORDER BY available_pct DESC;

-- 烘干机一周内按小时统计的"空闲概率"（找最佳洗衣时段）
SELECT strftime('%H', s.observed_at) AS hour_utc,
       ROUND(AVG(s.available) * 100, 1) AS free_pct,
       COUNT(*) AS samples
FROM machine_snapshots s
JOIN machines m ON m.id = s.machine_id
WHERE m.kind = 'dryer'
  AND s.observed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 day')
GROUP BY hour_utc
ORDER BY free_pct DESC;

-- 每次完整使用周期（进入 in_use → 离开 in_use）的时长
SELECT t1.machine_id,
       t1.observed_at AS started_at,
       t2.observed_at AS ended_at,
       ROUND((julianday(t2.observed_at) - julianday(t1.observed_at)) * 86400) AS seconds
FROM machine_transitions t1
JOIN machine_transitions t2
  ON t2.machine_id = t1.machine_id
 AND t2.from_state = 'in_use'
 AND t2.to_state != 'in_use'
 AND t2.observed_at > t1.observed_at
WHERE t1.to_state = 'in_use'
ORDER BY t1.observed_at DESC
LIMIT 20;
```

> 注意：SQLite 的 `now` 是 UTC；想看本地时间用 `datetime(observed_at, 'localtime')`。

## 库用法（不走 CLI）

```js
import { createClient } from 'hkust-laundry-machines';
import {
  createLogger,
  loadConfig,
  openDatabase,
  pollOnce,
  startMonitor,
} from 'hkust-laundry-monitor';

const config = loadConfig('./monitor.config.json');
const db = openDatabase(config.databasePath);
const client = createClient({ token: config.bearer, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs });
const logger = createLogger({ level: config.logLevel });

await pollOnce({ client, db, logger });              // 采一次

const controller = new AbortController();            // 常驻
process.on('SIGINT', () => controller.abort());
await startMonitor({ client, db, config, logger, signal: controller.signal });

db.close();
```

## 可靠性设计

- **失败也记录**：`poll_runs.ok=0` 保留错误码（`4032` token 失效、`TIMEOUT`、`NETWORK_ERROR`…），便于统计抓取成功率；
- **写入是事务**：一次轮询的 run + 快照 + 跳变在同一个事务里，不会写一半；
- **失败不影响状态判断**：失败轮询不更新 `machine_last_state`，下一轮仍以最后一次成功状态为基准；
- **优雅退出**：`SIGINT`/`SIGTERM` 会等当前采集结束再关闭数据库；
- **历史清理**：按 `retentionDays` 定期删除旧快照/跳变，机器维度表保留；
- **轮询不堆积**：上一轮结束后才开始计时，请求慢时自动拉长实际间隔。

## 注意

- token 过期后 `poll_runs` 会持续记录 `4032` 失败，重新登录网页换 `token` 后即可恢复（历史数据不受影响）；
- 长期运行建议 `pollIntervalSeconds >= 60`，一个月的快照量约 12 台 × 1440 次/天 × 30 ≈ 52 万行，SQLite 完全够用。

## License

MIT
