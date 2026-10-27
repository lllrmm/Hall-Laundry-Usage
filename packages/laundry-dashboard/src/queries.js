/**
 * 只读数据访问层：直接读监控服务写的 SQLite（不跟轮询服务通信，两个服务解耦）。
 *
 * 连接以只读方式打开（失败时退回读写连接 + PRAGMA query_only），
 * 所有查询都带时间范围，按窗口自动分桶，保证返回给前端的点数可控。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { buildBuckets, chooseBucketSeconds, MAX_WINDOW_SECONDS } from './time.js';

/** 机器状态 0/1 → boolean */
const bool = (value) => value === 1 || value === true;

/** 洗衣机是否带洗衣粉：取决于 service_type.value */
const POWDER_BY_SERVICE_VALUE = {
  washing_machine_with_powder: 'with',
  washing_machine_without_powder: 'without',
};

/** @returns {'with'|'without'|null} */
function powderOf(serviceValue) {
  return POWDER_BY_SERVICE_VALUE[serviceValue] ?? null;
}

function emptySeries(since, until, bucketSeconds) {
  return {
    available: false,
    since,
    until,
    bucketSeconds,
    buckets: [],
    machines: [],
    series: {},
    totals: { available: [], inUse: [], machines: [] },
    totalsByKind: {},
  };
}

/** 生成 SQL 的 in (...) 占位符 */
function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(',');
}

export class DashboardDatabase {
  /** @param {string} dbPath SQLite 文件路径 */
  constructor(dbPath) {
    if (typeof dbPath !== 'string' || !dbPath.trim()) {
      throw new Error('DashboardDatabase 需要数据库路径');
    }
    this.filePath = path.resolve(dbPath);
    this._db = null;
  }

  /** 打开（或复用）只读连接；库不存在/打不开时返回 null，由上层降级处理。 */
  _ensure() {
    if (this._db) return this._db;

    try {
      if (!fs.existsSync(this.filePath)) return null;
      const db = new DatabaseSync(this.filePath, { readOnly: true });
      db.prepare('SELECT 1').get();
      this._db = db;
      return db;
    } catch {
      // WAL 尚未 checkpoint 等情况下只读可能失败，退回读写连接但强制 query_only
      try {
        const db = new DatabaseSync(this.filePath);
        db.exec('PRAGMA query_only = ON');
        this._db = db;
        return db;
      } catch {
        return null;
      }
    }
  }

  /** 表是否已建好（监控服务还没跑过时可能为空库） */
  _hasSchema(db) {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'machine_snapshots'")
      .get();
    return Boolean(row);
  }

  close() {
    if (this._db) {
      try {
        this._db.close();
      } catch {
        // ignore
      }
      this._db = null;
    }
  }

  /** 数据库元信息：最后更新时间、最近一次轮询结果、行数 */
  meta() {
    const generatedAt = new Date().toISOString();
    const base = {
      available: false,
      database: this.filePath,
      generatedAt,
      lastObservedAt: null,
      lastPollAt: null,
      lastPoll: null,
      pollCount: 0,
      machineCount: 0,
      snapshots: 0,
    };

    const db = this._ensure();
    if (!db || !this._hasSchema(db)) return base;

    try {
      const snapshots = db
        .prepare(
          `SELECT MAX(observed_at) AS last_observed_at,
                  COUNT(*) AS snapshots,
                  COUNT(DISTINCT machine_id) AS machine_count
           FROM machine_snapshots`,
        )
        .get();

      const poll = db
        .prepare(
          `SELECT started_at, finished_at, duration_ms, ok, error_code, error_message
           FROM poll_runs ORDER BY id DESC LIMIT 1`,
        )
        .get();

      const pollCount = db.prepare('SELECT COUNT(*) AS n FROM poll_runs').get();

      return {
        ...base,
        available: true,
        lastObservedAt: snapshots.last_observed_at ?? null,
        lastPollAt: poll?.finished_at ?? null,
        lastPoll: poll
          ? {
              startedAt: poll.started_at,
              finishedAt: poll.finished_at,
              durationMs: poll.duration_ms,
              ok: bool(poll.ok),
              errorCode: poll.error_code ?? null,
              errorMessage: poll.error_message ?? null,
            }
          : null,
        pollCount: Number(pollCount.n),
        machineCount: Number(snapshots.machine_count),
        snapshots: Number(snapshots.snapshots),
      };
    } catch {
      return base;
    }
  }

  /** 机器维度表（用于前端勾选） */
  machines() {
    const db = this._ensure();
    if (!db || !this._hasSchema(db)) return [];
    try {
      return db
        .prepare(
          `SELECT id, name, kind, room_name, service_value, service_label
           FROM machines ORDER BY kind, name`,
        )
        .all()
        .map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind,
          roomName: row.room_name,
          serviceValue: row.service_value ?? null,
          serviceLabel: row.service_label ?? null,
          powder: powderOf(row.service_value),
        }));
    } catch {
      return [];
    }
  }

  /** 数据库里最新一轮快照（所有机器的"当下"状态） */
  latest() {
    const db = this._ensure();
    if (!db || !this._hasSchema(db)) return [];
    try {
      return db
        .prepare(
          `SELECT s.machine_id AS id, m.name, m.kind, s.observed_at,
                  s.status, s.state, s.available, s.planned_minutes,
                  s.remaining_seconds, s.elapsed_seconds, s.finished_but_not_emptied,
                  s.started_at, s.ends_at,
                  m.service_value AS service_value, m.service_label AS service_label
           FROM machine_snapshots s
           LEFT JOIN machines m ON m.id = s.machine_id
           WHERE s.run_id = (SELECT MAX(run_id) FROM machine_snapshots)
           ORDER BY m.kind, m.name`,
        )
        .all()
        .map((row) => ({
          id: row.id,
          name: row.name ?? row.id,
          kind: row.kind ?? null,
          observedAt: row.observed_at,
          status: row.status,
          state: row.state,
          available: bool(row.available),
          plannedMinutes: row.planned_minutes,
          remainingSeconds: row.remaining_seconds,
          elapsedSeconds: row.elapsed_seconds,
          finishedButNotEmptied: bool(row.finished_but_not_emptied),
          startedAt: row.started_at,
          endsAt: row.ends_at,
          serviceValue: row.service_value ?? null,
          serviceLabel: row.service_label ?? null,
          powder: powderOf(row.service_value),
        }));
    } catch {
      return [];
    }
  }

  /**
   * 时间序列（按桶聚合）。
   * @param {object} options
   * @param {string|null} options.since ISO 时间；null 表示从最早数据开始（上限 MAX_WINDOW_SECONDS）
   * @param {number} options.windowSeconds 窗口长度（用于选分桶粒度）
   * @param {string[]} [options.machineIds] 只统计这些机器；空表示全部
   */
  series({ since = null, windowSeconds = 24 * 3600, machineIds = [] } = {}) {
    const now = Date.now();
    const db = this._ensure();

    if (!db || !this._hasSchema(db)) {
      return emptySeries(since, new Date(now).toISOString(), chooseBucketSeconds(windowSeconds));
    }

    let effectiveSince = since;
    if (!effectiveSince) {
      try {
        const first = db.prepare('SELECT MIN(observed_at) AS first FROM machine_snapshots').get();
        effectiveSince = first?.first ?? new Date(now).toISOString();
      } catch {
        effectiveSince = new Date(now).toISOString();
      }
      // "全部"窗口也限制在 MAX_WINDOW_SECONDS 内
      const floor = new Date(now - MAX_WINDOW_SECONDS * 1000).toISOString();
      if (effectiveSince < floor) effectiveSince = floor;
    }

    const actualWindowSeconds = Math.max(60, Math.round((now - Date.parse(effectiveSince)) / 1000));
    const bucketSeconds = chooseBucketSeconds(actualWindowSeconds);
    // SQL 里的 bucket = epoch秒 / bucketSeconds，这里换回 ISO 时间
    const bucketToIso = (bucket) => new Date(Number(bucket) * bucketSeconds * 1000).toISOString();

    const filterIds = machineIds.filter((id) => typeof id === 'string' && id.length > 0);
    const idFilter = filterIds.length > 0 ? `AND machine_id IN (${placeholders(filterIds.length)})` : '';
    const idFilterAliased = filterIds.length > 0 ? `AND s.machine_id IN (${placeholders(filterIds.length)})` : '';
    const idParams = filterIds;

    try {
      const rows = db
        .prepare(
          `SELECT machine_id AS id,
                  CAST(CAST(strftime('%s', observed_at) AS INTEGER) / ? AS INTEGER) AS bucket,
                  AVG(available) AS available_ratio,
                  AVG(CASE WHEN state = 'in_use' THEN 1.0 ELSE 0 END) AS in_use_ratio,
                  COUNT(*) AS samples
           FROM machine_snapshots
           WHERE observed_at >= ? ${idFilter}
           GROUP BY id, bucket
           ORDER BY bucket`,
        )
        .all(bucketSeconds, effectiveSince, ...idParams);

      const totalsRows = db
        .prepare(
          `SELECT CAST(CAST(strftime('%s', observed_at) AS INTEGER) / ? AS INTEGER) AS bucket,
                  SUM(available) AS available_count,
                  SUM(CASE WHEN state = 'in_use' THEN 1 ELSE 0 END) AS in_use_count,
                  COUNT(*) AS samples,
                  COUNT(DISTINCT machine_id) AS machine_count
           FROM machine_snapshots
           WHERE observed_at >= ? ${idFilter}
           GROUP BY bucket
           ORDER BY bucket`,
        )
        .all(bucketSeconds, effectiveSince, ...idParams);

      // 按机型聚合（washer / dryer 各自一条线）
      const byKindRows = db
        .prepare(
          `SELECT CAST(CAST(strftime('%s', s.observed_at) AS INTEGER) / ? AS INTEGER) AS bucket,
                  COALESCE(m.kind, 'unknown') AS kind,
                  SUM(s.available) AS available_count,
                  SUM(CASE WHEN s.state = 'in_use' THEN 1 ELSE 0 END) AS in_use_count,
                  COUNT(*) AS samples,
                  COUNT(DISTINCT s.machine_id) AS machine_count
           FROM machine_snapshots s
           LEFT JOIN machines m ON m.id = s.machine_id
           WHERE s.observed_at >= ? ${idFilterAliased}
           GROUP BY bucket, kind
           ORDER BY bucket`,
        )
        .all(bucketSeconds, effectiveSince, ...idParams);

      const bucketIsoList = buildBuckets(effectiveSince, now, bucketSeconds);
      const indexByBucket = new Map(bucketIsoList.map((iso, index) => [iso, index]));

      const machineList = this._selectedMachines(filterIds);
      /** @type {Record<string, {availableRatio: (number|null)[], inUseRatio: (number|null)[], samples: (number|null)[]}>} */
      const series = {};
      for (const machine of machineList) {
        series[machine.id] = {
          availableRatio: new Array(bucketIsoList.length).fill(null),
          inUseRatio: new Array(bucketIsoList.length).fill(null),
          samples: new Array(bucketIsoList.length).fill(null),
        };
      }

      for (const row of rows) {
        const index = indexByBucket.get(bucketToIso(row.bucket));
        if (index === undefined) continue;
        const target = series[row.id];
        if (!target) continue;
        target.availableRatio[index] = Number(row.available_ratio);
        target.inUseRatio[index] = Number(row.in_use_ratio);
        target.samples[index] = Number(row.samples);
      }

      const totals = {
        available: new Array(bucketIsoList.length).fill(null),
        inUse: new Array(bucketIsoList.length).fill(null),
        machines: new Array(bucketIsoList.length).fill(null),
      };

      for (const row of totalsRows) {
        const index = indexByBucket.get(bucketToIso(row.bucket));
        if (index === undefined) continue;
        const machineCount = Number(row.machine_count);
        const samples = Number(row.samples) || 1;
        totals.available[index] = Number(((Number(row.available_count) / samples) * machineCount).toFixed(2));
        totals.inUse[index] = Number(((Number(row.in_use_count) / samples) * machineCount).toFixed(2));
        totals.machines[index] = machineCount;
      }

      /** 按机型的平均台数（available / inUse） */
      const totalsByKind = {};
      for (const row of byKindRows) {
        const index = indexByBucket.get(bucketToIso(row.bucket));
        if (index === undefined) continue;

        const kind = String(row.kind);
        totalsByKind[kind] ??= {
          available: new Array(bucketIsoList.length).fill(null),
          inUse: new Array(bucketIsoList.length).fill(null),
          machines: new Array(bucketIsoList.length).fill(null),
        };

        const machineCount = Number(row.machine_count);
        const samples = Number(row.samples) || 1;
        totalsByKind[kind].available[index] = Number(((Number(row.available_count) / samples) * machineCount).toFixed(2));
        totalsByKind[kind].inUse[index] = Number(((Number(row.in_use_count) / samples) * machineCount).toFixed(2));
        totalsByKind[kind].machines[index] = machineCount;
      }

      return {
        available: true,
        since: effectiveSince,
        until: new Date(now).toISOString(),
        bucketSeconds,
        buckets: bucketIsoList,
        machines: machineList,
        series,
        totals,
        totalsByKind,
      };
    } catch {
      return emptySeries(effectiveSince, new Date(now).toISOString(), bucketSeconds);
    }
  }

  /** 每台机器的状态占比（柱状图用）；可按日期范围 / 机器 / 星期几 / 分钟区间筛选 */
  bars({
    since = null,
    until = null,
    machineIds = [],
    weekday = null,
    weekdays = [],
    hour = null,
    minute = null,
    fromMinute = null,
    toMinute = null,
  } = {}) {
    const db = this._ensure();
    if (!db || !this._hasSchema(db)) return { available: false, since, until: null, rows: [] };

    const filterIds = machineIds.filter((id) => typeof id === 'string' && id.length > 0);
    const idFilter = filterIds.length > 0 ? `AND s.machine_id IN (${placeholders(filterIds.length)})` : '';
    const params = [since ?? '0000-01-01T00:00:00.000Z', ...filterIds];

    let scopeFilter = '';
    if (until) {
      scopeFilter += ' AND s.observed_at < ?';
      params.push(until);
    }
    const minuteExpr = `(CAST(strftime('%H', s.observed_at, 'localtime') AS INTEGER) * 60
                         + CAST(strftime('%M', s.observed_at, 'localtime') AS INTEGER))`;
    const hasRange =
      Number.isInteger(fromMinute) &&
      Number.isInteger(toMinute) &&
      fromMinute >= 0 &&
      toMinute <= 1439 &&
      fromMinute <= toMinute;
    if (hasRange) {
      scopeFilter += ` AND ${minuteExpr} BETWEEN ? AND ?`;
      params.push(fromMinute, toMinute);
    }
    const hasMinute = Number.isInteger(minute) && minute >= 0 && minute <= 1439;
    const weekdayList = (Array.isArray(weekdays) ? weekdays : []).filter(
      (value) => Number.isInteger(value) && value >= 0 && value <= 6,
    );
    const hasWeekdays = weekdayList.length > 0;
    const hasWeekday = Number.isInteger(weekday) && weekday >= 0 && weekday <= 6;
    const hasHour = Number.isInteger(hour) && hour >= 0 && hour <= 23;
    if (hasMinute) {
      scopeFilter += ` AND ${minuteExpr} = ?`;
      params.push(minute);
    }
    if (hasWeekdays) {
      // 热力图 weekday 0=周一 … 6=周日，支持多选
      scopeFilter += ` AND (CAST(strftime('%w', s.observed_at, 'localtime') AS INTEGER) + 6) % 7 IN (${weekdayList.map(() => '?').join(', ')})`;
      params.push(...weekdayList);
    } else if (hasWeekday) {
      scopeFilter += ` AND (CAST(strftime('%w', s.observed_at, 'localtime') AS INTEGER) + 6) % 7 = ?`;
      params.push(weekday);
    }
    if (hasHour) {
      scopeFilter += ` AND CAST(strftime('%H', s.observed_at, 'localtime') AS INTEGER) = ?`;
      params.push(hour);
    }

    try {
      const rows = db
        .prepare(
          `SELECT s.machine_id AS id,
                  COALESCE(m.name, s.machine_id) AS name,
                  m.kind AS kind,
                  COUNT(*) AS samples,
                  AVG(s.available) AS available_ratio,
                  AVG(CASE WHEN s.state = 'in_use' THEN 1.0 ELSE 0 END) AS in_use_ratio,
                  AVG(CASE WHEN s.available = 0 AND s.state != 'in_use' THEN 1.0 ELSE 0 END) AS unavailable_ratio,
                  MIN(s.observed_at) AS first_seen_at,
                  MAX(s.observed_at) AS last_seen_at
           FROM machine_snapshots s
           LEFT JOIN machines m ON m.id = s.machine_id
           WHERE s.observed_at >= ? ${idFilter} ${scopeFilter}
           GROUP BY s.machine_id
           ORDER BY m.kind DESC, name`,
        )
        .all(...params)
        .map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind,
          samples: Number(row.samples),
          availableRatio: Number(row.available_ratio),
          inUseRatio: Number(row.in_use_ratio),
          unavailableRatio: Number(row.unavailable_ratio),
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
        }));

      const observedSince = rows.length
        ? rows.reduce((earliest, row) => (row.firstSeenAt < earliest ? row.firstSeenAt : earliest), rows[0].firstSeenAt)
        : null;
      const observedUntil = rows.length
        ? rows.reduce((latest, row) => (row.lastSeenAt > latest ? row.lastSeenAt : latest), rows[0].lastSeenAt)
        : null;
      const effectiveSince = since ?? observedSince;
      const until = hasWeekday || hasHour ? observedUntil : new Date().toISOString();

      return {
        available: true,
        since: effectiveSince,
        until,
        scope: {
          weekday: hasWeekday ? weekday : null,
          weekdays: hasWeekdays ? weekdayList : null,
          hour: hasHour ? hour : null,
          minute: hasMinute ? minute : null,
          fromMinute: hasRange ? fromMinute : null,
          toMinute: hasRange ? toMinute : null,
        },
        rows,
      };
    } catch {
      return { available: false, since, until: null, rows: [] };
    }
  }

  /** 按本地小时聚合的使用率 / 空闲率 */
  hourly({ since = null, machineIds = [] } = {}) {
    const db = this._ensure();
    if (!db || !this._hasSchema(db)) return { available: false, since, hours: [] };

    const filterIds = machineIds.filter((id) => typeof id === 'string' && id.length > 0);
    const idFilter = filterIds.length > 0 ? `AND machine_id IN (${placeholders(filterIds.length)})` : '';
    const params = [since ?? '0000-01-01T00:00:00.000Z', ...filterIds];

    try {
      const rows = db
        .prepare(
          `SELECT CAST(strftime('%H', observed_at, 'localtime') AS INTEGER) AS hour,
                  AVG(available) AS free_ratio,
                  AVG(CASE WHEN state = 'in_use' THEN 1.0 ELSE 0 END) AS usage_ratio,
                  COUNT(*) AS samples
           FROM machine_snapshots
           WHERE observed_at >= ? ${idFilter}
           GROUP BY hour
           ORDER BY hour`,
        )
        .all(...params);

      const byHour = new Map(rows.map((row) => [Number(row.hour), row]));
      const hours = Array.from({ length: 24 }, (_, hour) => {
        const row = byHour.get(hour);
        return {
          hour,
          freeRatio: row ? Number(row.free_ratio) : null,
          usageRatio: row ? Number(row.usage_ratio) : null,
          samples: row ? Number(row.samples) : 0,
        };
      });

      return { available: true, since, hours };
    } catch {
      return { available: false, since, hours: [] };
    }
  }

  /** 星期 × 分钟热力图：每格的平均使用率（weekday 0 = 周一 … 6 = 周日，minute 0–1439） */
  heatmap({ since = null, until = null, machineIds = [] } = {}) {
    const db = this._ensure();
    if (!db || !this._hasSchema(db)) return { available: false, since, until: null, cells: [] };

    const filterIds = machineIds.filter((id) => typeof id === 'string' && id.length > 0);
    const idFilter = filterIds.length > 0 ? `AND machine_id IN (${placeholders(filterIds.length)})` : '';
    const params = [since ?? '0000-01-01T00:00:00.000Z', ...filterIds];
    let untilFilter = '';
    if (until) {
      untilFilter = 'AND observed_at < ?';
      params.push(until);
    }

    try {
      const rows = db
        .prepare(
          `SELECT (CAST(strftime('%w', observed_at, 'localtime') AS INTEGER) + 6) % 7 AS weekday,
                  CAST(strftime('%H', observed_at, 'localtime') AS INTEGER) * 60
                    + CAST(strftime('%M', observed_at, 'localtime') AS INTEGER) AS minute,
                  COUNT(*) AS samples,
                  AVG(CASE WHEN state = 'in_use' THEN 1.0 ELSE 0 END) AS usage_ratio
           FROM machine_snapshots
           WHERE observed_at >= ? ${idFilter} ${untilFilter}
           GROUP BY weekday, minute
           ORDER BY weekday, minute`,
        )
        .all(...params);

      const cells = rows.map((row) => ({
        weekday: Number(row.weekday),
        minute: Number(row.minute),
        samples: Number(row.samples),
        usageRatio: Number(row.usage_ratio),
      }));

      const span = db
        .prepare(
          `SELECT MIN(observed_at) AS first, MAX(observed_at) AS last
           FROM machine_snapshots
           WHERE observed_at >= ? ${idFilter} ${untilFilter}`,
        )
        .get(...params);

      return {
        available: true,
        since: since ?? span?.first ?? null,
        until: span?.last ?? until ?? null,
        cells,
      };
    } catch {
      return { available: false, since, until: null, cells: [] };
    }
  }

  /**
   * 按 5 分钟精度的时间剖面（每天 288 个槽位）。
   * weekday 0=周一…6=周日；不传则汇总所有天（按样本数加权由调用方处理，这里返回逐槽聚合值）。
   */
  profile({ since = null, until = null, weekday = null, weekdays = [], bucketSeconds = 300 } = {}) {
    const db = this._ensure();
    const slotsPerDay = Math.round(86400 / bucketSeconds);
    const slotsPerHour = slotsPerDay / 24;
    if (!db || !this._hasSchema(db)) {
      return { available: false, since, until: null, bucketSeconds, slots: [] };
    }

    const params = [since ?? '0000-01-01T00:00:00.000Z'];
    let weekdayFilter = '';
    const weekdayList = (Array.isArray(weekdays) ? weekdays : []).filter(
      (value) => Number.isInteger(value) && value >= 0 && value <= 6,
    );
    if (weekdayList.length > 0) {
      // SQLite %w: 0=周日 … 6=周六；我们的 0=周一
      weekdayFilter = `AND CAST(strftime('%w', s.observed_at, 'localtime') AS INTEGER) IN (${weekdayList.map(() => '?').join(', ')})`;
      params.push(...weekdayList.map((value) => (value + 1) % 7));
    } else if (weekday !== null && Number.isInteger(weekday) && weekday >= 0 && weekday <= 6) {
      weekdayFilter = `AND CAST(strftime('%w', s.observed_at, 'localtime') AS INTEGER) = ?`;
      params.push((weekday + 1) % 7);
    }
    let untilFilter = '';
    if (until) {
      untilFilter = 'AND s.observed_at < ?';
      params.push(until);
    }

    try {
      const rows = db
        .prepare(
          `SELECT CAST(strftime('%H', s.observed_at, 'localtime') AS INTEGER) * ${slotsPerHour}
                  + CAST(strftime('%M', s.observed_at, 'localtime') AS INTEGER) / ${Math.max(1, Math.round(bucketSeconds / 60))} AS slot,
                  m.kind AS kind,
                  COUNT(*) AS samples,
                  AVG(CASE WHEN s.state = 'in_use' THEN 1.0 ELSE 0 END) AS usage_ratio
           FROM machine_snapshots s
           LEFT JOIN machines m ON m.id = s.machine_id
           WHERE s.observed_at >= ? ${weekdayFilter} ${untilFilter}
           GROUP BY slot, kind
           ORDER BY slot`,
        )
        .all(...params);

      const bySlot = new Map();
      for (const row of rows) {
        const slot = Number(row.slot);
        let entry = bySlot.get(slot);
        if (!entry) {
          entry = { samples: 0, weighted: 0, washerSamples: 0, washerWeighted: 0, dryerSamples: 0, dryerWeighted: 0 };
          bySlot.set(slot, entry);
        }
        const samples = Number(row.samples);
        const usage = Number(row.usage_ratio);
        entry.samples += samples;
        entry.weighted += usage * samples;
        if (row.kind === 'washer') {
          entry.washerSamples += samples;
          entry.washerWeighted += usage * samples;
        } else if (row.kind === 'dryer') {
          entry.dryerSamples += samples;
          entry.dryerWeighted += usage * samples;
        }
      }

      const slots = Array.from({ length: slotsPerDay }, (_, slot) => {
        const entry = bySlot.get(slot);
        if (!entry) {
          return {
            slot,
            samples: 0,
            usageRatio: null,
            washerUsage: null,
            washerSamples: 0,
            dryerUsage: null,
            dryerSamples: 0,
          };
        }
        return {
          slot,
          samples: entry.samples,
          usageRatio: entry.samples ? entry.weighted / entry.samples : null,
          washerUsage: entry.washerSamples ? entry.washerWeighted / entry.washerSamples : null,
          washerSamples: entry.washerSamples,
          dryerUsage: entry.dryerSamples ? entry.dryerWeighted / entry.dryerSamples : null,
          dryerSamples: entry.dryerSamples,
        };
      });

      const span = db
        .prepare(
          `SELECT MIN(s.observed_at) AS first, MAX(s.observed_at) AS last
           FROM machine_snapshots s
           WHERE s.observed_at >= ? ${weekdayFilter} ${untilFilter}`,
        )
        .get(...params);

      return {
        available: true,
        since: since ?? span?.first ?? null,
        until: span?.last ?? until ?? null,
        bucketSeconds,
        weekday,
        slots,
      };
    } catch {
      return { available: false, since, until: null, bucketSeconds, slots: [] };
    }
  }

  /** 每天在指定分钟区间内的使用率（热力图拖选时段后的"每日剖面"） */
  dailyProfile({ since = null, until = null, machineIds = [], fromMinute = null, toMinute = null } = {}) {
    const db = this._ensure();
    if (!db || !this._hasSchema(db)) return { available: false, since, until: null, days: [] };

    const filterIds = machineIds.filter((id) => typeof id === 'string' && id.length > 0);
    const idFilter = filterIds.length > 0 ? `AND s.machine_id IN (${placeholders(filterIds.length)})` : '';
    const params = [since ?? '0000-01-01T00:00:00.000Z', ...filterIds];

    let untilFilter = '';
    if (until) {
      untilFilter = 'AND s.observed_at < ?';
      params.push(until);
    }

    const minuteExpr = `(CAST(strftime('%H', s.observed_at, 'localtime') AS INTEGER) * 60
                        + CAST(strftime('%M', s.observed_at, 'localtime') AS INTEGER))`;
    let rangeFilter = '';
    if (
      Number.isInteger(fromMinute) &&
      Number.isInteger(toMinute) &&
      fromMinute >= 0 &&
      toMinute <= 1439 &&
      fromMinute <= toMinute
    ) {
      rangeFilter = `AND ${minuteExpr} BETWEEN ? AND ?`;
      params.push(fromMinute, toMinute);
    }

    try {
      const rows = db
        .prepare(
          `SELECT date(s.observed_at, 'localtime') AS day,
                  COUNT(*) AS samples,
                  SUM(CASE WHEN s.state = 'in_use' THEN 1 ELSE 0 END) AS in_use,
                  SUM(CASE WHEN m.kind = 'washer' THEN 1 ELSE 0 END) AS washer_samples,
                  SUM(CASE WHEN m.kind = 'washer' AND s.state = 'in_use' THEN 1 ELSE 0 END) AS washer_in_use,
                  SUM(CASE WHEN m.kind = 'dryer' THEN 1 ELSE 0 END) AS dryer_samples,
                  SUM(CASE WHEN m.kind = 'dryer' AND s.state = 'in_use' THEN 1 ELSE 0 END) AS dryer_in_use
           FROM machine_snapshots s
           LEFT JOIN machines m ON m.id = s.machine_id
           WHERE s.observed_at >= ? ${idFilter} ${untilFilter} ${rangeFilter}
           GROUP BY day
           ORDER BY day`,
        )
        .all(...params);

      const days = rows.map((row) => {
        const samples = Number(row.samples);
        const washerSamples = Number(row.washer_samples);
        const dryerSamples = Number(row.dryer_samples);
        return {
          day: row.day,
          samples,
          usageRatio: samples ? Number(row.in_use) / samples : null,
          washerSamples,
          washerUsage: washerSamples ? Number(row.washer_in_use) / washerSamples : null,
          dryerSamples,
          dryerUsage: dryerSamples ? Number(row.dryer_in_use) / dryerSamples : null,
        };
      });

      const span = db
        .prepare(
          `SELECT MIN(s.observed_at) AS first, MAX(s.observed_at) AS last
           FROM machine_snapshots s
           WHERE s.observed_at >= ? ${idFilter} ${untilFilter} ${rangeFilter}`,
        )
        .get(...params);

      return {
        available: true,
        since: since ?? span?.first ?? null,
        until: span?.last ?? until ?? null,
        fromMinute,
        toMinute,
        days,
      };
    } catch {
      return { available: false, since, until: null, days: [] };
    }
  }

  /** 根据 id 列表返回机器信息（保持 kind/name 顺序） */
  _selectedMachines(machineIds) {
    const all = this.machines();
    if (machineIds.length === 0) return all;
    const wanted = new Set(machineIds);
    return all.filter((machine) => wanted.has(machine.id));
  }
}
