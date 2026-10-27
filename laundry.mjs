/**
 * HKUST Laundry System — 只读信息获取 CLI
 * 配套文档: docs/API.md
 *
 * 机器状态的 HTTP 调用/鉴权/归一化复用 `packages/laundry-machines`，
 * 本文件只保留 tickets / rooms 接口与命令行输出。
 *
 * 用法:
 *   node laundry.mjs machines            机器状态（默认，表格）
 *   node laundry.mjs machines --json     机器状态（原始 JSON，便于程序处理）
 *   node laundry.mjs available           Available Tickets
 *   node laundry.mjs used [n]            Used Tickets（默认最近 10 张）
 *   node laundry.mjs tickets --json      全部券原始 JSON
 *   node laundry.mjs rooms               洗衣房列表
 *
 * Token: 环境变量 LDR_TOKEN，否则读 ./token.txt
 */

import {
  createClient,
  formatRemaining,
  normalizeMachine,
  resolveToken,
} from './packages/laundry-monitor/src/machines/index.js';

export const BASE = 'https://laundry.ust.hk/ldr/api';

export function loadToken() {
  const token = resolveToken();
  if (!token) throw new Error('缺少 token：设置环境变量 LDR_TOKEN 或创建 token.txt');
  return token;
}

const client = createClient();

/** tickets / rooms 等非机器接口（库只封装了机器接口） */
export async function api(method, endpoint, body) {
  const res = await fetch(BASE + endpoint, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + loadToken(),
      Origin: 'https://laundry.ust.hk',
      Referer: 'https://laundry.ust.hk/ldr/app/tickets',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`非 JSON 响应 (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const code = json?.meta?.code;
  if (code === 4031) throw new Error('缺少 Bearer token（4031）');
  if (code === 4032) {
    throw new Error(
      'Bearer token 无效或已过期（4032）：重新打开网页，从 localStorage["ldr_student"].token 取新 token',
    );
  }
  if (code !== 200) {
    throw new Error(`API 错误 ${code}: ${json?.meta?.message} ${JSON.stringify(json?.data ?? '').slice(0, 300)}`);
  }
  return json.data;
}

/* ---------------- 三个只读接口 ---------------- */

/** 接口 1：所有洗衣房的机器实时状态（原始结构，原样返回） */
export async function getMachines() {
  const raw = await client.getMachinesRaw();
  return raw.data.laundry_room_machines;
}

/** 接口 2/3：当前账号的全部券（客户端再分 Available / Used） */
export async function getTickets() {
  const data = await api('GET', '/app/tickets');
  return data.tickets;
}

/** 辅助：洗衣房列表（拿 laundry_room_id 用） */
export async function getLaundryRooms() {
  const data = await api('GET', '/app/laundry-rooms');
  return data.laundry_rooms;
}

/* ---------------- 派生逻辑（与网页判定保持完全一致） ---------------- */

/** 与网页相同的三分类：available / expired / used */
export function classifyTicket(ticket, now = Date.now()) {
  const expire = new Date(ticket.expire_at).getTime();
  if (ticket.usage_status === 'used') return 'used';
  if (ticket.usage_status === 'available') return expire > now ? 'available' : 'expired';
  return 'other';
}

export const availableTickets = (list, now = Date.now()) =>
  list.filter((t) => classifyTicket(t, now) === 'available');

export const usedTickets = (list, n = 10) =>
  list
    .filter((t) => t.usage_status === 'used')
    .sort((a, b) => new Date(b.used_at) - new Date(a.used_at))
    .slice(0, n);

/* ---------------- CLI ---------------- */

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const positional = argv.filter((a) => !a.startsWith('--'));
const cmd = positional[0] ?? 'machines';

function stateLabel(machine) {
  if (machine.status !== 'enabled') return C.red(machine.status); // disabled / on_hold / maintenance
  if (machine.state === 'available') return C.green('available');
  if (machine.state === 'in_use') return C.yellow('in_use');
  return C.dim(String(machine.state)); // offline
}

try {
  if (cmd === 'machines') {
    const data = await getMachines();
    if (asJson) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      const now = Date.now();
      for (const room of data) {
        console.log(C.bold(`\n${room.laundry_room_name}`));
        const groups = { washer: [], dryer: [] };
        for (const raw of room.machines) {
          const machine = normalizeMachine(raw, now);
          groups[machine.kind]?.push(machine);
        }
        for (const [type, list] of Object.entries(groups)) {
          if (!list.length) continue;
          const free = list.filter((machine) => machine.available).length;
          console.log(`  ${type}s: ${C.bold(`${free}/${list.length} free`)}`);
          for (const machine of list) {
            let extra = '';
            if (machine.remainingSeconds != null) {
              const remaining = formatRemaining(machine.remainingSeconds);
              extra =
                machine.remainingSeconds > 0
                  ? C.dim(` (剩 ${remaining})`)
                  : C.dim(` (已到点 ${formatRemaining(-machine.remainingSeconds)}，可能未取衣)`);
            } else if (machine.elapsedSeconds != null) {
              extra = C.dim(` (已运行 ${formatRemaining(machine.elapsedSeconds)}，洗衣机无预计时长)`);
            }
            console.log(`    ${String(machine.name).padEnd(18)} ${stateLabel(machine)}${extra}`);
          }
        }
      }
    }
  } else if (cmd === 'available') {
    const list = availableTickets(await getTickets());
    if (asJson) console.log(JSON.stringify(list, null, 2));
    else if (!list.length) console.log(C.dim('没有可用的券（全部已过期或已使用）'));
    else {
      console.log(`${list.length} 张 Available Tickets`);
      for (const t of list) {
        console.log(
          `  ${t.display_id}  ${String(t.machine_type).padEnd(6)} ${(t.number_of_minutes ? t.number_of_minutes + ' min' : 'fixed').padEnd(7)} 过期 ${t.expire_at.slice(0, 10)}  id=${t._id}`,
        );
      }
    }
  } else if (cmd === 'used') {
    const n = Number(positional[1]) || 10;
    const list = usedTickets(await getTickets(), n);
    if (asJson) console.log(JSON.stringify(list, null, 2));
    else if (!list.length) console.log(C.dim('还没有使用过的券'));
    else {
      console.log(`最近 ${list.length} 张 Used Tickets`);
      for (const t of list) {
        const when = t.used_at
          ? new Date(t.used_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          : '-';
        const machine = t.selected_machine?.name ?? t.selected_machine_id ?? '-';
        console.log(`  ${t.display_id}  ${String(t.machine_type).padEnd(6)} ${machine.padEnd(18)} used_at=${when}`);
      }
    }
  } else if (cmd === 'tickets') {
    const all = await getTickets();
    if (asJson) console.log(JSON.stringify(all, null, 2));
    else {
      const now = Date.now();
      for (const t of all) {
        console.log(
          `  ${t.display_id}  ${String(t.machine_type).padEnd(6)} ${classifyTicket(t, now).padEnd(9)} pay=${t.payment_status}  exp=${t.expire_at.slice(0, 10)}`,
        );
      }
    }
  } else if (cmd === 'rooms') {
    const list = await getLaundryRooms();
    if (asJson) console.log(JSON.stringify(list, null, 2));
    else for (const r of list) console.log(`  ${r._id}  ${r.name}  status=${r.status}`);
  } else {
    console.log(`
用法: node laundry.mjs <command> [--json]

  machines          机器实时状态（默认）
  available         Available Tickets（未使用且未过期）
  used [n]          Used Tickets（默认最近 10 张，按 used_at 倒序）
  tickets           全部券（未分类）
  rooms             洗衣房列表

所有命令都支持 --json，输出原始 JSON 便于程序消费。
`);
  }
} catch (e) {
  console.error(C.red('错误: ') + e.message);
  process.exit(1);
}
