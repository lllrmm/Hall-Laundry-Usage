import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expandEnv, loadConfig, normalizeConfig } from '../src/config.js';

const baseInput = { bearer: 'token-123', pollIntervalSeconds: 30 };

test('默认值：只给 bearer 也能跑', () => {
  const config = normalizeConfig(baseInput, { env: {}, baseDir: '/tmp' });

  assert.equal(config.bearer, 'token-123');
  assert.equal(config.baseUrl, 'https://laundry.ust.hk/ldr/api');
  assert.equal(config.pollIntervalSeconds, 30);
  assert.equal(config.pollIntervalMs, 30_000);
  assert.equal(config.timeoutMs, 15_000);
  assert.equal(config.retentionDays, 30);
  assert.equal(config.logLevel, 'info');
  assert.deepEqual(config.warnings, []);
});

test('${ENV} 展开与 bearerEnv / LDR_TOKEN 回退', () => {
  assert.equal(expandEnv('Bearer ${TOKEN_X}', { TOKEN_X: 'abc' }), 'Bearer abc');
  assert.equal(expandEnv('${MISSING}', {}), '');
  assert.equal(expandEnv(42, {}), 42);

  const fromTemplate = normalizeConfig({ ...baseInput, bearer: '${MY_TOKEN}' }, { env: { MY_TOKEN: 'from-template' } });
  assert.equal(fromTemplate.bearer, 'from-template');

  const fromNamedEnv = normalizeConfig({ pollIntervalSeconds: 30, bearerEnv: 'LAUNDRY_TOKEN' }, { env: { LAUNDRY_TOKEN: 'from-env' } });
  assert.equal(fromNamedEnv.bearer, 'from-env');

  const fromLdrToken = normalizeConfig({ pollIntervalSeconds: 30 }, { env: { LDR_TOKEN: 'from-ldr' } });
  assert.equal(fromLdrToken.bearer, 'from-ldr');
});

test('缺少 bearer：默认报错，requireBearer=false 时只给警告', () => {
  assert.throws(() => normalizeConfig({ pollIntervalSeconds: 30 }, { env: {} }), /缺少 bearer/);

  const config = normalizeConfig({ pollIntervalSeconds: 30 }, { env: {}, requireBearer: false });
  assert.equal(config.bearer, null);
  assert.match(config.warnings.join('\n'), /没有 bearer/);
});

test('database 相对路径按配置文件目录解析', () => {
  const config = normalizeConfig(baseInput, { env: {}, baseDir: path.join('/base', 'dir') });
  assert.equal(config.databasePath, path.resolve('/base/dir', './data/laundry.sqlite'));

  const custom = normalizeConfig({ ...baseInput, database: './db/custom.sqlite' }, { env: {}, baseDir: '/tmp/x' });
  assert.equal(custom.databasePath, path.resolve('/tmp/x/db/custom.sqlite'));
});

test('参数校验：间隔过小 / 非法 URL / 非法日志级别 / 负数保留期', () => {
  assert.throws(() => normalizeConfig({ ...baseInput, pollIntervalSeconds: 1 }, { env: {} }), /不能小于 5/);
  assert.throws(() => normalizeConfig({ ...baseInput, baseUrl: 'ftp://x' }, { env: {} }), /baseUrl/);
  assert.throws(() => normalizeConfig({ ...baseInput, logLevel: 'verbose' }, { env: {} }), /logLevel/);
  assert.throws(() => normalizeConfig({ ...baseInput, retentionDays: -1 }, { env: {} }), /retentionDays/);
  assert.throws(() => normalizeConfig({ ...baseInput, pollIntervalSeconds: 'abc' }, { env: {} }), /pollIntervalSeconds/);
});

test('间隔小于建议值时给出警告，retentionDays 可为 null（不清理）', () => {
  const config = normalizeConfig({ ...baseInput, pollIntervalSeconds: 10, retentionDays: null }, { env: {} });
  assert.equal(config.retentionDays, null);
  assert.match(config.warnings.join('\n'), /建议 >= 15 秒/);
});

test('loadConfig：读取 JSON、报错友好', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-config-'));
  const goodPath = path.join(dir, 'monitor.config.json');
  fs.writeFileSync(goodPath, JSON.stringify({ bearer: '${TOK}', pollIntervalSeconds: 60, database: './d/x.sqlite' }));

  const config = loadConfig(goodPath, { env: { TOK: 'secret' } });
  assert.equal(config.bearer, 'secret');
  assert.equal(config.databasePath, path.join(dir, 'd', 'x.sqlite'));
  assert.equal(config.configPath, goodPath);

  const badPath = path.join(dir, 'bad.json');
  fs.writeFileSync(badPath, '{ not json');
  assert.throws(() => loadConfig(badPath), /不是合法 JSON/);
  assert.throws(() => loadConfig(path.join(dir, 'nope.json')), /读不到配置文件/);

  fs.rmSync(dir, { recursive: true, force: true });
});
