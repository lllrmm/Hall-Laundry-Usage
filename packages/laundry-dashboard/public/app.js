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

  const RANGES = [
    ['1h', '1 hour'],
    ['6h', '6 hours'],
    ['24h', '24 hours'],
    ['7d', '7 days'],
    ['30d', '30 days'],
    ['all', 'All'],
  ];

  const HOURLY_HINT = 'Taller bar = easier to find a free machine';

  const state = {
    range: '24h',
    selected: new Set(),
    machines: [],
    latest: [],
    meta: null,
    series: null,
    bars: null,
    hourly: null,
    charts: { trend: null, bars: null, hourly: null },
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

  function renderRangeChips() {
    const box = $('ranges');
    box.innerHTML = '';
    for (const [value, label] of RANGES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `chip plain${state.range === value ? ' active' : ''}`;
      button.textContent = label;
      button.onclick = () => {
        if (state.range === value) return;
        state.range = value;
        renderRangeChips();
        loadCharts();
      };
      box.appendChild(button);
    }
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

  function renderTrendChart(series) {
    const container = $('chart-trend');
    const buckets = series?.buckets ?? [];

    if (!buckets.length) {
      $('trend-hint').textContent = '';
      showChartEmpty('trend', container, 'No data yet (waiting for polls)');
      return;
    }

    const colors = chartColors();
    const compact = container.clientWidth > 0 && container.clientWidth < 520;
    const byKind = series.totalsByKind ?? {};

    $('trend-hint').textContent = `from ${fmtDateTime(series.since)} · ${
      series.bucketSeconds >= 60
        ? `${Math.round(series.bucketSeconds / 60)} min`
        : `${series.bucketSeconds} s`
    }/point · ${buckets.length} points`;

    const options = baseChartOptions(colors, compact);
    options.plugins.tooltip.callbacks = {
      label: (item) => `${item.dataset.label}: ${item.formattedValue}`,
    };
    options.scales = {
      x: {
        ticks: {
          color: colors.muted,
          font: chartFont(compact ? 9 : 10),
          maxTicksLimit: compact ? 4 : 6,
          maxRotation: 0,
          autoSkip: true,
        },
        grid: { color: colors.grid },
        border: { color: colors.grid },
      },
      y: {
        beginAtZero: true,
        ticks: { color: colors.muted, font: chartFont(compact ? 9 : 10), precision: 0 },
        grid: { color: colors.grid },
        border: { color: colors.grid },
      },
    };

    mountChart('trend', container, {
      type: 'line',
      data: {
        labels: buckets.map((iso) => fmtAxisTime(iso, series.bucketSeconds)),
        datasets: [
          {
            label: 'Washers in use',
            data: byKind.washer?.inUse ?? [],
            borderColor: colors.washer,
            backgroundColor: colors.washer,
            pointRadius: 0,
            pointHoverRadius: 3,
            borderWidth: 2,
            tension: 0.25,
          },
          {
            label: 'Dryers in use',
            data: byKind.dryer?.inUse ?? [],
            borderColor: colors.dryer,
            backgroundColor: colors.dryer,
            pointRadius: 0,
            pointHoverRadius: 3,
            borderWidth: 2,
            tension: 0.25,
          },
        ],
      },
      options,
    });
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

  function renderHourlyChart(hourly) {
    const container = $('chart-hourly');
    const hours = hourly?.hours ?? [];
    const hint = $('hourly-hint');
    const withData = hours.filter((entry) => entry.freeRatio !== null);

    if (!withData.length) {
      if (hint) hint.textContent = HOURLY_HINT;
      showChartEmpty('hourly', container, 'No data yet (waiting for polls)');
      return;
    }

    const colors = chartColors();
    const compact = container.clientWidth > 0 && container.clientWidth < 520;
    const best = withData.reduce((a, b) => (b.freeRatio > a.freeRatio ? b : a), withData[0]);

    if (hint) {
      hint.textContent = `Best time ${pad2(best.hour)}:00 (${Math.round(best.freeRatio * 100)}% free)`;
    }

    const options = baseChartOptions(colors, compact);
    options.plugins.legend.display = false;
    options.interaction = { mode: 'index', intersect: false };
    options.plugins.tooltip.callbacks = {
      title: (items) => items[0]?.label ?? '',
      label: (item) => (item.raw === null ? 'No data' : `Free: ${item.formattedValue}%`),
    };
    options.scales = {
      x: {
        ticks: {
          color: colors.muted,
          font: chartFont(9),
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: compact ? 8 : 12,
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

    mountChart('hourly', container, {
      type: 'bar',
      data: {
        labels: hours.map((entry) => `${pad2(entry.hour)}:00`),
        datasets: [
          {
            label: 'Free rate',
            data: hours.map((entry) => (entry.freeRatio === null ? null : round1(entry.freeRatio * 100))),
            backgroundColor: hours.map((entry) =>
              entry.hour === best.hour ? colors.freeStrong : colors.free,
            ),
            borderRadius: 3,
            borderWidth: 0,
            maxBarThickness: compact ? 12 : 26,
          },
        ],
      },
      options,
    });
  }

  /* ---------------- 图表数据装载 ---------------- */

  async function loadCharts() {
    const hasSelection = state.selected.size > 0;

    const params = new URLSearchParams({
      since: state.range,
      machines: [...state.selected].join(','),
    });
    // State breakdown 只跟时间范围走，始终展示所有机器（不带 machines 过滤）
    const barsParams = new URLSearchParams({ since: state.range });

    const requestId = (state.requestId ?? 0) + 1;
    state.requestId = requestId;

    if (!hasSelection) {
      $('trend-hint').textContent = 'No machines selected';
      showChartEmpty('trend', $('chart-trend'), 'Select at least one machine');
      showChartEmpty('hourly', $('chart-hourly'), 'Select at least one machine');
    }

    try {
      const [bars, series, hourly] = await Promise.all([
        api(`/api/bars?${barsParams}`),
        hasSelection ? api(`/api/series?${params}`) : Promise.resolve(null),
        hasSelection ? api(`/api/hourly?${params}`) : Promise.resolve(null),
      ]);

      if (requestId !== state.requestId) return; // 只渲染最新一次请求

      state.bars = bars;
      renderBarsChart(); // 无论选择什么，都展示全部机器的状态占比

      if (series) {
        state.series = series;
        renderTrendChart(series);
      } else {
        state.series = null;
      }

      if (hourly) {
        state.hourly = hourly;
        renderHourlyChart(hourly);
      } else {
        state.hourly = null;
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
    if (state.series) renderTrendChart(state.series);
    if (state.bars) renderBarsChart();
    if (state.hourly) renderHourlyChart(state.hourly);
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

    $('auto').addEventListener('change', (event) => {
      state.auto = event.target.checked;
      state.countdown = state.refreshSeconds;
      $('auto-countdown').textContent = state.auto ? `${state.countdown}s` : '';
    });

    window.addEventListener(
      'resize',
      debounce(() => {
        // 容器宽度变化会影响紧凑模式（刻度密度等），按新宽度重建图表
        if (state.series) renderTrendChart(state.series);
        if (state.bars) renderBarsChart();
        if (state.hourly) renderHourlyChart(state.hourly);
      }, 250),
    );

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshAll();
    });
  }

  async function init() {
    renderRangeChips();
    applyTheme(readThemeMode(), { redraw: false });
    watchSystemTheme();
    bindEvents();
    await refreshAll();
    setInterval(tick, 1000);
  }

  init();
})();
