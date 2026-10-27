/** 服务端返回的机型信息 */
export interface RawServiceType {
  _id: string;
  machine_type: 'washer' | 'dryer' | string;
  value: string;
  label: string;
  created_by?: string;
  updated_by?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** 服务端返回的原始 machine 对象 */
export interface RawMachine {
  _id: string;
  status: 'enabled' | 'disabled' | 'on_hold' | 'maintenance' | string;
  state: 'available' | 'in_use' | 'offline' | 'reserved' | string;
  name: string;
  service_type: RawServiceType;
  laundry_room_name: string;
  job?: {
    created_at: string;
    /** 只有烘干机（dryer）才有 */
    ticket?: { number_of_minutes?: number };
  };
  [key: string]: unknown;
}

/** 服务端原始响应 */
export interface RawMachinesResponse {
  meta: { code: number; message: string };
  data: {
    laundry_room_machines: Array<{
      laundry_room_name: string;
      machines: RawMachine[];
    }>;
  };
}

/** 归一化后的机器 */
export interface Machine {
  /** 机器 ID（预约机器时用） */
  id: string | null;
  /** 显示名，如 "UG4 Dryer (52)" */
  name: string | null;
  /** 从名字解析出的编号，如 52 */
  number: number | null;
  /** 机型：washer / dryer */
  kind: 'washer' | 'dryer' | string | null;
  serviceTypeId: string | null;
  serviceValue: string | null;
  serviceLabel: string | null;
  roomName: string | null;

  status: string | null;
  state: string | null;

  /** 是否可用：status === "enabled" && state === "available" */
  available: boolean;
  /** 是否正在使用 */
  inUse: boolean;
  /** 不可用原因（可用时为 null） */
  unavailableReason: string | null;

  /** 本次使用开始时间（仅 in_use 有） */
  startedAt: Date | null;
  /** 预计时长（分钟，仅烘干机有） */
  plannedMinutes: number | null;
  /** 预计结束时间（仅烘干机可算） */
  endsAt: Date | null;
  /** 剩余秒数（仅烘干机可算；负数表示已到点但衣物未取） */
  remainingSeconds: number | null;
  /** 已运行秒数（所有在用机器可算） */
  elapsedSeconds: number | null;
  /** 是否已到点但衣物仍未取 */
  finishedButNotEmptied: boolean;

  /** 服务端原始对象 */
  raw: RawMachine;
}

/** 洗衣房分组 */
export interface Room {
  name: string | null;
  machines: Machine[];
}

/** 归一化后的整份状态 */
export interface MachineStatus {
  /** 本次请求时间（remainingSeconds 的计算基准） */
  fetchedAt: Date;
  rooms: Room[];
  machines: Machine[];
  counts: { total: number; available: number; inUse: number; unavailable: number };
  byKind: Record<string, { total: number; available: number; inUse: number }>;
  meta: { code: number; message: string } | null;
}

export interface LaundryClientOptions {
  /** Bearer token；不传则依次读 LDR_TOKEN 环境变量、./token.txt */
  token?: string;
  /** API 基址，默认 https://laundry.ust.hk/ldr/api */
  baseUrl?: string;
  /** 自定义 fetch 实现（测试/代理用） */
  fetch?: typeof fetch;
  /** 单次请求超时（毫秒），默认 15000 */
  timeoutMs?: number;
  userAgent?: string;
  /** token.txt 文件名，默认 "token.txt" */
  tokenFile?: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface GetMachinesOptions extends RequestOptions {
  /** 计算剩余时间的基准时间戳（测试用） */
  now?: number;
}

export declare class LaundryError extends Error {
  constructor(
    message: string,
    options?: { code?: number | string | null; endpoint?: string | null; status?: number | null; data?: unknown; cause?: unknown },
  );
  /** 业务错误码（meta.code）或内部标识（TIMEOUT / NETWORK_ERROR / ABORTED / INVALID_RESPONSE） */
  code: number | string | null;
  endpoint: string | null;
  status: number | null;
  data: unknown;
}

/** token 缺失 / 失效（meta.code 4031、4032） */
export declare class LaundryAuthError extends LaundryError {}

export declare class LaundryClient {
  constructor(options?: LaundryClientOptions);
  readonly baseUrl: string;
  /** 拉取原始响应，不做归一化 */
  getMachinesRaw(options?: RequestOptions): Promise<RawMachinesResponse>;
  /** 查询机器状态（归一化后的结构） */
  getMachines(options?: GetMachinesOptions): Promise<MachineStatus>;
}

export declare function createClient(options?: LaundryClientOptions): LaundryClient;

export declare function normalizeMachine(raw: RawMachine, now?: number): Machine;
export declare function normalizeResponse(payload: RawMachinesResponse, now?: number): MachineStatus;
export declare function parseMachineNumber(name: string): number | null;
export declare function isAvailable(machine: { status?: string; state?: string }): boolean;
export declare function formatRemaining(seconds: number | null): string;

export declare function resolveToken(options?: {
  token?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  file?: string;
}): string | null;

export declare const DEFAULT_BASE_URL: string;
export declare const MACHINES_ENDPOINT: string;
