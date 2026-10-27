/**
 * 把服务端原始响应归一化成对调用方友好的对象。
 *
 * 服务端原始结构（GET /app/laundry-rooms/machines）：
 *   { meta, data: { laundry_room_machines: [ { laundry_room_name, machines: [ ... ] } ] } }
 *
 * 归一化后额外算出：
 *   - available / inUse / unavailableReason：机器能不能用
 *   - startedAt / plannedMinutes / endsAt / remainingSeconds / elapsedSeconds：时间信息
 *
 * 注意：接口本身**不返回**"是否空闲"和"还剩多久"，必须由客户端派生。
 */

/**
 * @typedef {'available'|'in_use'|'offline'|'reserved'|string} MachineState
 * @typedef {'enabled'|'disabled'|'on_hold'|'maintenance'|string} MachineStatus
 * @typedef {'washer'|'dryer'|string} MachineKind
 */

/**
 * 从显示名里取机器编号，如 "UG4 Dryer (52)" -> 52。
 * @param {string} name
 * @returns {number|null}
 */
export function parseMachineNumber(name) {
  const match = /\((\d+)\)\s*$/.exec(String(name ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * 机器是否可用：必须同时满足 status === "enabled" 且 state === "available"。
 * 只判断 state 是错的 —— 维护中的机器 state 也可能是 available。
 * @param {{status?: string, state?: string}} machine 归一化后的或原始机器对象
 * @returns {boolean}
 */
export function isAvailable(machine) {
  return machine?.status === 'enabled' && machine?.state === 'available';
}

/**
 * 把秒数格式化成 "1h05m" / "12m30s" 这种可读文本（负数表示已超时）。
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatRemaining(seconds) {
  if (seconds === null || seconds === undefined) return '';
  const negative = seconds < 0;
  const total = Math.abs(Math.trunc(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const text = hours > 0
    ? `${hours}h${String(minutes).padStart(2, '0')}m`
    : `${minutes}m${String(secs).padStart(2, '0')}s`;
  return negative ? `-${text}` : text;
}

/**
 * 归一化单台机器。
 * @param {Record<string, any>} raw 服务端返回的 machine 对象
 * @param {number} [now] 用于计算剩余时间的当前时间戳
 */
export function normalizeMachine(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError('normalizeMachine: machine must be an object');
  }

  const serviceType = raw.service_type ?? {};
  const startedAtRaw = raw.job?.created_at ?? null;
  const startedAt = startedAtRaw ? new Date(startedAtRaw) : null;
  const plannedMinutes = raw.job?.ticket?.number_of_minutes ?? null;

  // 只有烘干机的 job 里带 number_of_minutes，洗衣机算不出结束时间
  const endsAt = startedAt && typeof plannedMinutes === 'number'
    ? new Date(startedAt.getTime() + plannedMinutes * 60_000)
    : null;

  const remainingSeconds = endsAt ? Math.round((endsAt.getTime() - now) / 1000) : null;
  const elapsedSeconds = startedAt ? Math.round((now - startedAt.getTime()) / 1000) : null;
  const available = isAvailable(raw);

  let unavailableReason = null;
  if (!available) {
    unavailableReason = raw.status !== 'enabled' ? raw.status : raw.state;
  }

  return {
    /** 机器 ID（预约机器时用） */
    id: raw._id ?? null,
    /** 显示名，如 "UG4 Dryer (52)" */
    name: raw.name ?? null,
    /** 从名字解析出的编号，如 52 */
    number: parseMachineNumber(raw.name),
    /** 机型：washer / dryer */
    kind: serviceType.machine_type ?? null,
    /** 机型 ID（可作 /app/machines 的 service_type_id） */
    serviceTypeId: serviceType._id ?? null,
    /** 细分机型，如 dryer_machine / washing_machine_without_powder */
    serviceValue: serviceType.value ?? null,
    /** 机型英文名，如 "Dry Machine" */
    serviceLabel: serviceType.label ?? null,
    /** 洗衣房名称 */
    roomName: raw.laundry_room_name ?? null,

    /** 设备状态：enabled / disabled / on_hold / maintenance */
    status: raw.status ?? null,
    /** 运行状态：available / in_use / offline / reserved */
    state: raw.state ?? null,

    /** 是否可用（status === enabled && state === available） */
    available,
    /** 是否正在使用 */
    inUse: raw.state === 'in_use',
    /** 不可用原因（可用时为 null） */
    unavailableReason,

    /** 本次使用开始时间（仅 in_use 有） */
    startedAt,
    /** 预计时长（分钟，仅烘干机有） */
    plannedMinutes,
    /** 预计结束时间（仅烘干机可算） */
    endsAt,
    /** 剩余秒数（仅烘干机可算；负数表示已到点但衣物未取） */
    remainingSeconds,
    /** 已运行秒数（所有在用机器可算） */
    elapsedSeconds,
    /** 是否已到点但衣物仍未取（机器仍报 in_use） */
    finishedButNotEmptied: remainingSeconds !== null && remainingSeconds <= 0,

    /** 服务端原始对象，需要未归一化字段时使用 */
    raw,
  };
}

/**
 * 归一化整个接口响应。
 * @param {Record<string, any>} payload 服务端原始 JSON
 * @param {number} [now] 计算剩余时间用的时间戳
 */
export function normalizeResponse(payload, now = Date.now()) {
  const groups = payload?.data?.laundry_room_machines;
  if (!Array.isArray(groups)) {
    throw new TypeError('normalizeResponse: response has no data.laundry_room_machines array');
  }

  const rooms = groups.map((group) => ({
    name: group?.laundry_room_name ?? null,
    machines: Array.isArray(group?.machines) ? group.machines.map((m) => normalizeMachine(m, now)) : [],
  }));

  const machines = rooms.flatMap((room) => room.machines);

  const counts = { total: machines.length, available: 0, inUse: 0, unavailable: 0 };
  /** @type {Record<string, {total: number, available: number, inUse: number}>} */
  const byKind = {};

  for (const machine of machines) {
    const kind = machine.kind ?? 'unknown';
    byKind[kind] ??= { total: 0, available: 0, inUse: 0 };
    byKind[kind].total += 1;

    if (machine.available) {
      counts.available += 1;
      byKind[kind].available += 1;
    } else if (machine.inUse) {
      counts.inUse += 1;
      byKind[kind].inUse += 1;
    } else {
      counts.unavailable += 1;
    }
  }

  return {
    /** 本次请求时间（也是 remainingSeconds 的计算基准） */
    fetchedAt: new Date(now),
    /** 洗衣房分组 */
    rooms,
    /** 拍平的机器列表，方便直接 filter/sort */
    machines,
    /** 全局统计 */
    counts,
    /** 按机型的统计，如 byKind.dryer.available */
    byKind,
    /** 服务端 meta 原样保留 */
    meta: payload?.meta ?? null,
  };
}
