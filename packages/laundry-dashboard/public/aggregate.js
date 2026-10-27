/*!
 * 浏览器端聚合：把 /api/days 返回的"每台机器每天 1,440 个分钟字节"在本地算成
 * 星期 × 分钟热力图、时间剖面和状态占比。
 *
 * 目的：所有交互（勾选星期、拖动时段、选择机器、切换日期）都只重算内存数据，
 * 不再往返后端；后端只负责发原始日序列。
 *
 * 字节编码（与 laundry-monitor/src/series.js、laundry-dashboard/src/days.js 一致）：
 *   0x00 in_use      0x01 available   0x02 maintenance  0x03 disabled
 *   0x04 offline     0x05 on_hold     0xfe unknown      0xff no_data
 *
 * 该文件是普通 <script>（非 ES module），同时挂到全局 `LaundryAggregate`，
 * 便于 node 测试用 vm 直接执行。
 */
(function (root) {
  'use strict';

  const MINUTES_PER_DAY = 1440;
  const DAYS_PER_WEEK = 7;

  const BYTE = Object.freeze({
    inUse: 0x00,
    available: 0x01,
    maintenance: 0x02,
    disabled: 0x03,
    offline: 0x04,
    onHold: 0x05,
    unknown: 0xfe,
    noData: 0xff,
  });

  const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  /** 可运营状态：只有"在用/空闲"才计入使用率分母 */
  function isOperational(byte) {
    return byte === BYTE.inUse || byte === BYTE.available;
  }

  /**
   * 本地日历日（YYYY-MM-DD）→ 星期索引（0=周一 … 6=周日）。
   * 用 UTC 解析避免时区/夏令时影响：日历日的星期几与时刻无关。
   */
  function weekdayOfDay(day) {
    const year = Number(day.slice(0, 4));
    const month = Number(day.slice(5, 7));
    const date = Number(day.slice(8, 10));
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(date)) return null;
    const utcDay = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
    return (utcDay + 6) % 7;
  }

  /**
   * 星期 × 分钟热力图。
   * cells 只包含有可运营样本的格子：usageRatio = 在用分钟数 / 可运营分钟数。
   * @param {Array<{day: string, seq: Uint8Array}>} records 已按机器/日期过滤的机器·天序列
   */
  function buildHeatmap(records = []) {
    const samples = new Uint32Array(DAYS_PER_WEEK * MINUTES_PER_DAY);
    const usage = new Uint32Array(DAYS_PER_WEEK * MINUTES_PER_DAY);

    for (const record of records) {
      const seq = record?.seq;
      if (!seq) continue;
      const weekday = weekdayOfDay(record.day);
      if (weekday === null) continue;
      const base = weekday * MINUTES_PER_DAY;
      const limit = Math.min(seq.length, MINUTES_PER_DAY);
      for (let minute = 0; minute < limit; minute += 1) {
        const byte = seq[minute];
        if (!isOperational(byte)) continue;
        const index = base + minute;
        samples[index] += 1;
        if (byte === BYTE.inUse) usage[index] += 1;
      }
    }

    const cells = [];
    let totalSamples = 0;
    for (let weekday = 0; weekday < DAYS_PER_WEEK; weekday += 1) {
      for (let minute = 0; minute < MINUTES_PER_DAY; minute += 1) {
        const index = weekday * MINUTES_PER_DAY + minute;
        const count = samples[index];
        if (!count) continue;
        totalSamples += count;
        cells.push({ weekday, minute, samples: count, usageRatio: usage[index] / count });
      }
    }

    return { cells, samples: totalSamples, minutes: MINUTES_PER_DAY };
  }

  /**
   * 时间剖面：每天 1,440 个 1 分钟槽位（按机型拆成洗衣机 / 烘干机两条线）。
   * 只统计可运营样本；`weekdays` 为空表示所有星期。
   * @param {Array<{machineId: string, day: string, seq: Uint8Array}>} records
   * @param {{kindById?: Record<string, string>, weekdays?: number[]}} [options]
   */
  function buildProfile(records = [], { kindById = {}, weekdays = [] } = {}) {
    const samples = new Uint32Array(MINUTES_PER_DAY);
    const usage = new Uint32Array(MINUTES_PER_DAY);
    const washerSamples = new Uint32Array(MINUTES_PER_DAY);
    const washerUsage = new Uint32Array(MINUTES_PER_DAY);
    const dryerSamples = new Uint32Array(MINUTES_PER_DAY);
    const dryerUsage = new Uint32Array(MINUTES_PER_DAY);

    const weekdayFilter = Array.isArray(weekdays) && weekdays.length > 0 ? new Set(weekdays) : null;

    for (const record of records) {
      const seq = record?.seq;
      if (!seq) continue;
      if (weekdayFilter && !weekdayFilter.has(weekdayOfDay(record.day))) continue;
      const kind = kindById[record.machineId] ?? null;
      const limit = Math.min(seq.length, MINUTES_PER_DAY);
      for (let minute = 0; minute < limit; minute += 1) {
        const byte = seq[minute];
        if (!isOperational(byte)) continue;
        const inUse = byte === BYTE.inUse ? 1 : 0;
        samples[minute] += 1;
        usage[minute] += inUse;
        if (kind === 'washer') {
          washerSamples[minute] += 1;
          washerUsage[minute] += inUse;
        } else if (kind === 'dryer') {
          dryerSamples[minute] += 1;
          dryerUsage[minute] += inUse;
        }
      }
    }

    const slots = Array.from({ length: MINUTES_PER_DAY }, (_, slot) => {
      const count = samples[slot];
      const washerCount = washerSamples[slot];
      const dryerCount = dryerSamples[slot];
      return {
        slot,
        samples: count,
        usageRatio: count ? usage[slot] / count : null,
        washerUsage: washerCount ? washerUsage[slot] / washerCount : null,
        washerSamples: washerCount,
        dryerUsage: dryerCount ? dryerUsage[slot] / dryerCount : null,
        dryerSamples: dryerCount,
      };
    });

    const total = samples.reduce((sum, count) => sum + count, 0);
    return { bucketSeconds: 60, slots, samples: total };
  }

  /**
   * 每台机器的状态占比（In use / Free / Maintenance / Offline / Disabled / On hold / Unknown）。
   * 分母 = 该机器在筛选范围内的全部已观测分钟（含维护/离线等），no_data 不计入。
   * @param {Array<{machineId: string, day: string, seq: Uint8Array}>} records
   * @param {object} [options]
   * @param {Record<string, string>} [options.kindById]
   * @param {Record<string, string>} [options.nameById]
   * @param {string[]} [options.machineIds] 要输出的机器（保持传入顺序）
   * @param {number|null} [options.minute] 只看这一分钟
   * @param {number|null} [options.fromMinute] 分钟区间（含）
   * @param {number|null} [options.toMinute] 分钟区间（含）
   * @param {number[]} [options.weekdays] 只统计这些星期（空 = 全部）
   */
  function buildStateBreakdown(records = [], options = {}) {
    const {
      kindById = {},
      nameById = {},
      machineIds = [],
      minute = null,
      fromMinute = null,
      toMinute = null,
      weekdays = [],
    } = options;

    const hasMinute = Number.isInteger(minute) && minute >= 0 && minute < MINUTES_PER_DAY;
    const hasRange =
      Number.isInteger(fromMinute) &&
      Number.isInteger(toMinute) &&
      fromMinute >= 0 &&
      toMinute < MINUTES_PER_DAY &&
      fromMinute <= toMinute;
    const startMinute = hasMinute ? minute : hasRange ? fromMinute : 0;
    const endMinute = hasMinute ? minute : hasRange ? toMinute : MINUTES_PER_DAY - 1;
    const weekdayFilter = Array.isArray(weekdays) && weekdays.length > 0 ? new Set(weekdays) : null;

    const rows = machineIds.map((id) => ({
      id,
      name: nameById[id] ?? id,
      kind: kindById[id] ?? null,
      samples: 0,
      counts: {
        available: 0,
        inUse: 0,
        maintenance: 0,
        disabled: 0,
        offline: 0,
        onHold: 0,
        unknown: 0,
      },
    }));
    const rowById = new Map(rows.map((row) => [row.id, row]));

    for (const record of records) {
      const row = rowById.get(record?.machineId);
      if (!row) continue;
      const seq = record.seq;
      if (!seq) continue;
      if (weekdayFilter && !weekdayFilter.has(weekdayOfDay(record.day))) continue;
      const limit = Math.min(seq.length, endMinute + 1);
      for (let index = startMinute; index < limit; index += 1) {
        const byte = seq[index];
        if (byte === BYTE.noData) continue;
        row.samples += 1;
        switch (byte) {
          case BYTE.inUse:
            row.counts.inUse += 1;
            break;
          case BYTE.available:
            row.counts.available += 1;
            break;
          case BYTE.maintenance:
            row.counts.maintenance += 1;
            break;
          case BYTE.disabled:
            row.counts.disabled += 1;
            break;
          case BYTE.offline:
            row.counts.offline += 1;
            break;
          case BYTE.onHold:
            row.counts.onHold += 1;
            break;
          default:
            row.counts.unknown += 1;
            break;
        }
      }
    }

    const toRow = (row) => {
      const samples = row.samples;
      const ratio = (count) => (samples > 0 ? count / samples : 0);
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        samples,
        availableRatio: ratio(row.counts.available),
        inUseRatio: ratio(row.counts.inUse),
        maintenanceRatio: ratio(row.counts.maintenance),
        disabledRatio: ratio(row.counts.disabled),
        onHoldRatio: ratio(row.counts.onHold),
        offlineRatio: ratio(row.counts.offline),
        unknownRatio: ratio(row.counts.unknown),
      };
    };

    return {
      rows: rows.filter((row) => row.samples > 0).map(toRow),
      scope: {
        minute: hasMinute ? minute : null,
        fromMinute: hasRange ? fromMinute : null,
        toMinute: hasRange ? toMinute : null,
        weekdays: weekdayFilter ? [...weekdayFilter].sort((a, b) => a - b) : null,
      },
    };
  }

  const api = {
    MINUTES_PER_DAY,
    WEEKDAY_LABELS,
    BYTE,
    isOperational,
    weekdayOfDay,
    buildHeatmap,
    buildProfile,
    buildStateBreakdown,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LaundryAggregate = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
