/** hkust-laundry-monitor —— 机器状态采集与存储。 */

export { loadConfig, normalizeConfig, expandEnv, DEFAULT_CONFIG_FILE, DEFAULTS } from './config.js';
export { MonitorDatabase, openDatabase, SCHEMA_VERSION } from './db.js';
export {
  SeriesDatabase,
  openSeriesDatabase,
  MINUTES_PER_DAY,
  STATE_BYTES,
  BYTE_LABELS,
  dayKey,
  minuteOfDay,
  stateByte,
  snapshotByte,
  onHoldByte,
} from './series.js';
export { pollOnce } from './collector.js';
export { startMonitor } from './monitor.js';
export { createLogger } from './logger.js';
export { parseSince, formatDuration } from './time.js';

// 上游机器 API 客户端（原独立包 hkust-laundry-machines，已合并到 src/machines/）
export {
  LaundryClient,
  createClient,
  DEFAULT_BASE_URL,
  MACHINES_ENDPOINT,
  normalizeResponse,
  normalizeMachine,
  parseMachineNumber,
  isAvailable,
  formatRemaining,
  resolveToken,
  LaundryError,
  LaundryAuthError,
} from './machines/index.js';
