import test from 'node:test';
import assert from 'node:assert/strict';

import { computeSleepMs } from '../src/monitor.js';

test('固定节拍：sleep 时间 = 周期 - 本轮耗时', () => {
  assert.equal(computeSleepMs(60_000, 0), 60_000);
  assert.equal(computeSleepMs(60_000, 274), 59_726);
  assert.equal(computeSleepMs(60_000, 59_999), 1);
  assert.equal(computeSleepMs(60_000, 60_000), 0);
});

test('固定节拍：本轮超过周期时立即开始下一轮（不补跑、不叠加）', () => {
  assert.equal(computeSleepMs(60_000, 60_001), 0);
  assert.equal(computeSleepMs(5_000, 15_000), 0);
  assert.equal(computeSleepMs(60_000, -10), 60_000, '异常负耗时按 0 处理');
});
