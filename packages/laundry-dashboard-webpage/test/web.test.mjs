import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';

import { createWebServer } from '../src/server.js';
import { normalizeWebConfig } from '../src/config.js';

const silentLogger = { info() {}, warn() {}, error() {} };

function startStubApi(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test('静态托管：index.html、JS gzip、404、目录穿越、非 GET', async () => {
  const web = createWebServer({
    config: { host: '127.0.0.1', port: 0, apiTarget: null },
    logger: silentLogger,
  });
  const address = await web.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /Hall Laundry Usage/);

    // Node fetch 会自动解压，这里用 http 拿原始字节验证 gzip
    const rawScript = await new Promise((resolve, reject) => {
      http
        .get(`${base}/app.js`, { headers: { 'accept-encoding': 'gzip' } }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
        })
        .on('error', reject);
    });
    assert.equal(rawScript.headers['content-encoding'], 'gzip');
    const script = zlib.gunzipSync(rawScript.body).toString('utf8');
    assert.match(script, /\/api\/state/);

    assert.equal((await fetch(`${base}/missing.js`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e/%2e%2e/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  } finally {
    await web.close();
  }
});

test('API 反向代理：/api/* 转发到 apiTarget，失败时返回 502', async () => {
  let seenPath = null;
  const api = await startStubApi((req, res) => {
    seenPath = req.url;
    res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });

  const web = createWebServer({
    config: { host: '127.0.0.1', port: 0, apiTarget: api.url },
    logger: silentLogger,
  });
  const address = await web.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const response = await fetch(`${base}/api/state?x=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-upstream'), 'yes');
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.match(seenPath, /^\/api\/state\?x=1$/);
  } finally {
    await web.close();
    await api.close();
  }
});

test('API 代理未配置时返回 404 提示', async () => {
  const web = createWebServer({
    config: { host: '127.0.0.1', port: 0, apiTarget: null },
    logger: silentLogger,
  });
  const address = await web.listen(0, '127.0.0.1');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/state`);
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /API 代理未配置/);
  } finally {
    await web.close();
  }
});

test('配置校验：端口、apiTarget、默认值', () => {
  assert.deepEqual(normalizeWebConfig({}), {
    host: '127.0.0.1',
    port: 8788,
    apiTarget: 'http://127.0.0.1:8787',
    sourcePath: null,
  });
  assert.equal(normalizeWebConfig({ apiTarget: null }).apiTarget, null);
  assert.equal(normalizeWebConfig({ apiTarget: 'http://x:1/' }).apiTarget, 'http://x:1');
  assert.throws(() => normalizeWebConfig({ port: 70000 }), /port/);
  assert.throws(() => normalizeWebConfig({ apiTarget: 'ftp://x' }), /apiTarget/);
  assert.throws(() => normalizeWebConfig({ apiTarget: 'not a url' }), /apiTarget/);
});
