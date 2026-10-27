import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeResponse } from '../../laundry-machines/index.js';
import { MonitorDatabase } from '../../laundry-monitor/src/db.js';

import { createDashboardServer } from '../src/server.js';

// 用"相对现在"的时间，保证与真实运行的时间窗口一致
const T0 = Date.now() - 10 * 60 * 1000;

function buildFixtureDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-dash-server-'));
  const file = path.join(dir, 'test.sqlite');
  const db = new MonitorDatabase(file, { journalMode: 'DELETE' });

  const status = normalizeResponse(
    {
      meta: { code: 200, message: 'Success' },
      data: {
        laundry_room_machines: [
          {
            laundry_room_name: 'UG Hall IV',
            machines: [
              {
                _id: 'm1',
                status: 'enabled',
                state: 'available',
                name: 'UG4 Dryer (51)',
                service_type: { _id: 'st-d', machine_type: 'dryer', value: 'dryer_machine', label: 'Dry Machine' },
                laundry_room_name: 'UG Hall IV',
              },
            ],
          },
        ],
      },
    },
    T0,
  );

  db.recordSuccessfulPoll(status, { startedAt: new Date(T0), finishedAt: new Date(T0), durationMs: 90 });
  db.close();

  return { dir, file };
}

async function withServer(fn) {
  const { dir, file } = buildFixtureDb();
  const app = createDashboardServer({
    config: { databasePath: file, host: '127.0.0.1', port: 0, refreshSeconds: 30 },
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    const address = await app.listen(0, '127.0.0.1');
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await app.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

test('GET / 返回看板页面', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /HKUST Laundry Monitor/);
    assert.match(html, /Current status/);
    assert.match(html, /chart-trend/);
    assert.match(html, /id="theme-toggle"/, '页面应包含主题切换按钮');
    assert.match(html, /data-theme/, '首屏应内联主题初始化脚本');
    assert.match(html, /\/vendor\/chart\.umd\.js/, '应加载本地 vendor 的 Chart.js');
    assert.doesNotMatch(html, /Washers show detergent/, '状态区不应再有洗粉提示文案');
  });
});

test('GET /vendor/chart.umd.js 返回 Chart.js', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/vendor/chart.umd.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    const source = await response.text();
    assert.ok(source.length > 100_000, 'Chart.js UMD 构建应完整');
    assert.match(source, /Chart/, '内容应包含 Chart 定义');
  });
});

test('GET /api/meta 与 /api/state', async () => {
  await withServer(async (base) => {
    const meta = await (await fetch(`${base}/api/meta`)).json();
    assert.equal(meta.available, true);
    assert.equal(meta.pollCount, 1);

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.latest.length, 1);
    assert.equal(state.latest[0].name, 'UG4 Dryer (51)');
    assert.equal(state.machines.length, 1);
  });
});

test('GET /api/series 按机器过滤并返回分桶', async () => {
  await withServer(async (base) => {
    const series = await (await fetch(`${base}/api/series?since=1h&machines=m1`)).json();
    assert.equal(series.available, true);
    assert.ok(Array.isArray(series.buckets));
    assert.equal(series.machines.length, 1);
    assert.ok(series.bucketSeconds >= 30);

    const none = await (await fetch(`${base}/api/series?since=1h&machines=nope`)).json();
    assert.equal(none.machines.length, 0);
  });
});

test('GET /api/bars 与 /api/hourly', async () => {
  await withServer(async (base) => {
    const bars = await (await fetch(`${base}/api/bars?since=1h`)).json();
    assert.equal(bars.rows.length, 1);
    assert.equal(bars.rows[0].availableRatio, 1);

    const hourly = await (await fetch(`${base}/api/hourly?since=24h`)).json();
    assert.equal(hourly.hours.length, 24);
  });
});

test('非法时间窗口返回 500 错误 JSON', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/series?since=bogus`);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.match(body.error, /Cannot parse/);
  });
});

test('未知 API 路由 404，目录穿越被拒绝', async () => {
  await withServer(async (base) => {
    const notFound = await fetch(`${base}/api/nope`);
    assert.equal(notFound.status, 404);

    const traversal = await fetch(`${base}/%2e%2e/package.json`);
    assert.ok([403, 404].includes(traversal.status));

    const css = await fetch(`${base}/styles.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
  });
});
