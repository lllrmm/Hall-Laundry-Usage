# hkust-laundry-machines

HKUST 洗衣房**机器状态**查询库（只读）。零依赖，ESM，自带 TypeScript 类型、CLI 与测试。

> 数据来自 `https://laundry.ust.hk/ldr/api/app/laundry-rooms/machines`。
> 接口详情见仓库里的 [docs/API.md](../../docs/API.md)。

## 安装

```bash
npm install hkust-laundry-machines
```

本地开发（当前仓库内）：

```bash
cd packages/laundry-machines
npm install          # 只有 typescript 一个 devDependency
npm test             # 运行全部测试
npm run typecheck    # 校验 index.d.ts 与用法
npm run smoke        # 打真实接口的冒烟测试（需要 token）
```

## 获取 token

登录 <https://laundry.ust.hk/ldr/app/> 后，DevTools → Application → Local Storage → `ldr_student`，
复制其中的 `token`。库按以下顺序查找 token：

1. `createClient({ token })` 显式传入
2. 环境变量 `LDR_TOKEN`
3. 当前目录 `./token.txt`

token 失效时接口返回 `meta.code = 4032`，库会抛 `LaundryAuthError`，重新取 token 即可。

## 快速开始

```js
import { createClient } from 'hkust-laundry-machines';

const client = createClient(); // 读 LDR_TOKEN 或 ./token.txt

const status = await client.getMachines();

console.log(status.counts);        // { total: 12, available: 7, inUse: 4, unavailable: 1 }
console.log(status.byKind.dryer);  // { total: 6, available: 4, inUse: 2 }

// 有哪些空闲烘干机？
const freeDryers = status.machines.filter((m) => m.kind === 'dryer' && m.available);
console.log(freeDryers.map((m) => m.name));

// 哪台快洗完了？
const soonest = status.machines
  .filter((m) => m.inUse && m.remainingSeconds > 0)
  .sort((a, b) => a.remainingSeconds - b.remainingSeconds)[0];
if (soonest) console.log(`${soonest.name} 还剩 ${soonest.remainingSeconds} 秒`);
```

## API

### `createClient(options?)`

| 选项 | 默认值 | 说明 |
|---|---|---|
| `token` | `LDR_TOKEN` / `./token.txt` | Bearer token |
| `baseUrl` | `https://laundry.ust.hk/ldr/api` | API 基址 |
| `fetch` | `globalThis.fetch` | 自定义实现（测试/代理） |
| `timeoutMs` | `15000` | 单次请求超时 |
| `userAgent` | `hkust-laundry-machines/0.1.0` | User-Agent |
| `tokenFile` | `token.txt` | token 文件名 |

没有 token 时构造函数直接抛 `LaundryError`（`code: 4031`）。

### `client.getMachines(options?)`

返回归一化后的状态对象。`options.signal` 可取消请求，`options.now` 可指定剩余时间的计算基准（测试用）。

```ts
{
  fetchedAt: Date,
  rooms: [{ name: string, machines: Machine[] }],
  machines: Machine[],               // rooms 拍平，方便 filter/sort
  counts: { total, available, inUse, unavailable },
  byKind: { washer: {...}, dryer: {...} },
  meta: { code: 200, message: 'Success' }
}
```

### `client.getMachinesRaw(options?)`

不做归一化，直接返回服务端原始 JSON（需要未包装字段时用）。

### `Machine` 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 机器 ID |
| `name` | `string` | 显示名，如 `UG4 Dryer (52)` |
| `number` | `number \| null` | 从名字解析的编号（52） |
| `kind` | `'washer' \| 'dryer'` | 机型 |
| `serviceTypeId` / `serviceValue` / `serviceLabel` | `string` | 机型详情（`dryer_machine` 等） |
| `roomName` | `string` | 洗衣房名 |
| `status` | `string` | `enabled` / `disabled` / `on_hold` / `maintenance` |
| `state` | `string` | `available` / `in_use` / `offline` |
| `available` | `boolean` | **是否可用** = `status === 'enabled' && state === 'available'` |
| `inUse` | `boolean` | 是否正在使用 |
| `unavailableReason` | `string \| null` | 不可用原因（`maintenance` / `in_use` / …） |
| `startedAt` | `Date \| null` | 本次开始时间（仅 `in_use` 有） |
| `plannedMinutes` | `number \| null` | 预计时长（**仅烘干机有**） |
| `endsAt` | `Date \| null` | 预计结束时间（仅烘干机可算） |
| `remainingSeconds` | `number \| null` | 剩余秒数（仅烘干机；负数表示已到点未取衣） |
| `elapsedSeconds` | `number \| null` | 已运行秒数（所有在用机器） |
| `finishedButNotEmptied` | `boolean` | 已到点但衣物未取 |
| `raw` | `object` | 服务端原始对象 |

### 辅助函数

```js
import { isAvailable, formatRemaining, parseMachineNumber, normalizeResponse } from 'hkust-laundry-machines';

isAvailable({ status: 'enabled', state: 'available' }); // true
formatRemaining(3900);                                  // '1h05m'
parseMachineNumber('UG4 Dryer (52)');                   // 52
```

### 错误

所有错误继承 `LaundryError`，字段 `code` / `endpoint` / `status` / `data`：

| `code` | 含义 |
|---|---|
| `4031` / `4032` | token 缺失 / 失效（抛 `LaundryAuthError`） |
| `4034` | 参数校验失败（本接口不传参，基本不会遇到） |
| `TIMEOUT` | 请求超时 |
| `NETWORK_ERROR` | 网络层失败 |
| `ABORTED` | 被外部 `signal` 取消 |
| `INVALID_RESPONSE` | 响应不是 JSON |

```js
import { LaundryAuthError } from 'hkust-laundry-machines';

try {
  await client.getMachines();
} catch (error) {
  if (error instanceof LaundryAuthError) {
    console.error('token 过期了，重新登录取一个');
  } else {
    throw error;
  }
}
```

## CLI

```bash
npx laundry-machines              # 表格
npx laundry-machines --json       # JSON（去掉 raw）
npx laundry-machines --token <t>  # 临时指定 token
```

## 注意

- 接口**不返回**"是否空闲"和"剩余时间"，都由本库派生；
- **洗衣机没有预计时长**（`job` 里没有 `number_of_minutes`），只能算已运行时间；
- `remainingSeconds` 可能为负：机器已到预计结束时间但衣物没取，仍报 `in_use`；
- 维护中的机器 `state` 也是 `available`，所以必须同时判断 `status` 和 `state`；
- 建议轮询间隔 ≥ 15 秒。

## License

MIT
