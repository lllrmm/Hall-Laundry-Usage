/*!
 * 历史数据缓存 / 取数计划：只补缓存里缺的「机器·天」，已缓存的一律不再请求后端。
 *
 * 浏览器端按 (machineId, day) 缓存 /api/days 返回的 1440 字节日序列：
 *   - 首次加载：取全部历史（请求里不带日期边界）；
 *   - data range 变化：只请求新范围里还没缓存过的机器·天（diff）；
 *   - 机器从不选变成选：只请求这台机器在当前范围里还没缓存过的天；
 *   - 自动刷新：单独只重取「今天」的序列（今天的字节还在增长）。
 *
 * 该文件是普通 <script>（非 ES module），同时挂到全局 `LaundryHistory`，
 * 便于 node 测试用 vm 直接执行。
 */
(function (root) {
  'use strict';

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  /** 本地日历日 YYYY-MM-DD */
  function localDayKey(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function todayKey(now = new Date()) {
    return localDayKey(now);
  }

  /** 下一天（YYYY-MM-DD → YYYY-MM-DD） */
  function nextDayKey(day) {
    const [year, month, date] = String(day).split('-').map(Number);
    const next = new Date(year, month - 1, date);
    next.setDate(next.getDate() + 1);
    return localDayKey(next);
  }

  /** 两个本地日期（含首尾）之间的所有日期 */
  function dayListBetween(fromDay, toDay) {
    const days = [];
    if (!fromDay || !toDay) return days;
    const [fromYear, fromMonth, fromDate] = String(fromDay).split('-').map(Number);
    const [toYear, toMonth, toDate] = String(toDay).split('-').map(Number);
    const cursor = new Date(fromYear, fromMonth - 1, fromDate);
    const end = new Date(toYear, toMonth - 1, toDate);
    while (cursor.getTime() <= end.getTime()) {
      days.push(localDayKey(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return days;
  }

  /** 当前日期范围是否包含今天（自动刷新只重取今天的数据） */
  function rangeIncludesToday(dateFrom, dateTo, today = todayKey()) {
    if (!dateFrom && !dateTo) return true;
    if (dateFrom && today < dateFrom) return false;
    if (dateTo && today > dateTo) return false;
    return true;
  }

  function isFetched(machineId, day, fetchedAllMachines, fetchedDays) {
    if (fetchedAllMachines?.has(machineId)) return true;
    return fetchedDays?.get(machineId)?.has(day) ?? false;
  }

  /**
   * 计算还缺哪些机器·天。
   * 把缺失日期按连续区间分组，尽量合并成最少的请求。
   *
   * @param {object} options
   * @param {string[]} options.selectedIds 当前勾选的机器
   * @param {string|null} options.dateFrom 起始本地日期
   * @param {string|null} options.dateTo 结束本地日期
   * @param {Set<string>} options.fetchedAllMachines 已取过全部历史的机器
   * @param {Map<string, Set<string>>} options.fetchedDays 已取过的具体机器·天（含没有数据的日期）
   * @returns {Array<{machineIds: string[], fromDay: string|null, toDay: string|null}>}
   */
  function planDiff({
    selectedIds = [],
    dateFrom = null,
    dateTo = null,
    fetchedAllMachines = new Set(),
    fetchedDays = new Map(),
  } = {}) {
    const selected = selectedIds.filter(Boolean);
    if (!selected.length) return [];

    const targets = selected.filter((machineId) => !fetchedAllMachines.has(machineId));
    if (!targets.length) return [];

    if (!dateFrom && !dateTo) {
      // 全部历史：这些机器还没整库取过，一次取全
      return [{ machineIds: targets, fromDay: null, toDay: null }];
    }
    if (!dateFrom || !dateTo) {
      // 单边日期无法枚举缺失天数，整体请求一次
      return [{ machineIds: targets, fromDay: dateFrom, toDay: dateTo }];
    }

    const missingDays = new Set();
    const missingByMachine = new Map();
    for (const machineId of targets) {
      const missing = dayListBetween(dateFrom, dateTo).filter(
        (day) => !isFetched(machineId, day, fetchedAllMachines, fetchedDays),
      );
      missingByMachine.set(machineId, missing);
      for (const day of missing) missingDays.add(day);
    }
    if (!missingDays.size) return [];

    const sorted = [...missingDays].sort();
    const runs = [];
    let runStart = sorted[0];
    let runEnd = sorted[0];
    for (const day of sorted.slice(1)) {
      if (day === nextDayKey(runEnd)) {
        runEnd = day;
        continue;
      }
      runs.push([runStart, runEnd]);
      runStart = day;
      runEnd = day;
    }
    runs.push([runStart, runEnd]);

    return runs
      .map(([runFrom, runTo]) => ({
        machineIds: targets.filter((machineId) =>
          missingByMachine.get(machineId).some((day) => day >= runFrom && day <= runTo),
        ),
        fromDay: runFrom,
        toDay: runTo,
      }))
      .filter((request) => request.machineIds.length > 0);
  }

  const api = {
    localDayKey,
    todayKey,
    nextDayKey,
    dayListBetween,
    rangeIncludesToday,
    planDiff,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LaundryHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
