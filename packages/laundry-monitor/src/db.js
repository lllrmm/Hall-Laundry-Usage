/**
 * SQLite 存储层（node:sqlite，零原生依赖）。
 *
 * 设计目标：既能做"最近状态"查询，也能做长期分析。
 *
 *   poll_runs           每次轮询一行（成功/失败、耗时、统计快照）
 *   machines            机器维度表（名称、机型）
 *   machine_snapshots   每台机器每次轮询一行（时间序列，分析的主体）
 *   machine_transitions 状态发生变化时的跳变记录（用于算使用周期）
 *   machine_last_state  上一轮状态缓存（判断跳变用，避免全表扫描）
 *
 * 时间统一存 ISO 8601 UTC 字符串（可按字典序比较/范围查询）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 1;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT    NOT NULL,
  finished_at     TEXT    NOT NULL,
  duration_ms     INTEGER NOT NULL,
  ok              INTEGER NOT NULL,
  error_code      TEXT,
  error_message   TEXT,
  machine_count   INTEGER,
  available_count INTEGER,
  in_use_count    INTEGER,
  unavailable_count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_poll_runs_started ON poll_runs(started_at);

CREATE TABLE IF NOT EXISTS machines (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT,
  service_type_id TEXT,
  service_value   TEXT,
  service_label   TEXT,
  room_name       TEXT,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS machine_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES poll_runs(id) ON DELETE CASCADE,
  machine_id  TEXT    NOT NULL,
  observed_at TEXT    NOT NULL,
  status      TEXT,
  state       TEXT,
  available   INTEGER NOT NULL,
  planned_minutes INTEGER,
  started_at  TEXT,
  ends_at     TEXT,
  remaining_seconds INTEGER,
  elapsed_seconds   INTEGER,
  finished_but_not_emptied INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_machine_time ON machine_snapshots(machine_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_observed ON machine_snapshots(observed_at);

CREATE TABLE IF NOT EXISTS machine_transitions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id  TEXT    NOT NULL,
  observed_at TEXT    NOT NULL,
  from_status TEXT,
  from_state  TEXT,
  to_status   TEXT    NOT NULL,
  to_state    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transitions_machine_time ON machine_transitions(machine_id, observed_at);

CREATE TABLE IF NOT EXISTS machine_last_state (
  machine_id TEXT PRIMARY KEY,
  status     TEXT NOT NULL,
  state      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const MAX_ERROR_MESSAGE = 500;

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
  }
  throw new TypeError(`无法转换为时间：${String(value)}`);
}

function toBoolInt(value) {
  return value ? 1 : 0;
}

/** 数据库访问对象。用完记得 close()。 */
export class MonitorDatabase {
  /**
   * @param {string} filePath SQLite 文件路径（目录不存在会自动创建）
   * @param {object} [options]
   * @param {'WAL'|'DELETE'|'TRUNCATE'|'MEMORY'} [options.journalMode] 日志模式，默认 WAL（并发读更好）
   */
  constructor(filePath, { journalMode = 'WAL' } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('MonitorDatabase 需要数据库文件路径');
    }
    const modes = new Set(['WAL', 'DELETE', 'TRUNCATE', 'MEMORY', 'PERSIST', 'OFF']);
    const mode = String(journalMode).toUpperCase();
    if (!modes.has(mode)) {
      throw new Error(`不支持的 journalMode：${journalMode}`);
    }

    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    this.db = new DatabaseSync(this.filePath);
    this.db.exec(`PRAGMA journal_mode = ${mode}`);
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.db
      .prepare('INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', String(SCHEMA_VERSION));

    this._stmts = {
      insertRun: this.db.prepare(`
        INSERT INTO poll_runs
          (started_at, finished_at, duration_ms, ok, error_code, error_message,
           machine_count, available_count, in_use_count, unavailable_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      upsertMachine: this.db.prepare(`
        INSERT INTO machines (id, name, kind, service_type_id, service_value, service_label, room_name, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          kind = excluded.kind,
          service_type_id = excluded.service_type_id,
          service_value = excluded.service_value,
          service_label = excluded.service_label,
          room_name = excluded.room_name,
          last_seen_at = excluded.last_seen_at
      `),
      insertSnapshot: this.db.prepare(`
        INSERT INTO machine_snapshots
          (run_id, machine_id, observed_at, status, state, available, planned_minutes,
           started_at, ends_at, remaining_seconds, elapsed_seconds, finished_but_not_emptied)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertTransition: this.db.prepare(`
        INSERT INTO machine_transitions (machine_id, observed_at, from_status, from_state, to_status, to_state)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      getLastState: this.db.prepare('SELECT status, state FROM machine_last_state WHERE machine_id = ?'),
      upsertLastState: this.db.prepare(`
        INSERT INTO machine_last_state (machine_id, status, state, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(machine_id) DO UPDATE SET
          status = excluded.status, state = excluded.state, updated_at = excluded.updated_at
      `),
      lastRun: this.db.prepare('SELECT * FROM poll_runs ORDER BY id DESC LIMIT 1'),
    };
  }

  /** 当前 schema 版本 */
  get schemaVersion() {
    return SCHEMA_VERSION;
  }

  /** 记录一次成功的轮询（一个事务内写入 run + 机器 + 快照 + 跳变） */
  recordSuccessfulPoll(status, { startedAt, finishedAt, durationMs }) {
    const startedIso = toIso(startedAt);
    const finishedIso = toIso(finishedAt);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const runResult = this._stmts.insertRun.run(
        startedIso,
        finishedIso,
        Math.max(0, Math.round(durationMs)),
        1,
        null,
        null,
        status.counts.total,
        status.counts.available,
        status.counts.inUse,
        status.counts.unavailable,
      );
      const runId = Number(runResult.lastInsertRowid);

      const transitions = [];

      for (const machine of status.machines) {
        const observedAt = finishedIso;

        this._stmts.upsertMachine.run(
          String(machine.id),
          String(machine.name ?? machine.id),
          machine.kind ?? null,
          machine.serviceTypeId ?? null,
          machine.serviceValue ?? null,
          machine.serviceLabel ?? null,
          machine.roomName ?? null,
          startedIso,
          observedAt,
        );

        this._stmts.insertSnapshot.run(
          runId,
          String(machine.id),
          observedAt,
          machine.status ?? null,
          machine.state ?? null,
          toBoolInt(machine.available),
          machine.plannedMinutes ?? null,
          machine.startedAt ? toIso(machine.startedAt) : null,
          machine.endsAt ? toIso(machine.endsAt) : null,
          machine.remainingSeconds ?? null,
          machine.elapsedSeconds ?? null,
          toBoolInt(machine.finishedButNotEmptied),
        );

        const previous = this._stmts.getLastState.get(String(machine.id));
        const changed = !previous || previous.state !== machine.state || previous.status !== machine.status;

        if (changed) {
          if (previous) {
            // 注意列顺序：from_status, from_state, to_status, to_state
            this._stmts.insertTransition.run(
              String(machine.id),
              observedAt,
              previous.status ?? null,
              previous.state ?? null,
              String(machine.status),
              String(machine.state),
            );
            transitions.push({
              machineId: machine.id,
              name: machine.name,
              fromState: previous.state,
              toState: machine.state,
              fromStatus: previous.status,
              toStatus: machine.status,
              observedAt,
            });
          } else {
            // 首次见到这台机器，记录一条 from 为空的跳变，方便追溯
            this._stmts.insertTransition.run(
              String(machine.id),
              observedAt,
              null,
              null,
              String(machine.status),
              String(machine.state),
            );
            transitions.push({
              machineId: machine.id,
              name: machine.name,
              fromState: null,
              toState: machine.state,
              fromStatus: null,
              toStatus: machine.status,
              observedAt,
            });
          }

          this._stmts.upsertLastState.run(String(machine.id), String(machine.status), String(machine.state), observedAt);
        }
      }

      this.db.exec('COMMIT');
      return { runId, snapshotCount: status.machines.length, transitions };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 记录一次失败的轮询（不影响上一轮的 machine_last_state） */
  recordFailedPoll({ startedAt, finishedAt, durationMs, error }) {
    const code = error?.code === undefined || error?.code === null ? null : String(error.code);
    const message = String(error?.message ?? error ?? 'unknown error').slice(0, MAX_ERROR_MESSAGE);
    const result = this._stmts.insertRun.run(
      toIso(startedAt),
      toIso(finishedAt),
      Math.max(0, Math.round(durationMs)),
      0,
      code,
      message,
      null,
      null,
      null,
      null,
    );
    return { runId: Number(result.lastInsertRowid), code, message };
  }

  /** 最近一次轮询记录 */
  lastRun() {
    return this._stmts.lastRun.get() ?? null;
  }

  /** 总行数统计 */
  totals() {
    const count = (table) => Number(this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    return {
      runs: count('poll_runs'),
      snapshots: count('machine_snapshots'),
      transitions: count('machine_transitions'),
      machines: count('machines'),
    };
  }

  /**
   * 汇总统计（供分析/看板用）。
   * @param {object} [options]
   * @param {string|null} [options.since] ISO 时间，只统计此时间之后的数据
   */
  stats({ since = null } = {}) {
    const sinceIso = since ? toIso(since) : null;
    const runWhere = sinceIso ? 'WHERE started_at >= ?' : '';
    const runParams = sinceIso ? [sinceIso] : [];

    const runRow = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(ok), 0) AS ok,
                COALESCE(SUM(1 - ok), 0) AS failed,
                MIN(started_at) AS first_at,
                MAX(started_at) AS last_at,
                AVG(duration_ms) AS avg_duration_ms
         FROM poll_runs ${runWhere}`,
      )
      .get(...runParams);

    const errorRows = this.db
      .prepare(
        `SELECT error_code AS code, COUNT(*) AS n
         FROM poll_runs ${runWhere ? runWhere + ' AND' : 'WHERE'} ok = 0
         GROUP BY error_code
         ORDER BY n DESC`,
      )
      .all(...runParams);

    const sinceSnapshotted = sinceIso ? 'WHERE s.observed_at >= ?' : '';
    const machineRows = this.db
      .prepare(
        `SELECT s.machine_id AS id,
                COALESCE(m.name, s.machine_id) AS name,
                m.kind AS kind,
                COUNT(*) AS samples,
                COALESCE(SUM(s.available), 0) AS available_samples,
                COALESCE(SUM(CASE WHEN s.state = 'in_use' THEN 1 ELSE 0 END), 0) AS in_use_samples,
                COALESCE(SUM(CASE WHEN s.available = 0 AND s.state != 'in_use' THEN 1 ELSE 0 END), 0) AS unavailable_samples,
                MAX(s.observed_at) AS last_seen_at
         FROM machine_snapshots s
         LEFT JOIN machines m ON m.id = s.machine_id
         ${sinceSnapshotted}
         GROUP BY s.machine_id
         ORDER BY s.machine_id`,
      )
      .all(...(sinceIso ? [sinceIso] : []));

    const machineSince = sinceIso ? 'WHERE t.observed_at >= ?' : '';
    const transitionRows = this.db
      .prepare(
        `SELECT t.machine_id AS id, t.observed_at AS observed_at, t.from_state AS from_state, t.to_state AS to_state
         FROM machine_transitions t
         ${machineSince}
         ORDER BY t.machine_id, t.observed_at`,
      )
      .all(...(sinceIso ? [sinceIso] : []));

    /** @type {Map<string, {cycles: number, totalInUseSeconds: number, measuredCycles: number}>} */
    const cycleMap = new Map();
    /** @type {Map<string, number>} */
    const inUseStart = new Map();

    for (const transition of transitionRows) {
      const id = String(transition.id);
      const summary = cycleMap.get(id) ?? { cycles: 0, totalInUseSeconds: 0, measuredCycles: 0 };
      cycleMap.set(id, summary);

      // from_state === null 表示"首次见到这台机器"，不算一次真实的使用
      if (transition.to_state === 'in_use' && transition.from_state !== 'in_use' && transition.from_state !== null) {
        summary.cycles += 1;
        inUseStart.set(id, Date.parse(transition.observed_at));
      } else if (transition.from_state === 'in_use' && transition.to_state !== 'in_use') {
        const startedAt = inUseStart.get(id);
        if (startedAt !== undefined) {
          summary.totalInUseSeconds += Math.max(0, (Date.parse(transition.observed_at) - startedAt) / 1000);
          summary.measuredCycles += 1;
          inUseStart.delete(id);
        }
      }
    }

    const machines = machineRows.map((row) => {
      const summary = cycleMap.get(String(row.id)) ?? { cycles: 0, totalInUseSeconds: 0, measuredCycles: 0 };
      const samples = Number(row.samples) || 0;
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        samples,
        availablePct: samples ? Number(row.available_samples) / samples : 0,
        inUsePct: samples ? Number(row.in_use_samples) / samples : 0,
        unavailablePct: samples ? Number(row.unavailable_samples) / samples : 0,
        cycles: summary.cycles,
        avgInUseSeconds: summary.measuredCycles ? summary.totalInUseSeconds / summary.measuredCycles : null,
        lastSeenAt: row.last_seen_at,
      };
    });

    const totalCycles = machines.reduce((sum, machine) => sum + machine.cycles, 0);
    const measured = machines.filter((machine) => machine.avgInUseSeconds !== null);
    const avgInUseSeconds = measured.length
      ? measured.reduce((sum, machine) => sum + machine.avgInUseSeconds, 0) / measured.length
      : null;

    return {
      window: { since: sinceIso, until: new Date().toISOString() },
      runs: {
        total: Number(runRow.total),
        ok: Number(runRow.ok),
        failed: Number(runRow.failed),
        firstAt: runRow.first_at,
        lastAt: runRow.last_at,
        avgDurationMs: runRow.avg_duration_ms === null ? null : Math.round(Number(runRow.avg_duration_ms)),
      },
      errorsByCode: errorRows.map((row) => ({ code: row.code, count: Number(row.n) })),
      machines,
      transitions: {
        total: transitionRows.length,
        cycles: totalCycles,
        avgInUseSeconds,
      },
    };
  }

  /**
   * 导出快照时间序列。
   * @param {object} [options]
   * @param {string|null} [options.since]
   * @param {number} [options.limit]
   */
  exportSnapshots({ since = null, limit = 100_000 } = {}) {
    const sinceIso = since ? toIso(since) : null;
    const where = sinceIso ? 'WHERE s.observed_at >= ?' : '';
    const params = sinceIso ? [sinceIso, Number(limit)] : [Number(limit)];

    return this.db
      .prepare(
        `SELECT s.observed_at   AS observed_at,
                s.machine_id    AS machine_id,
                COALESCE(m.name, s.machine_id) AS name,
                m.kind          AS kind,
                s.status        AS status,
                s.state         AS state,
                s.available     AS available,
                s.planned_minutes AS planned_minutes,
                s.remaining_seconds AS remaining_seconds,
                s.elapsed_seconds   AS elapsed_seconds,
                s.finished_but_not_emptied AS finished_but_not_emptied
         FROM machine_snapshots s
         LEFT JOIN machines m ON m.id = s.machine_id
         ${where}
         ORDER BY s.observed_at, s.machine_id
         LIMIT ?`,
      )
      .all(...params);
  }

  /**
   * 删除早于 retentionDays 天的数据。
   * @param {number} days
   * @param {number} [now] 参考时间戳（测试用）
   * @returns {{runs: number, snapshots: number, transitions: number}}
   */
  purgeOlderThan(days, now = Date.now()) {
    if (!Number.isFinite(days) || days < 0) throw new Error('purgeOlderThan 需要 >= 0 的天数');
    const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const transitions = this.db.prepare('DELETE FROM machine_transitions WHERE observed_at < ?').run(cutoff);
      const snapshots = this.db.prepare('DELETE FROM machine_snapshots WHERE observed_at < ?').run(cutoff);
      const runs = this.db.prepare('DELETE FROM poll_runs WHERE started_at < ?').run(cutoff);
      this.db.exec('COMMIT');
      return {
        runs: Number(runs.changes),
        snapshots: Number(snapshots.changes),
        transitions: Number(transitions.changes),
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * 打开数据库的快捷函数。
 * @param {string} filePath
 */
export function openDatabase(filePath) {
  return new MonitorDatabase(filePath);
}
