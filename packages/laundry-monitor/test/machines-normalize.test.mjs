import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatRemaining,
  isAvailable,
  normalizeMachine,
  normalizeResponse,
  parseMachineNumber,
} from '../src/machines/index.js';

const NOW = Date.parse('2026-10-26T17:00:00.000Z');

function rawMachine(overrides = {}) {
  return {
    _id: 'machine-1',
    status: 'enabled',
    state: 'available',
    name: 'UG4 Dryer (51)',
    service_type: { _id: 'st-dryer', machine_type: 'dryer', value: 'dryer_machine', label: 'Dry Machine' },
    laundry_room_name: 'UG Hall IV',
    ...overrides,
  };
}

test('空闲机器：available=true，没有时间信息', () => {
  const machine = normalizeMachine(rawMachine(), NOW);

  assert.equal(machine.available, true);
  assert.equal(machine.inUse, false);
  assert.equal(machine.unavailableReason, null);
  assert.equal(machine.number, 51);
  assert.equal(machine.kind, 'dryer');
  assert.equal(machine.startedAt, null);
  assert.equal(machine.plannedMinutes, null);
  assert.equal(machine.endsAt, null);
  assert.equal(machine.remainingSeconds, null);
  assert.equal(machine.elapsedSeconds, null);
  assert.equal(machine.finishedButNotEmptied, false);
});

test('在用烘干机：算出剩余时间和已运行时间', () => {
  const machine = normalizeMachine(
    rawMachine({
      state: 'in_use',
      job: { created_at: '2026-10-26T16:41:05.666Z', ticket: { number_of_minutes: 45 } },
    }),
    NOW,
  );

  assert.equal(machine.available, false);
  assert.equal(machine.inUse, true);
  assert.equal(machine.unavailableReason, 'in_use');
  assert.equal(machine.startedAt.toISOString(), '2026-10-26T16:41:05.666Z');
  assert.equal(machine.plannedMinutes, 45);
  assert.equal(machine.endsAt.toISOString(), '2026-10-26T17:26:05.666Z');
  assert.equal(machine.remainingSeconds, 1566);
  assert.equal(machine.elapsedSeconds, 1134);
  assert.equal(machine.finishedButNotEmptied, false);
});

test('在用洗衣机：job 里没有 number_of_minutes，算不出剩余时间', () => {
  const machine = normalizeMachine(
    rawMachine({
      name: 'UG4 Washer (01)',
      state: 'in_use',
      service_type: { _id: 'st-washer', machine_type: 'washer', value: 'washing_machine_without_powder', label: 'Washer' },
      job: { created_at: '2026-10-26T16:30:00.000Z' },
    }),
    NOW,
  );

  assert.equal(machine.kind, 'washer');
  assert.equal(machine.inUse, true);
  assert.equal(machine.plannedMinutes, null);
  assert.equal(machine.endsAt, null);
  assert.equal(machine.remainingSeconds, null);
  assert.equal(machine.elapsedSeconds, 1800);
  assert.equal(machine.finishedButNotEmptied, false);
});

test('维护中的机器 state 仍是 available，但不能算空闲', () => {
  const machine = normalizeMachine(
    rawMachine({ name: 'UG4 Washer (05)', status: 'maintenance', state: 'available' }),
    NOW,
  );

  assert.equal(machine.available, false);
  assert.equal(machine.inUse, false);
  assert.equal(machine.unavailableReason, 'maintenance');
  assert.equal(machine.finishedButNotEmptied, false);
});

test('已到点但衣物未取：remainingSeconds 为负，finishedButNotEmptied=true', () => {
  const machine = normalizeMachine(
    rawMachine({
      state: 'in_use',
      job: { created_at: '2026-10-26T15:00:00.000Z', ticket: { number_of_minutes: 30 } },
    }),
    NOW,
  );

  assert.equal(machine.remainingSeconds, -5400);
  assert.equal(machine.finishedButNotEmptied, true);
});

test('缺失 service_type / name 时不抛错', () => {
  const machine = normalizeMachine({ _id: 'x', status: 'enabled', state: 'available' }, NOW);

  assert.equal(machine.kind, null);
  assert.equal(machine.serviceTypeId, null);
  assert.equal(machine.number, null);
  assert.equal(machine.available, true);
  assert.equal(machine.raw._id, 'x');
});

test('normalizeMachine 收到非对象时抛 TypeError', () => {
  assert.throws(() => normalizeMachine(null), TypeError);
  assert.throws(() => normalizeMachine('machine'), TypeError);
});

test('normalizeResponse：分组、计数、按机型统计', () => {
  const payload = {
    meta: { code: 200, message: 'Success' },
    data: {
      laundry_room_machines: [
        {
          laundry_room_name: 'UG Hall IV',
          machines: [
            rawMachine(),
            rawMachine({
              _id: 'machine-2',
              name: 'UG4 Dryer (52)',
              state: 'in_use',
              job: { created_at: '2026-10-26T16:41:05.666Z', ticket: { number_of_minutes: 45 } },
            }),
            rawMachine({
              _id: 'machine-3',
              name: 'UG4 Washer (01)',
              state: 'in_use',
              service_type: { _id: 'st-washer', machine_type: 'washer', value: 'washing_machine_without_powder', label: 'Washer' },
              job: { created_at: '2026-10-26T16:30:00.000Z' },
            }),
            rawMachine({
              _id: 'machine-4',
              name: 'UG4 Washer (05)',
              status: 'maintenance',
              service_type: { _id: 'st-washer', machine_type: 'washer', value: 'washing_machine_with_powder', label: 'Washer' },
            }),
          ],
        },
      ],
    },
  };

  const status = normalizeResponse(payload, NOW);

  assert.equal(status.rooms.length, 1);
  assert.equal(status.rooms[0].name, 'UG Hall IV');
  assert.equal(status.machines.length, 4);
  assert.deepEqual(status.counts, { total: 4, available: 1, inUse: 2, unavailable: 1 });
  assert.deepEqual(status.byKind.dryer, { total: 2, available: 1, inUse: 1 });
  assert.deepEqual(status.byKind.washer, { total: 2, available: 0, inUse: 1 });
  assert.equal(status.fetchedAt.toISOString(), new Date(NOW).toISOString());
  assert.deepEqual(status.meta, { code: 200, message: 'Success' });
});

test('normalizeResponse 缺少 data.laundry_room_machines 时抛 TypeError', () => {
  assert.throws(() => normalizeResponse({ meta: { code: 200 }, data: {} }), TypeError);
});

test('parseMachineNumber 从显示名里取编号', () => {
  assert.equal(parseMachineNumber('UG4 Dryer (52)'), 52);
  assert.equal(parseMachineNumber('UG4 Washer (01)'), 1);
  assert.equal(parseMachineNumber('Washer 03'), null);
  assert.equal(parseMachineNumber(undefined), null);
});

test('isAvailable 要求 status 与 state 同时满足', () => {
  assert.equal(isAvailable({ status: 'enabled', state: 'available' }), true);
  assert.equal(isAvailable({ status: 'maintenance', state: 'available' }), false);
  assert.equal(isAvailable({ status: 'enabled', state: 'in_use' }), false);
  assert.equal(isAvailable(undefined), false);
});

test('formatRemaining：可读文本，负数表示超时', () => {
  assert.equal(formatRemaining(null), '');
  assert.equal(formatRemaining(90), '1m30s');
  assert.equal(formatRemaining(3900), '1h05m');
  assert.equal(formatRemaining(0), '0m00s');
  assert.equal(formatRemaining(-90), '-1m30s');
});
