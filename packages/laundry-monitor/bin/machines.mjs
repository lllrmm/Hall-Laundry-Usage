#!/usr/bin/env node
/**
 * CLI: 查询 HKUST 洗衣房机器状态
 *
 *   laundry-machines                 表格输出
 *   laundry-machines --json          输出 JSON（去掉 raw 原始对象）
 *   laundry-machines --token <token> 指定 token（否则读 LDR_TOKEN / ./token.txt）
 */

import { LaundryClient, formatRemaining } from '../src/machines/index.js';

const HELP = `用法: laundry-machines [选项]

选项:
  -j, --json              输出 JSON（不含 raw 字段）
      --token <token>     Bearer token（默认读环境变量 LDR_TOKEN 或 ./token.txt）
      --base-url <url>    API 基址（默认 https://laundry.ust.hk/ldr/api）
      --timeout <ms>      请求超时，默认 15000
  -h, --help              显示帮助

token 获取: 登录 https://laundry.ust.hk/ldr/app/ 后，复制
  localStorage["ldr_student"].token
`;

function parseArgs(argv) {
  const options = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json' || arg === '-j') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--token') options.token = argv[++i];
    else if (arg.startsWith('--token=')) options.token = arg.slice('--token='.length);
    else if (arg === '--base-url') options.baseUrl = argv[++i];
    else if (arg.startsWith('--base-url=')) options.baseUrl = arg.slice('--base-url='.length);
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]);
  }
  return options;
}

const tty = process.stdout.isTTY;
const paint = (code) => (text) => (tty ? `\u001b[${code}m${text}\u001b[0m` : String(text));
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');

function describe(machine) {
  if (machine.available) return '';
  if (machine.inUse) {
    if (machine.remainingSeconds !== null) {
      return machine.remainingSeconds > 0
        ? dim(`剩 ${formatRemaining(machine.remainingSeconds)}`)
        : dim(`已到点 ${formatRemaining(-machine.remainingSeconds)}，可能未取衣`);
    }
    return dim(`已运行 ${formatRemaining(machine.elapsedSeconds)}（该机型无预计时长）`);
  }
  return dim(String(machine.unavailableReason ?? machine.state ?? ''));
}

function stateText(machine) {
  const plain = machine.available ? '空闲' : machine.inUse ? '在用' : '不可用';
  const padded = plain.padEnd(6);
  if (machine.available) return green(padded);
  if (machine.inUse) return yellow(padded);
  return red(padded);
}

function printStatus(status) {
  const { counts, rooms } = status;
  console.log(
    `${bold(`共 ${counts.total} 台`)}  ${green(`空闲 ${counts.available}`)}  ` +
      `${yellow(`在用 ${counts.inUse}`)}  ${red(`不可用 ${counts.unavailable}`)}  ${dim(status.fetchedAt.toISOString())}`,
  );

  for (const room of rooms) {
    console.log(`\n${bold(room.name ?? '(未知洗衣房)')}`);
    for (const kind of ['washer', 'dryer']) {
      const list = room.machines.filter((m) => m.kind === kind);
      if (list.length === 0) continue;
      const free = list.filter((m) => m.available).length;
      console.log(`  ${kind === 'washer' ? '洗衣机' : '烘干机'}  ${bold(`${free}/${list.length}`)} 空闲`);
      for (const machine of list) {
        const extra = describe(machine);
        const line = `    ${String(machine.name ?? machine.id).padEnd(18)} ${stateText(machine)}${extra ? '  ' + extra : ''}`;
        console.log(line.trimEnd());
      }
    }
  }
}

function toPlainJson(status) {
  return {
    fetchedAt: status.fetchedAt.toISOString(),
    counts: status.counts,
    byKind: status.byKind,
    machines: status.machines.map(({ raw, ...rest }) => rest),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return 0;
  }

  const client = new LaundryClient({
    token: options.token,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
  });

  const status = await client.getMachines();

  if (options.json) console.log(JSON.stringify(toPlainJson(status), null, 2));
  else printStatus(status);

  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`${red('错误:')} ${error.message}`);
    if (error.code === 4032 || error.code === 4031) {
      console.error(dim('token 失效或缺失：重新登录网页，复制 localStorage["ldr_student"].token 到 token.txt'));
    }
    process.exitCode = 1;
  },
);
