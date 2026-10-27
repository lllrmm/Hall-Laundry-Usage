/**
 * 上游机器状态客户端（原独立包 hkust-laundry-machines，已并入 laundry-monitor）。
 *
 * 数据来源：https://laundry.ust.hk/ldr/api/app/laundry-rooms/machines
 * 鉴权：Authorization: Bearer <token>（token 取自网页 localStorage["ldr_student"].token）
 */

export { LaundryClient, createClient, DEFAULT_BASE_URL, MACHINES_ENDPOINT } from './client.js';
export {
  normalizeResponse,
  normalizeMachine,
  parseMachineNumber,
  isAvailable,
  formatRemaining,
} from './normalize.js';
export { resolveToken } from './token.js';
export { LaundryError, LaundryAuthError } from './errors.js';
