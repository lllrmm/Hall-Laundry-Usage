/**
 * laundry-* 各包共享的契约（Node 侧唯一实现）。
 *
 * 序列字节编码（1 byte / 分钟）：
 *   0x00 in_use                 占用
 *   0x01 available              空闲
 *   0x02 maintenance            维护
 *   0x03 disabled               停用
 *   0x04 offline                离线
 *   0x05 on_hold                旧的通用 on_hold 编码（仅解码兼容，不再写入）
 *   0x06 on_hold + state=in_use
 *   0x07 on_hold + state=available
 *   0x08 on_hold + state=offline
 *   0x09 on_hold + state 无法识别
 *   0xfe unknown                轮询成功但状态无法识别
 *   0xff no_data                该分钟没有成功轮询
 *
 * 浏览器端（laundry-web 的 public/aggregate.js）是普通 <script>，无法 import 本文件；
 * 它只保留一份只读常量副本，并由 laundry-web/test/contract.test.mjs
 * 校验与这里完全一致（新增/修改编码时必须同步该副本并跑契约测试）。
 */

export const MINUTES_PER_DAY = 1440;
export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const STATE_BYTES = Object.freeze({
  in_use: 0x00,
  available: 0x01,
  maintenance: 0x02,
  disabled: 0x03,
  offline: 0x04,
  on_hold: 0x05, // 旧编码，仅用于兼容历史序列
  on_hold_in_use: 0x06,
  on_hold_available: 0x07,
  on_hold_offline: 0x08,
  on_hold_unknown: 0x09,
  unknown: 0xfe,
  no_data: 0xff,
});

/** 字节 → 可读标签（渲染/调试用） */
export const BYTE_LABELS = Object.freeze({
  [STATE_BYTES.in_use]: 'in_use',
  [STATE_BYTES.available]: 'available',
  [STATE_BYTES.maintenance]: 'maintenance',
  [STATE_BYTES.disabled]: 'disabled',
  [STATE_BYTES.offline]: 'offline',
  [STATE_BYTES.on_hold]: 'on_hold',
  [STATE_BYTES.on_hold_in_use]: 'on_hold_in_use',
  [STATE_BYTES.on_hold_available]: 'on_hold_available',
  [STATE_BYTES.on_hold_offline]: 'on_hold_offline',
  [STATE_BYTES.on_hold_unknown]: 'on_hold_unknown',
  [STATE_BYTES.unknown]: 'unknown',
  [STATE_BYTES.no_data]: 'no_data',
});

/** status=on_hold 时，按底层 state 细分编码 */
export function onHoldByte(state) {
  if (state === 'in_use') return STATE_BYTES.on_hold_in_use;
  if (state === 'available') return STATE_BYTES.on_hold_available;
  if (state === 'offline') return STATE_BYTES.on_hold_offline;
  return STATE_BYTES.on_hold_unknown;
}

/** 原始快照行 → 一个字节（rebuild / raw 回退用） */
export function snapshotByte(row) {
  // 非 enabled 的 status 优先（维护中的机器 state 也可能是 available）
  switch (row.status) {
    case 'maintenance':
      return STATE_BYTES.maintenance;
    case 'disabled':
      return STATE_BYTES.disabled;
    case 'on_hold':
      return onHoldByte(row.state);
    default:
      break;
  }
  if (row.available === 1 || row.available === true) return STATE_BYTES.available;
  if (row.state === 'in_use') return STATE_BYTES.in_use;
  if (row.state === 'offline') return STATE_BYTES.offline;
  if (row.state === 'available') return STATE_BYTES.available;
  return STATE_BYTES.unknown;
}

/** 可运营状态（计入使用率分母）：in_use / available / on_hold(+in_use) / on_hold(+available) */
export function isOperational(byte) {
  return (
    byte === STATE_BYTES.in_use ||
    byte === STATE_BYTES.available ||
    byte === STATE_BYTES.on_hold ||
    byte === STATE_BYTES.on_hold_in_use ||
    byte === STATE_BYTES.on_hold_available
  );
}

/** 计入使用率分子：in_use 与 on_hold(+in_use) */
export function isInUse(byte) {
  return (
    byte === STATE_BYTES.in_use || byte === STATE_BYTES.on_hold || byte === STATE_BYTES.on_hold_in_use
  );
}

/** on_hold 系列字节（State breakdown 统一归入 On hold） */
export function isOnHold(byte) {
  return (
    byte === STATE_BYTES.on_hold ||
    byte === STATE_BYTES.on_hold_in_use ||
    byte === STATE_BYTES.on_hold_available ||
    byte === STATE_BYTES.on_hold_offline ||
    byte === STATE_BYTES.on_hold_unknown
  );
}

/** 机器服务类型 → 洗粉标注 */
export function powderFor(serviceValue) {
  if (serviceValue === 'washing_machine_with_powder') return 'with';
  if (serviceValue === 'washing_machine_without_powder') return 'without';
  return null;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地日期 YYYY-MM-DD（序列按服务器本地时间切天） */
export function dayKey(date) {
  const value = date instanceof Date ? date : new Date(date);
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

/** 本地时间的当天第几分钟（0–1439） */
export function minuteOfDay(date) {
  const value = date instanceof Date ? date : new Date(date);
  return value.getHours() * 60 + value.getMinutes();
}
