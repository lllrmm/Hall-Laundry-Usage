#!/usr/bin/env node
/**
 * 前端看板启动入口。
 *
 *   laundry-dashboard --config dashboard.config.json
 *   laundry-dashboard --db ../laundry-monitor/data/laundry.sqlite --port 8787
 */

import { loadConfig, DEFAULT_CONFIG_FILE } from '../src/config.js';
import { createDashboardServer } from '../src/server.js';

const HELP = `用法: laundry-dashboard [选项]

选项:
  --config <path>   配置文件路径，默认 ${DEFAULT_CONFIG_FILE}
  --db <path>       SQLite 原始快照库路径（覆盖配置）
  --series <path>   SQLite 日序列库路径（覆盖配置）
  --host <host>     监听地址（覆盖配置，默认 127.0.0.1）
  --port <port>     监听端口（覆盖配置，默认 8787）
  -h, --help        显示帮助

只读访问监控服务写入的数据库，与轮询进程互不影响。
`;

function parseArgs(argv) {
  const options = { config: DEFAULT_CONFIG_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      return value;
    };

    if (arg === '--config') options.config = takeValue();
    else if (arg.startsWith('--config=')) options.config = arg.slice('--config='.length);
    else if (arg === '--db') options.db = takeValue();
    else if (arg.startsWith('--db=')) options.db = arg.slice('--db='.length);
    else if (arg === '--series') options.series = takeValue();
    else if (arg.startsWith('--series=')) options.series = arg.slice('--series='.length);
    else if (arg === '--host') options.host = takeValue();
    else if (arg.startsWith('--host=')) options.host = arg.slice('--host='.length);
    else if (arg === '--port') options.port = Number(takeValue());
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length));
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return 0;
  }

  const config = loadConfig(options.config);
  if (options.db) config.databasePath = options.db;
  if (options.series) config.seriesDatabasePath = options.series;
  if (options.host) config.host = options.host;
  if (options.port !== undefined) config.port = options.port;

  const app = createDashboardServer({ config, logger: console });

  const address = await app.listen();
  console.log(`洗衣房看板已启动: ${address.url}`);
  console.log(`原始库(只读): ${config.databasePath}`);
  console.log(`序列库(只读): ${config.seriesDatabasePath}`);
  console.log('Ctrl+C 停止');

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${signal}，正在关闭…`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  return new Promise(() => {
    // 保持进程存活
  });
}

main().then(
  (code) => {
    if (typeof code === 'number') process.exitCode = code;
  },
  (error) => {
    console.error(`错误: ${error.message}`);
    process.exitCode = 1;
  },
);
