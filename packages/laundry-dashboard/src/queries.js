/**
 * 只读数据访问层：直接读监控服务写的 SQLite（不跟轮询服务通信，两个服务解耦）。
 *
 * 连接以只读方式打开（失败时退回读写连接 + PRAGMA query_only）。
 * 看板只需要：元信息、机器维度 + 最新状态；历史图表聚合全部在浏览器端完成。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
      generatedAt,
      firstObservedAt: null,
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
          `SELECT MIN(observed_at) AS first_observed_at,
                  MAX(observed_at) AS last_observed_at,
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
        firstObservedAt: snapshots.first_observed_at ?? null,
        lastObservedAt: snapshots.last_observed_at ?? null,
        lastPollAt: poll?.finished_at ?? null,
        lastPoll: poll
          ? {
              startedAt: poll.started_at,
              finishedAt: poll.finished_at,
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

  /**
   * 机器维度 + 最新一轮状态（合并后的 machines 列表）。
   * 没有快照的机器也会返回，状态字段为 null / false。
   */
  machinesWithLatest() {
    const db = this._ensure();
    if (!db || !this._hasSchema(db)) return [];
    try {
      return db
        .prepare(
          `SELECT m.id, m.name, m.kind, m.room_name, m.service_value, m.service_label,
                  s.observed_at, s.status, s.state, s.available, s.planned_minutes,
                  s.remaining_seconds, s.elapsed_seconds, s.finished_but_not_emptied,
                  s.started_at, s.ends_at
           FROM machines m
           LEFT JOIN machine_snapshots s
             ON s.machine_id = m.id
            AND s.run_id = (SELECT MAX(run_id) FROM machine_snapshots)
           ORDER BY m.kind, m.name`,
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
          observedAt: row.observed_at ?? null,
          status: row.status ?? null,
          state: row.state ?? null,
          available: bool(row.available),
          plannedMinutes: row.planned_minutes ?? null,
          remainingSeconds: row.remaining_seconds ?? null,
          elapsedSeconds: row.elapsed_seconds ?? null,
          finishedButNotEmptied: bool(row.finished_but_not_emptied),
          startedAt: row.started_at ?? null,
          endsAt: row.ends_at ?? null,
        }));
    } catch {
      return [];
    }
  }
}
