import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeResponse } from '../../laundry-monitor/src/machines/index.js';
import { MonitorDatabase } from '../../laundry-monitor/src/db.js';

import { createDashboardServer } from '../src/server.js';

// 用"相对现在"的时间，保证与真实运行的时间窗口一致
const T0 = Date.now() - 10 * 60 * 1000;

/** 本地日期 YYYY-MM-DD */
function localDay(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const DAY = localDay(new Date(T0));
const DAYS_QUERY = `machines=m1&from=${DAY}&to=${DAY}`;

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

test('GET /api/meta 与 /api/state（latest 已合并进 machines）', async () => {
  await withServer(async (base) => {
    const meta = await (await fetch(`${base}/api/meta`)).json();
    assert.equal(meta.available, true);
    assert.equal(meta.pollCount, 1);
    assert.deepEqual(meta.span, { firstDay: DAY, lastDay: DAY }, '/api/meta 也应返回数据覆盖范围');

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal('latest' in state, false, 'latest 不再是顶层字段');
    assert.equal(state.machines.length, 1);
    const machine = state.machines[0];
    assert.equal(machine.name, 'UG4 Dryer (51)');
    assert.equal(machine.kind, 'dryer');
    assert.equal(machine.available, true);
    assert.equal(machine.state, 'available');
    assert.ok(machine.observedAt, 'machines 应带最新观测时间');
    assert.deepEqual(state.meta.span, { firstDay: DAY, lastDay: DAY }, 'span 放在 meta 里');
    assert.equal('span' in state, false, 'span 不再作为顶层字段');

    // /api/machines 也返回合并后的数据
    const machines = await (await fetch(`${base}/api/machines`)).json();
    assert.equal(machines.machines.length, 1);
    assert.equal(machines.machines[0].available, true);
    assert.equal('observedAt' in machines.machines[0], true);

    // /api/latest 已删除
    assert.equal((await fetch(`${base}/api/latest`)).status, 404);
  });
});

test('GET /api/days 返回原始日序列（序列库缺失时回退 raw）', async () => {
  await withServer(async (base) => {
    const payload = await (await fetch(`${base}/api/days?${DAYS_QUERY}`)).json();
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

    const scoped = await (
      await fetch(`${base}/api/days?machines=nope&from=${DAY}&to=${DAY}`)
    ).json();
    assert.equal(scoped.count, 0);

    // 缺参数 / 非法参数 → 400
    for (const query of [
      `from=${DAY}&to=${DAY}`,
      'machines=m1',
      `machines=m1&from=${DAY}`,
      `machines=m1&from=bogus&to=${DAY}`,
    ]) {
      const invalid = await fetch(`${base}/api/days?${query}`);
      assert.equal(invalid.status, 400, query);
    }

    // 旧的聚合接口已移除
    for (const route of ['/api/bars', '/api/hourly', '/api/heatmap', '/api/profile']) {
      assert.equal((await fetch(`${base}${route}`)).status, 404, `${route} 应已删除`);
    }
  });
});

test('gzip：大响应压缩、小响应不压缩', async () => {
  await withServer(async (base) => {
    // /api/days 返回 1440 字节日序列，JSON > 1KB，应被 gzip
    const compressed = await fetch(`${base}/api/days?${DAYS_QUERY}`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers.get('content-encoding'), 'gzip');
    assert.match(compressed.headers.get('vary') ?? '', /accept-encoding/i);
    const parsed = await compressed.json();
    assert.equal(parsed.count, 1, 'gzip 响应解压后仍是合法 JSON');

    const plain = await fetch(`${base}/api/days?${DAYS_QUERY}`, {
      headers: { 'accept-encoding': 'identity' },
    });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal((await plain.json()).count, parsed.count);

    // meta JSON 很小，即使客户端支持 gzip 也不压缩
    const meta = await fetch(`${base}/api/meta`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(meta.status, 200);
    assert.equal(meta.headers.get('content-encoding'), null, '小响应不应压缩');
  });
});

test('未知 API 路由 404；非 API 路径提示由 laundry-dashboard-webpage 托管', async () => {
  await withServer(async (base) => {
    const notFound = await fetch(`${base}/api/nope`);
    assert.equal(notFound.status, 404);

    // 已删除的历史聚合接口
    for (const route of ['/api/series', '/api/bars', '/api/heatmap', '/api/profile', '/api/hourly']) {
      assert.equal((await fetch(`${base}${route}`)).status, 404, `${route} 应已删除`);
    }

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 404, 'dashboard 只提供 API，页面由 laundry-dashboard-webpage 托管');
    assert.match((await page.json()).error, /laundry-dashboard-webpage/);
  });
});

test('CORS：白名单 origin 返回头，OPTIONS 预检 204，非白名单无 ACAO', async () => {
  const { dir, file } = buildFixtureDb();
  const app = createDashboardServer({
    config: {
      databasePath: file,
      seriesDatabasePath: path.join(dir, 'missing-series.sqlite'),
      host: '127.0.0.1',
      port: 0,
      corsOrigins: ['https://user.github.io'],
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  try {
    const address = await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${address.port}`;

    const allowed = await fetch(`${base}/api/state`, {
      headers: { origin: 'https://user.github.io' },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://user.github.io');
    assert.match(allowed.headers.get('vary') ?? '', /origin/i);

    const denied = await fetch(`${base}/api/state`, {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(denied.status, 200);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);

    const preflight = await fetch(`${base}/api/state`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://user.github.io',
        'access-control-request-method': 'GET',
        'access-control-request-private-network': 'true',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://user.github.io');
    assert.match(preflight.headers.get('access-control-allow-methods') ?? '', /GET/);
    assert.equal(
      preflight.headers.get('access-control-allow-private-network'),
      'true',
      'Chrome PNA：公网页面访问 localhost 时需要该响应头',
    );
  } finally {
    await app.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});
