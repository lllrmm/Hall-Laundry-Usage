import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_BASE_URL,
  LaundryAuthError,
  LaundryClient,
  LaundryError,
  MACHINES_ENDPOINT,
  createClient,
  resolveToken,
} from '../src/machines/index.js';

const fixtureUrl = new URL('./fixtures/machines-response.json', import.meta.url);
const fixture = JSON.parse(fs.readFileSync(fixtureUrl, 'utf8'));
const FIXED_NOW = Date.parse('2026-10-26T17:00:00.000Z');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('请求：URL、鉴权头、方法都正确，并返回归一化结果', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(fixture);
  };

  const client = createClient({ token: 'test-token', fetch: fakeFetch });
  const status = await client.getMachines({ now: FIXED_NOW });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, DEFAULT_BASE_URL + MACHINES_ENDPOINT);
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].init.headers.Accept, 'application/json');

  assert.equal(status.counts.total, 12);
  assert.equal(status.rooms.length, 1);
  assert.equal(status.rooms[0].name, 'UG Hall IV');
  assert.equal(status.machines.length, 12);
  assert.ok(status.machines.every((m) => typeof m.available === 'boolean'));
  // fixture 里 UG4 Dryer (52) 是 16:41:05.666 开始、45 分钟
  const dryer52 = status.machines.find((m) => m.name === 'UG4 Dryer (52)');
  assert.equal(dryer52.remainingSeconds, 1566);
});

test('getMachinesRaw 返回服务端原始结构', async () => {
  const client = createClient({ token: 't', fetch: async () => jsonResponse(fixture) });
  const raw = await client.getMachinesRaw();

  assert.deepEqual(raw.meta, { code: 200, message: 'Success' });
  assert.equal(raw.data.laundry_room_machines[0].machines.length, 12);
});

test('baseUrl 结尾斜杠会被规范化', async () => {
  let url = null;
  const client = createClient({
    token: 't',
    baseUrl: 'https://example.test/ldr/api/',
    fetch: async (u) => {
      url = u;
      return jsonResponse(fixture);
    },
  });
  await client.getMachines();
  assert.equal(url, 'https://example.test/ldr/api' + MACHINES_ENDPOINT);
});

test('token 失效（4032）抛 LaundryAuthError', async () => {
  const client = createClient({
    token: 'expired',
    fetch: async () => jsonResponse({ meta: { code: 4032, message: 'Invalid Bearer Token.' }, data: null }),
  });

  await assert.rejects(client.getMachines(), (error) => {
    assert.ok(error instanceof LaundryAuthError);
    assert.ok(error instanceof LaundryError);
    assert.equal(error.code, 4032);
    assert.equal(error.endpoint, MACHINES_ENDPOINT);
    return true;
  });
});

test('业务错误（4034）抛 LaundryError 并保留 data', async () => {
  const payload = {
    meta: { code: 4034, message: 'Schema validation error' },
    data: { errors: [{ keyword: 'required', params: { missingProperty: 'service_type_id' } }] },
  };
  const client = createClient({ token: 't', fetch: async () => jsonResponse(payload) });

  await assert.rejects(client.getMachines(), (error) => {
    assert.equal(error.name, 'LaundryError');
    assert.equal(error.code, 4034);
    assert.equal(error.data.errors[0].params.missingProperty, 'service_type_id');
    return true;
  });
});

test('非 JSON 响应抛 INVALID_RESPONSE', async () => {
  const client = createClient({
    token: 't',
    fetch: async () => new Response('<html>gateway error</html>', { status: 502 }),
  });

  await assert.rejects(client.getMachines(), (error) => {
    assert.equal(error.code, 'INVALID_RESPONSE');
    assert.equal(error.status, 502);
    return true;
  });
});

test('网络异常抛 NETWORK_ERROR', async () => {
  const client = createClient({
    token: 't',
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });

  await assert.rejects(client.getMachines(), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.match(error.message, /fetch failed/);
    return true;
  });
});

test('超时抛 TIMEOUT', async () => {
  const hangingFetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    });

  const client = createClient({ token: 't', fetch: hangingFetch, timeoutMs: 10 });

  await assert.rejects(client.getMachines(), (error) => {
    assert.equal(error.code, 'TIMEOUT');
    return true;
  });
});

test('外部 AbortSignal 取消抛 ABORTED', async () => {
  const hangingFetch = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
    });

  const client = createClient({ token: 't', fetch: hangingFetch, timeoutMs: 5000 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);

  await assert.rejects(client.getMachines({ signal: controller.signal }), (error) => {
    assert.equal(error.code, 'ABORTED');
    return true;
  });
});

test('没有 token 时构造直接报错（4031）', () => {
  // 隔离外部环境：临时清掉 LDR_TOKEN 并在空目录下执行，避免读到仓库里的 token.txt
  const savedToken = process.env.LDR_TOKEN;
  const savedCwd = process.cwd();
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-no-token-'));
  delete process.env.LDR_TOKEN;
  process.chdir(emptyDir);

  try {
    assert.throws(
      () => new LaundryClient(),
      (error) => {
        assert.equal(error.code, 4031);
        assert.match(error.message, /Missing token/);
        return true;
      },
    );
  } finally {
    process.chdir(savedCwd);
    if (savedToken !== undefined) process.env.LDR_TOKEN = savedToken;
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('resolveToken 优先级：显式 > 环境变量 > token.txt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-token-'));
  fs.writeFileSync(path.join(dir, 'token.txt'), 'from-file\n');

  assert.equal(resolveToken({ token: 'explicit', env: { LDR_TOKEN: 'from-env' }, cwd: dir }), 'explicit');
  assert.equal(resolveToken({ env: { LDR_TOKEN: 'from-env' }, cwd: dir }), 'from-env');
  assert.equal(resolveToken({ env: {}, cwd: dir }), 'from-file');
  assert.equal(resolveToken({ env: {}, cwd: path.join(dir, 'nope') }), null);

  fs.rmSync(dir, { recursive: true, force: true });
});
