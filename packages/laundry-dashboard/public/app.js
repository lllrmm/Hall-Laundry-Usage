/* 洗衣房看板前端（无框架，图表用 Chart.js） */
(() => {
  'use strict';

  /* ---------------- 主题 ---------------- */

  const THEME_KEY = 'laundry.theme';
  const THEME_CYCLE = ['auto', 'light', 'dark'];
  const THEME_LABELS = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  const THEME_ICONS = { auto: '◐', light: '☀', dark: '☾' };

  /** 每台机器的线条颜色：深色主题用更亮的色板，保证深底可读 */
  const COLOR_PALETTES = {
    light: [
      '#1b4dc1', '#e11d48', '#0d9488', '#7c3aed', '#c2410c', '#0891b2',
      '#4d7c0f', '#be185d', '#4338ca', '#a16207', '#0f766e', '#9d174d',
    ],
    dark: [
      '#60a5fa', '#f472b6', '#2dd4bf', '#a78bfa', '#fb923c', '#22d3ee',
      '#a3e635', '#f9a8d4', '#818cf8', '#facc15', '#34d399', '#f87171',
    ],
  };

  function currentTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }

  function palette() {
    return COLOR_PALETTES[currentTheme()] ?? COLOR_PALETTES.light;
  }

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
    machines: [],
    latest: [],
    meta: null,
    series: null,
    bars: null,
    hourly: null,
    heatmap: null,
    heatmapFocus: null,
    heatmapRange: null,
    profile: null,
    profileKey: null,
    profileAt: 0,
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

  /** 时段展示用：MM-DD HH:mm（本地时间） */
  function fmtRangeTime(iso) {
    const d = new Date(iso);
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /** "UG4 Dryer (51)" → "Dryer (51)"，窄屏图表标签用短名 */
  function shortMachineName(name) {
    return String(name ?? '').replace(/^UG\d+\s+/i, '');
  }

  function colorFor(machineId) {
    const index = state.machines.findIndex((machine) => machine.id === machineId);
    const colors = palette();
    return colors[(index >= 0 ? index : 0) % colors.length];
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

    if (!state.latest.length) {
      $('no-data').hidden = false;
      return;
    }
    $('no-data').hidden = true;

    const groups = [
      { kind: 'washer', label: 'Washers' },
      { kind: 'dryer', label: 'Dryers' },
    ];
    const knownKinds = new Set(['washer', 'dryer']);
    const others = state.latest.filter((machine) => !knownKinds.has(machine.kind));
    if (others.length) groups.push({ kind: 'other', label: 'Others' });

    for (const group of groups) {
      const machines = group.kind === 'other' ? others : state.latest.filter((machine) => machine.kind === group.kind);
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
    if (powder) {
      const badge = document.createElement('span');
      badge.className = `powder ${machine.powder}`;
      badge.textContent = powder;
      badge.title = machine.serviceLabel ?? powder;
      head.appendChild(badge);
    }

    const st = document.createElement('div');
    st.className = 'st';
    st.innerHTML = `<b>${stateLabel(machine)}</b>`;

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = machineSubText(machine);

    div.append(head, st, sub);
    div.title = `${machine.name}${powder ? ' · ' + powder : ''}\nObserved: ${fmtDateTime(machine.observedAt)}`;
    return div;
  }

  /* ---------------- 选择控件 ---------------- */

  /** 日期范围 → API 参数（本地日期，含首尾两天） */
  function dateRangeParams() {
    const params = {};
    if (state.dateFrom) params.since = new Date(`${state.dateFrom}T00:00:00`).toISOString();
    if (state.dateTo) params.until = new Date(`${state.dateTo}T23:59:59.999`).toISOString();
    return params;
  }

  function syncDateInputs() {
    const from = $('date-from');
    const to = $('date-to');
    const all = $('date-all');
    if (from) from.value = state.dateFrom ?? '';
    if (to) to.value = state.dateTo ?? '';
    if (all) all.disabled = !state.dateFrom && !state.dateTo;
  }

  function machineIdsParam() {
    return [...state.selected].join(',');
  }

  /** 图表通用参数：日期范围 + 选中的机器（所有面板共用） */
  function chartParams(extra = {}) {
    const dateParams = dateRangeParams();
    const params = new URLSearchParams({ since: dateParams.since ?? 'all' });
    if (dateParams.until) params.set('until', dateParams.until);
    const machines = machineIdsParam();
    if (machines) params.set('machines', machines);
    for (const [key, value] of Object.entries(extra)) params.set(key, String(value));
    return params;
  }

  function dateRangeLabel() {
    return state.dateFrom || state.dateTo
      ? `${state.dateFrom ?? '…'} – ${state.dateTo ?? '…'}`
      : 'all history';
  }

  /** 读取日期输入并重新加载图表（热力图 / 剖面跟随日期） */
  function applyDateRange() {
    state.dateFrom = $('date-from')?.value || null;
    state.dateTo = $('date-to')?.value || null;
    state.profile = null;
    state.profileKey = null;
    syncDateInputs();
    loadCharts();
  }

  function clearDateRange() {
    state.dateFrom = null;
    state.dateTo = null;
    state.profile = null;
    state.profileKey = null;
    syncDateInputs();
    loadCharts();
  }

  /** 全选 / 全不选（按钮文字随状态切换） */
  function toggleSelectAll() {
    if (!state.machines.length) return;
    if (state.selected.size === state.machines.length) state.selected.clear();
    else state.selected = new Set(state.machines.map((machine) => machine.id));
    renderMachineChips();
    loadCharts();
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

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = colorFor(machine.id);

    const text = document.createElement('span');
    text.textContent = machine.name.replace(/^UG\d\s*/, '');

    button.append(swatch, text);

    if (powder) {
      const tag = document.createElement('span');
      tag.className = 'chip-tag';
      tag.textContent = machine.powder === 'with' ? 'det.' : 'no det.';
      button.appendChild(tag);
    }

    button.onclick = () => {
      if (state.selected.has(machine.id)) state.selected.delete(machine.id);
      else state.selected.add(machine.id);
      renderMachineChips();
      loadCharts();
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
      showChartEmpty('bars', container, 'No data yet (waiting for polls)');
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

    mountChart('bars', container, {
      type: 'bar',
      data: {
        labels: rows.map((row) => (compact ? shortMachineName(row.name) : row.name)),
        datasets: [
          {
            label: 'In use',
            data: rows.map((row) => round1(row.inUseRatio * 100)),
            backgroundColor: colors.busy,
            stack: 'state',
            borderWidth: 0,
            borderSkipped: false,
          },
          {
            label: 'Free',
            data: rows.map((row) => round1(row.availableRatio * 100)),
            backgroundColor: colors.free,
            stack: 'state',
            borderWidth: 0,
            borderSkipped: false,
          },
          {
            label: 'Unavailable',
            data: rows.map((row) => round1(row.unavailableRatio * 100)),
            backgroundColor: colors.off,
            stack: 'state',
            borderWidth: 0,
            borderSkipped: false,
          },
        ],
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

  /** 点击行/列切换剖面焦点（再次点击取消）；range 焦点由热力图拖动产生 */
  function setHeatmapFocus(kind, value) {
    const focus = state.heatmapFocus;
    state.heatmapFocus = focus && focus.kind === kind && focus.value === value ? null : { kind, value };
    state.heatmapRange = null;
    if (state.heatmap) renderHeatmap(state.heatmap);
    refreshProfile();
    loadBars();
  }

  function hhmm(minute) {
    return `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
  }

  function renderHeatmap(heatmap, emptyMessage = 'No data yet (waiting for polls)') {
    const container = $('heatmap');
    const canvas = $('heatmap-canvas');
    const hoursBox = $('heatmap-hours');
    const labelBox = $('heatmap-row-labels');
    const tooltip = $('heatmap-tooltip');
    const hint = $('heatmap-hint');
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
      const empty = document.createElement('div');
      empty.className = 'empty heatmap-empty';
      empty.textContent = emptyMessage;
      container.querySelector('.heatmap-empty')?.remove();
      container.appendChild(empty);
      return;
    }
    container.querySelector('.heatmap-empty')?.remove();

    const colors = chartColors();
    const byKey = new Map(cells.map((cell) => [`${cell.weekday}-${cell.minute}`, cell]));
    const totalSamples = cells.reduce((sum, cell) => sum + cell.samples, 0);
    const minuteX = (minute) => (minute / 1440) * cssWidth;
    const cellW = cssWidth / 1440;
    canvas.dataset.minutes = '1440';

    hoursBox.innerHTML = '';
    for (let hour = 0; hour < 24; hour += 1) {
      const label = document.createElement('div');
      label.className = 'heatmap-hour';
      label.textContent = hour % 3 === 0 ? `${pad2(hour)}:00` : '';
      label.title = `Drag here to select a time range`;
      hoursBox.appendChild(label);
    }

    labelBox.innerHTML = '';
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const label = document.createElement('div');
      label.className = 'heatmap-row-label';
      label.textContent = WEEKDAY_LABELS[weekday];
      if (focus && focus.kind === 'weekday' && focus.value === weekday) label.classList.add('active');
      label.addEventListener('click', () => setHeatmapFocus('weekday', weekday));
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

    // 热力图内：单击选分钟 + hover tooltip（时段选择在顶部时间轴完成）
    canvas.onclick = (event) => {
      setHeatmapFocus('minute', minuteAt(event));
    };

    canvas.onmousemove = (event) => {
      const minute = minuteAt(event);
      const weekday = weekdayAt(event);
      const cell = byKey.get(`${weekday}-${minute}`);
      if (tooltip) {
        const rect = rectOf();
        tooltip.textContent = cell
          ? `${WEEKDAY_LABELS[weekday]} ${hhmm(minute)} · usage ${Math.round(cell.usageRatio * 100)}% · ${cell.samples} samples`
          : `${WEEKDAY_LABELS[weekday]} ${hhmm(minute)} · no data`;
        tooltip.style.left = `${event.clientX - rect.left}px`;
        tooltip.style.top = `${event.clientY - rect.top}px`;
        tooltip.classList.add('visible');
      }
    };

    canvas.onmouseleave = () => {
      if (tooltip) tooltip.classList.remove('visible');
    };

    // ---- 顶部时间轴：横向拖动选择时段 ----
    const axis = hoursBox;
    const axisSelection = document.createElement('div');
    axisSelection.className = 'axis-selection';
    axisSelection.style.opacity = '0';
    axis.appendChild(axisSelection);

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
      axisDragStart = axisMinuteAt(event);
      showAxisSelection(axisDragStart, axisDragStart);
      event.preventDefault();
    };
    axis.onmousemove = (event) => {
      if (axisDragStart === null) return;
      const minute = axisMinuteAt(event);
      showAxisSelection(Math.min(axisDragStart, minute), Math.max(axisDragStart, minute));
    };
    axis.onmouseup = (event) => {
      const end = axisMinuteAt(event);
      const start = axisDragStart;
      axisDragStart = null;
      if (start === null) return;
      if (Math.abs(end - start) >= 2) {
        const from = Math.min(start, end);
        const to = Math.max(start, end);
        state.heatmapRange = { from, to };
        state.heatmapFocus = { kind: 'range', from, to };
        renderHeatmap(state.heatmap);
        refreshProfile();
        loadBars();
        return;
      }
      setHeatmapFocus('minute', end);
    };
    axis.onmouseleave = () => {
      axisDragStart = null;
      if (focus && focus.kind === 'range') showAxisSelection(focus.from, focus.to);
      else axisSelection.style.opacity = '0';
    };

    if (hint) {
      const covered =
        heatmap.since && heatmap.until
          ? `${fmtRangeTime(heatmap.since)} – ${fmtRangeTime(heatmap.until)}`
          : 'all history';
      hint.textContent = `${covered} · ${totalSamples} samples · drag the top axis to select a time range`;
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
        showChartEmpty('profile', container, 'No data yet (waiting for polls)');
        return;
      }

      const byKey = new Map(cells.map((cell) => [`${cell.weekday}-${cell.minute}`, cell]));
      const labels = [];
      const values = [];
      const samples = [];
      for (let weekday = 0; weekday < 7; weekday += 1) {
        const cell = byKey.get(`${weekday}-${focus.value}`);
        labels.push(WEEKDAY_LABELS[weekday]);
        values.push(cell ? round1(cell.usageRatio * 100) : null);
        samples.push(cell?.samples ?? 0);
      }

      const time = `${pad2(Math.floor(focus.value / 60))}:${pad2(focus.value % 60)}`;
      if (hint) hint.textContent = `${time} · usage by weekday · ${dateRangeLabel()}`;
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
        options: profileChartOptions(colors, compact),
      });
      return;
    }

    if (focus && focus.kind === 'range') {
      const cells = state.heatmap?.cells ?? [];
      if (!cells.length) {
        if (hint) hint.textContent = '';
        showChartEmpty('profile', container, 'No data in this range');
        return;
      }

      // 拖选的分钟区间 → 按周几统计（柱状图）
      const labels = [...WEEKDAY_LABELS];
      const values = [];
      const samples = [];
      for (let weekday = 0; weekday < 7; weekday += 1) {
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

      if (hint) {
        hint.textContent = `${hhmm(focus.from)}–${hhmm(focus.to)} · usage by weekday · ${dateRangeLabel()}`;
      }
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
        options: profileChartOptions(colors, compact),
      });
      return;
    }

    const data = state.profile;
    if (!data || !data.slots?.length || !data.slots.some((entry) => entry.samples > 0)) {
      if (hint) hint.textContent = '';
      showChartEmpty('profile', container, 'No data in this date range');
      return;
    }

    const labels = data.slots.map((entry) => slotLabel(entry.slot, data.bucketSeconds));
    const toPercent = (value) => (value === null || value === undefined ? null : round1(value * 100));
    const washerValues = data.slots.map((entry) => toPercent(entry.washerUsage));
    const dryerValues = data.slots.map((entry) => toPercent(entry.dryerUsage));
    const washerSamples = data.slots.map((entry) => entry.washerSamples ?? 0);
    const dryerSamples = data.slots.map((entry) => entry.dryerSamples ?? 0);

    const period =
      data.since && data.until
        ? `${fmtRangeTime(data.since)} – ${fmtRangeTime(data.until)}`
        : 'all history';
    const title =
      focus && focus.kind === 'weekday'
        ? `${WEEKDAY_LABELS[focus.value]} · 1-min profile · ${period}`
        : `All days · 1-min profile · ${period}`;
    if (hint) hint.textContent = title;

    // 只画有样本的机型（机器选择变化时图例自动收缩）
    const datasets = [];
    if (washerSamples.some((count) => count > 0)) {
      datasets.push({
        label: 'Washers in use',
        data: washerValues,
        borderColor: colors.washer,
        backgroundColor: hexToRgba(colors.washer, 0.12),
        borderWidth: 2,
        tension: 0.15,
        fill: false,
        pointRadius: 0,
        pointHoverRadius: 4,
        spanGaps: false,
        samples: washerSamples,
      });
    }
    if (dryerSamples.some((count) => count > 0)) {
      datasets.push({
        label: 'Dryers in use',
        data: dryerValues,
        borderColor: colors.dryer,
        backgroundColor: hexToRgba(colors.dryer, 0.12),
        borderWidth: 2,
        tension: 0.15,
        fill: false,
        pointRadius: 0,
        pointHoverRadius: 4,
        spanGaps: false,
        samples: dryerSamples,
      });
    }

    mountChart('profile', container, {
      type: 'line',
      data: { labels, datasets },
      options: profileChartOptions(colors, compact, { showLegend: true }),
    });
  }

  /** 行/默认剖面按需拉取 5 分钟数据（同一日期/机器/周几 60 秒内复用） */
  async function refreshProfile() {
    if (!state.selected.size) {
      state.profile = null;
      showChartEmpty('profile', $('chart-profile'), 'Select at least one machine');
      return;
    }

    const focus = state.heatmapFocus;
    if (focus && focus.kind === 'minute') {
      renderProfile();
      return;
    }

    // 时段选择与"选时间点"一致：直接用热力图数据按周几聚合
    if (focus && focus.kind === 'range') {
      renderProfile();
      return;
    }

    const dateKey = `${state.dateFrom ?? ''}~${state.dateTo ?? ''}`;
    const machineKey = machineIdsParam();
    const key = `${focus && focus.kind === 'weekday' ? `w${focus.value}` : 'all'}|${dateKey}|${machineKey}`;
    const fresh = state.profileKey === key && state.profile && Date.now() - (state.profileAt ?? 0) < 60_000;
    if (fresh) {
      renderProfile();
      return;
    }

    try {
      const params = chartParams();
      params.set('bucketSeconds', '60');
      if (focus && focus.kind === 'weekday') params.set('weekday', String(focus.value));
      const data = await api(`/api/profile?${params}`);
      if (!state.selected.size) return; // 请求期间清空了选择，丢弃结果
      state.profile = data;
      state.profileKey = key;
      state.profileAt = Date.now();
      renderProfile();
    } catch (error) {
      console.error('Failed to load profile', error);
      showChartEmpty('profile', $('chart-profile'), 'Failed to load profile');
    }
  }

  /* ---------------- 图表数据装载 ---------------- */

  /** State breakdown 的查询范围：日期范围 + 机器选择 + 热力图选中的行/列 */
  function barsQuery() {
    const focus = state.heatmapFocus;
    const extra = {};
    let label = null;
    if (focus && focus.kind === 'weekday') {
      extra.weekday = focus.value;
      label = `${WEEKDAY_LABELS[focus.value]} · ${dateRangeLabel()}`;
    } else if (focus && focus.kind === 'minute') {
      extra.minute = focus.value;
      label = `${hhmm(focus.value)} · ${dateRangeLabel()}`;
    } else if (focus && focus.kind === 'range') {
      extra.fromMinute = focus.from;
      extra.toMinute = focus.to;
      label = `${hhmm(focus.from)}–${hhmm(focus.to)} · ${dateRangeLabel()}`;
    }
    return { params: chartParams(extra), label };
  }

  /** 只刷新 State breakdown（热力图选择变化时立即生效） */
  async function loadBars() {
    if (!state.selected.size) {
      state.bars = null;
      showChartEmpty('bars', $('chart-bars'), 'Select at least one machine');
      $('bars-range').textContent = '';
      return;
    }

    const { params, label } = barsQuery();
    const requestId = (state.barsRequestId ?? 0) + 1;
    state.barsRequestId = requestId;
    try {
      const bars = await api(`/api/bars?${params}`);
      if (requestId !== state.barsRequestId) return;
      state.bars = bars;
      renderBarsChart();
      const barsRangeEl = $('bars-range');
      if (barsRangeEl) {
        barsRangeEl.textContent =
          label ??
          (bars.since && bars.until ? `${fmtRangeTime(bars.since)} – ${fmtRangeTime(bars.until)}` : '');
      }
    } catch (error) {
      console.error('Failed to load bars', error);
    }
  }

  async function loadCharts() {
    // 没选机器时，所有面板都没有样本可统计
    if (!state.selected.size) {
      state.requestId = (state.requestId ?? 0) + 1; // 让进行中的旧请求失效
      state.barsRequestId = (state.barsRequestId ?? 0) + 1;
      state.bars = null;
      state.heatmap = null;
      state.profile = null;
      showChartEmpty('bars', $('chart-bars'), 'Select at least one machine');
      renderHeatmap(null, 'Select at least one machine');
      showChartEmpty('profile', $('chart-profile'), 'Select at least one machine');
      $('bars-range').textContent = '';
      return;
    }

    // State breakdown = 日期范围 + 机器选择 + 热力图选中行/列
    const barsQueryInfo = barsQuery();
    const barsParams = barsQueryInfo.params;

    // 热力图与剖面跟随 Date range 与 Machines selected（未选日期 = 全部历史）
    const heatmapParams = chartParams();

    const requestId = (state.requestId ?? 0) + 1;
    state.requestId = requestId;

    try {
      const [bars, heatmap] = await Promise.all([
        api(`/api/bars?${barsParams}`),
        api(`/api/heatmap?${heatmapParams}`),
      ]);

      if (requestId !== state.requestId) return; // 只渲染最新一次请求

      state.bars = bars;
      renderBarsChart(); // 无论选择什么，都展示全部机器的状态占比

      // 右上角：热力图选中行/列时显示该范围，否则显示实际时段
      const barsRangeEl = $('bars-range');
      if (barsRangeEl) {
        barsRangeEl.textContent =
          barsQueryInfo.label ??
          (bars.since && bars.until ? `${fmtRangeTime(bars.since)} – ${fmtRangeTime(bars.until)}` : '');
      }

      if (heatmap) {
        state.heatmap = heatmap;
        renderHeatmap(heatmap);
        await refreshProfile();
      } else {
        state.heatmap = null;
        showChartEmpty('profile', $('chart-profile'), 'No data yet (waiting for polls)');
      }
    } catch (error) {
      console.error('Failed to load charts', error);
      $('db-badge').textContent = `Load failed: ${error.message}`;
      $('db-badge').className = 'badge error';
    }
  }

  /* ---------------- 数据刷新 ---------------- */

  async function loadState() {
    const data = await api('/api/state');
    state.meta = data.meta;
    state.machines = data.machines ?? [];
    state.latest = data.latest ?? [];

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

  async function refreshAll() {
    if (refreshing) return;
    refreshing = true;
    try {
      await loadState();
      await loadCharts();
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
    await refreshAll();
    setInterval(tick, 1000);
  }

  init();
})();
