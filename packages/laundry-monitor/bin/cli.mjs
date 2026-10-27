#!/usr/bin/env node
/**
 * 命令行入口。
 *
 *   laundry-monitor run    --config monitor.config.json     常驻轮询
 *   laundry-monitor once   --config monitor.config.json     只采集一次（cron 用）
 *   laundry-monitor stats  --config monitor.config.json [--since 24h] [--json]
 *   laundry-monitor export --config monitor.config.json [--since 7d] [--format csv|jsonl] [--out file]
 *   laundry-monitor init   [--config monitor.config.json]   生成配置模板
 */

import fs from 'node:fs';
import path from 'node:path';

import { createClient } from 'hkust-laundry-machines';

import {
  DEFAULT_CONFIG_FILE,
  createLogger,
  formatDuration,
  loadConfig,
  openDatabase,
  openSeriesDatabase,
  parseSince,
  pollOnce,
  startMonitor,
} from '../src/index.js';

const HELP = `用法: laundry-monitor <命令> [选项]

命令:
  run       按配置周期常驻采集，Ctrl+C 优雅退出
  once      只采集一次（适合 cron / systemd timer）
  stats     查看汇总统计（可选 --since 24h / 7d / ISO 时间）
  export    导出快照时间序列（jsonl 或 csv）
  rebuild   从原始快照库重建序列库（可重复执行）
  series    查看序列库统计（天数 / 字节 / 最近状态）
  init      生成配置模板 monitor.config.json

选项:
  --config <path>    配置文件路径，默认 ${DEFAULT_CONFIG_FILE}
  --since <window>   统计/导出窗口：24h、7d、30m 或 ISO 时间
  --json             stats 输出 JSON
  --format <fmt>     export 格式：jsonl（默认）或 csv
  --out <path>       export 输出文件（默认 stdout）
  --limit <n>        export 最多导出行数，默认 100000
  -h, --help         显示帮助

配置示例见 monitor.config.example.json。
token 获取：登录 https://laundry.ust.hk/ldr/app/ 后复制
  localStorage["ldr_student"].token
`;

function parseArgs(argv) {
  // 允许 `laundry-monitor --help` / `--config x` 这类不带命令的写法
  const [first, ...remaining] = argv;
  const hasCommand = typeof first === 'string' && first !== '' && !first.startsWith('-');
  const command = hasCommand ? first : 'help';
  const rest = hasCommand ? remaining : argv;

  const options = { command, config: DEFAULT_CONFIG_FILE, json: false, format: 'jsonl', limit: 100_000 };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const takeValue = () => {
      const value = rest[++i];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      return value;
    };

    if (arg === '--config') options.config = takeValue();
    else if (arg.startsWith('--config=')) options.config = arg.slice('--config='.length);
    else if (arg === '--since') options.since = takeValue();
    else if (arg.startsWith('--since=')) options.since = arg.slice('--since='.length);
    else if (arg === '--format') options.format = takeValue();
    else if (arg.startsWith('--format=')) options.format = arg.slice('--format='.length);
    else if (arg === '--out') options.out = takeValue();
    else if (arg.startsWith('--out=')) options.out = arg.slice('--out='.length);
    else if (arg === '--limit') options.limit = Number(takeValue());
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.command = 'help';
    else throw new Error(`未知参数：${arg}`);
  }

  return options;
}

function openDbAndClient(config, logger) {
  const db = openDatabase(config.databasePath);
  const client = createClient({
    token: config.bearer,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
  });
  return { db, client };
}

function openSeries(config) {
  return openSeriesDatabase(config.seriesDatabasePath);
}

function printWarnings(config, logger) {
  for (const warning of config.warnings) logger.warn(warning);
}

/* ---------------- run ---------------- */

async function runCommand(options) {
  const config = loadConfig(options.config);
  const logger = createLogger({ level: config.logLevel });
  printWarnings(config, logger);

  const { db, client } = openDbAndClient(config, logger);
  const series = openSeries(config);
  const controller = new AbortController();
  let stopping = false;

  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info(`收到 ${signal}，等待当前采集结束后退出…`);
    controller.abort();
  };

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  try {
    logger.info(`数据库：${db.filePath}（schema v${db.schemaVersion}）`);
    logger.info(`序列库：${series.filePath}`);
    await startMonitor({ client, db, series, config, logger, signal: controller.signal });
  } finally {
    series.close();
    db.close();
  }

  return 0;
}

/* ---------------- once ---------------- */

async function onceCommand(options) {
  const config = loadConfig(options.config);
  const logger = createLogger({ level: config.logLevel });
  printWarnings(config, logger);

  const { db, client } = openDbAndClient(config, logger);
  const series = openSeries(config);

  try {
    const result = await pollOnce({ client, db, series, logger });

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: result.ok,
            runId: result.runId,
            counts: result.counts ?? null,
            transitions: result.transitions ?? [],
            error: result.ok ? null : { code: result.error?.code ?? null, message: result.error?.message ?? null },
            database: db.filePath,
            seriesDatabase: series.filePath,
          },
          null,
          2,
        ),
      );
    } else if (result.ok) {
      console.log(
        `采集成功 #${result.runId}：共 ${result.counts.total} 台，可用 ${result.counts.available}，在用 ${result.counts.inUse}，不可用 ${result.counts.unavailable}`,
      );

      const firstSeen = result.transitions.filter((transition) => transition.fromState === null);
      const realChanges = result.transitions.filter((transition) => transition.fromState !== null);

      if (firstSeen.length > 0) console.log(`  首次记录 ${firstSeen.length} 台机器的初始状态`);
      for (const transition of realChanges) {
        console.log(`  状态变化 ${transition.name}：${transition.fromState} → ${transition.toState}`);
      }

      console.log(`数据库：${db.filePath}`);
      console.log(`序列库：${series.filePath}`);
    }

    return result.ok ? 0 : 1;
  } finally {
    series.close();
    db.close();
  }
}

/* ---------------- stats ---------------- */

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function pad(value, width) {
  return String(value).padEnd(width);
}

function printStats(stats, totals) {
  const { window, runs, errorsByCode, machines, transitions } = stats;

  console.log('=== 轮询概况 ===');
  console.log(`窗口      ${window.since ?? '全部历史'} → ${window.until}`);
  console.log(
    `轮询      ${runs.total} 次（成功 ${runs.ok} / 失败 ${runs.failed}）` +
      (runs.avgDurationMs === null ? '' : `，平均耗时 ${runs.avgDurationMs}ms`),
  );
  if (errorsByCode.length > 0) {
    console.log(`失败原因  ${errorsByCode.map((item) => `${item.code ?? 'UNKNOWN'}×${item.count}`).join(', ')}`);
  }

  console.log('\n=== 机器占用 ===');
  console.log(`${pad('机器', 20)}${pad('采样', 8)}${pad('空闲', 8)}${pad('在用', 8)}${pad('不可用', 8)}${pad('使用次数', 10)}平均单次时长`);
  for (const machine of machines) {
    console.log(
      pad(machine.name, 20) +
        pad(machine.samples, 8) +
        pad(formatPercent(machine.availablePct), 8) +
        pad(formatPercent(machine.inUsePct), 8) +
        pad(formatPercent(machine.unavailablePct), 8) +
        pad(machine.cycles, 10) +
        (machine.avgInUseSeconds === null ? '-' : formatDuration(machine.avgInUseSeconds)),
    );
  }

  console.log('\n=== 状态跳变 ===');
  console.log(
    `共 ${transitions.total} 条，完整使用周期 ${transitions.cycles} 次` +
      (transitions.avgInUseSeconds === null ? '' : `，平均使用 ${formatDuration(transitions.avgInUseSeconds)}`),
  );
  console.log(`\n数据库累计：${totals.runs} 次轮询 / ${totals.snapshots} 条快照 / ${totals.transitions} 条跳变 / ${totals.machines} 台机器`);
}

async function statsCommand(options) {
  const config = loadConfig(options.config, { requireBearer: false });
  const since = options.since ? parseSince(options.since) : null;
  const db = openDatabase(config.databasePath);

  try {
    const stats = db.stats({ since });
    if (options.json) {
      console.log(JSON.stringify({ ...stats, database: db.filePath, totals: db.totals() }, null, 2));
    } else {
      printStats(stats, db.totals());
      console.log(`数据库：${db.filePath}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/* ---------------- export ---------------- */

function toCsvValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function exportCommand(options) {
  const config = loadConfig(options.config, { requireBearer: false });
  const since = options.since ? parseSince(options.since) : null;
  const db = openDatabase(config.databasePath);

  try {
    const rows = db.exportSnapshots({ since, limit: options.limit });

    if (options.format === 'csv') {
      const columns = [
        'observed_at',
        'machine_id',
        'name',
        'kind',
        'status',
        'state',
        'available',
        'planned_minutes',
        'remaining_seconds',
        'elapsed_seconds',
        'finished_but_not_emptied',
      ];
      const lines = [columns.join(',')];
      for (const row of rows) lines.push(columns.map((column) => toCsvValue(row[column])).join(','));
      const output = lines.join('\n') + '\n';
      if (options.out) fs.writeFileSync(path.resolve(options.out), output, 'utf8');
      else process.stdout.write(output);
    } else if (options.out) {
      const lines = rows.map((row) => JSON.stringify(row));
      fs.writeFileSync(path.resolve(options.out), lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    } else {
      for (const row of rows) process.stdout.write(JSON.stringify(row) + '\n');
    }

    if (options.out) {
      process.stderr.write(`已导出 ${rows.length} 行到 ${path.resolve(options.out)}\n`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/* ---------------- rebuild（从 raw 回填序列库） ---------------- */

async function rebuildCommand(options) {
  const config = loadConfig(options.config, { requireBearer: false });
  const rawDb = openDatabase(config.databasePath);
  const series = openSeries(config);

  try {
    const since = options.since ? parseSince(options.since) : null;
    const result = series.rebuildFromRaw(rawDb.db, { since });
    console.log(
      `已从原始快照回填序列库：${result.rows} 条快照 → ${result.days} 个「机器-日」` +
        (result.skipped ? `（跳过 ${result.skipped} 条无法解析的时间）` : ''),
    );
    console.log(`原始库：${rawDb.filePath}`);
    console.log(`序列库：${series.filePath}`);
    return 0;
  } finally {
    series.close();
    rawDb.close();
  }
}

/* ---------------- series（序列库统计） ---------------- */

async function seriesCommand(options) {
  const config = loadConfig(options.config, { requireBearer: false });
  const series = openSeries(config);

  try {
    const stats = series.stats();
    const latest = series.latest();
    if (options.json) {
      console.log(JSON.stringify({ ...stats, latest, database: series.filePath }, null, 2));
    } else {
      console.log('=== 序列库（分钟字节） ===');
      console.log(
        `覆盖        ${stats.days} 天 × ${stats.machines} 台 = ${stats.machineDays} 个「机器-日」（${stats.bytes} 字节）`,
      );
      console.log(`最近轮询    ${stats.lastPollAt ?? '-'}`);
      console.log(`最近回填    ${stats.lastRebuildAt ?? '-'}`);
      for (const row of latest) {
        console.log(`  ${row.machine_id}  ${row.state ?? '-'}  ${row.observed_at ?? '-'}`);
      }
      console.log(`\n序列库：${series.filePath}`);
    }
    return 0;
  } finally {
    series.close();
  }
}

/* ---------------- init ---------------- */

async function initCommand(options) {
  const target = path.resolve(options.config);
  if (fs.existsSync(target)) {
    throw new Error(`配置文件已存在：${target}`);
  }

  const examplePath = new URL('../monitor.config.example.json', import.meta.url);
  const content = fs.readFileSync(examplePath, 'utf8');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');

  console.log(`已生成配置模板：${target}`);
  console.log('下一步：把 bearer 换成你的 token（或改成 "${LDR_TOKEN}" 用环境变量），然后运行：');
  console.log(`  laundry-monitor once  --config ${options.config}`);
  console.log(`  laundry-monitor run   --config ${options.config}`);
  return 0;
}

/* ---------------- main ---------------- */

async function main() {
  const options = parseArgs(process.argv.slice(2));

  switch (options.command) {
    case 'run':
      return runCommand(options);
    case 'once':
      return onceCommand(options);
    case 'stats':
      return statsCommand(options);
    case 'export':
      return exportCommand(options);
    case 'rebuild':
      return rebuildCommand(options);
    case 'series':
      return seriesCommand(options);
    case 'init':
      return initCommand(options);
    case 'help':
      console.log(HELP);
      return 0;
    default:
      throw new Error(`未知命令：${options.command}\n\n${HELP}`);
  }
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
