import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeResponse } from '../src/machines/index.js';

import { SCHEMA_VERSION, MonitorDatabase } from '../src/db.js';

/** 构造一个只有 2 台机器的归一化 status */
function makeStatus(now, overrides = {}) {
  const payload = {
    meta: { code: 200, message: 'Success' },
    data: {
      laundry_room_machines: [
        {
          laundry_room_name: 'UG Hall IV',
          machines: [
            {
              _id: 'm-washer',
              status: 'enabled',
              state: overrides.washerState ?? 'available',
              name: 'UG4 Washer (01)',
              service_type: { _id: 'st-w', machine_type: 'washer', value: 'washing_machine_without_powder', label: 'Washer' },
              laundry_room_name: 'UG Hall IV',
              ...(overrides.washerJob ? { job: overrides.washerJob } : {}),
            },
            {
              _id: 'm-dryer',
              status: 'enabled',
              state: overrides.dryerState ?? 'available',
              name: 'UG4 Dryer (51)',
              service_type: { _id: 'st-d', machine_type: 'dryer', value: 'dryer_machine', label: 'Dry Machine' },
              laundry_room_name: 'UG Hall IV',
              ...(overrides.dryerJob ? { job: overrides.dryerJob } : {}),
            },
          ],
        },
      ],
    },
  };
  return normalizeResponse(payload, now);
}

function withTempDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-db-'));
  const db = new MonitorDatabase(path.join(dir, 'test.sqlite'), { journalMode: 'DELETE' });
  try {
    return fn(db, dir);
  } finally {
    db.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows 上偶发文件占用，忽略清理失败
    }
  }
}

test('初始化：空库、schema 版本、totals 全 0', () => {
  withTempDb((db) => {
    assert.equal(db.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(db.totals(), { runs: 0, snapshots: 0, transitions: 0, machines: 0 });
    assert.equal(db.lastRun(), null);
  });
});

test('记录成功轮询：run + 机器 + 快照 + 首次跳变', () => {
  const now = Date.parse('2026-10-27T02:00:00.000Z');

  withTempDb((db) => {
    const result = db.recordSuccessfulPoll(makeStatus(now), {
      startedAt: new Date(now),
      finishedAt: new Date(now + 200),
      durationMs: 200,
    });

    assert.equal(result.snapshotCount, 2);
    assert.equal(result.transitions.length, 2, '首次见到机器各记录一条跳变');
    assert.ok(result.transitions.every((t) => t.fromState === null));

    const totals = db.totals();
    assert.equal(totals.runs, 1);
    assert.equal(totals.snapshots, 2);
    assert.equal(totals.transitions, 2);
    assert.equal(totals.machines, 2);

    const run = db.lastRun();
    assert.equal(run.ok, 1);
    assert.equal(run.machine_count, 2);
    assert.equal(run.available_count, 2);
    assert.equal(run.error_code, null);
  });
});

test('状态变化：只记变化的那台机器，并能算出使用周期', () => {
  const t0 = Date.parse('2026-10-27T02:00:00.000Z');

  withTempDb((db) => {
    db.recordSuccessfulPoll(makeStatus(t0), { startedAt: new Date(t0), finishedAt: new Date(t0), durationMs: 10 });

    // 洗衣机开始使用，烘干机保持空闲
    const t1 = t0 + 60_000;
    const second = db.recordSuccessfulPoll(
      makeStatus(t1, { washerState: 'in_use', washerJob: { created_at: new Date(t1).toISOString() } }),
      { startedAt: new Date(t1), finishedAt: new Date(t1), durationMs: 10 },
    );

    assert.equal(second.transitions.length, 1);
    assert.equal(second.transitions[0].machineId, 'm-washer');
    assert.equal(second.transitions[0].fromState, 'available');
    assert.equal(second.transitions[0].toState, 'in_use');

    // 5 分钟后洗完变回空闲
    const t2 = t1 + 5 * 60_000;
    const third = db.recordSuccessfulPoll(makeStatus(t2), {
      startedAt: new Date(t2),
      finishedAt: new Date(t2),
      durationMs: 10,
    });
    assert.equal(third.transitions.length, 1);
    assert.equal(third.transitions[0].fromState, 'in_use');
    assert.equal(third.transitions[0].toState, 'available');

    const stats = db.stats();
    assert.equal(stats.runs.total, 3);
    assert.equal(stats.runs.ok, 3);
    assert.equal(stats.transitions.cycles, 1);

    const washer = stats.machines.find((machine) => machine.id === 'm-washer');
    assert.equal(washer.samples, 3);
    assert.ok(Math.abs(washer.inUsePct - 1 / 3) < 1e-9);
    assert.equal(washer.cycles, 1);
    assert.equal(washer.avgInUseSeconds, 300);
    assert.ok(Math.abs(stats.transitions.avgInUseSeconds - 300) < 1e-9);
  });
});

test('记录失败轮询：ok=0、错误码进统计，且不影响上一轮状态', () => {
  const now = Date.parse('2026-10-27T02:00:00.000Z');

  withTempDb((db) => {
    db.recordSuccessfulPoll(makeStatus(now), { startedAt: new Date(now), finishedAt: new Date(now), durationMs: 5 });

    const failed = db.recordFailedPoll({
      startedAt: new Date(now + 30_000),
      finishedAt: new Date(now + 30_100),
      durationMs: 100,
      error: Object.assign(new Error('Invalid Bearer Token.'), { code: 4032 }),
    });

    assert.ok(failed.runId > 0);
    assert.equal(failed.code, '4032');

    const stats = db.stats();
    assert.equal(stats.runs.total, 2);
    assert.equal(stats.runs.ok, 1);
    assert.equal(stats.runs.failed, 1);
    assert.deepEqual(stats.errorsByCode, [{ code: '4032', count: 1 }]);

    // 失败不产生快照：每台机器仍只有 1 条采样，总快照数 2
    assert.equal(stats.machines[0].samples, 1);
    assert.equal(db.totals().snapshots, 2);
  });
});

test('stats 支持 since 时间窗', () => {
  const t0 = Date.parse('2026-10-27T02:00:00.000Z');

  withTempDb((db) => {
    db.recordSuccessfulPoll(makeStatus(t0), { startedAt: new Date(t0), finishedAt: new Date(t0), durationMs: 5 });
    const t1 = t0 + 3_600_000;
    db.recordSuccessfulPoll(makeStatus(t1), { startedAt: new Date(t1), finishedAt: new Date(t1), durationMs: 5 });

    const recent = db.stats({ since: new Date(t1 - 1000).toISOString() });
    assert.equal(recent.runs.total, 1);
    assert.equal(recent.machines[0].samples, 1);
  });
});

test('exportSnapshots 带机器名称/机型，可直接转 CSV', () => {
  const now = Date.parse('2026-10-27T02:00:00.000Z');

  withTempDb((db) => {
    db.recordSuccessfulPoll(
      makeStatus(now, {
        dryerState: 'in_use',
        dryerJob: { created_at: new Date(now - 600_000).toISOString(), ticket: { number_of_minutes: 45 } },
      }),
      { startedAt: new Date(now), finishedAt: new Date(now), durationMs: 5 },
    );

    const rows = db.exportSnapshots({ limit: 10 });
    assert.equal(rows.length, 2);

    const dryer = rows.find((row) => row.machine_id === 'm-dryer');
    assert.equal(dryer.name, 'UG4 Dryer (51)');
    assert.equal(dryer.kind, 'dryer');
    assert.equal(dryer.available, 0);
    assert.equal(dryer.planned_minutes, 45);
    assert.equal(dryer.remaining_seconds, 2100);
  });
});

test('purgeOlderThan 清理历史数据', () => {
  const now = Date.parse('2026-10-27T02:00:00.000Z');

  withTempDb((db) => {
    db.recordSuccessfulPoll(makeStatus(now), { startedAt: new Date(now), finishedAt: new Date(now), durationMs: 5 });
    assert.equal(db.totals().snapshots, 2);

    const purged = db.purgeOlderThan(0, now + 1000);
    assert.equal(purged.snapshots, 2);
    assert.equal(purged.runs, 1);
    assert.equal(purged.transitions, 2);
    // 机器维度表保留，方便历史名称追溯
    assert.deepEqual(db.totals(), { runs: 0, snapshots: 0, transitions: 0, machines: 2 });
  });
});
