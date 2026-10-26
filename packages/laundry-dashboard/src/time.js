/** 时间窗口与分桶工具。 */

/** 前端可选的时间跨度 */
export const RANGE_PRESETS = {
  '1h': 3600,
  '6h': 6 * 3600,
  '24h': 24 * 3600,
  '7d': 7 * 24 * 3600,
  '30d': 30 * 24 * 3600,
};

/** 最长回看（"全部"窗口的上限，避免误查整库） */
export const MAX_WINDOW_SECONDS = 90 * 24 * 3600;

const BUCKET_STEPS = [
  30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800,
];

/** 目标最多返回多少个数据点 */
const TARGET_POINTS = 240;

/**
 * 把 `1h` / `6h` / `24h` / `7d` / `30d` / `all` 或 ISO 时间解析成窗口。
 * @param {string|null|undefined} value
 * @param {number} [now]
 * @returns {{ since: string|null, windowSeconds: number, label: string }}
 */
export function parseRange(value, now = Date.now()) {
  const text = value === undefined || value === null || value === '' ? '24h' : String(value).trim();

  if (text === 'all') {
    return { since: null, windowSeconds: MAX_WINDOW_SECONDS, label: 'all' };
  }

  const relative = /^(\d+(?:\.\d+)?)([smhd])$/.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[relative[2]];
    const windowSeconds = Math.min(amount * unit, MAX_WINDOW_SECONDS);
    return { since: new Date(now - windowSeconds * 1000).toISOString(), windowSeconds, label: text };
  }

  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new Error(`无法解析时间窗口：${JSON.stringify(value)}（支持 1h / 24h / 7d / all / ISO 时间）`);
  }
  const windowSeconds = Math.min(Math.max(1, Math.round((now - parsed) / 1000)), MAX_WINDOW_SECONDS);
  return { since: new Date(parsed).toISOString(), windowSeconds, label: text };
}

/**
 * 根据窗口长度选择分桶粒度（保证点数不超过 TARGET_POINTS）。
 * @param {number} windowSeconds
 * @returns {number} 桶大小（秒）
 */
export function chooseBucketSeconds(windowSeconds) {
  const window = Math.max(1, Number(windowSeconds) || 1);
  for (const step of BUCKET_STEPS) {
    if (window / step <= TARGET_POINTS) return step;
  }
  return BUCKET_STEPS[BUCKET_STEPS.length - 1];
}

/** 把毫秒时间戳对齐到 bucket 边界（返回 ISO） */
export function floorToBucketIso(ms, bucketSeconds) {
  const bucketMs = bucketSeconds * 1000;
  return new Date(Math.floor(ms / bucketMs) * bucketMs).toISOString();
}

/** 生成从 since 到 until 的连续桶列表（ISO 字符串） */
export function buildBuckets(sinceIso, untilMs, bucketSeconds) {
  const bucketMs = bucketSeconds * 1000;
  const startMs = Math.floor(Date.parse(sinceIso) / bucketMs) * bucketMs;
  const buckets = [];
  for (let ms = startMs; ms <= untilMs; ms += bucketMs) {
    buckets.push(new Date(ms).toISOString());
  }
  return buckets;
}

/** 分桶对齐后的 epoch 秒 → ISO */
export function bucketSecondsToIso(bucketEpochSeconds) {
  return new Date(Number(bucketEpochSeconds) * 1000).toISOString();
}
