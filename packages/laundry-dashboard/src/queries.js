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
        .prepare('SELECT id, name, kind, room_name FROM machines ORDER BY kind, name')
        .all()
        .map((row) => ({ id: row.id, name: row.name, kind: row.kind, roomName: row.room_name }));
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
                  s.started_at, s.ends_at
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

      return {
        available: true,
        since: effectiveSince,
        until: new Date(now).toISOString(),
        bucketSeconds,
        buckets: bucketIsoList,
        machines: machineList,
        series,
        totals,
      };
    } catch {
      return emptySeries(effectiveSince, new Date(now).toISOString(), bucketSeconds);
    }
  }

  /** 时间窗内每台机器的状态占比（柱状图用） */
  bars({ since = null, machineIds = [] } = {}) {
    const db = this._ensure();
    if (!db || !this._hasSchema(db)) return { available: false, since, rows: [] };

    const filterIds = machineIds.filter((id) => typeof id === 'string' && id.length > 0);
    const idFilter = filterIds.length > 0 ? `AND s.machine_id IN (${placeholders(filterIds.length)})` : '';
    const params = [since ?? '0000-01-01T00:00:00.000Z', ...filterIds];

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
           WHERE s.observed_at >= ? ${idFilter}
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

      return { available: true, since, rows };
    } catch {
      return { available: false, since, rows: [] };
    }
  }

  /** 按本地小时聚合的空闲率（找最佳时段用） */
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
          samples: row ? Number(row.samples) : 0,
        };
      });

      return { available: true, since, hours };
    } catch {
      return { available: false, since, hours: [] };
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
