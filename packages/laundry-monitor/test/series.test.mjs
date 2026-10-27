import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeResponse } from 'hkust-laundry-machines';

import { MonitorDatabase } from '../src/db.js';
import { pollOnce } from '../src/collector.js';
import {
  MINUTES_PER_DAY,
  STATE_BYTES,
  SeriesDatabase,
  dayKey,
  minuteOfDay,
  snapshotByte,
  stateByte,
} from '../src/series.js';

const NOW = new Date('2026-10-27T02:00:00.000Z');
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function rawMachine(id, name, kind, state, serviceValue = null) {
  const value = serviceValue ?? (kind === 'dryer' ? 'dryer_machine' : 'washing_machine_without_powder');
  return {
    _id: id,
    status: 'enabled',
    state,
    name,
    service_type: {
      _id: kind === 'dryer' ? 'st-d' : 'st-w',
      machine_type: kind,
      value,
      label: value,
    },
    laundry_room_name: 'UG Hall IV',
  };
}

function payload(machines) {
  return {
    meta: { code: 200, message: 'Success' },
    data: {
      laundry_room_machines: [{ laundry_room_name: 'UG Hall IV', machines }],
    },
  };
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-series-'));
  return { dir, file: path.join(dir, 'series.sqlite') };
}

async function withSeries(fn) {
  const { dir, file } = tempDir();
  const series = new SeriesDatabase(file, { journalMode: 'DELETE' });
  try {
    return await fn(series, dir);
  } finally {
    series.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上偶发文件占用，忽略
    }
  }
}

test('字节编码：机器状态 → 1 byte', () => {
  assert.equal(stateByte({ available: true, state: 'available' }), STATE_BYTES.available);
  assert.equal(stateByte({ available: false, state: 'in_use' }), STATE_BYTES.in_use);
  assert.equal(stateByte({ available: false, state: 'offline' }), STATE_BYTES.offline);
  assert.equal(stateByte({ available: false, state: 'x', status: 'maintenance' }), STATE_BYTES.maintenance);
  assert.equal(stateByte({ available: false, state: 'x', status: 'disabled' }), STATE_BYTES.disabled);
  assert.equal(stateByte({ available: false, state: 'x', status: 'on_hold' }), STATE_BYTES.on_hold);
  assert.equal(stateByte({ available: false, state: 'weird', status: 'enabled' }), STATE_BYTES.unknown);
  assert.equal(stateByte(null), STATE_BYTES.no_data);

  assert.equal(snapshotByte({ available: 1 }), STATE_BYTES.available);
  assert.equal(snapshotByte({ available: 0, state: 'in_use' }), STATE_BYTES.in_use);
  assert.equal(snapshotByte({ available: 0, state: 'offline' }), STATE_BYTES.offline);
  assert.equal(snapshotByte({ available: 0, state: 'x', status: 'maintenance' }), STATE_BYTES.maintenance);

  const date = new Date(2026, 9, 27, 14, 45, 12); // 本地时间
  assert.equal(dayKey(date), '2026-10-27');
  assert.equal(minuteOfDay(date), 14 * 60 + 45);
});

test('recordPoll：写入 1440 字节序列、元数据与最新状态', async () => {
  await withSeries((series) => {
    const machines = [
      rawMachine('m1', 'UG4 Dryer (51)', 'dryer', 'available'),
      rawMachine('m2', 'UG4 Washer (05)', 'washer', 'in_use', 'washing_machine_with_powder'),
    ];
    const status = normalizeResponse(payload(machines), NOW.getTime());
    const day = dayKey(NOW);
    const minute = minuteOfDay(NOW);

    const result = series.recordPoll(status.machines, NOW);
    assert.equal(result.day, day);
    assert.equal(result.minute, minute);

    const rows = series.readDays({});
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.day, day);
      assert.equal(row.seq.length, MINUTES_PER_DAY);
    }

    const dryer = rows.find((row) => row.machineId === 'm1');
    const washer = rows.find((row) => row.machineId === 'm2');
    assert.equal(dryer.seq[minute], STATE_BYTES.available);
    assert.equal(washer.seq[minute], STATE_BYTES.in_use);
    // 没轮询过的分钟保持 no_data
    assert.equal(dryer.seq[(minute + 1) % MINUTES_PER_DAY], STATE_BYTES.no_data);

    const meta = series.machines();
    assert.equal(meta.length, 2);
    assert.equal(meta.find((row) => row.id === 'm2').powder, 'with');
    assert.equal(meta.find((row) => row.id === 'm1').powder, null);

    const latest = series.latest();
    assert.equal(latest.length, 2);
    assert.equal(latest.find((row) => row.machine_id === 'm2').available, 0);

    const stats = series.stats();
    assert.equal(stats.days, 1);
    assert.equal(stats.machineDays, 2, '两台机器各一天');
    assert.equal(stats.machines, 2);
    assert.equal(stats.bytes, MINUTES_PER_DAY * 2);
    assert.ok(stats.lastPollAt);

    // 同一分钟再次轮询 → 后写覆盖
    const changed = normalizeResponse(
      payload([rawMachine('m2', 'UG4 Washer (05)', 'washer', 'available', 'washing_machine_with_powder')]),
      NOW.getTime() + 500,
    );
    series.recordPoll(changed.machines, new Date(NOW.getTime() + 500));
    const after = series.readDays({ machineIds: ['m2'] })[0];
    assert.equal(after.seq[minute], STATE_BYTES.available);
  });
});

test('rebuildFromRaw：从原始快照回填，同分钟以最后一条为准', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-raw-'));
  const raw = new MonitorDatabase(path.join(dir, 'raw.sqlite'), { journalMode: 'DELETE' });
  const series = new SeriesDatabase(path.join(dir, 'series.sqlite'), { journalMode: 'DELETE' });

  try {
    const poll = (at, state) => {
      const status = normalizeResponse(
        payload([rawMachine('m1', 'UG4 Dryer (51)', 'dryer', state)]),
        at.getTime(),
      );
      raw.recordSuccessfulPoll(status, { startedAt: at, finishedAt: at, durationMs: 10 });
    };

    poll(NOW, 'available');
    poll(new Date(NOW.getTime() + 60_000), 'in_use');
    poll(new Date(NOW.getTime() + 90_000), 'available'); // 可能与上一轮同分钟
    poll(new Date(NOW.getTime() + 120_000), 'in_use');

    const result = series.rebuildFromRaw(raw.db);
    assert.equal(result.rows, 4);
    assert.equal(result.days, 1);
    assert.equal(result.skipped, 0);

    const row = series.readDays({})[0];
    assert.equal(row.seq.length, MINUTES_PER_DAY);
    assert.equal(row.seq[minuteOfDay(NOW)], STATE_BYTES.available);
    // +60s 与 +90s 落在同一分钟：后一条（available）覆盖前一条（in_use）
    assert.equal(
      row.seq[minuteOfDay(new Date(NOW.getTime() + 60_000))],
      STATE_BYTES.available,
      '同分钟以最后一条快照为准',
    );
    assert.equal(row.seq[minuteOfDay(new Date(NOW.getTime() + 120_000))], STATE_BYTES.in_use);

    const stats = series.stats();
    assert.equal(stats.days, 1);
    assert.equal(stats.machines, 1, '回填应写入机器元数据');
    assert.ok(stats.lastRebuildAt);
    assert.equal(series.latest().length, 1, '回填应写入最新状态');
  } finally {
    series.close();
    raw.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test('pollOnce 同时写原始库与序列库', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-dual-'));
  const db = new MonitorDatabase(path.join(dir, 'raw.sqlite'), { journalMode: 'DELETE' });
  const series = new SeriesDatabase(path.join(dir, 'series.sqlite'), { journalMode: 'DELETE' });

  try {
    const status = normalizeResponse(payload([rawMachine('m1', 'UG4 Dryer (51)', 'dryer', 'available')]), NOW.getTime());
    const client = { async getMachines() { return status; } };

    const result = await pollOnce({ client, db, series, logger: silentLogger, now: () => NOW });
    assert.equal(result.ok, true);
    assert.equal(db.totals().runs, 1);

    const rows = series.readDays({});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].seq[minuteOfDay(NOW)], STATE_BYTES.available);
  } finally {
    series.close();
    db.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});
