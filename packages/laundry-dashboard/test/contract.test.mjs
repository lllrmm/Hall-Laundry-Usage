import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import {
  MINUTES_PER_DAY,
  STATE_BYTES,
  WEEKDAY_LABELS,
  isInUse,
  isOnHold,
  isOperational,
} from '../../shared/contracts.js';

/** public/aggregate.js 是普通 <script>，浏览器里无法直接 import 共享契约，这里做契约校验 */
function loadAggregate() {
  const source = fs.readFileSync(new URL('../public/aggregate.js', import.meta.url), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.LaundryAggregate;
}

const Agg = loadAggregate();

const BYTE_NAME_IN_AGGREGATE = {
  in_use: 'inUse',
  available: 'available',
  maintenance: 'maintenance',
  disabled: 'disabled',
  offline: 'offline',
  on_hold: 'onHold',
  on_hold_in_use: 'onHoldInUse',
  on_hold_available: 'onHoldAvailable',
  on_hold_offline: 'onHoldOffline',
  on_hold_unknown: 'onHoldUnknown',
  unknown: 'unknown',
  no_data: 'noData',
};

test('契约：浏览器端字节常量与 shared/contracts.js 完全一致', () => {
  assert.deepEqual(
    Object.keys(BYTE_NAME_IN_AGGREGATE).sort(),
    Object.keys(STATE_BYTES).sort(),
    '每个共享字节都应在 aggregate.js 有对应常量',
  );
  for (const [name, byte] of Object.entries(STATE_BYTES)) {
    assert.equal(Agg.BYTE[BYTE_NAME_IN_AGGREGATE[name]], byte, `字节 ${name}`);
  }
  assert.equal(Object.keys(Agg.BYTE).length, Object.keys(STATE_BYTES).length, 'aggregate.js 不应有契约外字节');
});

test('契约：浏览器端可运营/占用/on_hold 判定与共享契约一致', () => {
  for (const byte of new Set(Object.values(STATE_BYTES))) {
    const label = `0x${byte.toString(16).padStart(2, '0')}`;
    assert.equal(Agg.isOperational(byte), isOperational(byte), `isOperational ${label}`);
    assert.equal(Agg.isInUse(byte), isInUse(byte), `isInUse ${label}`);
    assert.equal(Agg.isOnHold(byte), isOnHold(byte), `isOnHold ${label}`);
  }
});

test('契约：分钟数 / 星期标签一致', () => {
  assert.equal(Agg.MINUTES_PER_DAY, MINUTES_PER_DAY);
  assert.deepEqual([...Agg.WEEKDAY_LABELS], [...WEEKDAY_LABELS]);
});
