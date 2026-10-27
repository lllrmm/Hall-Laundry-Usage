import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

/** public/history.js 是普通 <script>（挂全局 LaundryHistory），用 vm 执行后取导出对象 */
function loadHistory() {
  const source = fs.readFileSync(new URL('../public/history.js', import.meta.url), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.LaundryHistory;
}

const History = loadHistory();

/** vm 里创建的对象原型不同，序列化后再比较 */
function same(actual, expected) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
}

function fetchedDaysOf(entries) {
  const map = new Map();
  for (const [machineId, days] of Object.entries(entries)) map.set(machineId, new Set(days));
  return map;
}

test('日期工具：本地日期 + 连续日期列表', () => {
  assert.equal(History.localDayKey(new Date(2026, 9, 27, 16, 30)), '2026-10-27');
  assert.equal(History.todayKey(new Date(2026, 0, 2, 0, 0)), '2026-01-02');
  assert.equal(History.nextDayKey('2026-10-27'), '2026-10-28');
  assert.equal(History.nextDayKey('2026-10-31'), '2026-11-01');
  same(History.dayListBetween('2026-10-01', '2026-10-03'), [
    '2026-10-01',
    '2026-10-02',
    '2026-10-03',
  ]);
  same(History.dayListBetween('2026-10-03', '2026-10-01'), []);
});

test('rangeIncludesToday：全部历史 / 区间内外', () => {
  assert.equal(History.rangeIncludesToday(null, null, '2026-10-27'), true);
  assert.equal(History.rangeIncludesToday('2026-10-01', '2026-10-27', '2026-10-27'), true);
  assert.equal(History.rangeIncludesToday('2026-10-01', '2026-10-26', '2026-10-27'), false);
  assert.equal(History.rangeIncludesToday('2026-10-28', null, '2026-10-27'), false);
  assert.equal(History.rangeIncludesToday('2026-10-01', null, '2026-10-27'), true);
});

test('planDiff：/api/days 必须有明确日期区间，缺一边不规划请求', () => {
  same(History.planDiff({ selectedIds: [] }), []);
  same(History.planDiff({ selectedIds: ['a'] }), [], '没有日期范围不请求');
  same(History.planDiff({ selectedIds: ['a'], dateFrom: '2026-10-01' }), [], '只有 from 不请求');
  same(History.planDiff({ selectedIds: ['a'], dateTo: '2026-10-03' }), [], '只有 to 不请求');
  same(
    History.planDiff({ selectedIds: ['a'], dateFrom: '2026-10-03', dateTo: '2026-10-01' }),
    [],
    'from 晚于 to 不请求',
  );
});

test('planDiff：已缓存的不再请求', () => {
  same(
    History.planDiff({
      selectedIds: ['a', 'b'],
      dateFrom: '2026-10-01',
      dateTo: '2026-10-03',
      fetchedDays: fetchedDaysOf({
        a: ['2026-10-01', '2026-10-02', '2026-10-03'],
        b: ['2026-10-01', '2026-10-02', '2026-10-03'],
      }),
    }),
    [],
    '全部已缓存（含没有数据的日期）不应该产生请求',
  );
});

test('planDiff：data range 变化只补缓存缺的机器·天', () => {
  // b 完全没取过；a 只取过 10-01、10-02 → 缺 10-03
  const requests = History.planDiff({
    selectedIds: ['a', 'b'],
    dateFrom: '2026-10-01',
    dateTo: '2026-10-03',
    fetchedDays: fetchedDaysOf({ a: ['2026-10-01', '2026-10-02'] }),
  });
  same(requests, [{ machineIds: ['a', 'b'], fromDay: '2026-10-01', toDay: '2026-10-03' }]);

  // a 已全部取过 → 只剩 b
  const onlyB = History.planDiff({
    selectedIds: ['a', 'b'],
    dateFrom: '2026-10-01',
    dateTo: '2026-10-02',
    fetchedDays: fetchedDaysOf({ a: ['2026-10-01', '2026-10-02'] }),
  });
  same(onlyB, [{ machineIds: ['b'], fromDay: '2026-10-01', toDay: '2026-10-02' }]);

  // 缺少的日期不连续 → 拆成两个请求，避免把中间已缓存的日期再取一遍
  const disjoint = History.planDiff({
    selectedIds: ['a'],
    dateFrom: '2026-10-01',
    dateTo: '2026-10-05',
    fetchedDays: fetchedDaysOf({ a: ['2026-10-01', '2026-10-03', '2026-10-05'] }),
  });
  same(disjoint, [
    { machineIds: ['a'], fromDay: '2026-10-02', toDay: '2026-10-02' },
    { machineIds: ['a'], fromDay: '2026-10-04', toDay: '2026-10-04' },
  ]);
});

test('planDiff：新选机器只补它自己缺的天', () => {
  const requests = History.planDiff({
    selectedIds: ['a', 'b', 'c'],
    dateFrom: '2026-10-01',
    dateTo: '2026-10-02',
    fetchedDays: fetchedDaysOf({
      a: ['2026-10-01', '2026-10-02'],
      b: ['2026-10-01', '2026-10-02'],
    }),
  });
  same(requests, [{ machineIds: ['c'], fromDay: '2026-10-01', toDay: '2026-10-02' }]);

  // 只取过一部分：新选机器补齐整个区间
  const partial = History.planDiff({
    selectedIds: ['c'],
    dateFrom: '2026-10-01',
    dateTo: '2026-10-03',
    fetchedDays: fetchedDaysOf({ c: ['2026-10-02'] }),
  });
  same(partial, [
    { machineIds: ['c'], fromDay: '2026-10-01', toDay: '2026-10-01' },
    { machineIds: ['c'], fromDay: '2026-10-03', toDay: '2026-10-03' },
  ]);
});

test('planDiff：单日区间只发一天', () => {
  same(
    History.planDiff({
      selectedIds: ['a'],
      dateFrom: '2026-10-02',
      dateTo: '2026-10-02',
    }),
    [{ machineIds: ['a'], fromDay: '2026-10-02', toDay: '2026-10-02' }],
  );
});
