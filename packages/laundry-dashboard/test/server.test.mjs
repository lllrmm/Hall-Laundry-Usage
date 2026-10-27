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
    config: {
      databasePath: file,
      // 这个 fixture 只造了原始库：日序列接口应回退到 raw 即时生成
      seriesDatabasePath: path.join(dir, 'missing-series.sqlite'),
      host: '127.0.0.1',
      port: 0,
      refreshSeconds: 30,
    },
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
    assert.match(html, /chart-bars/);
    assert.match(html, /chart-profile/);
    assert.doesNotMatch(html, /chart-trend|chart-hourly/, '趋势图与按小时图已移除');
    assert.match(html, /Date range/, '时间跨度控件改名为 Date range');
    assert.match(html, /id="theme-toggle"/, '页面应包含主题切换按钮');
    assert.match(html, /data-theme/, '首屏应内联主题初始化脚本');
    assert.match(html, /\/vendor\/chart\.umd\.js/, '应加载本地 vendor 的 Chart.js');
    assert.match(html, /\/aggregate\.js/, '应加载浏览器端聚合脚本');
    assert.match(html, /\/history\.js/, '应加载浏览器端取数计划脚本');
    assert.match(html, /Database updated/, '顶栏时间标签应为 Database updated');
    assert.doesNotMatch(html, />Data updated</, '旧标签 Data updated 应已移除');
    assert.match(html, /id="bars-range"/, '占比图应显示当前时间范围');
    assert.doesNotMatch(html, /All machines/, '旧的 All machines 文案应已移除');
    assert.doesNotMatch(html, /Usage rate by hour/, '按小时图已移除');
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

test('GET /api/days 返回原始日序列（序列库缺失时回退 raw）', async () => {
  await withServer(async (base) => {
    const payload = await (await fetch(`${base}/api/days`)).json();
    assert.equal(payload.available, true);
    assert.equal(payload.source, 'raw');
    assert.equal(payload.count, 1, '1 台机器 × 1 天');
    assert.equal(payload.encoding.noData, 0xff);

    const row = payload.days[0];
    assert.equal(row.machineId, 'm1');
    const bytes = Buffer.from(row.seq, 'base64');
    assert.equal(bytes.length, 1440);
    const at = new Date(T0);
    assert.equal(bytes[at.getHours() * 60 + at.getMinutes()], 0x01, '该分钟为空闲');

    const scoped = await (await fetch(`${base}/api/days?machines=nope`)).json();
    assert.equal(scoped.count, 0);

    const invalid = await fetch(`${base}/api/days?from=bogus`);
    assert.equal(invalid.status, 500);

    // 旧的聚合接口已移除
    for (const route of ['/api/bars', '/api/hourly', '/api/heatmap', '/api/profile']) {
      assert.equal((await fetch(`${base}${route}`)).status, 404, `${route} 应已删除`);
    }
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
