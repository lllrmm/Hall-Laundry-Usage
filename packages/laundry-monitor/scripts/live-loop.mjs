/**
 * 演示/自测：跑一段时间的采集循环后优雅停止（用于本地验证，不参与 npm 发布）。
 *
 *   node scripts/live-loop.mjs [持续秒数=30] [采集间隔秒数=15]
 */

import { fileURLToPath } from 'node:url';

import { createClient } from 'hkust-laundry-machines';
import { createLogger, loadConfig, openDatabase, startMonitor } from '../src/index.js';

const configPath = fileURLToPath(new URL('../monitor.config.json', import.meta.url));
const config = loadConfig(configPath);

const durationSeconds = Number(process.argv[2] ?? 30);
const intervalSeconds = Number(process.argv[3] ?? 15);
config.pollIntervalSeconds = intervalSeconds;
config.pollIntervalMs = Math.round(intervalSeconds * 1000);

const logger = createLogger({ level: 'info' });
const db = openDatabase(config.databasePath);
const client = createClient({ token: config.bearer, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs });

const controller = new AbortController();
const timer = setTimeout(() => {
  logger.info(`已运行 ${durationSeconds}s，主动停止`);
  controller.abort();
}, durationSeconds * 1000);

try {
  await startMonitor({ client, db, config, logger, signal: controller.signal });
} finally {
  clearTimeout(timer);
  db.close();
}
