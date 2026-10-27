import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/** public/aggregate.js 是普通 <script>（挂全局 LaundryAggregate），用 vm 执行后取导出对象 */
function loadAggregate() {
  const source = fs.readFileSync(new URL('../public/aggregate.js', import.meta.url), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.LaundryAggregate;
}

const Agg = loadAggregate();
const BYTE = Agg.BYTE;

/** 1440 字节序列；writes 形如 {600: BYTE.inUse} */
function sequence(writes = {}, fill = BYTE.noData) {
  const seq = new Uint8Array(Agg.MINUTES_PER_DAY).fill(fill);
  for (const [minute, byte] of Object.entries(writes)) seq[Number(minute)] = byte;
  return seq;
}

const MONDAY = '2024-01-01';
const TUESDAY = '2024-01-02';

function cellAt(cells, weekday, minute) {
  return cells.find((cell) => cell.weekday === weekday && cell.minute === minute);
}

test('STATE_CATEGORIES：State breakdown 堆叠柱从左到右的顺序', () => {
  assert.deepEqual(
    [...Agg.STATE_CATEGORIES].map((category) => category.label),
    ['In use', 'On hold', 'Maintenance', 'Offline', 'Free', 'Disabled', 'Unknown'],
  );
});

test('weekdayOfDay：0=周一 … 6=周日（与日期所在时区无关）', () => {
  assert.equal(Agg.weekdayOfDay(MONDAY), 0);
  assert.equal(Agg.weekdayOfDay(TUESDAY), 1);
  assert.equal(Agg.weekdayOfDay('2024-01-06'), 5);
  assert.equal(Agg.weekdayOfDay('2024-01-07'), 6);
  assert.equal(Agg.weekdayOfDay('bad'), null);
});

test('isOperational / isInUse：on_hold 计入分子和分母', () => {
  assert.equal(Agg.isOperational(BYTE.available), true);
  assert.equal(Agg.isOperational(BYTE.inUse), true);
  assert.equal(Agg.isOperational(BYTE.onHold), true, 'on_hold 计入使用率分母');
  assert.equal(Agg.isOperational(BYTE.maintenance), false);
  assert.equal(Agg.isOperational(BYTE.offline), false);
  assert.equal(Agg.isOperational(BYTE.noData), false);

  assert.equal(Agg.isInUse(BYTE.inUse), true);
  assert.equal(Agg.isInUse(BYTE.onHold), true, 'on_hold 计入使用率分子');
  assert.equal(Agg.isInUse(BYTE.available), false);
  assert.equal(Agg.isInUse(BYTE.maintenance), false);
});

test('buildHeatmap：星期 × 分钟只在可运营样本上算使用率', () => {
  const records = [
    {
      machineId: 'w1',
      day: MONDAY,
      seq: sequence({
        600: BYTE.inUse,
        601: BYTE.available,
        602: BYTE.maintenance,
        603: BYTE.onHold,
      }),
    },
    { machineId: 'd1', day: TUESDAY, seq: sequence({ 600: BYTE.available }) },
  ];

  const heatmap = Agg.buildHeatmap(records);
  assert.equal(heatmap.minutes, 1440);
  assert.equal(heatmap.samples, 4, '维护/离线/no_data 不计入样本；on_hold 计入');

  const monday600 = cellAt(heatmap.cells, 0, 600);
  assert.equal(monday600.samples, 1);
  assert.equal(monday600.usageRatio, 1);

  const monday601 = cellAt(heatmap.cells, 0, 601);
  assert.equal(monday601.samples, 1);
  assert.equal(monday601.usageRatio, 0);

  const monday603 = cellAt(heatmap.cells, 0, 603);
  assert.equal(monday603.samples, 1, 'on_hold 计入分母');
  assert.equal(monday603.usageRatio, 1, 'on_hold 计入分子');

  assert.equal(cellAt(heatmap.cells, 0, 602), undefined, '维护样本不产生热力图格子');
  const tuesday600 = cellAt(heatmap.cells, 1, 600);
  assert.equal(tuesday600.samples, 1);
  assert.equal(tuesday600.usageRatio, 0);
});

test('buildProfile：1 分钟槽位，按机型拆分，可筛选星期', () => {
  const records = [
    {
      machineId: 'w1',
      day: MONDAY,
      seq: sequence({
        600: BYTE.inUse,
        601: BYTE.available,
        602: BYTE.maintenance,
        603: BYTE.onHold,
      }),
    },
    { machineId: 'd1', day: TUESDAY, seq: sequence({ 600: BYTE.available }) },
  ];
  const kindById = { w1: 'washer', d1: 'dryer' };

  const profile = Agg.buildProfile(records, { kindById });
  assert.equal(profile.bucketSeconds, 60);
  assert.equal(profile.slots.length, 1440);

  const slot603 = profile.slots[603];
  assert.equal(slot603.samples, 1, 'on_hold 计入剖面分母');
  assert.equal(slot603.usageRatio, 1);
  assert.equal(slot603.washerSamples, 1);
  assert.equal(slot603.washerUsage, 1, 'on_hold 计入剖面分子');

  const slot600 = profile.slots[600];
  assert.equal(slot600.samples, 2);
  assert.equal(slot600.usageRatio, 0.5);
  assert.equal(slot600.washerSamples, 1);
  assert.equal(slot600.washerUsage, 1);
  assert.equal(slot600.dryerSamples, 1);
  assert.equal(slot600.dryerUsage, 0);

  const slot601 = profile.slots[601];
  assert.equal(slot601.samples, 1);
  assert.equal(slot601.washerSamples, 1);
  assert.equal(slot601.washerUsage, 0);
  assert.equal(slot601.dryerSamples, 0);
  assert.equal(slot601.dryerUsage, null);

  const slot602 = profile.slots[602];
  assert.equal(slot602.samples, 0, '维护样本不计入剖面');
  assert.equal(slot602.usageRatio, null);

  // 只统计周二：只有烘干机样本
  const tuesday = Agg.buildProfile(records, { kindById, weekdays: [1] });
  assert.equal(tuesday.slots[600].samples, 1);
  assert.equal(tuesday.slots[600].washerSamples, 0);
  assert.equal(tuesday.slots[600].dryerSamples, 1);
  assert.equal(tuesday.slots[601].samples, 0);

  // 只统计周一：只有洗衣机样本
  const monday = Agg.buildProfile(records, { kindById, weekdays: [0] });
  assert.equal(monday.slots[600].washerSamples, 1);
  assert.equal(monday.slots[600].dryerSamples, 0);

  // 没有数据的星期：全部空槽
  const empty = Agg.buildProfile(records, { kindById, weekdays: [5] });
  assert.ok(empty.slots.every((slot) => slot.samples === 0));
  assert.equal(empty.samples, 0);
});

test('buildStateBreakdown：各种状态都计入分母，no_data 除外', () => {
  const records = [
    {
      machineId: 'w1',
      day: TUESDAY,
      seq: sequence({
        600: BYTE.inUse,
        601: BYTE.maintenance,
        602: BYTE.noData,
      }),
    },
    {
      machineId: 'd1',
      day: TUESDAY,
      seq: sequence({
        600: BYTE.available,
        601: BYTE.offline,
        602: BYTE.unknown,
      }),
    },
  ];
  const kindById = { w1: 'washer', d1: 'dryer' };
  const nameById = { w1: 'UG4 Washer (01)', d1: 'UG4 Dryer (51)' };

  const breakdown = Agg.buildStateBreakdown(records, {
    kindById,
    nameById,
    machineIds: ['w1', 'd1'],
  });
  assert.equal(breakdown.rows.length, 2);
  assert.deepEqual(
    breakdown.rows.map((row) => row.id),
    ['w1', 'd1'],
    '保持传入的机器顺序',
  );

  const washer = breakdown.rows[0];
  assert.equal(washer.name, 'UG4 Washer (01)');
  assert.equal(washer.kind, 'washer');
  assert.equal(washer.samples, 2, 'no_data 不计入分母');
  assert.equal(washer.inUseRatio, 0.5);
  assert.equal(washer.maintenanceRatio, 0.5);
  assert.equal(washer.availableRatio, 0);

  const dryer = breakdown.rows[1];
  assert.equal(dryer.samples, 3);
  assert.equal(dryer.availableRatio, 1 / 3);
  assert.equal(dryer.offlineRatio, 1 / 3);
  assert.equal(dryer.unknownRatio, 1 / 3);
  const total = [
    'inUseRatio',
    'availableRatio',
    'maintenanceRatio',
    'disabledRatio',
    'onHoldRatio',
    'offlineRatio',
    'unknownRatio',
  ].reduce((sum, key) => sum + dryer[key], 0);
  assert.ok(Math.abs(total - 1) < 1e-9, '各状态占比之和应为 1');

  // 热力图/剖面聚焦到某一分钟
  const minute = Agg.buildStateBreakdown(records, {
    kindById,
    nameById,
    machineIds: ['w1', 'd1'],
    minute: 600,
  });
  assert.deepEqual(minute.rows.map((row) => row.samples), [1, 1]);
  assert.equal(minute.rows[0].inUseRatio, 1);
  assert.equal(minute.rows[1].availableRatio, 1);

  // 时段选择：601–602
  const range = Agg.buildStateBreakdown(records, {
    kindById,
    nameById,
    machineIds: ['w1', 'd1'],
    fromMinute: 601,
    toMinute: 602,
  });
  assert.deepEqual(range.rows.map((row) => row.samples), [1, 2]);
  assert.equal(range.rows[0].maintenanceRatio, 1);
  assert.equal(range.rows[1].offlineRatio, 0.5);
  assert.equal(range.rows[1].unknownRatio, 0.5);

  // 星期筛选：周二有样本，周一没有
  const tuesday = Agg.buildStateBreakdown(records, {
    kindById,
    nameById,
    machineIds: ['w1', 'd1'],
    weekdays: [1],
  });
  assert.equal(tuesday.rows.length, 2);
  const monday = Agg.buildStateBreakdown(records, {
    kindById,
    nameById,
    machineIds: ['w1', 'd1'],
    weekdays: [0],
  });
  assert.equal(monday.rows.length, 0, '没有样本的机器不出现在占比图里');
});

test('buildHeatmap / buildProfile：空数据返回空结果但不抛错', () => {
  assert.equal(Agg.buildHeatmap([]).cells.length, 0);
  assert.equal(Agg.buildHeatmap([]).samples, 0);
  const profile = Agg.buildProfile([]);
  assert.equal(profile.slots.length, 1440);
  assert.ok(profile.slots.every((slot) => slot.samples === 0));
  assert.equal(Agg.buildStateBreakdown([], { machineIds: ['x'] }).rows.length, 0);
});
