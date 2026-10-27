# HKUST Laundry System 学生端 API 文档（只读信息获取）

> 适用范围：本文档只覆盖**信息获取**相关的只读接口，共三类需求：
> 1. **当前机器状态**（哪台空闲、哪台在用、还剩多久）
> 2. **Available Tickets**（可用/未用过且未过期的券）
> 3. **Used Tickets**（已使用过的券）
>
> 采集方式：对 `https://laundry.ust.hk/ldr/app/` 的 React SPA 打包文件做静态逆向（`main.*.chunk.js`），
> 再用真实 Bearer token 对生产接口逐条实测验证（HTTP 记录见附录 D）。
> 采集时间：2026-10-27（Asia/Shanghai）。站点未公开文档，字段语义均以实测为准。

---

## 目录

- [1. 基础信息](#1-基础信息)
- [2. 鉴权](#2-鉴权)
- [3. 通用响应格式与错误码](#3-通用响应格式与错误码)
- [4. 接口一：获取当前机器状态](#4-接口一获取当前机器状态)
- [5. 接口二/三：Available Tickets 与 Used Tickets](#5-接口二三available-tickets-与-used-tickets)
- [6. 组合用法与轮询建议](#6-组合用法与轮询建议)
- [7. 代码示例](#7-代码示例)
- [8. 附录](#8-附录)

---

## 1. 基础信息

| 项目 | 值 |
|---|---|
| 站点（前端 SPA） | `https://laundry.ust.hk/ldr/app/` |
| **API Base URL** | `https://laundry.ust.hk/ldr/api` |
| 协议 | HTTPS（TLS 1.2+） |
| 鉴权方式 | `Authorization: Bearer <token>` |
| 请求体格式 | `application/json` |
| 响应体格式 | `application/json; charset=utf-8` |
| 服务端 | `nginx/1.18.0 (Ubuntu)` → Node.js/Express |
| HTTP 状态码 | **恒为 200**，业务结果看响应体 `meta.code` |
| 跨域 | **已启用 CORS**：预检返回 204，回显 `Origin`，允许 `authorization` 头 |
| 其他环境 | UAT `https://laundry-uat.ust.hk/ldr/api`、测试 `https://ust-testing.beautitag.com/ldr/api`（仅从 bundle 中记录，未使用） |

> CORS 实测结论：浏览器页面（任意 origin，如 `http://localhost:3000`）可以直接 `fetch` 这些接口，
> 但仍然需要带 Bearer token，并且 `Authorization` 头会触发预检（已通过）。

---

## 2. 鉴权

### 2.1 Token 是什么

前端登录成功后把整份登录态写入 `localStorage`，键名 **`ldr_student`**：

```json
{
  "token": "<YOUR_TOKEN>",
  "user": { "_id": "…", "email": "…", "hall_floors": [ … ] },
  "last_login": "2026-10-26T17:47:10.024Z"
}
```

之后所有 API 调用都附加：

```http
Authorization: Bearer <localStorage["ldr_student"].token>
```

> Token 不是 JWT（无 `.` 分段，20 字符左右），是服务端下发的不透明串；**不能**在客户端解析出过期时间。

### 2.2 如何拿到 token（三种方式）

| 方式 | 说明 |
|---|---|
| **A. 浏览器 localStorage（最省事，推荐）** | 登录 `https://laundry.ust.hk/ldr/app/` 后，DevTools → Application → Local Storage → `ldr_student` → 复制 `token` 字段。 |
| **B. HKUST CAS 单点登录（网页实际走的流程）** | `GET /app/auth/cas/url` → 拿到 `{url:"https://cas.ust.hk/cas/login?service=…"}` → 浏览器跳 CAS 登录 → 回调 `https://laundry.ust.hk/ldr/app/callback/cas?ticket=ST-…&path=` → 前端 `POST /app/auth/cas/auth` `{ticket, path}` → 返回 `data.auth.token`。 |
| **C. 账号密码登录（本地账号，非 HKUST 统一认证）** | `POST /app/auth/login` `{email, password}` → `data.auth.token`。 |

CAS 登录含学校的统一认证/二次验证，不适合脚本自动完成；**日常脚本请用方式 A 手工取 token**。

### 2.3 有效期与失效处理

- 前端以 `last_login` + `login_timeout = 86400s（24h）` 判断登录态，超过则跳登录页；
- 服务端 TTL 未公开，实测 token 在采集时点有效；
- 失效时接口仍返回 **HTTP 200**，`meta.code = 4032`，`message = "Invalid Bearer Token."`；
- 缺失 `Authorization` 头时 `meta.code = 4031`，`message = "Missing Bearer Token."`；
- 建议：脚本捕获 4031/4032 时提示"重新登录网页取新 token"，不要重试轰炸。

---

## 3. 通用响应格式与错误码

### 3.1 成功

```json
{
  "meta": { "code": 200, "message": "Success" },
  "data": { }
}
```

`data` 的具体结构随接口不同，见下文。

### 3.2 业务错误码（HTTP 一律 200）

| `meta.code` | `meta.message` | 含义 / 处理 |
|---|---|---|
| `200` | `Success` | 成功 |
| `4031` | `Missing Bearer Token.` | 没带 `Authorization` 头 |
| `4032` | `Invalid Bearer Token.` | token 错误或过期 → 重新登录取 token |
| `4033` | （业务信息） | 账号未授权访问该 laundry 应用；前端会跳回首页 |
| `4034` | `Schema validation error` | 参数校验失败；`data.errors[]` 里有 JSON-Schema 细节（`dataPath`、`missingProperty` 等） |
| `404` | `Route does not exist` | 路径写错（注意 base 是 `/ldr/api`，接口以 `/app/` 开头） |

`4034` 示例：

```json
{
  "meta": { "code": 4034, "message": "Schema validation error" },
  "data": { "errors": [ {
    "keyword": "required",
    "dataPath": ".query",
    "schemaPath": "#/properties/query/required",
    "params": { "missingProperty": "service_type_id" },
    "message": "should have required property 'service_type_id'"
  } ] }
}
```

### 3.3 时间与数据类型约定

- 所有时间是 **ISO 8601 UTC** 字符串（如 `"2026-10-16T15:59:59.999Z"`），展示时需转 `Asia/Shanghai`；
- 金额字段（`price`、`bulk_purchase_price`）单位是 **HKD 整数**；
- 所有 `_id` 是 MongoDB ObjectId 的 24 位十六进制字符串。

---

## 4. 接口一：获取当前机器状态

一次请求返回该账号所属洗衣房的全部机器及其实时状态，是"哪台机器空着"的唯一数据源。

### 4.1 请求

```http
GET /ldr/api/app/laundry-rooms/machines
Authorization: Bearer <TOKEN>
Accept: application/json
```

- **无任何查询参数**（实测传参不影响结果，接口固定返回当前用户洗衣房全部机器）；
- 单次响应约 5–6 KB，实测延迟约 250 ms。

### 4.2 响应

```json
{
  "meta": { "code": 200, "message": "Success" },
  "data": {
    "laundry_room_machines": [
      {
        "laundry_room_name": "UG Hall IV",
        "machines": [
          { "_id": "64d03c75e24330a9fc5692ae", "name": "UG4 Dryer (51)", "status": "enabled",  "state": "available",
            "service_type": { "_id": "6482c1c23d71ec4ea60f9752", "machine_type": "dryer", "value": "dryer_machine", "label": "Dry Machine" },
            "laundry_room_name": "UG Hall IV" },
          { "_id": "64d03c8be24330a9fc5699d1", "name": "UG4 Dryer (52)", "status": "enabled", "state": "in_use",
            "job": { "created_at": "2026-10-26T16:41:05.666Z", "ticket": { "number_of_minutes": 45 } },
            "service_type": { "_id": "6482c1c23d71ec4ea60f9752", "machine_type": "dryer", "value": "dryer_machine", "label": "Dry Machine" },
            "laundry_room_name": "UG Hall IV" },
          { "_id": "64d03c0ae24330a9fc566886", "name": "UG4 Washer (01)", "status": "enabled", "state": "in_use",
            "job": { "created_at": "2026-10-26T17:25:02.047Z" },
            "service_type": { "_id": "6482c1b82fdd325916161e40", "machine_type": "washer", "value": "washing_machine_without_powder", "label": "Washing Machine (Without Washing Powder)" },
            "laundry_room_name": "UG Hall IV" },
          { "_id": "64d03c4be24330a9fc56847d", "name": "UG4 Washer (05)", "status": "maintenance", "state": "available",
            "service_type": { "_id": "6482c1b82fdd325916161e40", "machine_type": "washer", "value": "washing_machine_without_powder", "label": "Washing Machine (Without Washing Powder)" },
            "laundry_room_name": "UG Hall IV" }
        ]
      }
    ]
  }
}
```

> 省略了 `created_by / updated_by / created_at / updated_at` 等审计字段；真实响应里每个 `service_type` 都带这些字段。

### 4.3 字段说明

**顶层**

| 字段 | 类型 | 说明 |
|---|---|---|
| `data.laundry_room_machines` | array | 洗衣房分组列表；当前账号一般只有 1 个元素 |
| `laundry_room_machines[].laundry_room_name` | string | 洗衣房名称，如 `"UG Hall IV"` |
| `laundry_room_machines[].machines` | array | 该洗衣房的机器数组 |

**machine 对象**

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 机器 ID（24 hex） |
| `name` | string | 显示名，**编号就在里面**，如 `"UG4 Dryer (52)"`、`"UG4 Washer (01)"` |
| `status` | enum | 设备状态：`enabled` / `disabled` / `on_hold` / `maintenance` |
| `state` | enum | 运行状态：`available` / `in_use` / `offline`（`reserved` 在枚举里存在，未实测到） |
| `service_type` | object | 机型：`machine_type` 为 `washer` 或 `dryer`；`value` 区分带/不带洗衣粉等 |
| `laundry_room_name` | string | 冗余字段，同上层 |
| `job` | object \| 缺失 | **仅 `state === "in_use"` 时出现**，见下 |

**job 对象（仅 in_use）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `job.created_at` | string(ISO) | 本次使用开始时间 |
| `job.ticket.number_of_minutes` | number \| **缺失** | 预计时长。**只有烘干机（dryer）有；洗衣机没有这个字段** |

**service_type 对象**（机型，12/12 台都带）

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 机型 ID，同 `service_type_id`（可作 `/app/machines` 的查询参数） |
| `machine_type` | enum | `washer` / `dryer`（业务上最常用的分类字段） |
| `value` | enum | 细分机型：`dryer_machine` / `washing_machine_without_powder` / `washing_machine_with_powder` |
| `label` | string | 英文展示名，如 `"Dry Machine"`、`"Washing Machine (Without Washing Powder)"` |
| `created_by` / `updated_by` / `created_at` / `updated_at` | — | 审计字段，无业务价值 |

> 实测字段出现率（12 台样本）：`_id`/`name`/`status`/`state`/`service_type`/`laundry_room_name` 均 12/12；
> `job` 4/12（正在用的机器）；`job.ticket` 仅 2/12（在用烘干机）。
>
> **machine 对象里没有 `laundry_room_id`**，只有 `laundry_room_name`。需要房间 ID 时，
> 用 `GET /app/laundry-rooms` 拿，或从券对象的 `laundry_room_id` 取。

### 4.4 判定规则（与网页完全一致）

```
可 用  = status === "enabled" && state === "available"
在用   = state === "in_use"
不可用 = status === "disabled" | "on_hold" | "maintenance"
离线   = state === "offline"
```

> 注意 `status` 和 `state` 是**两组独立字段**：一台 `status="maintenance", state="available"` 的机器
> **不可用**（网页显示 Maintenance）。判断空闲必须两个条件同时满足。

**剩余时间**（仅烘干机可算）：

```
remaining = job.created_at + ticket.number_of_minutes * 60000 - now
```

- 结果**可能为负**：已到预计结束时间但衣物未取，机器仍报 `in_use`。建议 UI 显示"已到点，可能未取衣"而不是负数倒计时；
- 洗衣机没有 `number_of_minutes`，只能用 `now - job.created_at` 显示"已运行多久"。

### 4.5 备选接口（按房间+机型查询）

```http
GET /ldr/api/app/machines?laundry_room_id=<ROOM_ID>&service_type_id=<SERVICE_TYPE_ID>
```

两个参数**都必填**，缺一个返回 `4034 Schema validation error`。响应的机器对象结构与 4.3 相同，
但**不带** `laundry_room_name` 字段。机型常量（实测，可能随部署变化）：

| 机型 | `service_type_id` |
|---|---|
| 烘干机 `dryer_machine` | `6482c1c23d71ec4ea60f9752` |
| 洗衣机（不带洗衣粉）`washing_machine_without_powder` | `6482c1b82fdd325916161e40` |
| 洗衣机（带洗衣粉）`washing_machine_with_powder` | `6482c1799a133fdced8f61a9` |

`laundry_room_id` 可从 `GET /app/laundry-rooms` 获取（见附录 B）。**日常建议直接用 4.1，省一次请求。**

---

## 5. 接口二/三：Available Tickets 与 Used Tickets

**关键结论：Available 与 Used 不是两个接口，而是同一个接口返回后由客户端分类。**

前端 `GET /app/tickets` 一次返回当前账号**全部**券，然后在本地区分
Available / Expired / Used 三个"标签页"。

### 5.1 请求

```http
GET /ldr/api/app/tickets
Authorization: Bearer <TOKEN>
Accept: application/json
```

- **无查询参数**：实测 `?usage_status=used`、`?machine_type=washer` 等均被**忽略**，始终返回全量；
- **无分页**：一次性返回全部历史券（本次样本 18 张，最早可追溯到 2025-12）；
- 响应约 38 KB / 18 张券，实测延迟约 45 ms；
- 返回的是 token 所属用户自己的券，不需要传 user_id。

### 5.2 分类规则（必须照抄，否则与网页不一致）

```
Available Tickets = usage_status === "available" && expire_at > now
Expired           = usage_status === "available" && expire_at <= now
Used Tickets      = usage_status === "used"
```

网页 "Used Tickets" 列表还做了两件事，建议照做：

1. 按 `used_at` **倒序**；
2. 只展示**最近 10 张**（`filter(used).slice(-10)` 语义）。

> 注意：`usage_status === "available"` 但 `expire_at` 已过期的券**不是** Available，
> 网页叫 **Expired**。本次采样中 10 张 `available` 券全部过期，所以 Available 列表为空 —— 这是正常现象。

### 5.3 响应

```json
{
  "meta": { "code": 200, "message": "Success" },
  "data": {
    "tickets": [
      {
        "_id": "6aaa1df1ac1cdc075c7e98a3",
        "display_id": "L126091612412194802",
        "ticket_type": "user",
        "uuid": "e066bbde-786d-4413-9b62-f8735176f146",
        "token": "<128 字符的券码，二维码内容>",
        "user_id": "68cbac54f67f7b077d750a98",
        "laundry_room_id": "64b3b75b419acf208b1ce861",
        "machine_type": "dryer",
        "number_of_minutes": 40,
        "service_type_id": "6482c1c23d71ec4ea60f9752",
        "price": 10,
        "bulk_purchase_quantity": 2,
        "bulk_purchase_price": 20,
        "payment_method": "wechat_pay",
        "payment_status": "paid",
        "usage_status": "available",
        "invoice_number": "L1260916124121948",
        "expire_at": "2026-10-16T15:59:59.999Z",
        "created_at": "2026-09-16T04:41:21.951Z",
        "updated_at": "2026-09-16T04:42:08.283Z",
        "service_type": { "_id": "6482c1c23d71ec4ea60f9752", "machine_type": "dryer", "value": "dryer_machine", "label": "Dry Machine" },
        "laundry_room":  { "_id": "64b3b75b419acf208b1ce861", "name": "UG Hall IV", "invoice_prefix": "L1", "status": "enabled" },
        "user":          { "_id": "68cbac54f67f7b077d750a98", "email": "<USER_EMAIL>", "source": "mercury", "hall_floors": [ … ] }
      }
    ]
  }
}
```

> 该示例券的 `expire_at` 已过期（采集时点无有效券），所以它当前属于 **Expired** 而不是 Available。

**Used 券额外多出 4 个字段**：

```json
{
  "display_id": "L126091610133812802",
  "machine_type": "washer",
  "usage_status": "used",
  "selected_machine_id": "64d03c2be24330a9fc56766f",
  "selected_machine_at": "2026-09-16T02:29:55.261Z",
  "used_at": "2026-09-16T02:30:02.602Z",
  "selected_machine": {
    "_id": "64d03c2be24330a9fc56766f",
    "device_uid": "UG4 Washer (03)",
    "name": "UG4 Washer (03)",
    "machine_type": "washer",
    "service_type_id": "6482c1b82fdd325916161e40",
    "laundry_room_id": "64b3b75b419acf208b1ce861",
    "laundry_room_hardware_id": "64b4bb2b419acf208b1d08c1",
    "channel": "3",
    "relay_toggle_time": 100,
    "status": "enabled"
  }
}
```

### 5.4 字段说明

**通用字段（Available / Expired / Used 都有）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 券 ID，用于查详情 / 预约机器 |
| `display_id` | string | 人类可读券号（含序号后缀），列表展示用 |
| `invoice_number` | string | 发票号；**一次批量购买的多张券共享同一个 invoice_number**，靠 `display_id` 末两位区分 |
| `ticket_type` | string | 实测为 `"user"`（用户自购券） |
| `uuid` | string | 券 UUID |
| `token` | string | **128 字符券码 = 详情页二维码内容**，机器扫码启动；属于敏感凭据，勿外泄 |
| `machine_type` | enum | `washer` / `dryer` |
| `number_of_minutes` | number \| 缺失 | 烘干机有（20/30/40/45/60），**洗衣机没有该字段**（固定时长） |
| `service_type_id` / `service_type` | string / object | 机型详情（`value` 如 `washing_machine_without_powder`） |
| `laundry_room_id` / `laundry_room` | string / object | 洗衣房（`name`、`invoice_prefix`） |
| `price` | number | **单张**价格（HKD 整数） |
| `bulk_purchase_quantity` | number | 本次批量购买张数，如 `2`、`3` |
| `bulk_purchase_price` | number | 本次批量购买总价，如 `20`、`24` |
| `payment_method` | string | `wechat_pay` / `alipay` / `fps` / `visa_master` / `union_pay` / `new_visa_master` / `new_union_pay` / `free` |
| `payment_status` | string | 实测 `paid`；未支付券可能为其他值（未实测） |
| `usage_status` | enum | **`available` / `used`**（分类核心字段） |
| `expire_at` | string(ISO) | 券过期时间；`available` + 已过期 = Expired |
| `created_at` / `updated_at` | string(ISO) | 购买/更新时间 |
| `redirect_url` | string \| 缺失 | 支付跳转链接（含支付网关 token），非必要勿使用 |
| `user` / `user_id` | object / string | 券所属用户（含邮箱、楼层等 PII） |

**仅 Used 券有**

| 字段 | 类型 | 说明 |
|---|---|---|
| `used_at` | string(ISO) | **实际使用（扫码启动）时间**，Used 列表排序依据。实测 8/8 张 used 券都有该字段 |
| `selected_machine_at` | string(ISO) | 选定机器时间 |
| `selected_machine_id` | string | 使用的机器 ID |
| `selected_machine` | object | 使用的机器完整信息（含 `device_uid`、`channel`、`relay_toggle_time` 等硬件字段） |

---

## 6. 组合用法与轮询建议

### 6.1 典型调用组合

| 需求 | 调用 |
|---|---|
| 机器状态 | `GET /app/laundry-rooms/machines`（1 次） |
| Available Tickets | `GET /app/tickets` + 本地过滤 `available && expire_at > now` |
| Used Tickets | `GET /app/tickets` + 本地过滤 `used` + 按 `used_at` 倒序取前 N |
| 三个都要 | **2 次请求**：`machines` + `tickets`（tickets 一份数据服务两个需求） |

### 6.2 轮询建议

- 站点未公布限流策略；响应很快（45–250 ms），**建议间隔 ≥ 15 s**，机器状态用 15–30 s 足够；
- 网页自身在"已选机器、等待启动"的详情页里用的是 **3 s 轮询** `GET /app/tickets/id?id=`，
  说明该频率服务端可接受，但脚本长期跑不建议照搬；
- 两个接口都是**幂等只读**，可安全重试（网络错误时）；业务 `4031/4032` 不要重试。

### 6.3 注意事项

- 响应里含 **PII**（邮箱、楼层、券码），落盘/日志请脱敏；
- Bearer `token` 和券的 `token` 都是凭据，不要提交到 git；
- 本文档只涉及只读接口；购券、支付、预约机器属于写操作，**不在本文档范围内，请勿在未确认后果的情况下调用**（附录 C 仅列出路径供参考）。

---

## 7. 代码示例

### 7.1 curl

```bash
TOKEN='<YOUR_TOKEN>'

# 1) 机器状态
curl -s 'https://laundry.ust.hk/ldr/api/app/laundry-rooms/machines' \
  -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json'

# 2) 券列表（Available / Used 都在里面）
curl -s 'https://laundry.ust.hk/ldr/api/app/tickets' \
  -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json'
```

### 7.2 Node.js（18+，零依赖）

```js
const BASE = 'https://laundry.ust.hk/ldr/api';
const TOKEN = process.env.LDR_TOKEN;

async function api(path) {
  const res = await fetch(BASE + path, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` },
  });
  const json = await res.json();
  if (json.meta.code !== 200) throw new Error(`${json.meta.code}: ${json.meta.message}`);
  return json.data;
}

// 1) 机器状态
const { laundry_room_machines } = await api('/app/laundry-rooms/machines');
for (const room of laundry_room_machines) {
  for (const m of room.machines) {
    const free = m.status === 'enabled' && m.state === 'available';
    console.log(m.name, m.status, m.state, free ? 'FREE' : '', JSON.stringify(m.job ?? {}));
  }
}

// 2) Available / 3) Used
const { tickets } = await api('/app/tickets');
const now = Date.now();
const isAvailable = (t) => t.usage_status === 'available' && new Date(t.expire_at) > now;
const available = tickets.filter(isAvailable);
const used = tickets
  .filter((t) => t.usage_status === 'used')
  .sort((a, b) => new Date(b.used_at) - new Date(a.used_at))
  .slice(0, 10);

console.log('available:', available.length, 'used:', used.length);
```

### 7.3 Python 3（requests）

```python
import os, datetime, requests

BASE = "https://laundry.ust.hk/ldr/api"
HEADERS = {"Authorization": f"Bearer {os.environ['LDR_TOKEN']}", "Accept": "application/json"}

def api(path):
    r = requests.get(BASE + path, headers=HEADERS, timeout=20)
    body = r.json()
    if body["meta"]["code"] != 200:
        raise RuntimeError(body["meta"])
    return body["data"]

machines = api("/app/laundry-rooms/machines")["laundry_room_machines"]
free = [m["name"] for room in machines for m in room["machines"]
        if m["status"] == "enabled" and m["state"] == "available"]

now = datetime.datetime.now(datetime.timezone.utc)
tickets = api("/app/tickets")["tickets"]
available = [t for t in tickets
             if t["usage_status"] == "available"
             and datetime.datetime.fromisoformat(t["expire_at"].replace("Z", "+00:00")) > now]
used = sorted([t for t in tickets if t["usage_status"] == "used"],
              key=lambda t: t["used_at"], reverse=True)[:10]

print("free machines:", free)
print("available tickets:", len(available), "used tickets:", len(used))
```

### 7.4 本仓库自带 CLI

```bash
cd packages/laundry-monitor
node bin/machines.mjs          # 机器状态（表格，含倒计时）
node bin/machines.mjs --json   # 原始 JSON，便于管道处理
```

Token：优先 `--token`，其次是环境变量 `LDR_TOKEN`；采集服务则使用 `monitor.config.json` 的 bearer。
tickets / rooms 没有内置 CLI，请直接按上面的 HTTP 示例调用。

---

## 8. 附录

### A. 本次实测采样（2026-10-27 01:5x，Asia/Shanghai）

| 项目 | 实测值 |
|---|---|
| 账号所属洗衣房 | 1 个：`UG Hall IV`（`app_id=UGLaundry`） |
| 机器总数 | 12 台（洗衣机 6、烘干机 6） |
| 机器状态分布 | 空闲 7 台（`enabled/available`）、在用 4 台（`enabled/in_use`）、维护 1 台（`maintenance`） |
| 券总数 | 18 张 |
| 券分类 | Available 0 张、Expired 10 张、Used 8 张 |
| 接口延迟 | `machines` ≈ 250 ms / 5.6 KB；`tickets` ≈ 45 ms / 38 KB |

### B. 只读端点清单（补充）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/app/laundry-rooms` | 洗衣房列表（`_id`、`name`、`invoice_prefix`、`status`），用于取 `laundry_room_id` |
| GET | `/app/laundry-rooms/machines` | **机器状态（主接口）** |
| GET | `/app/machines?laundry_room_id=&service_type_id=` | 机器状态（按房间+机型，两参数必填） |
| GET | `/app/tickets` | **券全量列表**（Available / Expired / Used 由此派生） |
| GET | `/app/tickets/id?id=<ticketId>` | 单张券详情（含 `selected_machine_id`、`used_at` 等演进字段） |
| GET | `/app/tickets/payment-methods` | 可用支付方式 |
| GET | `/app/payment-methods?channel=<channel>` | 按渠道列支付方式（实测本部署返回 404，前端未使用） |
| GET | `/app/auth/cas/url` | 取 CAS 登录跳转地址 |

### C. 写操作端点（**不在本文档范围**，仅列出）

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/app/tickets` | 购券（body `{ticket:{laundry_room_id, machine_type, service_type_id, payment_method, bulk_purchase_quantity, number_of_minutes?}}`） |
| PATCH | `/app/tickets/id?id=` | 预约机器（body `{ticket:{selected_machine_id, action:"machine_reserve", updated_at}}`） |
| PATCH | `/app/tickets/id/laundry-room?id=` | 改券所属洗衣房（body `{ticket:{laundry_room_id, updated_at}}`） |
| POST | `/app/tickets/id/status?id=` | 支付回调后轮询支付状态 |
| POST | `/app/auth/login` `/app/auth/cas/auth` `/app/auth/logout` | 登录 / CAS 登录 / 登出 |

### D. 结论与依据

- **接口来源**：SPA bundle `static/js/main.3bf855c9.chunk.js` 中的 API 封装层（superagent），
  可见 `GET|POST|PATCH` 三个包装函数统一拼接 `Zt.api`（= `https://laundry.ust.hk/ldr/api`）+ 路径，
  并统一设置 `Authorization: Bearer <localStorage.ldr_student.token>`；
- **响应校验**：所有结论均用真实 token 实调生产接口验证，示例数据来自真实响应（已脱敏）；
- **未验证项**：C 类写操作、`reserved`/`offline` 状态样本、未支付券的 `payment_status` 取值、
  服务端 token 精确 TTL —— 本文档不对这些做断言。
