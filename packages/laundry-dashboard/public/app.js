/* 洗衣房看板前端（无框架，直接 SVG 画图） */
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const COLORS = [
    '#1b4dc1', '#e11d48', '#0d9488', '#7c3aed', '#c2410c', '#0891b2',
    '#4d7c0f', '#be185d', '#4338ca', '#a16207', '#0f766e', '#9d174d',
  ];

  const RANGES = [
    ['1h', '1 小时'],
    ['6h', '6 小时'],
    ['24h', '24 小时'],
    ['7d', '7 天'],
    ['30d', '30 天'],
    ['all', '全部'],
  ];

  const PRESETS = [
    ['all', '全部'],
    ['washer', '仅洗衣机'],
    ['dryer', '仅烘干机'],
    ['free', '当前空闲'],
    ['busy', '当前在用'],
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
    colorOf: new Map(),
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
    if (seconds < 60) return `${seconds} 秒前`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
    return `${Math.floor(seconds / 86400)} 天前`;
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
    if (!state.colorOf.has(machineId)) {
      state.colorOf.set(machineId, COLORS[state.colorOf.size % COLORS.length]);
    }
    return state.colorOf.get(machineId);
  }

  function stateClass(machine) {
    if (machine.available) return 'free';
    if (machine.state === 'in_use') return 'busy';
    return 'off';
  }

  function stateLabel(machine) {
    if (machine.available) return '空闲';
    if (machine.state === 'in_use') return '在用';
    if (machine.state === 'offline') return '离线';
    if (machine.status === 'maintenance') return '维护中';
    if (machine.status === 'on_hold') return '暂停';
    if (machine.status === 'disabled') return '停用';
    return machine.state || '不可用';
  }

  function machineSubText(machine) {
    if (machine.state === 'in_use') {
      if (machine.remainingSeconds !== null && machine.remainingSeconds !== undefined) {
        return machine.remainingSeconds > 0
          ? `预计剩 ${fmtDuration(machine.remainingSeconds)}`
          : `已到点 ${fmtDuration(-machine.remainingSeconds)}，可能未取衣`;
      }
      return `已运行 ${fmtDuration(machine.elapsedSeconds)}`;
    }
    if (machine.available) return machine.kind === 'dryer' ? '可烘干' : '可洗涤';
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
      badge.textContent = '等待数据';
      badge.className = 'badge warn';
    } else if (meta.lastPoll && !meta.lastPoll.ok) {
      badge.textContent = `采集失败 ${meta.lastPoll.errorCode ?? ''}`;
      badge.className = 'badge error';
    } else {
      badge.textContent = '运行中';
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
        pollText = `${ok ? '成功' : '失败'} · ${meta.lastPoll.durationMs}ms`;
        if (!ok && meta.lastPoll.errorCode) pollText += ` · ${meta.lastPoll.errorCode}`;
        if (meta.pollCount) pollText += ` · 共 ${meta.pollCount} 次`;
      }
      $('poll-state').textContent = pollText;
      $('db-path').textContent = meta.database;
      $('db-path').title = meta.database;
      $('latest-time').textContent = meta.lastObservedAt
        ? `数据时间 ${fmtDateTime(meta.lastObservedAt)}`
        : '';

      if (meta.lastPoll && meta.lastPoll.finishedAt) {
        state.refreshSeconds = state.refreshSeconds || 30;
      }
    }

    $('footer-time').textContent = fmtClock(new Date().toISOString());
  }

  function renderMachineGrid() {
    const grid = $('machine-grid');
    grid.innerHTML = '';

    if (!state.latest.length) {
      $('no-data').hidden = false;
      return;
    }
    $('no-data').hidden = true;

    for (const machine of state.latest) {
      const div = document.createElement('div');
      div.className = `machine ${stateClass(machine)}`;

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = machine.name;
      name.title = machine.name;

      const st = document.createElement('div');
      st.className = 'st';
      st.innerHTML = `<b>${stateLabel(machine)}</b>`;

      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = machineSubText(machine);

      div.append(name, st, sub);
      div.title = `${machine.name}\n观测时间：${fmtDateTime(machine.observedAt)}`;
      grid.appendChild(div);
    }
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

  function applyPreset(preset) {
    const all = state.machines.map((machine) => machine.id);
    const byKind = (kind) => state.machines.filter((machine) => machine.kind === kind).map((machine) => machine.id);
    const current = new Map(state.latest.map((machine) => [machine.id, machine]));

    if (preset === 'all') state.selected = new Set(all);
    else if (preset === 'washer') state.selected = new Set(byKind('washer'));
    else if (preset === 'dryer') state.selected = new Set(byKind('dryer'));
    else if (preset === 'free') state.selected = new Set(all.filter((id) => current.get(id)?.available));
    else if (preset === 'busy') state.selected = new Set(all.filter((id) => current.get(id)?.state === 'in_use'));

    renderMachineChips();
    loadCharts();
  }

  function renderPresetChips() {
    const box = $('presets');
    box.innerHTML = '';
    for (const [value, label] of PRESETS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip plain';
      button.textContent = label;
      button.onclick = () => applyPreset(value);
      box.appendChild(button);
    }
  }

  function renderMachineChips() {
    const box = $('machine-chips');
    box.innerHTML = '';

    const groups = [
      ['washer', '洗衣机'],
      ['dryer', '烘干机'],
    ];

    for (const [kind, label] of groups) {
      const list = state.machines.filter((machine) => machine.kind === kind);
      if (!list.length) continue;

      const groupLabel = document.createElement('span');
      groupLabel.className = 'hint';
      groupLabel.style.alignSelf = 'center';
      groupLabel.textContent = label;
      box.appendChild(groupLabel);

      for (const machine of list) {
        const active = state.selected.has(machine.id);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `chip${active ? ' active' : ''}`;
        button.title = `点击${active ? '取消' : '选中'} ${machine.name}`;

        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = colorFor(machine.id);

        const text = document.createElement('span');
        text.textContent = machine.name.replace(/^UG\d\s*/, '');

        button.append(swatch, text);
        button.onclick = () => {
          if (state.selected.has(machine.id)) state.selected.delete(machine.id);
          else state.selected.add(machine.id);
          renderMachineChips();
          loadCharts();
        };
        box.appendChild(button);
      }
    }

    const count = $('selected-count');
    count.textContent = `已选 ${state.selected.size}/${state.machines.length} 台`;
  }

  /* ---------------- 图表：折线 ---------------- */

  function drawLineChart(container, options) {
    const width = Math.max(320, container.clientWidth || 900);
    const height = options.height ?? 260;
    const margin = { top: 14, right: 18, bottom: 26, left: 44 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const { buckets, lines } = options;
    const n = buckets.length;

    container.innerHTML = '';
    if (!n) {
      renderEmpty(container, '暂无数据（等待采集）');
      return;
    }

    const yMax = Math.max(1, options.yMax ?? 1);
    const xs = (index) => (n === 1 ? margin.left + plotW / 2 : margin.left + (index / (n - 1)) * plotW);
    const yFor = (value) => margin.top + plotH - (Math.min(Math.max(value, 0), yMax) / yMax) * plotH;

    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });

    const yTicks = 4;
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

    const xLabelCount = Math.min(6, n);
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
      style: 'cursor: crosshair',
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
          return `<div class="t-row"><span class="t-dot" style="background:${line.color}"></span>${line.label}：<b>${shown}</b></div>`;
        })
        .join('');

      tooltip.innerHTML = `<div class="t-title">${fmtTickTime(ctx.buckets[index])}</div>${rows || '<div class="t-row">无数据</div>'}`;

      const containerRect = container.getBoundingClientRect();
      const cssX = (x / scale);
      tooltip.style.left = `${Math.max(50, Math.min(cssX, containerRect.width - 50))}px`;
      tooltip.style.top = `${ctx.margin.top + 30}px`;
      tooltip.classList.add('visible');
    };

    overlay.addEventListener('mousemove', show);
    overlay.addEventListener('mouseleave', () => {
      tooltip.classList.remove('visible');
      hoverLine.setAttribute('opacity', 0);
    });
  }

  /* ---------------- 图表：堆叠柱状 ---------------- */

  function drawStackedBars(container, rows) {
    const width = Math.max(320, container.clientWidth || 900);
    container.innerHTML = '';
    if (!rows.length) {
      renderEmpty(container, '暂无数据（等待采集）');
      return;
    }

    const rowHeight = 26;
    const rowGap = 8;
    const labelWidth = 132;
    const valueWidth = 96;
    const height = rows.length * (rowHeight + rowGap) + 32;
    const plotW = Math.max(80, width - labelWidth - valueWidth - 8);

    const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' });

    const legendY = height - 12;
    const legend = [
      ['可用', '#22c55e'],
      ['在用', '#f59e0b'],
      ['不可用', '#94a3b8'],
    ];
    let legendX = labelWidth;
    for (const [label, color] of legend) {
      svg.appendChild(el('rect', { x: legendX, y: legendY - 8, width: 10, height: 10, rx: 2, fill: color }));
      svg.appendChild(svgText(label, { x: legendX + 14, y: legendY + 1, class: 'bar-value' }));
      legendX += 14 + label.length * 12 + 18;
    }

    rows.forEach((row, index) => {
      const y = index * (rowHeight + rowGap);
      svg.appendChild(svgText(row.name, {
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
        fill: '#f1f5f9',
      }));

      const segments = [
        [row.availableRatio, '#22c55e'],
        [row.inUseRatio, '#f59e0b'],
        [row.unavailableRatio, '#94a3b8'],
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
      title.textContent = `${row.name}：可用 ${(row.availableRatio * 100).toFixed(1)}%，在用 ${(row.inUseRatio * 100).toFixed(1)}%，不可用 ${(row.unavailableRatio * 100).toFixed(1)}%（${row.samples} 个采样）`;
      segmentGroup.appendChild(title);
      svg.appendChild(segmentGroup);

      svg.appendChild(svgText(`${Math.round(row.availableRatio * 100)}% 空闲`, {
        x: labelWidth + plotW + 8,
        y: y + rowHeight / 2 + 4,
        class: 'bar-value',
      }));
    });

    container.appendChild(svg);
  }

  /* ---------------- 图表：按小时 ---------------- */

  function drawHourlyBars(container, hours) {
    const width = Math.max(320, container.clientWidth || 900);
    const height = 240;
    const margin = { top: 14, right: 12, bottom: 26, left: 44 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    container.innerHTML = '';
    const withData = hours.filter((entry) => entry.freeRatio !== null);
    if (!withData.length) {
      renderEmpty(container, '暂无数据（等待采集）');
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
        fill: isBest ? '#15803d' : '#22c55e',
        opacity: entry.freeRatio === 0 ? 0.35 : 0.75,
      });
      const title = el('title', {});
      title.textContent = `${pad2(entry.hour)}:00 空闲率 ${(entry.freeRatio * 100).toFixed(1)}%（${entry.samples} 个采样）`;
      bar.appendChild(title);
      svg.appendChild(bar);

      if (index % 3 === 0) {
        svg.appendChild(svgText(`${pad2(entry.hour)}`, {
          x: x + barWidth / 2,
          y: height - 8,
          'text-anchor': 'middle',
          class: 'hour-label',
        }));
      }
    });

    svg.appendChild(svgText(`最佳时段 ${pad2(bestHour.hour)}:00（${Math.round(bestHour.freeRatio * 100)}% 空闲）`, {
      x: margin.left + plotW,
      y: 10,
      'text-anchor': 'end',
      class: 'axis-text',
    }));

    container.appendChild(svg);
  }

  /* ---------------- 图表数据装载 ---------------- */

  async function loadCharts() {
    if (!state.selected.size) {
      $('trend-hint').textContent = '未选择机器';
      renderEmpty($('chart-trend'), '请至少选择一台机器');
      renderEmpty($('chart-series'), '请至少选择一台机器');
      renderEmpty($('chart-bars'), '请至少选择一台机器');
      $('legend-series').innerHTML = '';
      return;
    }

    const params = new URLSearchParams({
      since: state.range,
      machines: [...state.selected].join(','),
    });

    const requestId = (state.requestId ?? 0) + 1;
    state.requestId = requestId;

    try {
      const [series, bars, hourly] = await Promise.all([
        api(`/api/series?${params}`),
        api(`/api/bars?${params}`),
        api(`/api/hourly?${params}`),
      ]);

      if (requestId !== state.requestId) return; // 只渲染最新一次请求

      state.series = series;
      state.bars = bars;
      state.hourly = hourly;

      renderTrend(series);
      renderSeriesChart(series);
      drawStackedBars($('chart-bars'), (bars.rows ?? []).map((row) => ({
        name: row.name,
        samples: row.samples,
        availableRatio: row.availableRatio,
        inUseRatio: row.inUseRatio,
        unavailableRatio: row.unavailableRatio,
      })));
      drawHourlyBars($('chart-hourly'), hourly.hours ?? []);
    } catch (error) {
      console.error('加载图表失败', error);
      $('db-badge').textContent = `加载失败: ${error.message}`;
      $('db-badge').className = 'badge error';
    }
  }

  function renderTrend(series) {
    const totals = series.totals ?? { available: [], inUse: [] };
    const machineCount = Math.max(1, ...(series.machines ?? []).length ? [series.machines.length] : [1]);
    const values = [...(totals.available ?? []), ...(totals.inUse ?? [])].filter((v) => v !== null);
    const yMax = Math.max(machineCount, Math.ceil(Math.max(1, ...values)));

    $('trend-hint').textContent = series.buckets?.length
      ? `${fmtDateTime(series.since)} 起 · ${series.bucketSeconds >= 60 ? `${Math.round(series.bucketSeconds / 60)} 分钟` : `${series.bucketSeconds} 秒`}/点 · ${series.buckets.length} 点`
      : '';

    drawLineChart($('chart-trend'), {
      buckets: series.buckets ?? [],
      bucketSeconds: series.bucketSeconds,
      yMax,
      yFormat: (value) => `${Math.round(value)}`,
      lines: [
        { label: '可用', color: '#22c55e', values: totals.available ?? [], step: false, valueFormat: (v) => `${v.toFixed(1)} 台` },
        { label: '在用', color: '#f59e0b', values: totals.inUse ?? [], step: false, valueFormat: (v) => `${v.toFixed(1)} 台` },
      ],
    });
  }

  function renderSeriesChart(series) {
    const machines = series.machines ?? [];
    const buckets = series.buckets ?? [];
    const bucketSeconds = series.bucketSeconds;

    $('series-hint').textContent = machines.length
      ? `${machines.length} 台机器 · 空闲率 = 该时段内处于 available 的采样占比`
      : '';

    const lines = machines.map((machine) => ({
      label: machine.name,
      color: colorFor(machine.id),
      values: (series.series[machine.id]?.availableRatio ?? []).map((ratio) => (ratio === null ? null : Math.round(ratio * 1000) / 10)),
      step: true,
      valueFormat: (value) => `${value.toFixed(0)}%`,
    }));

    drawLineChart($('chart-series'), {
      buckets,
      bucketSeconds,
      yMax: 100,
      yFormat: (value) => `${Math.round(value)}%`,
      lines,
    });

    const legend = $('legend-series');
    legend.innerHTML = '';
    for (const machine of machines) {
      const item = document.createElement('span');
      item.className = 'item';
      const line = document.createElement('span');
      line.className = 'line';
      line.style.background = colorFor(machine.id);
      item.append(line, document.createTextNode(machine.name));
      legend.appendChild(item);
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
      state.firstLoad = false;
      renderMachineChips();
    } else {
      // 新出现的机器默认加进选择（保持视图完整）
      let added = false;
      for (const machine of state.machines) {
        if (!state.colorOf.has(machine.id)) added = true;
      }
      if (added) renderMachineChips();
    }

    renderHeader();
    renderMachineGrid();
    updateSelectedCount();
  }

  function updateSelectedCount() {
    $('selected-count').textContent = `已选 ${state.selected.size}/${state.machines.length} 台`;
  }

  let refreshing = false;

  async function refreshAll() {
    if (refreshing) return;
    refreshing = true;
    try {
      await loadState();
      await loadCharts();
    } catch (error) {
      console.error('刷新失败', error);
      $('db-badge').textContent = `连接失败: ${error.message}`;
      $('db-badge').className = 'badge error';
    } finally {
      refreshing = false;
      state.countdown = state.refreshSeconds;
      $('auto-countdown').textContent = state.auto ? `${state.countdown}s` : '';
    }
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

    $('auto').addEventListener('change', (event) => {
      state.auto = event.target.checked;
      state.countdown = state.refreshSeconds;
      $('auto-countdown').textContent = state.auto ? `${state.countdown}s` : '';
    });

    window.addEventListener(
      'resize',
      debounce(() => {
        if (state.series) renderTrend(state.series);
        if (state.series) renderSeriesChart(state.series);
        if (state.bars) {
          drawStackedBars($('chart-bars'), (state.bars.rows ?? []).map((row) => ({
            name: row.name,
            samples: row.samples,
            availableRatio: row.availableRatio,
            inUseRatio: row.inUseRatio,
            unavailableRatio: row.unavailableRatio,
          })));
        }
        if (state.hourly) drawHourlyBars($('chart-hourly'), state.hourly.hours ?? []);
      }, 200),
    );

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshAll();
    });
  }

  async function init() {
    renderRangeChips();
    renderPresetChips();
    bindEvents();
    await refreshAll();
    setInterval(tick, 1000);
  }

  init();
})();
