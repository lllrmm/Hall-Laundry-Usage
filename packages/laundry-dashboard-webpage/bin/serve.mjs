#!/usr/bin/env node
/**
 * 看板前端服务入口：静态文件 + /api/* 反向代理。
 *
 *   laundry-dashboard-webpage --config dashboard-webpage.config.json
 *   laundry-dashboard-webpage --port 8788 --api http://127.0.0.1:8787
 */

import { createWebServer } from '../src/server.js';
import { DEFAULT_CONFIG_FILE, loadWebConfig } from '../src/config.js';

function parseArgs(argv) {
  const options = { command: 'serve', config: DEFAULT_CONFIG_FILE, host: null, port: null, apiTarget: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} 缺少值`);
      return argv[index];
    };
    if (arg === '--config') options.config = next();
    else if (arg === '--host') options.host = next();
    else if (arg === '--port') options.port = Number(next());
    else if (arg === '--api') options.apiTarget = next();
    else if (arg === '-h' || arg === '--help') options.command = 'help';
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

const HELP = `用法: laundry-dashboard-webpage [选项]

选项:
  --config <path>   配置文件，默认 ${DEFAULT_CONFIG_FILE}
  --host <host>     监听地址（覆盖配置）
  --port <port>     监听端口（覆盖配置）
  --api <url>       反向代理的 API 地址，例如 http://127.0.0.1:8787
  -h, --help        显示帮助

浏览器只访问本服务：静态资源由这里托管，/api/* 转发到 laundry-dashboard-api。
`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    console.log(HELP);
    return 0;
  }

  const config = loadWebConfig(options.config);
  if (options.host) config.host = options.host;
  if (options.port !== null) config.port = options.port;
  if (options.apiTarget !== undefined) config.apiTarget = options.apiTarget;

  const app = createWebServer({ config });
  const address = await app.listen();
  console.log(`看板前端已启动: ${address.url}/`);
  console.log(`API 反向代理: ${config.apiTarget ?? '未启用（使用 public/config.js 的 API 地址）'}`);

  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`错误: ${error.message}`);
    process.exitCode = 2;
  },
);
