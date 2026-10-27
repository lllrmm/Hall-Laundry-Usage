import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeResponse } from '../../laundry-machines/index.js';
import { MonitorDatabase } from '../../laundry-monitor/src/db.js';

import { DashboardDatabase } from '../src/queries.js';
import { chooseBucketSeconds, parseRange } from '../src/time.js';

// 用"相对现在"的时间，保证窗口计算与真实运行一致（避免未来时间导致空桶）
const T0 = Date.now() - 30 * 60 * 1000;

function statusAt(now, { washerState = 'available', dryerState = 'available', dryerJob } = {}) {
  return normalizeResponse(
    {
      meta: { code: 200, message: 'Success' },
      data: {
        laundry_room_machines: [
          {
            laundry_room_name: 'UG Hall IV',
            machines: [
              {
                _id: 'm-washer',
                status: 'enabled',
                state: washerState,
                name: 'UG4 Washer (01)',
                service_type: { _id: 'st-w', machine_type: 'washer', value: 'washing_machine_without_powder', label: 'Washer' },
                laundry_room_name: 'UG Hall IV',
              },
              {
                _id: 'm-dryer',
                status: 'enabled',
                state: dryerState,
                name: 'UG4 Dryer (51)',
                service_type: { _id: 'st-d', machine_type: 'dryer', value: 'dryer_machine', label: 'Dry Machine' },
                laundry_room_name: 'UG Hall IV',
                ...(dryerJob ? { job: dryerJob } : {}),
              },
            ],
          },
        ],
      },
    },
    now,
  );
}

function makeDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-dash-'));
  const file = path.join(dir, 'test.sqlite');
  const db = new MonitorDatabase(file, { journalMode: 'DELETE' });

  db.recordSuccessfulPoll(statusAt(T0), { startedAt: new Date(T0), finishedAt: new Date(T0), durationMs: 120 });
  db.recordSuccessfulPoll(statusAt(T0 + 60_000, { dryerState: 'in_use', dryerJob: { created_at: new Date(T0).toISOString(), ticket: { number_of_minutes: 45 } } }), {
    startedAt: new Date(T0 + 60_000),
    finishedAt: new Date(T0 + 60_000),
    durationMs: 100,
  });
  db.recordSuccessfulPoll(statusAt(T0 + 120_000), {
    startedAt: new Date(T0 + 120_000),
    finishedAt: new Date(T0 + 120_000),
    durationMs: 110,
  });
  db.close();

  return { dir, file };
}

function withDashboard(fn) {
  const { dir, file } = makeDatabase();
  const dashboard = new DashboardDatabase(file);
  try {
    return fn(dashboard);
  } finally {
    dashboard.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

test('parseRange / chooseBucketSeconds', () => {
  const now = T0;
  const day = parseRange('24h', now);
  assert.equal(day.label, '24h');
  assert.equal(day.windowSeconds, 86400);
  assert.equal(day.since, new Date(now - 86400_000).toISOString());

  const all = parseRange('all', now);
  assert.equal(all.since, null);

  assert.throws(() => parseRange('nonsense', now), /Cannot parse/);

  assert.equal(chooseBucketSeconds(3600), 30);
  assert.equal(chooseBucketSeconds(86400), 600);
  assert.equal(chooseBucketSeconds(7 * 86400), 3600);
  assert.ok(chooseBucketSeconds(30 * 86400) >= 3600);
});

test('meta：最后更新时间、轮询次数、机器数', () => {
  withDashboard((dashboard) => {
    const meta = dashboard.meta();
    assert.equal(meta.available, true);
    assert.equal(meta.pollCount, 3);
    assert.equal(meta.machineCount, 2);
    assert.equal(meta.lastObservedAt, new Date(T0 + 120_000).toISOString());
    assert.equal(meta.lastPoll.ok, true);
    assert.equal(meta.lastPoll.durationMs, 110);
  });
});

test('latest：返回数据库中最新一轮的全部机器', () => {
  withDashboard((dashboard) => {
    const latest = dashboard.latest();
    assert.equal(latest.length, 2);
    const dryer = latest.find((machine) => machine.id === 'm-dryer');
    assert.equal(dryer.available, true);
    assert.equal(dryer.state, 'available');
    assert.equal(dryer.observedAt, new Date(T0 + 120_000).toISOString());
  });
});

test('series：分桶、按机器过滤、totals 对齐', () => {
  withDashboard((dashboard) => {
    const since = new Date(T0 - 120_000).toISOString();
    const series = dashboard.series({ since, windowSeconds: 3600, machineIds: [] });

    assert.equal(series.available, true);
    assert.ok(series.buckets.length >= 5, `应当有多个桶，实际 ${series.buckets.length}`);
    assert.equal(series.machines.length, 2);
    assert.equal(series.series['m-washer'].availableRatio.length, series.buckets.length);
    assert.equal(series.totals.available.length, series.buckets.length);
    assert.equal(series.totals.inUse.length, series.buckets.length);

    // 洗衣机全程空闲，取到的值应当都是 100%
    const washerValues = series.series['m-washer'].availableRatio.filter((value) => value !== null);
    assert.ok(washerValues.length > 0);
    assert.ok(washerValues.every((value) => value === 1));

    // 烘干机中间一轮在用：样本里应当同时出现可用和不可用
    const dryerValues = series.series['m-dryer'].availableRatio.filter((value) => value !== null);
    assert.ok(dryerValues.includes(1));
    assert.ok(dryerValues.includes(0));

    const filtered = dashboard.series({ since, windowSeconds: 3600, machineIds: ['m-washer'] });
    assert.equal(filtered.machines.length, 1);
    assert.equal(filtered.machines[0].id, 'm-washer');
    assert.equal(filtered.series['m-dryer'], undefined);

    // 按机型聚合：washer / dryer 各自的在用台数序列
    assert.ok(series.totalsByKind, 'series 应返回 totalsByKind');
    assert.equal(series.totalsByKind.washer.inUse.length, series.buckets.length);
    assert.equal(series.totalsByKind.dryer.inUse.length, series.buckets.length);
    assert.ok(
      series.totalsByKind.washer.inUse.every((value) => value === null || value === 0),
      '洗衣机全程空闲，在用台数应恒为 0',
    );
    const dryerInUse = series.totalsByKind.dryer.inUse.filter((value) => value !== null);
    assert.ok(dryerInUse.some((value) => value > 0), '烘干机应有在用时段');
    const dryerMachineCounts = series.totalsByKind.dryer.machines.filter((value) => value !== null);
    assert.ok(dryerMachineCounts.length > 0 && dryerMachineCounts.every((count) => count === 1), 'dryer 机型 1 台');
  });
});

test('bars：时间窗内状态占比', () => {
  withDashboard((dashboard) => {
    const since = new Date(T0 - 60_000).toISOString();
    const bars = dashboard.bars({ since, machineIds: [] });
    const { rows } = bars;
    assert.equal(rows.length, 2);

    // 返回实际时段，供前端显示"开始 – 结束"
    assert.equal(bars.since, since);
    assert.ok(bars.until && Date.parse(bars.until) > Date.parse(since), 'bars 应返回 until');

    const dryer = rows.find((row) => row.id === 'm-dryer');
    assert.equal(dryer.samples, 3);
    assert.ok(Math.abs(dryer.availableRatio - 2 / 3) < 1e-9);

    const washer = rows.find((row) => row.id === 'm-washer');
    assert.equal(washer.availableRatio, 1);

    // since 为空（全部时间）时，用最早一条观测作为开始
    const all = dashboard.bars({ since: null, machineIds: [] });
    const earliest = rows.reduce(
      (min, row) => (row.firstSeenAt < min ? row.firstSeenAt : min),
      rows[0].firstSeenAt,
    );
    assert.equal(all.since, earliest, '全部时间时应回退到最早观测');
  });
});

test('hourly：总是返回 24 个小时桶', () => {
  withDashboard((dashboard) => {
    const { hours } = dashboard.hourly({ since: new Date(T0 - 60_000).toISOString(), machineIds: [] });
    assert.equal(hours.length, 24);
    const used = hours.filter((entry) => entry.samples > 0);
    assert.ok(used.length >= 1);
    assert.ok(used.every((entry) => entry.freeRatio >= 0 && entry.freeRatio <= 1));
    assert.ok(used.every((entry) => entry.usageRatio >= 0 && entry.usageRatio <= 1));
    assert.ok(used.some((entry) => entry.usageRatio > 0), '烘干机在用应产生使用率');
  });
});

test('洗粉标注：洗衣机 powder 字段（with / without），烘干机为 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-powder-'));
  const file = path.join(dir, 'test.sqlite');
  const db = new MonitorDatabase(file, { journalMode: 'DELETE' });

  const makeMachine = (id, name, kind, value) => ({
    _id: id,
    status: 'enabled',
    state: 'available',
    name,
    service_type: { _id: `st-${id}`, machine_type: kind, value, label: value },
    laundry_room_name: 'UG Hall IV',
  });

  const status = normalizeResponse(
    {
      meta: { code: 200, message: 'Success' },
      data: {
        laundry_room_machines: [
          {
            laundry_room_name: 'UG Hall IV',
            machines: [
              makeMachine('d1', 'UG4 Dryer (51)', 'dryer', 'dryer_machine'),
              makeMachine('w1', 'UG4 Washer (01)', 'washer', 'washing_machine_without_powder'),
              makeMachine('w2', 'UG4 Washer (05)', 'washer', 'washing_machine_with_powder'),
            ],
          },
        ],
      },
    },
    T0,
  );

  db.recordSuccessfulPoll(status, { startedAt: new Date(T0), finishedAt: new Date(T0), durationMs: 10 });
  db.close();

  const dashboard = new DashboardDatabase(file);
  try {
    const latest = dashboard.latest();
    const byId = new Map(latest.map((machine) => [machine.id, machine]));

    assert.equal(byId.get('w1').powder, 'without');
    assert.equal(byId.get('w1').serviceValue, 'washing_machine_without_powder');
    assert.equal(byId.get('w2').powder, 'with');
    assert.equal(byId.get('w2').serviceValue, 'washing_machine_with_powder');
    assert.equal(byId.get('d1').powder, null);

    const machines = new Map(dashboard.machines().map((machine) => [machine.id, machine]));
    assert.equal(machines.get('w1').powder, 'without');
    assert.equal(machines.get('w2').powder, 'with');
    assert.equal(machines.get('d1').powder, null);
  } finally {
    dashboard.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test('数据库不存在时优雅降级', () => {
  const dashboard = new DashboardDatabase(path.join(os.tmpdir(), 'definitely-missing', 'nope.sqlite'));
  try {
    const meta = dashboard.meta();
    assert.equal(meta.available, false);
    assert.equal(meta.lastObservedAt, null);
    assert.deepEqual(dashboard.machines(), []);
    assert.deepEqual(dashboard.latest(), []);

    const series = dashboard.series({ since: null, windowSeconds: 3600 });
    assert.equal(series.available, false);
    assert.deepEqual(series.buckets, []);
  } finally {
    dashboard.close();
  }
});
