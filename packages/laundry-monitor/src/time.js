/** 时间工具：解析 `24h` / `7d` / ISO 字符串这类 --since 参数。 */

const UNIT_MS = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * 把 "24h" / "7d" / "30m" / "2026-10-01T00:00:00Z" 解析成 ISO 时间字符串。
 * 不传则返回 null（表示不限时间）。
 *
 * @param {string|null|undefined} value
 * @param {number} [now]
 * @returns {string|null} ISO UTC 字符串
 */
export function parseSince(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;

  const text = String(value).trim();
  const relative = /^(\d+(?:\.\d+)?)([smhd])$/.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = UNIT_MS[relative[2]];
    return new Date(now - amount * unit).toISOString();
  }

  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new Error(`无法解析时间：${JSON.stringify(value)}（支持 24h / 7d / ISO 时间）`);
  }
  return new Date(parsed).toISOString();
}

/** 把秒数格式化成 1h05m / 12m30s */
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '-';
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}
