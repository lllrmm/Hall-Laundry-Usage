import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/** public/config.js 是普通 <script>：用 vm 执行后测试 API 地址解析 */
function loadConfigScript() {
  const source = fs.readFileSync(new URL('../public/config.js', import.meta.url), 'utf8');
  const sandbox = {
    URL,
    URLSearchParams,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox;
}

test('API 地址解析：?api= 优先、兼容末尾斜杠与路径、拒绝非 http(s)', () => {
  const sandbox = loadConfigScript();
  const resolve = sandbox.__resolveLaundryApiBase__;

  assert.equal(typeof resolve, 'function');
  assert.equal(resolve(''), '', '默认同源');
  assert.equal(resolve('?api=https%3A%2F%2Fapi.example.com%2F'), 'https://api.example.com');
  assert.equal(resolve('?api=https://api.example.com'), 'https://api.example.com');
  assert.equal(resolve('?api=https://api.example.com/base/'), 'https://api.example.com/base');
  assert.equal(resolve('?api=javascript:alert(1)'), '', '拒绝 javascript:');
  assert.equal(resolve('?api=ftp://api.example.com'), '', '拒绝非 http(s)');
  assert.equal(resolve('?api=not%20a%20url'), '', '非法 URL 回退默认值');
  assert.equal(resolve('?other=1'), '', '没有 api 参数时回退');
});

test('API 地址解析：config.js 里写死的基础地址作为 fallback', () => {
  const sandbox = loadConfigScript();
  sandbox.__LAUNDRY_API_BASE__ = 'https://fixed.example.com/';
  assert.equal(sandbox.__resolveLaundryApiBase__(''), 'https://fixed.example.com');
  assert.equal(
    sandbox.__resolveLaundryApiBase__('?api=https%3A%2F%2Foverride.example.com'),
    'https://override.example.com',
    'URL 参数优先于 config.js',
  );
});
