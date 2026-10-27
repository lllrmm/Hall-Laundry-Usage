/* 洗衣房看板前端（无框架，图表用 Chart.js；历史聚合全部在浏览器端完成） */
(() => {
  'use strict';

  const Aggregate = window.LaundryAggregate;
  if (!Aggregate) throw new Error('aggregate.js 未加载');

  const History = window.LaundryHistory;
  if (!History) throw new Error('history.js 未加载');

  /* ---------------- 主题 ---------------- */

  const THEME_KEY = 'laundry.theme';
  const THEME_CYCLE = ['auto', 'light', 'dark'];
  const THEME_LABELS = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  const THEME_ICONS = { auto: '◐', light: '☀', dark: '☾' };

  function cssVar(name, fallback = '') {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function readThemeMode() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return THEME_CYCLE.includes(saved) ? saved : 'auto';
    } catch {
      return 'auto';
    }
  }

  function resolveTheme(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch {
      // 忽略：不支持 matchMedia 时按浅色处理
    }
    return 'light';
  }

  const state = {
    dateFrom: null,
    dateTo: null,
    selected: new Set(),
    /** 机器维度 + 最新状态（/api/state 的 machines 已合并 latest） */
    machines: [],
    meta: null,
    /** machineId|day → {machineId, day, seq: Uint8Array(1440), updatedAt} */
    dayCache: new Map(),
    /** 已经请求过的机器·天（没有数据的日期也算，避免重复请求） */
    fetchedDays: new Map(),
    /** 数据覆盖的本地日期范围（来自 /api/state，用于把"全部历史"换算成明确区间） */
    span: null,
    /** 是否已经成功加载过完整历史区间 */
    historyLoaded: false,
    heatmapFocus: null,
    heatmapRange: null,
    weekdaySelection: new Set(),
    heatmap: null,
    profile: null,
    bars: null,
    charts: { trend: null, bars: null, hourly: null, profile: null },
    auto: true,
    refreshSeconds: 30,
    countdown: 30,
    loading: false,
    firstLoad: true,
    themeMode: 'auto',
    knownIds: new Set(),
  };

  const $ = (id) => document.getElementById(id);

  /* ---------------- 工具 ---------------- */

  async function api(path) {
    const response = await fetch(path, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function fmtClock(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function fmtRelative(iso) {
    if (!iso) return '';
    const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  function fmtDuration(seconds) {
    if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '';
    const total = Math.max(0, Math.round(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h${pad2(m)}m`;
    if (m > 0) return `${m}m${pad2(s)}s`;
    return `${s}s`;
  }

  function fmtAxisTime(iso, bucketSeconds) {
    const d = new Date(iso);
    if (bucketSeconds < 86400) {
      return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /** "UG4 Dryer (51)" → "Dryer (51)"，窄屏图表标签用短名 */
  function shortMachineName(name) {
    return String(name ?? '').replace(/^UG\d+\s+/i, '');
  }

  function stateClass(machine) {
    if (machine.available) return 'free';
    if (machine.state === 'in_use') return 'busy';
    return 'off';
  }

  function stateLabel(machine) {
    if (machine.available) return 'Free';
    if (machine.state === 'in_use') return 'In use';
    if (machine.state === 'offline') return 'Offline';
    if (machine.status === 'maintenance') return 'Maintenance';
    if (machine.status === 'on_hold') return 'On hold';
    if (machine.status === 'disabled') return 'Disabled';
    return machine.state || 'Unavailable';
  }

  function machineSubText(machine) {
    if (machine.state === 'in_use') {
      if (machine.remainingSeconds !== null && machine.remainingSeconds !== undefined) {
        return machine.remainingSeconds > 0
          ? `~${fmtDuration(machine.remainingSeconds)} left`
          : `Finished ${fmtDuration(-machine.remainingSeconds)} ago, not collected`;
      }
      return `Running for ${fmtDuration(machine.elapsedSeconds)}`;
    }
    if (machine.available) return machine.kind === 'dryer' ? 'Ready to dry' : 'Ready to wash';
    return machine.status && machine.status !== 'enabled' ? machine.status : '';
  }

  /* ---------------- 顶栏 / 状态卡片 ---------------- */

  function renderHeader() {
    const meta = state.meta;
    const badge = $('db-badge');

    if (!meta || !meta.available) {
      badge.textContent = 'Waiting for data';
      badge.className = 'badge warn';
    } else if (meta.lastPoll && !meta.lastPoll.ok) {
      badge.textContent = `Poll failed ${meta.lastPoll.errorCode ?? ''}`;
      badge.className = 'badge error';
    } else {
      badge.textContent = 'Running';
      badge.className = 'badge ok';
    }

    if (meta) {
      $('last-update').textContent = meta.lastObservedAt
        ? `${fmtClock(meta.lastObservedAt)} · ${fmtRelative(meta.lastObservedAt)}`
        : '—';
      $('last-update').title = meta.lastObservedAt ? fmtDateTime(meta.lastObservedAt) : '';

      $('latest-time').textContent = meta.lastObservedAt
        ? `Data time ${fmtDateTime(meta.lastObservedAt)}`
        : '';

      if (meta.lastPoll && meta.lastPoll.finishedAt) {
        state.refreshSeconds = state.refreshSeconds || 30;
      }
    }
  }

  function powderText(machine) {
    if (machine.kind !== 'washer') return '';
    if (machine.powder === 'with') return 'With detergent';
    if (machine.powder === 'without') return 'No detergent';
    return '';
  }

  function renderMachineGrid() {
    const container = $('machine-grid');
    container.innerHTML = '';

    if (!state.machines.length) {
      $('no-data').hidden = false;
      return;
    }
    $('no-data').hidden = true;

    const groups = [
      { kind: 'washer', label: 'Washers' },
      { kind: 'dryer', label: 'Dryers' },
    ];
    const knownKinds = new Set(['washer', 'dryer']);
    const others = state.machines.filter((machine) => !knownKinds.has(machine.kind));
    if (others.length) groups.push({ kind: 'other', label: 'Others' });

    for (const group of groups) {
      const machines = group.kind === 'other' ? others : state.machines.filter((machine) => machine.kind === group.kind);
      if (!machines.length) continue;

      const section = document.createElement('section');
      section.className = 'machine-group';
      section.dataset.kind = group.kind;

      const head = document.createElement('div');
      head.className = 'machine-group-head';
      const title = document.createElement('h3');
      title.textContent = group.label;
      const free = machines.filter((machine) => machine.available).length;
      const stat = document.createElement('span');
      stat.className = 'hint';
      stat.textContent = `${free}/${machines.length} free`;
      head.append(title, stat);

      const grid = document.createElement('div');
      grid.className = 'machine-grid';
      for (const machine of machines) grid.appendChild(machineCard(machine));

      section.append(head, grid);
      container.appendChild(section);
    }
  }

  /** 单台机器的状态卡片 */
  function machineCard(machine) {
    const div = document.createElement('div');
    div.className = `machine ${stateClass(machine)}`;

    const head = document.createElement('div');
    head.className = 'machine-head';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = machine.name;
    name.title = machine.name;
    head.appendChild(name);

    const powder = powderText(machine);
    let powderLine = null;
    if (powder) {
      // detergent 标签独立一行，放在卡片最下方
      powderLine = document.createElement('div');
      powderLine.className = 'powder-line';
      const badge = document.createElement('span');
      badge.className = `powder ${machine.powder}`;
      badge.textContent = powder;
      badge.title = machine.serviceLabel ?? powder;
      powderLine.appendChild(badge);
    }

    const st = document.createElement('div');
    st.className = 'st';
    st.innerHTML = `<b>${stateLabel(machine)}</b>`;

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = machineSubText(machine);

    div.append(head, st, sub);
    if (powderLine) div.appendChild(powderLine);
    div.title = `${machine.name}${powder ? ' · ' + powder : ''}\nObserved: ${fmtDateTime(machine.observedAt)}`;
    return div;
  }

  /* ---------------- 选择控件 ---------------- */

  function syncDateInputs() {
    const from = $('date-from');
    const to = $('date-to');
    const all = $('date-all');
    if (from) from.value = state.dateFrom ?? '';
    if (to) to.value = state.dateTo ?? '';
    if (all) all.disabled = !state.dateFrom && !state.dateTo;
  }

  function dateRangeLabel() {
    return state.dateFrom || state.dateTo
      ? `${state.dateFrom ?? '…'} – ${state.dateTo ?? '…'}`
      : 'all history';
  }

  /** 只有显式选了日期范围才显示的日期后缀（"全部历史"不再出现在标签里） */
  function dateRangeSuffix() {
    return state.dateFrom || state.dateTo ? ` · ${dateRangeLabel()}` : '';
  }

  /** 读取日期输入并重新加载图表（日期范围变化 → 向后台要当前已选机器在新范围的数据） */
  async function applyDateRange() {
    state.dateFrom = $('date-from')?.value || null;
    state.dateTo = $('date-to')?.value || null;
    syncDateInputs();
    await loadHistoryForRange();
  }

  async function clearDateRange() {
    state.dateFrom = null;
    state.dateTo = null;
    syncDateInputs();
    await loadHistoryForRange();
  }

  /** 全选 / 全不选（按钮文字随状态切换） */
  async function toggleSelectAll() {
    if (!state.machines.length) return;
    const selecting = state.selected.size !== state.machines.length;
    if (selecting) state.selected = new Set(state.machines.map((machine) => machine.id));
    else state.selected.clear();
    renderMachineChips();
    // 机器从不选变成选：要这些机器在当前日期范围下的数据
    if (selecting) await loadHistoryForRange();
    else renderViews();
  }

  function renderMachineChips() {
    const box = $('machine-chips');
    box.innerHTML = '';

    // Washers / Dryers 分两栏显示
    for (const [kind, label] of [
      ['washer', 'Washers'],
      ['dryer', 'Dryers'],
    ]) {
      const list = state.machines.filter((machine) => machine.kind === kind);
      if (!list.length) continue;

      const column = document.createElement('div');
      column.className = 'chip-group';
      column.dataset.kind = kind;

      const heading = document.createElement('div');
      heading.className = 'chip-group-head';
      heading.textContent = label;
      column.appendChild(heading);

      const chips = document.createElement('div');
      chips.className = 'chips';
      for (const machine of list) chips.appendChild(machineChip(machine));
      column.appendChild(chips);
      box.appendChild(column);
    }

    updateSelectedCount();
  }

  /** 单台机器的勾选 chip */
  function machineChip(machine) {
    const active = state.selected.has(machine.id);
    const powder = powderText(machine);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `chip${active ? ' active' : ''}`;
    button.title = `Click to ${active ? 'deselect' : 'select'} ${machine.name}${powder ? ' · ' + powder : ''}`;

    const text = document.createElement('span');
    text.textContent = machine.name.replace(/^UG\d\s*/, '');

    button.append(text);

    if (powder) {
      const tag = document.createElement('span');
      tag.className = 'chip-tag';
      tag.textContent = machine.powder === 'with' ? 'det.' : 'no det.';
      button.appendChild(tag);
    }

    button.onclick = async () => {
      const selecting = !state.selected.has(machine.id);
      if (selecting) state.selected.add(machine.id);
      else state.selected.delete(machine.id);
      renderMachineChips();
      // 机器从不选变成选：只补这台机器在当前日期范围下还没缓存的天
      if (selecting) await loadHistoryForMachine();
      else renderViews();
    };

    return button;
  }

  /* ---------------- 图表（Chart.js） ---------------- */

  const CHART_FONT_FAMILY =
    'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

  /** 从 CSS 变量取当前主题的颜色 */
  function chartColors() {
    return {
      text: cssVar('--text', '#16213a'),
      muted: cssVar('--muted', '#6b7893'),
      grid: cssVar('--grid', '#eef1f7'),
      free: cssVar('--free', '#22c55e'),
      freeStrong: cssVar('--free-strong', '#15803d'),
      busy: cssVar('--busy', '#f59e0b'),
      maintenance: cssVar('--maintenance', '#a855f7'),
      disabled: cssVar('--disabled', '#94a3b8'),
      offline: cssVar('--offline', '#64748b'),
      onHold: cssVar('--on-hold', '#fb923c'),
      unknown: cssVar('--unknown', '#cbd5e1'),
      off: cssVar('--off', '#94a3b8'),
      washer: cssVar('--chart-washer', '#0891b2'),
      dryer: cssVar('--chart-dryer', '#d97706'),
      tooltipBg: cssVar('--tooltip-bg', 'rgba(15, 23, 42, 0.92)'),
      tooltipText: cssVar('--tooltip-text', '#ffffff'),
    };
  }

  function chartFont(size) {
    return { family: CHART_FONT_FAMILY, size };
  }

  function round1(value) {
    return Math.round(value * 10) / 10;
  }

  function destroyChart(key) {
    const chart = state.charts[key];
    if (chart) chart.destroy();
    state.charts[key] = null;
  }

  /** 清空容器并显示占位文案（无数据时用） */
  function showChartEmpty(key, container, message) {
    destroyChart(key);
    container.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = message;
    container.appendChild(div);
  }

  /** 在容器里创建（或重建）Chart.js 实例 */
  function mountChart(key, container, config) {
    destroyChart(key);
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    state.charts[key] = new Chart(canvas, config);
    window.__laundryCharts = state.charts; // 方便调试与测试
    return state.charts[key];
  }

  /** 公共配置：响应式、无动画、主题化图例/提示框 */
  function baseChartOptions(colors, compact) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: colors.text,
            usePointStyle: true,
            pointStyle: 'rectRounded',
            boxWidth: compact ? 8 : 10,
            boxHeight: compact ? 8 : 10,
            font: chartFont(compact ? 10 : 11),
          },
        },
        tooltip: {
          backgroundColor: colors.tooltipBg,
          titleColor: colors.tooltipText,
          bodyColor: colors.tooltipText,
          borderColor: colors.grid,
          borderWidth: 1,
          padding: 8,
          displayColors: true,
          boxWidth: 8,
          boxHeight: 8,
          titleFont: chartFont(11),
          bodyFont: chartFont(11),
        },
      },
    };
  }

  function renderBarsChart() {
    const container = $('chart-bars');
    const rows = state.bars?.rows ?? [];

    if (!rows.length) {
      showChartEmpty('bars', container, 'No data in the selected range');
      return;
    }

    const colors = chartColors();
    const compact = container.clientWidth > 0 && container.clientWidth < 520;
    container.style.height = `${Math.max(compact ? 220 : 260, rows.length * (compact ? 24 : 30) + 48)}px`;

    const options = baseChartOptions(colors, compact);
    options.indexAxis = 'y';
    // 横向柱状图的 index 模式必须按 y 轴（行）算，否则 tooltip 会取到错误行
    options.interaction = { mode: 'index', intersect: false, axis: 'y' };
    options.plugins.tooltip.callbacks = {
      label: (item) => `${item.dataset.label}: ${item.formattedValue}%`,
      footer: (items) => {
        const row = rows[items[0]?.dataIndex];
        return row ? `${row.samples} samples` : '';
      },
    };
    options.scales = {
      x: {
        stacked: true,
        min: 0,
        max: 100,
        ticks: {
          color: colors.muted,
          font: chartFont(compact ? 9 : 10),
          callback: (value) => `${value}%`,
        },
        grid: { color: colors.grid },
        border: { color: colors.grid },
      },
      y: {
        stacked: true,
        ticks: { color: colors.text, font: chartFont(compact ? 10 : 11), autoSkip: false },
        grid: { display: false },
      },
    };

    // 从左到右的堆叠顺序由 aggregate.js 的 STATE_CATEGORIES 定义：
    // In use → On hold → Maintenance → Offline → Free → Disabled → Unknown
    // 始终展示全部状态图例（没有样本的状态显示为 0）
    const colorByKey = {
      inUseRatio: colors.busy,
      onHoldRatio: colors.onHold,
      maintenanceRatio: colors.maintenance,
      offlineRatio: colors.offline,
      availableRatio: colors.free,
      disabledRatio: colors.disabled,
      unknownRatio: colors.unknown,
    };
    const categories = Aggregate.STATE_CATEGORIES.map((category) => ({
      ...category,
      color: colorByKey[category.key],
    }));

    mountChart('bars', container, {
      type: 'bar',
      data: {
        labels: rows.map((row) => (compact ? shortMachineName(row.name) : row.name)),
        datasets: categories.map((category) => ({
          label: category.label,
          data: rows.map((row) => round1((row[category.key] ?? 0) * 100)),
          backgroundColor: category.color,
          stack: 'state',
          borderWidth: 0,
          borderSkipped: false,
        })),
      },
      options,
    });
  }

  /** #rrggbb → rgba(...)，用于热力图按使用率调透明度 */
  function hexToRgba(hex, alpha) {
    const value = String(hex || '').trim();
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
    if (!match) return `rgba(245, 158, 11, ${alpha})`;
    let full = match[1];
    if (full.length === 3) full = full.split('').map((char) => char + char).join('');
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  function hhmm(minute) {
    return `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
  }

  function renderHeatmap(heatmap, emptyMessage = 'No data in the selected range') {
    const container = $('heatmap');
    const canvas = $('heatmap-canvas');
    const hoursBox = $('heatmap-hours');
    const labelBox = $('heatmap-row-labels');
    const tooltip = $('heatmap-tooltip');
    const hint = $('heatmap-hint');
    const headBox = container.querySelector('.heatmap-head');
    const bodyBox = container.querySelector('.heatmap-body');
    const cells = heatmap?.cells ?? [];
    const focus = state.heatmapFocus;

    const cssWidth = Math.max(320, container.clientWidth || 900);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rowH = 20;
    const top = 4;
    const height = top + 7 * rowH + 4;

    canvas.style.height = `${height}px`;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, height);

    if (!cells.length) {
      if (hint) hint.textContent = '';
      if (tooltip) tooltip.classList.remove('visible');
      hoursBox.innerHTML = '';
      labelBox.innerHTML = '';
      canvas.dataset.minutes = '0';
      // 空状态：隐藏热力图网格，显示与 Inspection 一致的空状态占位
      if (headBox) headBox.hidden = true;
      if (bodyBox) bodyBox.hidden = true;
      const empty = document.createElement('div');
      empty.className = 'empty heatmap-empty';
      empty.textContent = emptyMessage;
      container.querySelector('.heatmap-empty')?.remove();
      container.appendChild(empty);
      return;
    }
    container.querySelector('.heatmap-empty')?.remove();
    if (headBox) headBox.hidden = false;
    if (bodyBox) bodyBox.hidden = false;

    const colors = chartColors();
    const byKey = new Map(cells.map((cell) => [`${cell.weekday}-${cell.minute}`, cell]));
    const minuteX = (minute) => (minute / 1440) * cssWidth;
    const cellW = cssWidth / 1440;
    canvas.dataset.minutes = '1440';

    hoursBox.innerHTML = '';
    for (let hour = 0; hour < 24; hour += 1) {
      const label = document.createElement('div');
      label.className = 'heatmap-hour';
      // 时间轴只显示整点：00、01、…、23
      label.textContent = pad2(hour);
      label.title = `Drag here to select a time range`;
      hoursBox.appendChild(label);
    }

    labelBox.innerHTML = '';
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const label = document.createElement('div');
      label.className = 'heatmap-row-label';
      label.textContent = WEEKDAY_LABELS[weekday];
      if (state.weekdaySelection.has(weekday)) label.classList.add('active');
      label.title = `Toggle ${WEEKDAY_LABELS[weekday]} (multi-select)`;
      label.addEventListener('click', () => {
        if (state.weekdaySelection.has(weekday)) state.weekdaySelection.delete(weekday);
        else state.weekdaySelection.add(weekday);
        // 时段选择与星期选择互斥：选星期时清除时段/分钟选择
        if (state.weekdaySelection.size) {
          state.heatmapFocus = null;
          state.heatmapRange = null;
        }
        renderViews();
      });
      labelBox.appendChild(label);
    }

    const draw = (preview) => {
      ctx.clearRect(0, 0, cssWidth, height);
      ctx.fillStyle = hexToRgba(colors.busy, 0.05);
      ctx.fillRect(0, top, cssWidth, 7 * rowH);

      for (let weekday = 0; weekday < 7; weekday += 1) {
        const y = top + weekday * rowH;
        for (let minute = 0; minute < 1440; minute += 1) {
          const cell = byKey.get(`${weekday}-${minute}`);
          if (!cell) continue;
          ctx.fillStyle = hexToRgba(colors.busy, 0.08 + 0.9 * cell.usageRatio);
          ctx.fillRect(minuteX(minute), y, Math.max(cellW, 1), rowH - 1);
        }
      }

      if (preview) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.25)';
        ctx.fillRect(minuteX(preview.from), top, minuteX(preview.to + 1) - minuteX(preview.from), 7 * rowH);
        return;
      }

      if (state.weekdaySelection.size) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.14)';
        for (const weekday of state.weekdaySelection) {
          ctx.fillRect(0, top + weekday * rowH, cssWidth, rowH - 1);
        }
      }

      if (focus && focus.kind === 'weekday') {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.12)';
        ctx.fillRect(0, top + focus.value * rowH, cssWidth, rowH - 1);
      } else if (focus && focus.kind === 'minute') {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.35)';
        ctx.fillRect(minuteX(focus.value), top, Math.max(cellW, 2), 7 * rowH);
      } else if (focus && focus.kind === 'range') {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.28)';
        ctx.fillRect(minuteX(focus.from), top, minuteX(focus.to + 1) - minuteX(focus.from), 7 * rowH);
      }
    };
    draw(null);

    const rectOf = () => canvas.getBoundingClientRect();
    const minuteAt = (event) => {
      const rect = rectOf();
      const x = event.clientX - rect.left;
      const width = rect.width || cssWidth;
      return Math.max(0, Math.min(1439, Math.floor((x / width) * 1440)));
    };
    const weekdayAt = (event) => {
      const rect = rectOf();
      const y = ((event.clientY - rect.top) / (rect.height || height)) * height;
      return Math.max(0, Math.min(6, Math.floor((y - top) / rowH)));
    };

    const showTooltip = (event) => {
      const minute = minuteAt(event);
      const weekday = weekdayAt(event);
      const cell = byKey.get(`${weekday}-${minute}`);
      if (!tooltip) return;
      const rect = rectOf();
      tooltip.textContent = cell
        ? `${WEEKDAY_LABELS[weekday]} ${hhmm(minute)} · usage ${Math.round(cell.usageRatio * 100)}% · ${cell.samples} samples`
        : `${WEEKDAY_LABELS[weekday]} ${hhmm(minute)} · no data`;
      tooltip.style.left = `${event.clientX - rect.left}px`;
      tooltip.style.top = `${event.clientY - rect.top}px`;
      tooltip.classList.add('visible');
    };

    // 热力图内：点击/悬停只弹标签显示该点信息，不改变选择
    canvas.onclick = (event) => showTooltip(event);

    canvas.onmousemove = (event) => {
      showTooltip(event);
    };

    canvas.onmouseleave = () => {
      if (tooltip) tooltip.classList.remove('visible');
    };

    // ---- 顶部时间轴：横向拖动选择时段（10 分钟粒度） ----
    const axis = hoursBox;
    const axisSelection = document.createElement('div');
    axisSelection.className = 'axis-selection';
    axisSelection.style.opacity = '0';
    axis.appendChild(axisSelection);

    const SNAP_MINUTES = 30;
    const snapStart = (minute) => Math.min(1439, Math.floor(minute / SNAP_MINUTES) * SNAP_MINUTES);
    const blockEnd = (start) => Math.min(1439, start + SNAP_MINUTES - 1);

    const axisMinuteAt = (event) => {
      const rect = axis.getBoundingClientRect();
      const width = rect.width || axis.clientWidth || cssWidth;
      const x = event.clientX - rect.left;
      return Math.max(0, Math.min(1439, Math.floor((x / width) * 1440)));
    };
    const showAxisSelection = (from, to) => {
      axisSelection.style.left = `${(from / 1440) * 100}%`;
      axisSelection.style.width = `${((to - from + 1) / 1440) * 100}%`;
      axisSelection.style.opacity = '1';
    };

    if (focus && focus.kind === 'range') showAxisSelection(focus.from, focus.to);

    let axisDragStart = null;
    axis.onmousedown = (event) => {
      axisDragStart = snapStart(axisMinuteAt(event));
      showAxisSelection(axisDragStart, blockEnd(axisDragStart));
      event.preventDefault();
    };
    axis.onmousemove = (event) => {
      if (axisDragStart === null) return;
      const minute = snapStart(axisMinuteAt(event));
      const from = Math.min(axisDragStart, minute);
      showAxisSelection(from, blockEnd(Math.max(axisDragStart, minute)));
    };
    axis.onmouseup = (event) => {
      const end = snapStart(axisMinuteAt(event));
      const start = axisDragStart;
      axisDragStart = null;
      if (start === null) return;

      const from = Math.min(start, end);
      const to = blockEnd(Math.max(start, end));
      state.heatmapRange = { from, to };
      state.heatmapFocus = { kind: 'range', from, to };
      // 时段选择与星期选择互斥
      state.weekdaySelection.clear();
      renderViews();
    };
    axis.onmouseleave = () => {
      axisDragStart = null;
      if (focus && focus.kind === 'range') showAxisSelection(focus.from, focus.to);
      else axisSelection.style.opacity = '0';
    };

    if (hint) {
      hint.textContent =
        'click weekday labels to filter · drag the top axis to select a time range';
    }
  }

  /** 历史剖面：选中周几 → 24 小时分布；选中小时 → 一周 7 天分布；未选 → 全部按小时（样本加权） */
  /** 5 分钟槽位 → HH:mm */
  function slotLabel(slot, bucketSeconds) {
    const minutes = slot * (bucketSeconds / 60);
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    return `${pad2(hour)}:${pad2(minute)}`;
  }

  /** 横轴标签间距：只能取 15 / 30 / 60 / 120 分钟 */
  function profileTickStep(width) {
    const maxLabels = Math.max(4, Math.floor(Math.max(320, width) / 80));
    for (const step of [15, 30, 60, 120]) {
      if (1440 / step <= maxLabels) return step;
    }
    return 120;
  }

  function profileChartOptions(colors, compact, { showLegend = false } = {}) {
    const options = baseChartOptions(colors, compact);
    options.plugins.legend.display = showLegend;
    options.interaction = { mode: 'index', intersect: false };
    options.plugins.tooltip.callbacks = {
      title: (items) => items[0]?.label ?? '',
      label: (item) => {
        if (item.raw === null || item.raw === undefined) return `${item.dataset.label}: no data`;
        const count = item.dataset.samples?.[item.dataIndex] ?? 0;
        return count > 0
          ? `${item.dataset.label}: ${item.formattedValue}% · ${count} samples`
          : `${item.dataset.label}: ${item.formattedValue}%`;
      },
    };
    options.scales = {
      x: {
        ticks: {
          color: colors.muted,
          font: chartFont(9),
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: compact ? 6 : 10,
        },
        grid: { display: false },
        border: { color: colors.grid },
      },
      y: {
        beginAtZero: true,
        max: 100,
        ticks: {
          color: colors.muted,
          font: chartFont(compact ? 9 : 10),
          callback: (value) => `${value}%`,
        },
        grid: { color: colors.grid },
        border: { color: colors.grid },
      },
    };
    return options;
  }

  /** 当前勾选的星期（空 = 全部 7 天） */
  function selectedWeekdays() {
    if (!state.weekdaySelection.size) return [0, 1, 2, 3, 4, 5, 6];
    return [...state.weekdaySelection].sort((a, b) => a - b);
  }

  /**
   * 星期列表 → 紧凑标签：连续的天合并成区间。
   * 例：[0,1,2] → "Mon–Wed"；[0,1,4,5,6] → "Mon–Tue, Fri–Sun"；7 天 → "Mon–Sun"。
   */
  function formatWeekdayRanges(weekdayList) {
    const sorted = [...new Set(weekdayList)].sort((a, b) => a - b);
    if (!sorted.length) return '';
    const parts = [];
    let start = sorted[0];
    let previous = sorted[0];
    const flush = () => {
      parts.push(start === previous ? WEEKDAY_LABELS[start] : `${WEEKDAY_LABELS[start]}–${WEEKDAY_LABELS[previous]}`);
    };
    for (const weekday of sorted.slice(1)) {
      if (weekday === previous + 1) {
        previous = weekday;
        continue;
      }
      flush();
      start = weekday;
      previous = weekday;
    }
    flush();
    return parts.join(', ');
  }

  /**
   * Inspection 柱状图：点击某根柱子 → 选中该星期（等效点击热力图左侧行标签），
   * 切换到该星期的 1 分钟线图。
   */
  function barChartOptions(colors, compact, weekdayList) {
    const options = profileChartOptions(colors, compact);
    options.onClick = (event, elements) => {
      const index = elements?.[0]?.index;
      const weekday = index === undefined || index === null ? undefined : weekdayList[index];
      if (weekday === undefined) return;
      state.weekdaySelection = new Set([weekday]);
      state.heatmapFocus = null;
      state.heatmapRange = null;
      // 等 Chart.js 退出本次事件处理后再重绘
      setTimeout(renderViews, 0);
    };
    options.onHover = (event, elements) => {
      const target = event?.native?.target;
      if (target?.style) target.style.cursor = elements?.length ? 'pointer' : 'default';
    };
    return options;
  }

  /** 历史剖面：行/默认 → 1 分钟线图；列（分钟）→ 一周 7 天柱状图 */
  function renderProfile() {
    const container = $('chart-profile');
    const hint = $('profile-hint');
    const focus = state.heatmapFocus;
    const colors = chartColors();
    const compact = container.clientWidth > 0 && container.clientWidth < 520;

    if (focus && focus.kind === 'minute') {
      const cells = state.heatmap?.cells ?? [];
      if (!cells.length) {
        if (hint) hint.textContent = '';
        showChartEmpty('profile', container, 'No data in the selected range');
        return;
      }

      const byKey = new Map(cells.map((cell) => [`${cell.weekday}-${cell.minute}`, cell]));
      const weekdayList = selectedWeekdays();
      const labels = [];
      const values = [];
      const samples = [];
      for (const weekday of weekdayList) {
        const cell = byKey.get(`${weekday}-${focus.value}`);
        labels.push(WEEKDAY_LABELS[weekday]);
        values.push(cell ? round1(cell.usageRatio * 100) : null);
        samples.push(cell?.samples ?? 0);
      }

      const time = `${pad2(Math.floor(focus.value / 60))}:${pad2(focus.value % 60)}`;
      // 柱状图模式只显示时间段
      if (hint) hint.textContent = time;
      mountChart('profile', container, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Usage rate',
              data: values,
              backgroundColor: colors.busy,
              borderRadius: 3,
              borderWidth: 0,
              maxBarThickness: compact ? 14 : 30,
              samples,
            },
          ],
        },
        options: barChartOptions(colors, compact, weekdayList),
      });
      return;
    }

    if (focus && focus.kind === 'range') {
      const cells = state.heatmap?.cells ?? [];
      if (!cells.length) {
        if (hint) hint.textContent = '';
        showChartEmpty('profile', container, 'No data in the selected range');
        return;
      }

      // 拖选的分钟区间 → 按周几统计（柱状图，仅显示勾选的星期）
      const weekdayList = selectedWeekdays();
      const labels = weekdayList.map((weekday) => WEEKDAY_LABELS[weekday]);
      const values = [];
      const samples = [];
      for (const weekday of weekdayList) {
        let weighted = 0;
        let weight = 0;
        for (const cell of cells) {
          if (cell.weekday !== weekday) continue;
          if (cell.minute < focus.from || cell.minute > focus.to) continue;
          weighted += cell.usageRatio * cell.samples;
          weight += cell.samples;
        }
        values.push(weight > 0 ? round1((weighted / weight) * 100) : null);
        samples.push(weight);
      }

      // 柱状图模式只显示时间段
      if (hint) hint.textContent = `${hhmm(focus.from)}–${hhmm(focus.to)}`;
      mountChart('profile', container, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Usage rate',
              data: values,
              backgroundColor: colors.busy,
              borderRadius: 3,
              borderWidth: 0,
              maxBarThickness: compact ? 14 : 30,
              samples,
            },
          ],
        },
        options: barChartOptions(colors, compact, weekdayList),
      });
      return;
    }

    const data = state.profile;
    if (!data || !data.slots?.length || !data.slots.some((entry) => entry.samples > 0)) {
      if (hint) hint.textContent = '';
      showChartEmpty('profile', container, 'No data in the selected range');
      return;
    }

    const labels = data.slots.map((entry) => slotLabel(entry.slot, data.bucketSeconds));
    const toPercent = (value) => (value === null || value === undefined ? null : round1(value * 100));
    const washerValues = data.slots.map((entry) => toPercent(entry.washerUsage));
    const dryerValues = data.slots.map((entry) => toPercent(entry.dryerUsage));
    const washerSamples = data.slots.map((entry) => entry.washerSamples ?? 0);
    const dryerSamples = data.slots.map((entry) => entry.dryerSamples ?? 0);
    // 用 1 分钟索引作为 x 坐标，便于按时距控制刻度
    const washerPoints = washerValues.map((value, index) => ({ x: index, y: value }));
    const dryerPoints = dryerValues.map((value, index) => ({ x: index, y: value }));

    // 默认 1 分钟线图：右上角始终显示星期范围（没选时即全部 7 天 → Mon–Sun）
    if (hint) hint.textContent = formatWeekdayRanges(selectedWeekdays());

    // 线图始终显示两条机型图例（没有样本的机型数据全为 null，只隐藏线条、不隐藏图例）
    const datasets = [
      {
        label: 'Washers in use',
        data: washerPoints,
        borderColor: colors.washer,
        backgroundColor: hexToRgba(colors.washer, 0.12),
        borderWidth: 2,
        tension: 0.15,
        fill: false,
        pointRadius: 0,
        pointHoverRadius: 4,
        spanGaps: false,
        samples: washerSamples,
      },
      {
        label: 'Dryers in use',
        data: dryerPoints,
        borderColor: colors.dryer,
        backgroundColor: hexToRgba(colors.dryer, 0.12),
        borderWidth: 2,
        tension: 0.15,
        fill: false,
        pointRadius: 0,
        pointHoverRadius: 4,
        spanGaps: false,
        samples: dryerSamples,
      },
    ];

    // 横轴刻度固定为 15 / 30 / 60 / 120 分钟间距
    const tickStep = profileTickStep(container.clientWidth || 900);
    const options = profileChartOptions(colors, compact, { showLegend: true });
    // 显式给出整数分钟刻度，避免 Chart.js 自动把范围均分后产生 239.833… 这种小数刻度
    const minuteTicks = [];
    for (let minute = 0; minute <= 1439; minute += tickStep) minuteTicks.push({ value: minute });
    options.scales.x = {
      type: 'linear',
      min: 0,
      max: 1439,
      afterBuildTicks: (axis) => {
        axis.ticks = minuteTicks.map((tick) => ({ value: tick.value }));
      },
      ticks: {
        stepSize: tickStep,
        autoSkip: false,
        color: colors.muted,
        font: chartFont(compact ? 8 : 9),
        maxRotation: 0,
        callback: (value) => {
          const minute = Math.round(Number(value));
          return `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
        },
      },
      grid: { color: colors.grid },
      border: { color: colors.grid },
    };
    options.plugins.tooltip.callbacks.title = (items) => {
      const minute = Math.round(items[0]?.parsed?.x ?? 0);
      return `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
    };

    mountChart('profile', container, {
      type: 'line',
      data: { datasets },
      options,
    });
  }

  /* ---------------- 历史数据（/api/days → 浏览器端聚合） ---------------- */

  /** base64 → Uint8Array（每台机器每天 1,440 字节） */
  function decodeSequence(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function todayKey() {
    return History.todayKey();
  }

  /** 当前日期范围是否包含今天（自动刷新只重取今天的数据） */
  function rangeIncludesToday() {
    return History.rangeIncludesToday(state.dateFrom, state.dateTo);
  }

  /**
   * 把 UI 上的日期选择换算成 /api/days 必填的明确区间。
   * "全部历史" 用 /api/state 返回的 span（数据覆盖范围），并夹到已知数据范围内；
   * 与已知数据完全没有交集时返回 null（不需要请求，直接显示空）。
   */
  function effectiveRange() {
    const span = state.span;
    let from = state.dateFrom;
    let to = state.dateTo;

    if (!from && !to) {
      from = span?.firstDay ?? null;
      to = span?.lastDay ?? null;
    } else if (from && !to) {
      to = span?.lastDay ?? todayKey();
    } else if (!from && to) {
      from = span?.firstDay ?? to;
    }
    if (!from || !to) return null;

    if (span?.firstDay && from < span.firstDay) from = span.firstDay;
    if (span?.lastDay && to > span.lastDay) to = span.lastDay;
    if (from > to) return null;
    return { fromDay: from, toDay: to };
  }

  /** 记录某台机器的某些天已经取过（即使那天没有数据） */
  function markFetched(machineIds, fromDay, toDay, returnedDays) {
    for (const machineId of machineIds) {
      let days = state.fetchedDays.get(machineId);
      if (!days) {
        days = new Set();
        state.fetchedDays.set(machineId, days);
      }
      if (fromDay && toDay) {
        for (const day of History.dayListBetween(fromDay, toDay)) days.add(day);
      } else {
        for (const day of returnedDays) days.add(day);
      }
    }
  }

  /** 当前选择下还缺哪些机器·天（已缓存的不再请求；缺失日期按连续区间分组） */
  function pendingRequests() {
    const range = effectiveRange();
    if (!range) return [];
    return History.planDiff({
      selectedIds: [...state.selected],
      dateFrom: range.fromDay,
      dateTo: range.toDay,
      fetchedDays: state.fetchedDays,
    });
  }

  /**
   * 向后端要一段机器·天的序列（只在缓存缺数据时调用）。
   * 返回的数据会替换缓存里对应机器、对应日期的旧序列。
   */
  async function fetchHistory({ machineIds = [], fromDay = null, toDay = null } = {}) {
    const params = new URLSearchParams();
    const ids = machineIds.filter(Boolean);
    if (ids.length) params.set('machines', ids.join(','));
    if (fromDay) params.set('from', fromDay);
    if (toDay) params.set('to', toDay);

    const data = await api(`/api/days?${params}`);
    if (data.available === false) throw new Error('history database unavailable');

    // 先清掉这次请求覆盖的机器·天，再写入新数据（今天的序列会随轮询增长）
    const wanted = new Set(ids);
    for (const [key, record] of state.dayCache) {
      if (wanted.size && !wanted.has(record.machineId)) continue;
      if (fromDay && record.day < fromDay) continue;
      if (toDay && record.day > toDay) continue;
      state.dayCache.delete(key);
    }

    const returnedDays = new Set();
    for (const row of data.days ?? []) {
      returnedDays.add(row.day);
      state.dayCache.set(`${row.machineId}|${row.day}`, {
        machineId: row.machineId,
        day: row.day,
        seq: decodeSequence(row.seq),
        updatedAt: row.updatedAt ?? null,
      });
    }

    markFetched(ids, fromDay, toDay, returnedDays);
    return data;
  }

  function historyFailed(error) {
    console.error('Failed to load history data', error);
    $('db-badge').textContent = `Load failed: ${error.message}`;
    $('db-badge').className = 'badge error';
    if (!state.heatmap) clearCharts('Failed to load history data');
  }

  /** 把当前缺失的机器·天补齐（已缓存的不再请求） */
  async function fetchPendingHistory() {
    for (const request of pendingRequests()) await fetchHistory(request);
  }

  /** 日期范围变化 / 首次加载：只补当前区间里还没缓存过的机器·天 */
  async function loadHistoryForRange() {
    if (!state.selected.size) {
      renderViews();
      return;
    }
    // 与已知数据没有交集（例如选了全空的日期）：不需要请求
    if (!effectiveRange()) {
      state.historyLoaded = false;
      renderViews();
      return;
    }
    try {
      await fetchPendingHistory();
    } catch (error) {
      historyFailed(error);
      state.historyLoaded = false;
      return;
    }
    state.historyLoaded = true;
    renderViews();
  }

  /** 机器从不选变成选：只补这台机器在当前范围里还没缓存过的天 */
  async function loadHistoryForMachine() {
    try {
      await fetchPendingHistory();
    } catch (error) {
      historyFailed(error);
      return;
    }
    renderViews();
  }

  /** 自动/手动刷新：只重取今天、已选机器的序列（今天的序列还在增长） */
  async function loadHistoryForRefresh() {
    if (!state.selected.size || !rangeIncludesToday()) return;
    const today = todayKey();
    try {
      await fetchHistory({ machineIds: [...state.selected], fromDay: today, toDay: today });
    } catch (error) {
      historyFailed(error);
      return;
    }
    renderViews();
  }

  /** 当前日期范围 + 机器选择对应的机器·天序列 */
  function recordsForView() {
    const from = state.dateFrom;
    const to = state.dateTo;
    const records = [];
    for (const record of state.dayCache.values()) {
      if (!state.selected.has(record.machineId)) continue;
      if (from && record.day < from) continue;
      if (to && record.day > to) continue;
      records.push(record);
    }
    return records;
  }

  /** 展示用的覆盖时段：日期范围与真实首条观测取交集，结束时间不超过现在 */
  function computeCoverage(records) {
    const now = Date.now();
    let since = null;
    if (state.meta?.firstObservedAt) since = new Date(state.meta.firstObservedAt);
    if (state.dateFrom) {
      const from = new Date(`${state.dateFrom}T00:00:00`);
      since = since ? new Date(Math.max(since.getTime(), from.getTime())) : from;
    } else if (!since && records.length) {
      const earliest = records.reduce((min, record) => (record.day < min ? record.day : min), records[0].day);
      since = new Date(`${earliest}T00:00:00`);
    }

    let until = new Date(now);
    if (state.dateTo) {
      const end = new Date(`${state.dateTo}T23:59:59.999`);
      until = new Date(Math.min(end.getTime(), now));
    }
    if (since && until.getTime() < since.getTime()) until = new Date(since.getTime());
    return { since: since ? since.toISOString() : null, until: until.toISOString() };
  }

  /** State breakdown 用的机器顺序：洗衣机 → 烘干机 → 其他 */
  function chartMachineList() {
    const kindOrder = { washer: 0, dryer: 1 };
    return state.machines
      .filter((machine) => state.selected.has(machine.id))
      .slice()
      .sort(
        (a, b) =>
          (kindOrder[a.kind] ?? 2) - (kindOrder[b.kind] ?? 2) ||
          String(a.name).localeCompare(String(b.name)),
      );
  }

  /** State breakdown 的筛选范围标签：始终显示「星期 · 时段」 */
  function barsScopeLabel() {
    const focus = state.heatmapFocus;
    const weekdays = state.weekdaySelection.size
      ? [...state.weekdaySelection].sort((a, b) => a - b)
      : [0, 1, 2, 3, 4, 5, 6];
    const dayLabel = formatWeekdayRanges(weekdays);
    if (focus && focus.kind === 'minute') {
      return `${dayLabel} · ${hhmm(focus.value)}${dateRangeSuffix()}`;
    }
    if (focus && focus.kind === 'range') {
      return `${dayLabel} · ${hhmm(focus.from)}–${hhmm(focus.to)}${dateRangeSuffix()}`;
    }
    // 没有时间筛选时，时段按整天显示
    return `${dayLabel} · 00:00–23:59${dateRangeSuffix()}`;
  }

  function clearCharts(message = 'No data in the selected range') {
    state.heatmap = null;
    state.profile = null;
    state.bars = null;
    renderHeatmap(null, message);
    showChartEmpty('bars', $('chart-bars'), message);
    showChartEmpty('profile', $('chart-profile'), message);
    $('bars-range').textContent = '';
  }

  /**
   * 纯本地重算并重绘：勾机器、选星期、拖时段、点分钟都走这里，不请求后端。
   */
  function renderViews() {
    if (!state.selected.size) {
      clearCharts('Select at least one machine');
      return;
    }

    const records = recordsForView();
    const machineList = chartMachineList();
    const kindById = {};
    const nameById = {};
    for (const machine of state.machines) {
      kindById[machine.id] = machine.kind;
      nameById[machine.id] = machine.name;
    }

    const coverage = computeCoverage(records);
    const weekdays = [...state.weekdaySelection].sort((a, b) => a - b);
    const focus = state.heatmapFocus;

    state.heatmap = { ...Aggregate.buildHeatmap(records), coverage };
    state.profile = Aggregate.buildProfile(records, { kindById, weekdays });
    const breakdown = Aggregate.buildStateBreakdown(records, {
      kindById,
      nameById,
      machineIds: machineList.map((machine) => machine.id),
      weekdays,
      minute: focus && focus.kind === 'minute' ? focus.value : null,
      fromMinute: focus && focus.kind === 'range' ? focus.from : null,
      toMinute: focus && focus.kind === 'range' ? focus.to : null,
    });
    state.bars = { ...breakdown, since: coverage.since, until: coverage.until };

    renderHeatmap(state.heatmap);
    renderProfile();
    renderBarsChart();

    $('bars-range').textContent = state.bars.rows.length ? barsScopeLabel() : '';
  }

  /* ---------------- 数据刷新 ---------------- */

  async function loadState() {
    const data = await api('/api/state');
    state.meta = data.meta;
    state.machines = data.machines ?? [];
    state.span = data.meta?.span ?? null;

    if (state.firstLoad) {
      state.selected = new Set(state.machines.map((machine) => machine.id));
      state.knownIds = new Set(state.machines.map((machine) => machine.id));
      state.firstLoad = false;
      renderMachineChips();
    } else {
      // 新出现的机器：刷新 chip 列表（新机器默认未选中），并让视图保持完整
      const hasNewMachine = state.machines.some((machine) => !state.knownIds.has(machine.id));
      if (hasNewMachine) {
        for (const machine of state.machines) state.knownIds.add(machine.id);
        renderMachineChips();
      }
    }

    renderHeader();
    renderMachineGrid();
    updateSelectedCount();
  }

  function updateSelectedCount() {
    $('selected-count').textContent = `${state.selected.size}/${state.machines.length} selected`;

    const button = $('select-all');
    if (button) {
      const allSelected = state.machines.length > 0 && state.selected.size === state.machines.length;
      button.textContent = allSelected ? 'Clear all' : 'Select all';
      button.disabled = state.machines.length === 0;
    }
  }

  let refreshing = false;

  async function refreshAll({ initial = false } = {}) {
    if (refreshing) return;
    refreshing = true;
    try {
      await loadState();
      // 首次加载取全部历史；之后刷新只重取今天的序列
      if (initial) await loadHistoryForRange();
      else if (!state.historyLoaded) await loadHistoryForRange();
      else await loadHistoryForRefresh();
    } catch (error) {
      console.error('Refresh failed', error);
      $('db-badge').textContent = `Connection failed: ${error.message}`;
      $('db-badge').className = 'badge error';
    } finally {
      refreshing = false;
      state.countdown = state.refreshSeconds;
      $('auto-countdown').textContent = state.auto ? `${state.countdown}s` : '';
    }
  }

  /* ---------------- 主题切换 ---------------- */

  function applyTheme(mode, { persist = false, redraw = true } = {}) {
    state.themeMode = THEME_CYCLE.includes(mode) ? mode : 'auto';

    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, state.themeMode);
      } catch {
        // 隐私模式下 localStorage 可能不可用，忽略
      }
    }

    document.documentElement.dataset.theme = resolveTheme(state.themeMode);

    const button = $('theme-toggle');
    if (button) {
      const icon = button.querySelector('.theme-icon');
      const label = $('theme-label');
      if (icon) icon.textContent = THEME_ICONS[state.themeMode];
      if (label) label.textContent = THEME_LABELS[state.themeMode];
      button.title =
        state.themeMode === 'auto' ? 'Theme: Auto (follows system)' : `Theme: ${THEME_LABELS[state.themeMode]}`;
    }

    if (redraw) redrawCharts();
  }

  function cycleTheme() {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(state.themeMode) + 1) % THEME_CYCLE.length];
    applyTheme(next, { persist: true });
  }

  function redrawCharts() {
    renderMachineChips();
    if (state.bars) renderBarsChart();
    if (state.heatmap) renderHeatmap(state.heatmap);
    if (state.heatmap) renderProfile();
  }

  /** 监听系统深浅色变化（仅 Auto 模式下跟随） */
  function watchSystemTheme() {
    if (!window.matchMedia) return;
    let media;
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const onChange = () => {
      if (state.themeMode === 'auto') applyTheme('auto');
    };
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
    else if (typeof media.addListener === 'function') media.addListener(onChange);
  }

  /* ---------------- 初始化 ---------------- */

  function tick() {
    if (!state.auto) return;
    state.countdown -= 1;
    if (state.countdown <= 0) {
      state.countdown = state.refreshSeconds;
      refreshAll();
    }
    $('auto-countdown').textContent = `${Math.max(0, state.countdown)}s`;
  }

  function bindEvents() {
    $('refresh').addEventListener('click', () => refreshAll());
    $('theme-toggle').addEventListener('click', () => cycleTheme());
    $('select-all').addEventListener('click', () => toggleSelectAll());

    $('date-from').addEventListener('change', applyDateRange);
    $('date-to').addEventListener('change', applyDateRange);
    $('date-all').addEventListener('click', clearDateRange);

    $('auto').addEventListener('change', (event) => {
      state.auto = event.target.checked;
      state.countdown = state.refreshSeconds;
      $('auto-countdown').textContent = state.auto ? `${state.countdown}s` : '';
    });

    window.addEventListener(
      'resize',
      debounce(() => {
        // 容器宽度变化会影响紧凑模式（刻度密度等），按新宽度重建图表
        if (state.bars) renderBarsChart();
        if (state.heatmap) {
          renderHeatmap(state.heatmap);
          renderProfile();
        }
      }, 250),
    );

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshAll();
    });
  }

  async function init() {
    syncDateInputs();
    applyTheme(readThemeMode(), { redraw: false });
    watchSystemTheme();
    bindEvents();
    await refreshAll({ initial: true });
    setInterval(tick, 1000);
  }

  init();
})();
