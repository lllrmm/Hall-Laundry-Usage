/* 洗衣房看板前端（无框架，直接 SVG 画图） */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

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

  const state = {
    range: '24h',
    selected: new Set(),
    machines: [],
    latest: [],
    meta: null,
    series: null,
    bars: null,
    hourly: null,
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

  function fmtTickTime(iso) {
    const d = new Date(iso);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) continue;
      node.setAttribute(key, String(value));
    }
    for (const child of children) node.appendChild(child);
    return node;
  }

  function svgText(content, attrs = {}) {
    const node = el('text', attrs);
    node.textContent = content;
    return node;
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

  function renderEmpty(container, message) {
    container.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = message;
    container.appendChild(div);
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

      let pollText = '—';
      if (meta.lastPoll) {
        const ok = meta.lastPoll.ok;
        pollText = `${ok ? 'ok' : 'failed'} · ${meta.lastPoll.durationMs}ms`;
        if (!ok && meta.lastPoll.errorCode) pollText += ` · ${meta.lastPoll.errorCode}`;
        if (meta.pollCount) pollText += ` · ${meta.pollCount} polls`;
      }
      $('poll-state').textContent = pollText;
      $('latest-time').textContent = meta.lastObservedAt
        ? `Data time ${fmtDateTime(meta.lastObservedAt)}`
        : '';

      if (meta.lastPoll && meta.lastPoll.finishedAt) {
        state.refreshSeconds = state.refreshSeconds || 30;
      }
    }

    $('footer-time').textContent = fmtClock(new Date().toISOString());
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

  /* ---------------- 图表：折线 ---------------- */

  function drawLineChart(container, options) {
    const width = Math.max(280, container.clientWidth || 900);
    const compact = width < 520;
    const height = options.height ?? (compact ? 200 : 260);
    const margin = compact
      ? { top: 12, right: 10, bottom: 22, left: 34 }
      : { top: 14, right: 18, bottom: 26, left: 44 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const { buckets, lines } = options;
    const n = buckets.length;

    container.innerHTML = '';
    if (!n) {
      renderEmpty(container, 'No data yet (waiting for polls)');
      return;
    }

    const yMax = Math.max(1, options.yMax ?? 1);
    const xs = (index) => (n === 1 ? margin.left + plotW / 2 : margin.left + (index / (n - 1)) * plotW);
    const yFor = (value) => margin.top + plotH - (Math.min(Math.max(value, 0), yMax) / yMax) * plotH;

    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });

    const yTicks = compact ? 3 : 4;
    for (let t = 0; t <= yTicks; t += 1) {
      const value = (yMax / yTicks) * t;
      const y = yFor(value);
      svg.appendChild(el('line', { x1: margin.left, x2: margin.left + plotW, y1: y, y2: y, class: 'grid-line' }));
      svg.appendChild(svgText(options.yFormat(value), {
        x: margin.left - 8,
        y: y + 4,
        'text-anchor': 'end',
        class: 'axis-text',
      }));
    }

    const xLabelCount = Math.min(compact ? 4 : 6, n);
    for (let k = 0; k < xLabelCount; k += 1) {
      const index = Math.round((k / Math.max(1, xLabelCount - 1)) * (n - 1));
      svg.appendChild(svgText(fmtAxisTime(buckets[index], options.bucketSeconds), {
        x: xs(index),
        y: height - 8,
        'text-anchor': k === 0 ? 'start' : k === xLabelCount - 1 ? 'end' : 'middle',
        class: 'axis-text',
      }));
    }

    for (const line of lines) {
      let path = '';
      let open = false;
      for (let i = 0; i < n; i += 1) {
        const value = line.values[i];
        if (value === null || value === undefined) {
          open = false;
          continue;
        }
        const x = xs(i).toFixed(1);
        const y = yFor(value).toFixed(1);
        if (!open) {
          path += `M${x},${y}`;
          open = true;
        } else if (line.step) {
          path += `H${x}V${y}`;
        } else {
          path += `L${x},${y}`;
        }
      }
      if (path) svg.appendChild(el('path', { d: path, class: 'series-line', stroke: line.color }));

      if (n <= 80) {
        for (let i = 0; i < n; i += 1) {
          const value = line.values[i];
          if (value === null || value === undefined) continue;
          svg.appendChild(el('circle', { cx: xs(i), cy: yFor(value), r: 2.4, fill: line.color, class: 'point' }));
        }
      }
    }

    container.appendChild(svg);
    attachHover(container, svg, {
      buckets,
      lines,
      xs,
      width,
      height,
      margin,
      plotW,
      plotH,
      yFormat: options.yFormat,
      bucketSeconds: options.bucketSeconds,
    });
  }

  function attachHover(container, svg, ctx) {
    const tooltip = document.createElement('div');
    tooltip.className = 'tooltip';
    container.appendChild(tooltip);

    const hoverLine = el('line', {
      y1: ctx.margin.top,
      y2: ctx.margin.top + ctx.plotH,
      class: 'hover-line',
      opacity: 0,
    });
    const overlay = el('rect', {
      x: ctx.margin.left,
      y: ctx.margin.top,
      width: ctx.plotW,
      height: ctx.plotH,
      fill: 'transparent',
      style: 'cursor: crosshair; touch-action: pan-y',
    });
    svg.appendChild(hoverLine);
    svg.appendChild(overlay);

    const count = ctx.buckets.length;

    const show = (event) => {
      const rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      const scale = ctx.width / rect.width;
      const localX = (event.clientX - rect.left) * scale;
      const ratio = (localX - ctx.margin.left) / ctx.plotW;
      const index = Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));

      const x = ctx.xs(index);
      hoverLine.setAttribute('x1', x);
      hoverLine.setAttribute('x2', x);
      hoverLine.setAttribute('opacity', 1);

      const rows = ctx.lines
        .filter((line) => line.values[index] !== null && line.values[index] !== undefined)
        .map((line) => {
          const value = line.values[index];
          const shown = line.valueFormat ? line.valueFormat(value) : String(value);
          return `<div class="t-row"><span class="t-dot" style="background:${line.color}"></span>${line.label}: <b>${shown}</b></div>`;
        })
        .join('');

      tooltip.innerHTML = `<div class="t-title">${fmtTickTime(ctx.buckets[index])}</div>${rows || '<div class="t-row">No data</div>'}`;

      const containerRect = container.getBoundingClientRect();
      const cssX = (x / scale);
      tooltip.style.left = `${Math.max(50, Math.min(cssX, containerRect.width - 50))}px`;
      tooltip.style.top = `${ctx.margin.top + 30}px`;
      tooltip.classList.add('visible');
    };

    const hide = () => {
      tooltip.classList.remove('visible');
      hoverLine.setAttribute('opacity', 0);
    };

    overlay.addEventListener('mousemove', show);
    overlay.addEventListener('mouseleave', hide);

    // 触摸屏：按住/拖动显示数值，抬手 2 秒后自动隐藏
    let hideTimer = null;
    const showTouch = (event) => {
      const touch = event.touches?.[0] ?? event.changedTouches?.[0];
      if (!touch) return;
      clearTimeout(hideTimer);
      show({ clientX: touch.clientX, clientY: touch.clientY });
    };
    overlay.addEventListener('touchstart', showTouch, { passive: true });
    overlay.addEventListener('touchmove', showTouch, { passive: true });
    overlay.addEventListener(
      'touchend',
      () => {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, 2000);
      },
      { passive: true },
    );
    overlay.addEventListener('touchcancel', hide, { passive: true });
  }

  /* ---------------- 图表：堆叠柱状 ---------------- */

  /** "UG4 Dryer (51)" → "Dryer (51)"，窄屏标签用短名 */
  function shortMachineName(name) {
    return String(name ?? '').replace(/^UG\d+\s+/i, '');
  }

  function drawStackedBars(container, rows) {
    const width = Math.max(300, container.clientWidth || 900);
    const compact = width < 520;
    container.innerHTML = '';
    if (!rows.length) {
      renderEmpty(container, 'No data yet (waiting for polls)');
      return;
    }

    const rowHeight = compact ? 22 : 26;
    const rowGap = compact ? 6 : 8;
    const labelWidth = compact ? 84 : 132;
    const valueWidth = compact ? 56 : 96;
    const height = rows.length * (rowHeight + rowGap) + 32;
    const plotW = Math.max(80, width - labelWidth - valueWidth - 8);

    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });

    const colorFree = cssVar('--free', '#22c55e');
    const colorBusy = cssVar('--busy', '#f59e0b');
    const colorOff = cssVar('--off', '#94a3b8');

    const legendY = height - 12;
    // 堆叠顺序：In use → Free → Unavailable
    const legend = [
      ['In use', colorBusy],
      ['Free', colorFree],
      ['Unavailable', colorOff],
    ];
    let legendX = labelWidth;
    for (const [label, color] of legend) {
      svg.appendChild(el('rect', { x: legendX, y: legendY - 8, width: 10, height: 10, rx: 2, fill: color }));
      svg.appendChild(svgText(label, { x: legendX + 14, y: legendY + 1, class: 'bar-value' }));
      legendX += 14 + label.length * (compact ? 7 : 12) + (compact ? 12 : 18);
    }

    rows.forEach((row, index) => {
      const y = index * (rowHeight + rowGap);
      svg.appendChild(svgText(compact ? shortMachineName(row.name) : row.name, {
        x: labelWidth - 10,
        y: y + rowHeight / 2 + 4,
        'text-anchor': 'end',
        class: 'bar-label',
      }));

      svg.appendChild(el('rect', {
        x: labelWidth,
        y,
        width: plotW,
        height: rowHeight,
        rx: 5,
        fill: cssVar('--track', '#f1f5f9'),
      }));

      const segments = [
        [row.inUseRatio, colorBusy],
        [row.availableRatio, colorFree],
        [row.unavailableRatio, colorOff],
      ];
      let offset = 0;
      const segmentGroup = el('g', {});
      for (const [ratio, color] of segments) {
        const w = Math.max(0, (ratio ?? 0) * plotW);
        if (w > 0.4) {
          segmentGroup.appendChild(el('rect', {
            x: labelWidth + offset,
            y,
            width: w,
            height: rowHeight,
            fill: color,
          }));
        }
        offset += w;
      }
      const title = el('title', {});
      title.textContent = `${row.name}: free ${(row.availableRatio * 100).toFixed(1)}%, in use ${(row.inUseRatio * 100).toFixed(1)}%, unavailable ${(row.unavailableRatio * 100).toFixed(1)}% (${row.samples} samples)`;
      segmentGroup.appendChild(title);
      svg.appendChild(segmentGroup);

      svg.appendChild(svgText(`${Math.round(row.availableRatio * 100)}%${compact ? '' : ' free'}`, {
        x: labelWidth + plotW + 8,
        y: y + rowHeight / 2 + 4,
        class: 'bar-value',
      }));
    });

    container.appendChild(svg);
  }

  /* ---------------- 图表：按小时 ---------------- */

  function drawHourlyBars(container, hours) {
    const width = Math.max(300, container.clientWidth || 900);
    const compact = width < 520;
    const height = compact ? 190 : 240;
    const margin = compact
      ? { top: 12, right: 8, bottom: 22, left: 32 }
      : { top: 14, right: 12, bottom: 26, left: 44 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    container.innerHTML = '';
    const withData = hours.filter((entry) => entry.freeRatio !== null);
    if (!withData.length) {
      renderEmpty(container, 'No data yet (waiting for polls)');
      return;
    }

    const maxRatio = Math.max(...withData.map((entry) => entry.freeRatio));
    const bestHour = withData.reduce((best, entry) => (entry.freeRatio > best.freeRatio ? entry : best), withData[0]);

    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });

    for (let t = 0; t <= 4; t += 1) {
      const ratio = t / 4;
      const y = margin.top + plotH - ratio * plotH;
      svg.appendChild(el('line', { x1: margin.left, x2: margin.left + plotW, y1: y, y2: y, class: 'grid-line' }));
      svg.appendChild(svgText(`${Math.round(ratio * 100)}%`, {
        x: margin.left - 8,
        y: y + 4,
        'text-anchor': 'end',
        class: 'axis-text',
      }));
    }

    const slot = plotW / 24;
    const barWidth = Math.max(6, slot * 0.62);

    hours.forEach((entry, index) => {
      const x = margin.left + slot * index + (slot - barWidth) / 2;
      if (entry.freeRatio === null) {
        svg.appendChild(svgText('·', { x: x + barWidth / 2, y: margin.top + plotH - 4, 'text-anchor': 'middle', class: 'hour-label' }));
        return;
      }
      const h = Math.max(2, entry.freeRatio * plotH);
      const y = margin.top + plotH - h;
      const isBest = entry.hour === bestHour.hour;
      const bar = el('rect', {
        x,
        y,
        width: barWidth,
        height: h,
        rx: 3,
        fill: isBest ? cssVar('--free-strong', '#15803d') : cssVar('--free', '#22c55e'),
        opacity: entry.freeRatio === 0 ? 0.35 : 0.75,
      });
      const title = el('title', {});
      title.textContent = `${pad2(entry.hour)}:00 free rate ${(entry.freeRatio * 100).toFixed(1)}% (${entry.samples} samples)`;
      bar.appendChild(title);
      svg.appendChild(bar);

      if (index % (compact ? 6 : 3) === 0) {
        svg.appendChild(svgText(`${pad2(entry.hour)}`, {
          x: x + barWidth / 2,
          y: height - 8,
          'text-anchor': 'middle',
          class: 'hour-label',
        }));
      }
    });

    const bestLabel = compact
      ? `Best ${pad2(bestHour.hour)}:00`
      : `Best time ${pad2(bestHour.hour)}:00 (${Math.round(bestHour.freeRatio * 100)}% free)`;
    svg.appendChild(svgText(bestLabel, {
      x: margin.left + plotW,
      y: 10,
      'text-anchor': 'end',
      class: 'axis-text',
    }));

    container.appendChild(svg);
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
      renderEmpty($('chart-trend'), 'Select at least one machine');
      renderEmpty($('chart-hourly'), 'Select at least one machine');
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
        renderTrend(series);
      } else {
        state.series = null;
      }

      if (hourly) {
        state.hourly = hourly;
        drawHourlyBars($('chart-hourly'), hourly.hours ?? []);
      } else {
        state.hourly = null;
      }
    } catch (error) {
      console.error('Failed to load charts', error);
      $('db-badge').textContent = `Load failed: ${error.message}`;
      $('db-badge').className = 'badge error';
    }
  }

  /** 用缓存的数据重画"状态占比"柱状图（主题切换/窗口缩放时复用） */
  function renderBarsChart() {
    drawStackedBars($('chart-bars'), (state.bars?.rows ?? []).map((row) => ({
      name: row.name,
      samples: row.samples,
      availableRatio: row.availableRatio,
      inUseRatio: row.inUseRatio,
      unavailableRatio: row.unavailableRatio,
    })));
  }

  function renderTrend(series) {
    // 按机型各画一条线：washer / dryer 的在用台数
    const byKind = series.totalsByKind ?? {};
    const washerInUse = byKind.washer?.inUse ?? [];
    const dryerInUse = byKind.dryer?.inUse ?? [];

    const values = [...washerInUse, ...dryerInUse].filter((value) => value !== null);
    const peak = values.length ? Math.max(...values) : 0;
    const yMax = Math.max(1, Math.ceil(peak));

    $('trend-hint').textContent = series.buckets?.length
      ? `from ${fmtDateTime(series.since)} · ${series.bucketSeconds >= 60 ? `${Math.round(series.bucketSeconds / 60)} min` : `${series.bucketSeconds} s`}/point · ${series.buckets.length} points`
      : '';

    drawLineChart($('chart-trend'), {
      buckets: series.buckets ?? [],
      bucketSeconds: series.bucketSeconds,
      yMax,
      yFormat: (value) => `${Math.round(value)}`,
      lines: [
        {
          label: 'Washers in use',
          color: cssVar('--chart-washer', '#0891b2'),
          values: washerInUse,
          step: false,
          valueFormat: (value) => `${value.toFixed(1)}`,
        },
        {
          label: 'Dryers in use',
          color: cssVar('--chart-dryer', '#f59e0b'),
          values: dryerInUse,
          step: false,
          valueFormat: (value) => `${value.toFixed(1)}`,
        },
      ],
    });
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
    if (state.series) renderTrend(state.series);
    if (state.bars) renderBarsChart();
    if (state.hourly) drawHourlyBars($('chart-hourly'), state.hourly.hours ?? []);
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
        if (state.series) renderTrend(state.series);
        if (state.bars) renderBarsChart();
        if (state.hourly) drawHourlyBars($('chart-hourly'), state.hourly.hours ?? []);
      }, 200),
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
