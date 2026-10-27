import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeResponse } from '../src/machines/index.js';

import { pollOnce } from '../src/collector.js';
import { startMonitor } from '../src/monitor.js';
import { MonitorDatabase } from '../src/db.js';

const NOW = Date.parse('2026-10-27T02:00:00.000Z');

function payloadFor(state = 'available') {
  return {
    meta: { code: 200, message: 'Success' },
    data: {
      laundry_room_machines: [
        {
          laundry_room_name: 'UG Hall IV',
          machines: [
            {
              _id: 'm1',
              status: 'enabled',
              state,
              name: 'UG4 Dryer (51)',
              service_type: { _id: 'st-d', machine_type: 'dryer', value: 'dryer_machine', label: 'Dry Machine' },
              laundry_room_name: 'UG Hall IV',
            },
          ],
        },
      ],
    },
  };
}

function fakeClient({ states = ['available'], failWith = null } = {}) {
  let call = 0;
  return {
    calls: () => call,
    async getMachines() {
      const index = Math.min(call, states.length - 1);
      call += 1;
      if (failWith) throw failWith;
      return normalizeResponse(payloadFor(states[index]), NOW + call * 1000);
    },
  };
}

async function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-collector-'));
  const db = new MonitorDatabase(path.join(dir, 'test.sqlite'), { journalMode: 'DELETE' });
  try {
    return await fn(db, dir);
  } finally {
    db.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上偶发文件占用，忽略清理失败
    }
  }
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

test('pollOnce 成功：返回统计并落库', async () => {
  await withTempDb(async (db) => {
    const client = fakeClient();
    const result = await pollOnce({ client, db, logger: silentLogger });

    assert.equal(result.ok, true);
    assert.deepEqual(result.counts, { total: 1, available: 1, inUse: 0, unavailable: 0 });
    assert.ok(result.runId > 0);

    assert.equal(db.totals().runs, 1);
    assert.equal(db.totals().snapshots, 1);
    assert.equal(db.lastRun().ok, 1);
  });
});

test('pollOnce 失败：记录失败轮询且不抛错', async () => {
  await withTempDb(async (db) => {
    const error = Object.assign(new Error('Invalid Bearer Token.'), { code: 4032 });
    const client = fakeClient({ failWith: error });

    const result = await pollOnce({ client, db, logger: silentLogger });

    assert.equal(result.ok, false);
    assert.equal(result.error, error);

    const run = db.lastRun();
    assert.equal(run.ok, 0);
    assert.equal(run.error_code, '4032');
    assert.match(run.error_message, /Invalid Bearer Token/);
    assert.equal(db.totals().snapshots, 0);
  });
});

test('startMonitor：按间隔循环采集，abort 后优雅停止', async () => {
  await withTempDb(async (db) => {
    const client = fakeClient();
    const controller = new AbortController();
    const config = { pollIntervalSeconds: 0.01, pollIntervalMs: 10, databasePath: db.filePath, retentionDays: null };

    const run = startMonitor({ client, db, config, logger: silentLogger, signal: controller.signal });
    setTimeout(() => controller.abort(), 60);
    await run;

    const runs = db.totals().runs;
    assert.ok(runs >= 2, `应当采集多次，实际 ${runs}`);
    assert.equal(db.totals().snapshots, runs, '每轮每台机器一条快照');
  });
});

test('startMonitor：采集失败不中断循环', async () => {
  await withTempDb(async (db) => {
    let calls = 0;
    const client = {
      async getMachines() {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('fetch failed'), { code: 'NETWORK_ERROR' });
        return normalizeResponse(payloadFor('available'), NOW);
      },
    };

    const controller = new AbortController();
    const config = { pollIntervalSeconds: 0.01, pollIntervalMs: 10, databasePath: db.filePath, retentionDays: null };

    const run = startMonitor({ client, db, config, logger: silentLogger, signal: controller.signal });
    setTimeout(() => controller.abort(), 60);
    await run;

    const runs = db.totals().runs;
    assert.ok(runs >= 2);
    const stats = db.stats();
    assert.equal(stats.runs.failed, 1);
    assert.deepEqual(stats.errorsByCode, [{ code: 'NETWORK_ERROR', count: 1 }]);
  });
});
