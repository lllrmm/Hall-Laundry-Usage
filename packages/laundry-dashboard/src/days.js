/**
 * 历史日序列数据源：把"每台机器每天 1,440 个分钟字节"原样提供给前端。
 *
 * 数据优先取自监控服务的序列库（`machine_days`，由 laundry-monitor 双写/回填），
 * 序列库缺失或还没覆盖某天时，回退到原始快照库（`machine_snapshots`）即时生成同样的
 * 日序列 —— 这样只跑过采集、还没 rebuild 的库也能直接用。
 *
 * 看板只负责"发原始序列"：星期 × 分钟热力图、时间剖面、状态占比全部由浏览器端
 * `public/aggregate.js` 计算，交互（选星期、拖时段、勾机器、切日期）不再请求后端。
 *
 * 字节编码（与 laundry-monitor/src/series.js 保持一致）：
 *   0x00 in_use      0x01 available   0x02 maintenance  0x03 disabled
 *   0x04 offline     0x05 on_hold     0xfe unknown      0xff no_data
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MINUTES_PER_DAY = 1440;

export const STATE_BYTES = Object.freeze({
  inUse: 0x00,
  available: 0x01,
  maintenance: 0x02,
  disabled: 0x03,
  offline: 0x04,
  onHold: 0x05,
  unknown: 0xfe,
  noData: 0xff,
});

/** 字节 → 可读标签（响应里的 encoding 字段用） */
export const BYTE_LABELS = Object.freeze({
  [STATE_BYTES.inUse]: 'in_use',
  [STATE_BYTES.available]: 'available',
  [STATE_BYTES.maintenance]: 'maintenance',
  [STATE_BYTES.disabled]: 'disabled',
  [STATE_BYTES.offline]: 'offline',
  [STATE_BYTES.onHold]: 'on_hold',
  [STATE_BYTES.unknown]: 'unknown',
  [STATE_BYTES.noData]: 'no_data',
});

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 校验 YYYY-MM-DD（真实存在的日历日）；非法返回 null */
export function normalizeDay(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const match = DAY_PATTERN.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  if (month < 1 || month > 12 || date < 1 || date > 31) return null;
  const parsed = new Date(Date.UTC(year, month - 1, date));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== date
  ) {
    return null;
  }
  return text;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地日历日 YYYY-MM-DD（与序列库 dayKey 一致） */
function localDayKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 本地时间的当天第几分钟（0–1439） */
function localMinuteOf(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/** YYYY-MM-DD（本地日期）→ 当天本地 00:00 */
function localDayStart(day) {
  const [year, month, date] = String(day).split('-').map(Number);
  return new Date(year, month - 1, date, 0, 0, 0, 0);
}

/** YYYY-MM-DD（本地日期）→ 下一天本地 00:00 */
function nextLocalDayStart(day) {
  const start = localDayStart(day);
  start.setDate(start.getDate() + 1);
  return start;
}

/** 原始快照行 → 一个字节（与 monitor 的 snapshotByte 逻辑一致） */
export function snapshotByte(row) {
  // 非 enabled 的 status 优先（维护中的机器 state 也可能是 available）
  switch (row.status) {
    case 'maintenance':
      return STATE_BYTES.maintenance;
    case 'disabled':
      return STATE_BYTES.disabled;
    case 'on_hold':
      return STATE_BYTES.onHold;
    default:
      break;
  }
  if (row.available === 1 || row.available === true) return STATE_BYTES.available;
  if (row.state === 'in_use') return STATE_BYTES.inUse;
  if (row.state === 'offline') return STATE_BYTES.offline;
  if (row.state === 'available') return STATE_BYTES.available;
  return STATE_BYTES.unknown;
}

/** 保证长度正好 1,440：短的补 no_data，长的截断（防脏数据） */
function normalizeSequence(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value ?? []);
  if (bytes.length === MINUTES_PER_DAY) return bytes;
  const buffer = new Uint8Array(MINUTES_PER_DAY).fill(STATE_BYTES.noData);
  buffer.set(bytes.subarray(0, MINUTES_PER_DAY));
  return buffer;
}

/**
 * 以只读方式打开 SQLite（失败时退回读写连接 + PRAGMA query_only）。
 * 文件不存在 / 打不开返回 null，由上层降级。
 */
function openReadOnly(filePath) {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const db = new DatabaseSync(filePath, { readOnly: true });
    db.prepare('SELECT 1').get();
    return db;
  } catch {
    try {
      const db = new DatabaseSync(filePath);
      db.exec('PRAGMA query_only = ON');
      return db;
    } catch {
      return null;
    }
  }
}

function hasTable(db, name) {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    return Boolean(row);
  } catch {
    return false;
  }
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(',');
}

export class DaysDatabase {
  /**
   * @param {object} options
   * @param {string} options.rawPath 原始快照库路径
   * @param {string} [options.seriesPath] 序列库路径（可选；缺失时整库回退 raw）
   */
  constructor({ rawPath, seriesPath = null }) {
    this.rawPath = rawPath;
    this.seriesPath = seriesPath;
    this._raw = null;
    this._series = null;
    this._rawChecked = false;
    this._seriesChecked = false;
  }

  _rawDb() {
    if (!this._rawChecked) {
      this._rawChecked = true;
      this._raw = openReadOnly(this.rawPath);
    }
    return this._raw;
  }

  _seriesDb() {
    if (!this._seriesChecked) {
      this._seriesChecked = true;
      this._series = openReadOnly(this.seriesPath);
    }
    return this._series;
  }

  close() {
    for (const key of ['_raw', '_series']) {
      const db = this[key];
      if (!db) continue;
      try {
        db.close();
      } catch {
        // ignore
      }
      this[key] = null;
    }
  }

  /**
   * 读取日序列。参数由调用方（HTTP 层）校验：machines 必填，
   * 日期范围用 from+to 或显式的 days 列表（二者互斥）。
   * @param {object} [options]
   * @param {string|null} [options.fromDay] 起始本地日期 YYYY-MM-DD（含）
   * @param {string|null} [options.toDay] 结束本地日期 YYYY-MM-DD（含）
   * @param {string[]} [options.machineIds] 机器 id（必填，非空）
   * @param {string[]|null} [options.days] 显式日期列表（与 from/to 互斥）
   * @returns {{available: boolean, source: 'series'|'raw'|'mixed'|null, fromDay: string|null,
   *   toDay: string|null, firstDay: string|null, lastDay: string|null, count: number,
   *   encoding: Record<string, number>, days: Array<{machineId: string, day: string,
   *   seq: string, updatedAt: string|null}>}}
   */
  days({ fromDay = null, toDay = null, machineIds = [], days = null } = {}) {
    const dayList = Array.isArray(days) && days.length
      ? [...new Set(days.map(normalizeDay).filter(Boolean))].sort()
      : null;
    const from = dayList ? dayList[0] : normalizeDay(fromDay);
    const to = dayList ? dayList[dayList.length - 1] : normalizeDay(toDay);
    const ids = (machineIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);

    const seriesRows = this._readSeriesDays(from, to, ids, dayList);
    const seriesKeys = new Set(seriesRows.map((row) => `${row.machineId}|${row.day}`));
    const rawKeys = this._readRawDayKeys(from, to, ids, dayList);
    const missingKeys = rawKeys.filter((key) => !seriesKeys.has(key));
    const rawRows = missingKeys.length ? this._buildRawDays(missingKeys) : [];

    const rows = [...seriesRows, ...rawRows].sort((a, b) => {
      if (a.day !== b.day) return a.day < b.day ? -1 : 1;
      return a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0;
    });

    const sources = new Set();
    if (seriesRows.length) sources.add('series');
    if (rawRows.length) sources.add('raw');
    let source = null;
    if (sources.size === 2) source = 'mixed';
    else if (sources.size === 1) source = [...sources][0];

    const rawAvailable = Boolean(this._rawDb() && hasTable(this._rawDb(), 'machine_snapshots'));
    const seriesAvailable = Boolean(
      this._seriesDb() && hasTable(this._seriesDb(), 'machine_days'),
    );

    return {
      available: rawAvailable || seriesAvailable,
      source,
      fromDay: from,
      toDay: to,
      firstDay: rows.length ? rows[0].day : null,
      lastDay: rows.length ? rows[rows.length - 1].day : null,
      count: rows.length,
      encoding: { ...STATE_BYTES },
      days: rows.map((row) => ({
        machineId: row.machineId,
        day: row.day,
        seq: Buffer.from(row.seq).toString('base64'),
        updatedAt: row.updatedAt,
      })),
    };
  }

  /**
   * 数据覆盖的本地日期范围（序列库与原始库取并集）。
   * 前端用它把"全部历史"换算成 /api/days 必填的 from/to。
   */
  span() {
    const result = { firstDay: null, lastDay: null };
    const merge = (first, last) => {
      if (first && (!result.firstDay || first < result.firstDay)) result.firstDay = first;
      if (last && (!result.lastDay || last > result.lastDay)) result.lastDay = last;
    };

    const series = this._seriesDb();
    if (series && hasTable(series, 'machine_days')) {
      try {
        const row = series.prepare('SELECT MIN(day) AS first, MAX(day) AS last FROM machine_days').get();
        merge(row?.first, row?.last);
      } catch {
        // ignore
      }
    }

    const raw = this._rawDb();
    if (raw && hasTable(raw, 'machine_snapshots')) {
      try {
        const row = raw
          .prepare(
            `SELECT MIN(date(observed_at, 'localtime')) AS first,
                    MAX(date(observed_at, 'localtime')) AS last
             FROM machine_snapshots`,
          )
          .get();
        merge(row?.first, row?.last);
      } catch {
        // ignore
      }
    }

    return result;
  }

  /** 序列库里的日序列（库缺失 / 读失败时返回空数组） */
  _readSeriesDays(fromDay, toDay, machineIds, dayList = null) {
    const db = this._seriesDb();
    if (!db || !hasTable(db, 'machine_days')) return [];

    const clauses = [];
    const params = [];
    if (dayList) {
      clauses.push(`day IN (${placeholders(dayList.length)})`);
      params.push(...dayList);
    } else {
      if (fromDay) {
        clauses.push('day >= ?');
        params.push(fromDay);
      }
      if (toDay) {
        clauses.push('day <= ?');
        params.push(toDay);
      }
    }
    if (machineIds.length) {
      clauses.push(`machine_id IN (${placeholders(machineIds.length)})`);
      params.push(...machineIds);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    try {
      return db
        .prepare(`SELECT machine_id, day, seq, updated_at FROM machine_days ${where} ORDER BY day, machine_id`)
        .all(...params)
        .map((row) => ({
          machineId: row.machine_id,
          day: row.day,
          seq: normalizeSequence(row.seq),
          updatedAt: row.updated_at ?? null,
        }));
    } catch {
      return [];
    }
  }

  /** 原始快照库里存在数据的 (machine_id|day) 列表（用于判断序列库缺哪些天） */
  _readRawDayKeys(fromDay, toDay, machineIds, dayList = null) {
    const db = this._rawDb();
    if (!db || !hasTable(db, 'machine_snapshots')) return [];

    const clauses = [];
    const params = [];
    if (dayList) {
      clauses.push(`date(observed_at, 'localtime') IN (${placeholders(dayList.length)})`);
      params.push(...dayList);
    } else {
      if (fromDay) {
        clauses.push("date(observed_at, 'localtime') >= ?");
        params.push(fromDay);
      }
      if (toDay) {
        clauses.push("date(observed_at, 'localtime') <= ?");
        params.push(toDay);
      }
    }
    if (machineIds.length) {
      clauses.push(`machine_id IN (${placeholders(machineIds.length)})`);
      params.push(...machineIds);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    try {
      return db
        .prepare(
          `SELECT DISTINCT machine_id, date(observed_at, 'localtime') AS day
           FROM machine_snapshots ${where}`,
        )
        .all(...params)
        .map((row) => `${row.machine_id}|${row.day}`);
    } catch {
      return [];
    }
  }

  /** 用原始快照即时生成缺失的日序列（同分钟以最后一条为准，与 monitor rebuild 一致） */
  _buildRawDays(missingKeys) {
    const db = this._rawDb();
    if (!db) return [];
    const wanted = new Set(missingKeys);

    const days = missingKeys.map((key) => key.slice(key.indexOf('|') + 1)).sort();
    const firstDay = days[0];
    const lastDay = days[days.length - 1];
    // 本地日期 → UTC ISO 边界，与 observed_at（UTC ISO）按字符串比较
    const sinceIso = localDayStart(firstDay).toISOString();
    const untilIso = nextLocalDayStart(lastDay).toISOString();

    let rows;
    try {
      rows = db
        .prepare(
          `SELECT machine_id, observed_at, status, state, available
           FROM machine_snapshots
           WHERE observed_at >= ? AND observed_at < ?
           ORDER BY observed_at, machine_id`,
        )
        .all(sinceIso, untilIso);
    } catch {
      return [];
    }

    const buffers = new Map();
    for (const row of rows) {
      const date = new Date(row.observed_at);
      if (Number.isNaN(date.getTime())) continue;
      const day = localDayKey(date);
      const key = `${row.machine_id}|${day}`;
      if (!wanted.has(key)) continue;

      let entry = buffers.get(key);
      if (!entry) {
        entry = { seq: new Uint8Array(MINUTES_PER_DAY).fill(STATE_BYTES.noData), updatedAt: row.observed_at };
        buffers.set(key, entry);
      }
      entry.seq[localMinuteOf(date)] = snapshotByte(row);
      if (row.observed_at > entry.updatedAt) entry.updatedAt = row.observed_at;
    }

    return [...buffers.entries()].map(([key, entry]) => {
      const separator = key.indexOf('|');
      return {
        machineId: key.slice(0, separator),
        day: key.slice(separator + 1),
        seq: entry.seq,
        updatedAt: entry.updatedAt,
      };
    });
  }
}
