/**
 * hkust-laundry-machines —— 只读的机器状态查询库。
 *
 * 数据来源：https://laundry.ust.hk/ldr/api/app/laundry-rooms/machines
 * 鉴权：Authorization: Bearer <token>（token 取自网页 localStorage["ldr_student"].token）
 */

export { LaundryClient, createClient, DEFAULT_BASE_URL, MACHINES_ENDPOINT } from './src/client.js';
export {
  normalizeResponse,
  normalizeMachine,
  parseMachineNumber,
  isAvailable,
  formatRemaining,
} from './src/normalize.js';
export { resolveToken } from './src/token.js';
export { LaundryError, LaundryAuthError } from './src/errors.js';
