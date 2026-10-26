// 沙箱能力诊断：命名管道 / 子进程管道 / 文件写入
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const results = {};

// 1) 创建 named pipe server
results.namedPipe = await new Promise((resolve) => {
  const srv = net.createServer();
  const timer = setTimeout(() => resolve({ ok: false, err: 'timeout' }), 4000);
  srv.on('error', (e) => {
    clearTimeout(timer);
    resolve({ ok: false, code: e.code, errno: e.errno, syscall: e.syscall, message: e.message });
  });
  srv.listen('\\\\.\\pipe\\dsh_pipe_probe_1', () => {
    clearTimeout(timer);
    srv.close();
    resolve({ ok: true });
  });
});

// 2) 子进程 + 管道 stdio（文档说沙箱下会 EPERM）
results.spawnPipe = (() => {
  const r = spawnSync('cmd.exe', ['/c', 'echo hi'], { encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout || '').trim(), error: r.error ? `${r.error.code}: ${r.error.message}` : null };
})();

// 3) 子进程 + inherit/ignore stdio
results.spawnInherit = (() => {
  const r = spawnSync('cmd.exe', ['/c', 'echo inherited'], { stdio: 'ignore' });
  return { status: r.status, error: r.error ? `${r.error.code}: ${r.error.message}` : null };
})();

// 4) 写 workspace 内文件
try {
  fs.writeFileSync(new URL('./.diag_write_test', import.meta.url), 'ok');
  results.workspaceWrite = { ok: true };
} catch (e) {
  results.workspaceWrite = { ok: false, code: e.code, message: e.message };
}

// 5) 写 workspace 外文件（预期被拒）
try {
  fs.writeFileSync('C:\\Users\\lllrm\\Desktop\\dsh_write_probe.txt', 'x');
  results.outsideWrite = { ok: true };
} catch (e) {
  results.outsideWrite = { ok: false, code: e.code, message: e.message };
}

// 6) 进程环境
results.env = {
  user: process.env.USERNAME,
  userprofile: process.env.USERPROFILE,
  temp: process.env.TEMP,
  dsh: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^DSH/i.test(k))),
  integrity: (() => {
    try {
      return spawnSync('whoami.exe', ['/groups'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /Mandatory Label|S-1-16/.test(l));
    } catch (e) {
      return 'whoami failed: ' + e.message;
    }
  })(),
};

console.log(JSON.stringify(results, null, 2));
