/**
 * 真实接口冒烟测试（不打进 npm test，避免依赖网络/token）
 *
 *   node test/machines-live-smoke.mjs   # 或 npm run smoke
 *
 * token 来源：环境变量 LDR_TOKEN；没有则跳过（退出码 0）。
 */

import { createClient, formatRemaining } from '../src/machines/index.js';

const token = process.env.LDR_TOKEN?.trim();
if (!token) {
  console.log('SKIP: 没有 token（设置环境变量 LDR_TOKEN）');
  process.exit(0);
}

const client = createClient({ token });

try {
  const status = await client.getMachines();

  console.log(`fetchedAt: ${status.fetchedAt.toISOString()}`);
  console.log('counts:', status.counts);
  console.log('byKind:', status.byKind);

  for (const room of status.rooms) {
    console.log(`\n${room.name}`);
    for (const machine of room.machines) {
      const tail = machine.available
        ? 'FREE'
        : machine.inUse
          ? machine.remainingSeconds !== null
            ? `剩 ${formatRemaining(machine.remainingSeconds)}`
            : `已运行 ${formatRemaining(machine.elapsedSeconds)}`
          : (machine.unavailableReason ?? machine.state);
      console.log(`  ${machine.name.padEnd(18)} ${machine.state.padEnd(10)} ${tail}`);
    }
  }

  console.log('\nOK: live smoke passed');
} catch (error) {
  console.error(`FAIL: ${error.name} ${error.code ?? ''} ${error.message}`);
  process.exitCode = 1;
}
