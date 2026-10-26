// 验证：沙箱下子进程能否连接到父进程创建的命名管道（Chromium mojo 正是这么干的）
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PIPE = '\\\\.\\pipe\\dsh_child_connect_probe';
const results = {};

// 父进程创建命名管道服务端
const srv = net.createServer((sock) => {
  sock.end('hello-from-parent');
});
const listenOk = await new Promise((resolve) => {
  srv.once('error', (e) => resolve({ ok: false, code: e.code, message: e.message }));
  srv.listen(PIPE, () => resolve({ ok: true }));
});
results.parentServer = listenOk;

if (listenOk.ok) {
  // 子进程（stdio inherit，不用管道）去连接同一个命名管道
  const childScript = `
    const net = require('net');
    const s = net.connect(${JSON.stringify(PIPE)});
    s.on('connect', () => { console.log('CHILD_CONNECT_OK'); s.end(); process.exit(0); });
    s.on('error', (e) => { console.log('CHILD_CONNECT_ERR', e.code, e.message); process.exit(0); });
    setTimeout(() => { console.log('CHILD_CONNECT_TIMEOUT'); process.exit(0); }, 4000);
  `;
  const cf = path.join(DIR, '.child_pipe_probe.cjs');
  fs.writeFileSync(cf, childScript);
  const out = path.join(DIR, '.child_pipe_probe.out');
  const fd = fs.openSync(out, 'w');
  const r = spawnSync(process.execPath, [cf], { stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  results.childConnect = {
    status: r.status,
    error: r.error ? `${r.error.code}: ${r.error.message}` : null,
    output: fs.readFileSync(out, 'utf8').trim(),
  };
  srv.close();
  fs.rmSync(cf, { force: true });
  fs.rmSync(out, { force: true });
}

console.log(JSON.stringify(results, null, 2));
