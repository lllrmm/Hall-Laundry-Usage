/**
 * 序列库：每台机器每天一条 1,440 字节的 BLOB（每分钟一个字节），
 * 是原始快照库（raw sqlite）的"日级压缩派生层"，供看板快速做历史规律查询。
 *
 * 字节编码（1 byte / 分钟）：
 *   0x00 in_use                 占用
 *   0x01 available              空闲
 *   0x02 maintenance            维护
 *   0x03 disabled               停用
 *   0x04 offline                离线
 *   0x05 on_hold                旧的通用 on_hold 编码（仅解码兼容，不再写入）
 *   0x06 on_hold + in_use       占用流程中，且底层 state=in_use
 *   0x07 on_hold + available    占用流程中，且底层 state=available
 *   0x08 on_hold + offline      占用流程中，且底层 state=offline
 *   0x09 on_hold + unknown      status=on_hold 但底层 state 无法识别
 *   0xfe unknown                轮询成功但状态无法识别
 *   0xff no_data                该分钟没有成功轮询
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  MINUTES_PER_DAY,
  STATE_BYTES,
  BYTE_LABELS,
  dayKey,
  minuteOfDay,
  snapshotByte,
  onHoldByte,
} from '../../shared/contracts.js';

// 保持原有公共导出（index.js / 测试继续可用）
export { MINUTES_PER_DAY, STATE_BYTES, BYTE_LABELS, dayKey, minuteOfDay, snapshotByte, onHoldByte };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS machine_days (
  machine_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  seq        BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (machine_id, day)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS machine_latest (
  machine_id        TEXT PRIMARY KEY,
  observed_at       TEXT,
  status            TEXT,
  state             TEXT,
  available         INTEGER,
  remaining_seconds INTEGER,
  elapsed_seconds   INTEGER,
  updated_at        TEXT
);

CREATE TABLE IF NOT EXISTS series_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/** 归一化后的机器对象 → 一个字节 */
export function stateByte(machine) {
  if (!machine) return STATE_BYTES.no_data;
  // 非 enabled 的 status 优先：维护中的机器 state 也可能是 "available"，
  // 必须先落成 maintenance/disabled/on_hold，才不会被当成可运营样本。
  switch (machine.status) {
    case 'maintenance':
      return STATE_BYTES.maintenance;
    case 'disabled':
      return STATE_BYTES.disabled;
    case 'on_hold':
      return onHoldByte(machine.state);
    default:
      break;
  }
  if (machine.available) return STATE_BYTES.available;
  if (machine.state === 'in_use') return STATE_BYTES.in_use;
  if (machine.state === 'offline') return STATE_BYTES.offline;
  if (machine.state === 'available') return STATE_BYTES.available;
  return STATE_BYTES.unknown;
}

function createDayBuffer() {
  return new Uint8Array(MINUTES_PER_DAY).fill(STATE_BYTES.no_data);
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? String(value) : new Date(parsed).toISOString();
}

/** 序列库访问对象。用完记得 close()。 */
export class SeriesDatabase {
  /**
   * @param {string} filePath SQLite 文件路径（目录不存在会自动创建）
   * @param {object} [options]
   * @param {'WAL'|'DELETE'|'TRUNCATE'|'MEMORY'} [options.journalMode]
   */
  constructor(filePath, { journalMode = 'WAL' } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('SeriesDatabase 需要数据库文件路径');
    }
    const modes = new Set(['WAL', 'DELETE', 'TRUNCATE', 'MEMORY', 'PERSIST', 'OFF']);
    const mode = String(journalMode).toUpperCase();
    if (!modes.has(mode)) throw new Error(`不支持的 journalMode：${journalMode}`);

    this.filePath = path.resolve(filePath);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    this.db = new DatabaseSync(this.filePath);
    this.db.exec(`PRAGMA journal_mode = ${mode}`);
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);

    this._stmts = {
      getDay: this.db.prepare('SELECT seq FROM machine_days WHERE machine_id = ? AND day = ?'),
      upsertDay: this.db.prepare(`
        INSERT INTO machine_days (machine_id, day, seq, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(machine_id, day) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at
      `),
      upsertLatest: this.db.prepare(`
        INSERT INTO machine_latest
          (machine_id, observed_at, status, state, available, remaining_seconds, elapsed_seconds, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(machine_id) DO UPDATE SET
          observed_at = excluded.observed_at, status = excluded.status, state = excluded.state,
          available = excluded.available, remaining_seconds = excluded.remaining_seconds,
          elapsed_seconds = excluded.elapsed_seconds, updated_at = excluded.updated_at
      `),
      setMeta: this.db.prepare(`
        INSERT INTO series_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `),
      getMeta: this.db.prepare('SELECT value FROM series_meta WHERE key = ?'),
    };
  }

  /** 记录一轮成功采集：更新每台机器当天的分钟字节、元数据与最新状态 */
  recordPoll(machines, observedAt = new Date()) {
    const date = observedAt instanceof Date ? observedAt : new Date(observedAt);
    if (Number.isNaN(date.getTime())) throw new TypeError(`无法解析时间：${String(observedAt)}`);
    const day = dayKey(date);
    const minute = minuteOfDay(date);
    const observedIso = date.toISOString();
    const updatedAt = new Date().toISOString();
    const list = Array.isArray(machines) ? machines : [];
    const buffers = new Map();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const machine of list) {
        const id = String(machine.id);
        let seq = buffers.get(id);
        if (!seq) {
          const row = this._stmts.getDay.get(id, day);
          seq = row ? new Uint8Array(row.seq) : createDayBuffer();
          buffers.set(id, seq);
        }
        seq[minute] = stateByte(machine);

        this._stmts.upsertLatest.run(
          id,
          observedIso,
          machine.status ?? null,
          machine.state ?? null,
          machine.available ? 1 : 0,
          machine.remainingSeconds ?? null,
          machine.elapsedSeconds ?? null,
          updatedAt,
        );
      }

      for (const [id, seq] of buffers) {
        this._stmts.upsertDay.run(id, day, seq, updatedAt);
      }
      this._stmts.setMeta.run('last_poll_at', observedIso);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return { day, minute, machines: list.length };
  }

  /** 用原始快照库回填/重建序列库（raw 是真相源） */
  rebuildFromRaw(rawDb, { since = null, until = null } = {}) {
    const conditions = [];
    const params = [];
    if (since) {
      conditions.push('observed_at >= ?');
      params.push(toIso(since));
    }
    if (until) {
      conditions.push('observed_at < ?');
      params.push(toIso(until));
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = rawDb
      .prepare(
        `SELECT machine_id, observed_at, status, state, available
         FROM machine_snapshots ${where}
         ORDER BY observed_at, machine_id`,
      )
      .all(...params);

    const buffers = new Map();
    let skipped = 0;
    for (const row of rows) {
      const date = new Date(row.observed_at);
      if (Number.isNaN(date.getTime())) {
        skipped += 1;
        continue;
      }
      const day = dayKey(date);
      const minute = minuteOfDay(date);
      const key = `${row.machine_id}|${day}`;
      let entry = buffers.get(key);
      if (!entry) {
        entry = { machineId: row.machine_id, day, seq: createDayBuffer(), updatedAt: row.observed_at };
        buffers.set(key, entry);
      }
      entry.seq[minute] = snapshotByte(row);
      if (row.observed_at > entry.updatedAt) entry.updatedAt = row.observed_at;
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of buffers.values()) {
        this._stmts.upsertDay.run(entry.machineId, entry.day, entry.seq, entry.updatedAt);
      }

      // 回填最新状态，保证看板只读序列库时信息完整
      const nowIso = new Date().toISOString();
      const latestRows = rawDb
        .prepare(
          `SELECT machine_id, observed_at, status, state, available, remaining_seconds, elapsed_seconds
           FROM machine_snapshots
           WHERE id IN (SELECT MAX(id) FROM machine_snapshots GROUP BY machine_id)`,
        )
        .all();
      for (const row of latestRows) {
        this._stmts.upsertLatest.run(
          row.machine_id,
          row.observed_at,
          row.status,
          row.state,
          row.available,
          row.remaining_seconds,
          row.elapsed_seconds,
          nowIso,
        );
      }

      const newest = rows.length ? rows[rows.length - 1].observed_at : null;
      this._stmts.setMeta.run('last_rebuild_at', new Date().toISOString());
      if (newest) this._stmts.setMeta.run('last_poll_at', newest);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return { rows: rows.length, days: buffers.size, skipped };
  }

  /** 读取日序列（供看板/调试），返回原始字节 */
  readDays({ sinceDay = null, untilDay = null, machineIds = [] } = {}) {
    const conditions = [];
    const params = [];
    if (sinceDay) {
      conditions.push('day >= ?');
      params.push(String(sinceDay));
    }
    if (untilDay) {
      conditions.push('day <= ?');
      params.push(String(untilDay));
    }
    const ids = (machineIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);
    if (ids.length) {
      conditions.push(`machine_id IN (${ids.map(() => '?').join(', ')})`);
      params.push(...ids);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT machine_id, day, seq, updated_at FROM machine_days ${where} ORDER BY day, machine_id`)
      .all(...params)
      .map((row) => ({
        machineId: row.machine_id,
        day: row.day,
        seq: new Uint8Array(row.seq),
        updatedAt: row.updated_at,
      }));
  }

  /** 最新状态（CLI 展示用；看板直接读 raw 库） */
  latest() {
    return this.db.prepare('SELECT * FROM machine_latest ORDER BY machine_id').all();
  }

  stats() {
    const machineDays = this.db.prepare('SELECT COUNT(*) AS n FROM machine_days').get().n;
    const days = this.db.prepare('SELECT COUNT(DISTINCT day) AS n FROM machine_days').get().n;
    const machines = this.db.prepare('SELECT COUNT(DISTINCT machine_id) AS n FROM machine_days').get().n;
    const latest = this.db.prepare('SELECT MAX(observed_at) AS at FROM machine_latest').get()?.at ?? null;
    return {
      days: Number(days),
      machineDays: Number(machineDays),
      machines: Number(machines),
      bytes: Number(machineDays) * MINUTES_PER_DAY,
      lastPollAt: latest,
      lastRebuildAt: this._stmts.getMeta.get('last_rebuild_at')?.value ?? null,
    };
  }

  close() {
    this.db.close();
  }
}

/** 打开（或创建）序列库 */
export function openSeriesDatabase(filePath) {
  return new SeriesDatabase(filePath);
}
