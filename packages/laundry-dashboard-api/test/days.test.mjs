/**
 * /api/days：历史日序列接口。
 *
 * 接口强约束：machines 必填；日期用 from+to 或 days 列表（互斥）。
 * 覆盖：序列库直读、原始快照回退、两者混合、日期/机器/日期列表筛选、
 * 参数校验（400）、/api/state 的 span、旧聚合接口已删除。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeResponse } from '../../laundry-monitor/src/machines/index.js';
import { MonitorDatabase } from '../../laundry-monitor/src/db.js';
import { SeriesDatabase } from '../../laundry-monitor/src/series.js';

import { createDashboardServer } from '../src/server.js';
import { snapshotByte, STATE_BYTES } from '../src/days.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const MINUTES = 1440;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function localKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function timeline() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const day1Start = new Date(todayStart);
  day1Start.setDate(day1Start.getDate() - 1);
  const at = (dayStart, hour, minute) =>
    new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), hour, minute, 0, 0);
  return {
    day1Start,
    todayStart,
    day1: localKey(day1Start),
    day2: localKey(todayStart),
    at1: at(day1Start, 10, 0),
    at2: at(day1Start, 10, 1),
    at3: at(todayStart, 11, 0),
    at4: at(todayStart, 11, 5),
  };
}

const MACHINES = [
  { id: 'm-washer', name: 'UG4 Washer (01)', kind: 'washer', serviceValue: 'washing_machine_without_powder' },
  { id: 'm-dryer', name: 'UG4 Dryer (51)', kind: 'dryer', serviceValue: 'dryer_machine' },
  { id: 'm-maint', name: 'UG4 Washer (05)', kind: 'washer', serviceValue: 'washing_machine_with_powder' },
];

const ALL_IDS = MACHINES.map((machine) => machine.id).join(',');

function statusAt(when, specs) {
  const machines = MACHINES.map((machine) => ({
    _id: machine.id,
    status: specs[machine.id]?.status ?? 'enabled',
    state: specs[machine.id]?.state ?? 'available',
    name: machine.name,
    service_type: {
      _id: `st-${machine.id}`,
      machine_type: machine.kind,
      value: machine.serviceValue,
      label: machine.serviceValue,
    },
    laundry_room_name: 'UG Hall IV',
  }));
  return normalizeResponse(
    {
      meta: { code: 200, message: 'Success' },
      data: { laundry_room_machines: [{ laundry_room_name: 'UG Hall IV', machines }] },
    },
    when.getTime(),
  );
}

const DAY1_FIRST = {
  'm-washer': { state: 'available' },
  'm-dryer': { state: 'in_use' },
  'm-maint': { state: 'available', status: 'maintenance' },
};
const DAY1_SECOND = {
  'm-washer': { state: 'in_use' },
  'm-dryer': { state: 'available' },
  'm-maint': { state: 'available', status: 'maintenance' },
};
const DAY2_FIRST = {
  'm-washer': { state: 'available' },
  'm-dryer': { state: 'available' },
  'm-maint': { state: 'available', status: 'disabled' },
};
const DAY2_SECOND = {
  'm-washer': { state: 'offline' },
  'm-dryer': { state: 'in_use' },
  'm-maint': { state: 'available', status: 'disabled' },
};

function recordPoll(raw, when, specs) {
  raw.recordSuccessfulPoll(statusAt(when, specs), { startedAt: when, finishedAt: when, durationMs: 10 });
}

/**
 * @param {'full'|'raw-only'|'mixed'} mode
 *   full     —— 序列库已从 raw 回填两天
 *   raw-only —— 不建序列库，只有原始快照
 *   mixed    —— 序列库只有第一天，第二天由 raw 回退
 */
function buildDatabases(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-days-'));
  const rawFile = path.join(dir, 'raw.sqlite');
  const seriesFile = path.join(dir, 'series.sqlite');
  const timelineInfo = timeline();
  const raw = new MonitorDatabase(rawFile, { journalMode: 'DELETE' });

  recordPoll(raw, timelineInfo.at1, DAY1_FIRST);
  recordPoll(raw, timelineInfo.at2, DAY1_SECOND);

  const series = mode === 'raw-only' ? null : new SeriesDatabase(seriesFile, { journalMode: 'DELETE' });
  try {
    // mixed 模式：先回填（此时 raw 只有第一天），之后 raw 再写第二天
    if (mode === 'mixed' && series) series.rebuildFromRaw(raw.db);
    recordPoll(raw, timelineInfo.at3, DAY2_FIRST);
    recordPoll(raw, timelineInfo.at4, DAY2_SECOND);
    if (mode !== 'mixed' && series) series.rebuildFromRaw(raw.db);
  } finally {
    series?.close();
    raw.close();
  }

  return { dir, rawFile, seriesFile, timeline: timelineInfo };
}

async function withServer(mode, fn) {
  const fixture = buildDatabases(mode);
  const app = createDashboardServer({
    config: {
      databasePath: fixture.rawFile,
      seriesDatabasePath: fixture.seriesFile,
      host: '127.0.0.1',
      port: 0,
    },
    logger: silentLogger,
  });

  try {
    const address = await app.listen(0, '127.0.0.1');
    return await fn({ base: `http://127.0.0.1:${address.port}`, fixture });
  } finally {
    await app.close();
    try {
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    } catch {
      // Windows 上偶发文件占用，忽略
    }
  }
}

function rowOf(payload, machineId, day) {
  return payload.days.find((row) => row.machineId === machineId && row.day === day);
}

function bytesOf(payload, machineId, day) {
  const row = rowOf(payload, machineId, day);
  assert.ok(row, `应存在 ${machineId} ${day}`);
  const bytes = Buffer.from(row.seq, 'base64');
  assert.equal(bytes.length, MINUTES, '每天应为 1,440 字节');
  return bytes;
}

const EXPECTED = {
  inUse: 0x00,
  available: 0x01,
  maintenance: 0x02,
  disabled: 0x03,
  offline: 0x04,
  noData: 0xff,
};

function assertBytes(payload, machineId, day, writes) {
  const bytes = bytesOf(payload, machineId, day);
  for (const [minute, byte] of Object.entries(writes)) {
    assert.equal(bytes[Number(minute)], byte, `${machineId} ${day} 第 ${minute} 分钟应为 ${byte}`);
  }
  assert.equal(bytes[0], EXPECTED.noData, '没有轮询的分钟应为 no_data');
}

async function getJson(base, query) {
  const response = await fetch(`${base}/api/days?${query}`);
  return { status: response.status, body: await response.json() };
}

test('GET /api/days：优先读序列库，返回 1440 字节/机器·天（status 优先编码）', async () => {
  await withServer('full', async ({ base, fixture }) => {
    const { day1, day2 } = fixture.timeline;
    const { status, body } = await getJson(base, `machines=${ALL_IDS}&from=${day1}&to=${day2}`);

    assert.equal(status, 200);
    assert.equal(body.available, true);
    assert.equal(body.source, 'series');
    assert.equal(body.count, 6, '3 台机器 × 2 天');
    assert.equal(body.fromDay, day1);
    assert.equal(body.toDay, day2);
    assert.equal(body.firstDay, day1);
    assert.equal(body.lastDay, day2);
    assert.equal(body.encoding.inUse, 0x00);
    assert.equal(body.encoding.noData, 0xff);

    assertBytes(body, 'm-washer', day1, { 600: EXPECTED.available, 601: EXPECTED.inUse });
    assertBytes(body, 'm-dryer', day1, { 600: EXPECTED.inUse, 601: EXPECTED.available });
    // 维护中的机器 state 也是 available，必须算 maintenance 而不是 available
    assertBytes(body, 'm-maint', day1, { 600: EXPECTED.maintenance, 601: EXPECTED.maintenance });
    assertBytes(body, 'm-washer', day2, { 660: EXPECTED.available, 665: EXPECTED.offline });
    assertBytes(body, 'm-dryer', day2, { 660: EXPECTED.available, 665: EXPECTED.inUse });
    assertBytes(body, 'm-maint', day2, { 660: EXPECTED.disabled, 665: EXPECTED.disabled });

    assert.ok(rowOf(body, 'm-washer', day1).updatedAt, '应带该机器·天的最近更新时间');
  });
});

test('GET /api/days：from / to / machines 过滤', async () => {
  await withServer('full', async ({ base, fixture }) => {
    const { day1, day2 } = fixture.timeline;

    const secondDay = (
      await getJson(base, `machines=${ALL_IDS}&from=${day2}&to=${day2}`)
    ).body;
    assert.equal(secondDay.count, 3);
    assert.ok(secondDay.days.every((row) => row.day === day2));
    assert.equal(secondDay.firstDay, day2);

    const washerOnly = (await getJson(base, `machines=m-washer&from=${day1}&to=${day2}`)).body;
    assert.equal(washerOnly.count, 2);
    assert.deepEqual([...new Set(washerOnly.days.map((row) => row.machineId))], ['m-washer']);

    const scoped = (
      await getJson(base, `machines=m-washer,m-dryer&from=${day2}&to=${day2}`)
    ).body;
    assert.equal(scoped.count, 2);
    assert.deepEqual(
      scoped.days.map((row) => row.machineId),
      ['m-dryer', 'm-washer'],
      '按 day、machineId 排序',
    );

    const none = (await getJson(base, `machines=${ALL_IDS}&from=2000-01-01&to=2000-01-02`)).body;
    assert.equal(none.available, true);
    assert.equal(none.count, 0);
    assert.equal(none.firstDay, null);
    assert.equal(none.source, null);
  });
});

test('GET /api/days：days 日期列表（与 from/to 互斥），只返回列出的日期', async () => {
  await withServer('full', async ({ base, fixture }) => {
    const { day1, day2 } = fixture.timeline;

    // 乱序 + 重复 → 排序去重后按天返回
    const payload = (
      await getJson(base, `machines=m-washer&days=${day2},${day1},${day2}`)
    ).body;
    assert.equal(payload.count, 2);
    assert.deepEqual(
      payload.days.map((row) => row.day),
      [day1, day2],
    );
    assert.equal(payload.fromDay, day1);
    assert.equal(payload.toDay, day2);
    assertBytes(payload, 'm-washer', day1, { 600: EXPECTED.available, 601: EXPECTED.inUse });
    assertBytes(payload, 'm-washer', day2, { 660: EXPECTED.available, 665: EXPECTED.offline });

    // 只取其中一天
    const single = (await getJson(base, `machines=m-washer&days=${day2}`)).body;
    assert.equal(single.count, 1);
    assert.equal(single.days[0].day, day2);
  });
});

test('GET /api/days：序列库不存在时回退原始快照即时生成', async () => {
  await withServer('raw-only', async ({ base, fixture }) => {
    const { day1, day2 } = fixture.timeline;
    const payload = (await getJson(base, `machines=${ALL_IDS}&from=${day1}&to=${day2}`)).body;

    assert.equal(payload.available, true);
    assert.equal(payload.source, 'raw');
    assert.equal(payload.count, 6);
    assertBytes(payload, 'm-washer', day1, { 600: EXPECTED.available, 601: EXPECTED.inUse });
    assertBytes(payload, 'm-maint', day1, { 600: EXPECTED.maintenance }, 'raw 回填同样要 status 优先');
    assertBytes(payload, 'm-maint', day2, { 660: EXPECTED.disabled });
  });
});

test('GET /api/days：序列库缺天时用 raw 补齐（source=mixed）', async () => {
  await withServer('mixed', async ({ base, fixture }) => {
    const { day1, day2 } = fixture.timeline;
    const payload = (await getJson(base, `machines=${ALL_IDS}&from=${day1}&to=${day2}`)).body;

    assert.equal(payload.source, 'mixed');
    assert.equal(payload.count, 6, '第一天来自序列库，第二天来自 raw');
    assertBytes(payload, 'm-washer', day1, { 600: EXPECTED.available });
    assertBytes(payload, 'm-washer', day2, { 660: EXPECTED.available, 665: EXPECTED.offline });
    assertBytes(payload, 'm-maint', day1, { 600: EXPECTED.maintenance });
  });
});

test('snapshotByte：on_hold 按底层 state 细分编码', () => {
  assert.equal(
    snapshotByte({ status: 'on_hold', state: 'in_use', available: 0 }),
    STATE_BYTES.onHoldInUse,
  );
  assert.equal(
    snapshotByte({ status: 'on_hold', state: 'available', available: 0 }),
    STATE_BYTES.onHoldAvailable,
  );
  assert.equal(
    snapshotByte({ status: 'on_hold', state: 'offline', available: 0 }),
    STATE_BYTES.onHoldOffline,
  );
  assert.equal(
    snapshotByte({ status: 'on_hold', state: 'weird', available: 0 }),
    STATE_BYTES.onHoldUnknown,
  );
});

test('GET /api/state：meta 里返回数据覆盖的日期范围 span', async () => {
  await withServer('full', async ({ base, fixture }) => {
    const { day1, day2 } = fixture.timeline;
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(state.meta.span, { firstDay: day1, lastDay: day2 });
    assert.equal('span' in state, false, 'span 不再是顶层字段');
  });
});

test('GET /api/days：参数校验（machines 必填 + from/to 或 days 必填）', async () => {
  await withServer('full', async ({ base, fixture }) => {
    const { day1, day2 } = fixture.timeline;

    const cases = [
      {
        query: `from=${day1}&to=${day2}`,
        message: /machines 参数必填/,
        label: '缺 machines',
      },
      {
        query: `machines=m-washer`,
        message: /from 和 to/,
        label: '缺日期范围',
      },
      {
        query: `machines=m-washer&from=${day1}`,
        message: /from 和 to/,
        label: '只有 from',
      },
      {
        query: `machines=m-washer&to=${day2}`,
        message: /from 和 to/,
        label: '只有 to',
      },
      {
        query: `machines=m-washer&from=nonsense&to=${day2}`,
        message: /无法解析日期参数/,
        label: 'from 非法',
      },
      {
        query: `machines=m-washer&from=${day1}&to=2026-13-99`,
        message: /无法解析日期参数/,
        label: 'to 不是真实日期',
      },
      {
        query: `machines=m-washer&from=${day2}&to=${day1}`,
        message: /from 不能晚于 to/,
        label: 'from 晚于 to',
      },
      {
        query: `machines=m-washer&from=${day1}&to=${day2}&days=${day1}`,
        message: /不能同时使用/,
        label: 'from/to 与 days 同时给',
      },
      {
        query: `machines=m-washer&days=${day1},bad-day`,
        message: /days 列表里包含非法日期/,
        label: 'days 含非法日期',
      },
    ];

    for (const item of cases) {
      const response = await fetch(`${base}/api/days?${item.query}`);
      assert.equal(response.status, 400, item.label);
      const body = await response.json();
      assert.match(body.error, item.message, item.label);
    }

    // days 列表超过 366 天 → 400
    const days = [];
    for (let index = 0; index < 367; index += 1) {
      const cursor = new Date(2020, 0, 1 + index);
      days.push(localKey(cursor));
    }
    const tooMany = await fetch(`${base}/api/days?machines=m-washer&days=${days.join(',')}`);
    assert.equal(tooMany.status, 400);
    assert.match((await tooMany.json()).error, /最多 366 天/);
  });
});

test('GET /api/days：两个库都不存在时优雅降级；库稍后出现能自动恢复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-days-empty-'));
  const rawPath = path.join(dir, 'missing-raw.sqlite');
  const seriesPath = path.join(dir, 'missing-series.sqlite');
  const app = createDashboardServer({
    config: { databasePath: rawPath, seriesDatabasePath: seriesPath, host: '127.0.0.1', port: 0 },
    logger: silentLogger,
  });
  let fixture = null;
  try {
    const address = await app.listen(0, '127.0.0.1');
    const first = await fetch(
      `http://127.0.0.1:${address.port}/api/days?machines=m-washer&from=2026-01-01&to=2026-01-02`,
    );
    assert.equal(first.status, 200);
    const empty = await first.json();
    assert.equal(empty.available, false);
    assert.deepEqual(empty.days, []);
    assert.equal(empty.count, 0);

    // 模拟 Docker 启动顺序：API 先起，采集服务稍后才创建 SQLite
    fixture = buildDatabases('full');
    fs.copyFileSync(fixture.rawFile, rawPath);
    fs.copyFileSync(fixture.seriesFile, seriesPath);
    const second = await fetch(
      `http://127.0.0.1:${address.port}/api/days?machines=${ALL_IDS}&from=${fixture.timeline.day1}&to=${fixture.timeline.day2}`,
    );
    const recovered = await second.json();
    assert.equal(recovered.available, true);
    assert.equal(recovered.count, 6, '库出现后无需重启 API 即可读取');
  } finally {
    await app.close();
    if (fixture) fs.rmSync(fixture.dir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('旧的聚合接口已移除（交由前端计算）', async () => {
  await withServer('full', async ({ base }) => {
    for (const route of ['/api/bars', '/api/hourly', '/api/heatmap', '/api/profile', '/api/profile/days']) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 404, `${route} 应返回 404`);
      const body = await response.json();
      assert.match(body.error, /Unknown API route/);
    }
  });
});
