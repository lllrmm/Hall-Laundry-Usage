/**
 * 前端渲染闭环测试：用 jsdom 真跑一遍 public/ 里的页面（含 Chart.js）。
 *
 * 说明：
 * - 本环境无法启动真实浏览器（沙箱禁止 Chromium 的命名管道），用 jsdom 做 DOM + 脚本级验证；
 * - jsdom 没有原生 Canvas 2D（原生 canvas 包在沙箱里装不了），这里用一个轻量 context stub
 *   让 Chart.js 能正常初始化，断言对象是 Chart 实例的数据/配置（真正的绘制由 Chart.js 负责）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { JSDOM, VirtualConsole } from 'jsdom';

import { normalizeResponse } from '../../laundry-machines/index.js';
import { MonitorDatabase } from '../../laundry-monitor/src/db.js';
import { createDashboardServer } from '../../laundry-dashboard/src/server.js';
import { createWebServer } from '../src/server.js';

const isBun = Boolean(process.versions.bun);
const T0 = Date.now() - 10 * 60 * 1000;

/** 最小 Canvas 2D 上下文：Chart.js 只要求这些方法可调用 */
function createContext2DStub(canvas) {
  const props = {};
  const noop = () => {};
  return new Proxy(props, {
    get(target, prop) {
      if (prop === 'canvas') return canvas;
      if (prop === 'measureText') {
        return (text) => ({
          width: String(text ?? '').length * 6,
          actualBoundingBoxAscent: 8,
          actualBoundingBoxDescent: 2,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: String(text ?? '').length * 6,
        });
      }
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => ({ addColorStop: noop });
      }
      if (prop === 'createPattern') return () => null;
      if (prop === 'getImageData') {
        // 限制尺寸，避免 jsdom 下拿不到布局尺寸时分配超大 buffer
        return (x, y, w, h) => {
          const width = Math.min(2048, Math.max(1, Math.round(Number.isFinite(w) ? w : 1)));
          const height = Math.min(2048, Math.max(1, Math.round(Number.isFinite(h) ? h : 1)));
          return { data: new Uint8ClampedArray(width * height * 4), width, height };
        };
      }
      if (prop === 'getLineDash') return () => [];
      if (prop === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      if (prop === 'isPointInPath' || prop === 'isPointInStroke') return () => false;
      if (prop in target) return target[prop];
      return noop;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

function machine(id, name, kind, state, serviceValue = null) {
  const value = serviceValue ?? (kind === 'dryer' ? 'dryer_machine' : 'washing_machine_without_powder');
  return {
    _id: id,
    status: 'enabled',
    state,
    name,
    service_type: {
      _id: kind === 'dryer' ? 'st-d' : 'st-w',
      machine_type: kind,
      value,
      label: value,
    },
    laundry_room_name: 'UG Hall IV',
  };
}

function buildFixtureDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-dashboard-dom-'));
  const file = path.join(dir, 'test.sqlite');
  const db = new MonitorDatabase(file, { journalMode: 'DELETE' });

  const states = [
    { dryer1: 'available', dryer2: 'available', washer1: 'available', washer2: 'available' },
    { dryer1: 'in_use', dryer2: 'available', washer1: 'available', washer2: 'available' },
    { dryer1: 'in_use', dryer2: 'in_use', washer1: 'available', washer2: 'available' },
    { dryer1: 'available', dryer2: 'available', washer1: 'available', washer2: 'available' },
  ];

  states.forEach((state, index) => {
    const now = T0 + index * 60_000;
    const status = normalizeResponse(
      {
        meta: { code: 200, message: 'Success' },
        data: {
          laundry_room_machines: [
            {
              laundry_room_name: 'UG Hall IV',
              machines: [
                machine('d1', 'UG4 Dryer (51)', 'dryer', state.dryer1),
                machine('d2', 'UG4 Dryer (52)', 'dryer', state.dryer2),
                machine('w1', 'UG4 Washer (01)', 'washer', state.washer1),
                machine('w2', 'UG4 Washer (05)', 'washer', state.washer2, 'washing_machine_with_powder'),
              ],
            },
          ],
        },
      },
      now,
    );
    db.recordSuccessfulPoll(status, { startedAt: new Date(now), finishedAt: new Date(now), durationMs: 50 });
  });

  db.close();
  return { dir, file };
}

function waitFor(check, { timeout = 8000, interval = 50, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let value = false;
      try {
        value = check();
      } catch {
        value = false;
      }
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error(`等待超时：${label}`));
      }
    }, interval);
  });
}

test('jsdom 渲染：状态卡片 + 三张 Chart.js 图表 + 筛选交互', { skip: isBun ? 'jsdom 测试仅在 node 下运行' : false }, async () => {
  const { dir, file } = buildFixtureDb();
  const app = createDashboardServer({
    config: {
      databasePath: file,
      // fixture 只造原始库：/api/days 走 raw 回退，也能验证前端在无序列库时的表现
      seriesDatabasePath: path.join(dir, 'missing-series.sqlite'),
      host: '127.0.0.1',
      port: 0,
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const errors = [];
  let dom = null;
  let web = null;

  try {
    const apiAddress = await app.listen(0, '127.0.0.1');
    const apiUrl = `http://127.0.0.1:${apiAddress.port}`;
    web = createWebServer({
      config: { host: '127.0.0.1', port: 0, apiTarget: apiUrl },
      logger: { info() {}, warn() {}, error() {} },
    });
    const webAddress = await web.listen(0, '127.0.0.1');
    const baseUrl = `http://127.0.0.1:${webAddress.port}`;

    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error) => {
      if (process.env.DEBUG_DOM) console.error('[jsdomError]', error);
      errors.push(error.message);
    });
    virtualConsole.on('error', (...args) => {
      if (process.env.DEBUG_DOM) console.error('[console.error]', ...args);
      errors.push(args.join(' '));
    });

    dom = await JSDOM.fromURL(`${baseUrl}/`, {
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        // jsdom 没有 fetch：桥接到 Node 的 fetch，并解析相对 URL
        window.fetch = (input, init) => globalThis.fetch(new URL(input, window.location.href), init);

        // 可控的系统深浅色
        const media = { matches: false, listeners: new Set() };
        window.__themeMedia = media;
        window.matchMedia = () => ({
          get matches() {
            return media.matches;
          },
          media: '(prefers-color-scheme: dark)',
          addEventListener: (type, listener) => {
            if (type === 'change') media.listeners.add(listener);
          },
          removeEventListener: (type, listener) => {
            media.listeners.delete(listener);
          },
        });

        // Chart.js 需要 ResizeObserver
        window.ResizeObserver = class {
          observe() {}
          unobserve() {}
          disconnect() {}
        };

        // jsdom 没有 Canvas 2D：stub 掉，让 Chart.js 能初始化
        window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
          if (type !== '2d') return null;
          if (!this.__ctx) this.__ctx = createContext2DStub(this);
          return this.__ctx;
        };
      },
    });

    const { document } = dom.window;
    await waitFor(() => document.readyState === 'complete', { label: '页面加载完成' });

    // config.js 的 ?api= 解析：GitHub Pages 等跨域部署依赖它（本地别名可避开 jsdom 的 window 方法调用怪癖）
    const resolvePageApiBase = dom.window.__resolveLaundryApiBase__;
    assert.equal(typeof resolvePageApiBase, 'function', 'config.js 应提供 API 解析');
    assert.equal(
      resolvePageApiBase(`?api=${encodeURIComponent(apiUrl)}`),
      apiUrl,
      '?api= 参数应解析为绝对 API 地址',
    );

    // 1) 当前状态卡片：4 台机器，分为 Washers / Dryers 两块
    await waitFor(() => document.querySelectorAll('.machine').length === 4, { label: '状态卡片渲染' });
    const cards = [...document.querySelectorAll('.machine')];
    assert.equal(cards.length, 4);
    assert.ok(cards.every((card) => card.classList.contains('free')), '最后一轮全部空闲，卡片应为 free');
    assert.match(document.getElementById('last-update').textContent, /\d{2}:\d{2}:\d{2}/);

    const machineGroups = [...document.querySelectorAll('#machine-grid .machine-group')];
    assert.equal(machineGroups.length, 2, 'Current status 分为 Washers / Dryers 两块');
    assert.deepEqual(machineGroups.map((group) => group.dataset.kind), ['washer', 'dryer']);
    assert.deepEqual(machineGroups.map((group) => group.querySelector('h3').textContent), ['Washers', 'Dryers']);
    assert.deepEqual(machineGroups.map((group) => group.querySelectorAll('.machine').length), [2, 2]);

    // Washers 的 detergent 标签独立成行，且在卡片最下方
    const powderBadges = [...document.querySelectorAll('.machine .powder')];
    assert.equal(powderBadges.length, 2, '两台洗衣机显示 detergent 标签');
    assert.equal(document.querySelectorAll('.machine-head .powder').length, 0, '标签不在机器名行内');
    assert.ok(
      powderBadges.every((badge) => badge.closest('.powder-line')),
      'detergent 标签在独立行',
    );
    assert.ok(
      powderBadges.every((badge) => {
        const card = badge.closest('.machine');
        return card.lastElementChild === badge.closest('.powder-line');
      }),
      'detergent 标签位于卡片最下方',
    );

    // 2) Chart.js 图表（State breakdown + 历史剖面）
    await waitFor(() => {
      const charts = dom.window.__laundryCharts;
      return charts?.bars && charts?.profile;
    }, { label: 'Chart.js 图表实例创建' });

    const charts = () => dom.window.__laundryCharts;

    // 关掉自动刷新计时器，避免测试中途的定时刷新干扰请求计数
    const autoBox = document.getElementById('auto');
    autoBox.checked = false;
    autoBox.dispatchEvent(new dom.window.Event('change'));

    // 记录之后的 /api/days 请求：只有 data range 变化 / 新选机器且缺数据时才应出现
    const dayRequests = [];
    const originalFetch = dom.window.fetch;
    dom.window.fetch = (input, init) => {
      const url = String(input);
      if (url.includes('/api/days')) dayRequests.push(url);
      return originalFetch(input, init);
    };

    for (const id of ['chart-bars', 'chart-profile']) {
      assert.ok(document.querySelector(`#${id} canvas`), `${id} 应渲染出 canvas`);
    }

    // 状态占比：横向堆叠柱，始终展示全部状态图例（没有样本的状态为 0）
    const bars = charts().bars;
    assert.equal(bars.config.type, 'bar');
    assert.equal(bars.options.indexAxis, 'y');
    assert.equal(bars.options.scales.x.stacked, true);
    assert.equal(bars.options.interaction.mode, 'index');
    assert.equal(bars.options.interaction.intersect, false);
    assert.equal(bars.options.interaction.axis, 'y', '横向柱状图 tooltip 必须按 y 轴定位行');
    assert.deepEqual(Array.from(bars.data.datasets, (dataset) => dataset.label), [
      'In use',
      'On hold',
      'Maintenance',
      'Offline',
      'Disabled',
      'Unknown',
      'Free',
    ]);
    assert.ok(
      bars.data.datasets.every((dataset) => dataset.data.every((value) => Number.isFinite(value))),
      '所有状态图例都有数据（无样本为 0）',
    );
    assert.equal(bars.data.labels.length, 4, '始终展示全部 4 台机器');
    assert.ok(bars.data.datasets[0].data.some((value) => value > 0), '烘干机应有 in use 占比');
    const barsRangeText = document.getElementById('bars-range').textContent;
    assert.equal(
      barsRangeText,
      'Mon–Sun · 00:00–23:59',
      '占比图右上角始终显示「星期 · 时段」（无时间筛选时为全天）',
    );

    // 热力图：Canvas 绘制（7 行 × 1440 分钟），表头 24 个小时刻度
    await waitFor(() => document.getElementById('heatmap-canvas')?.dataset.minutes === '1440', {
      label: '热力图 Canvas 渲染',
    });
    assert.ok(document.querySelector('#heatmap canvas'), '热力图应使用 canvas');
    assert.ok(!document.querySelector('#heatmap .heatmap-cell'), '热力图不再使用 DOM 格子');
    assert.deepEqual(
      [...document.querySelectorAll('#heatmap .heatmap-row-label')].map((node) => node.textContent),
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      '纵轴为周一到周日',
    );
    assert.equal(document.querySelectorAll('#heatmap .heatmap-hour').length, 24, '24 个小时表头');
    assert.equal(
      dom.window.getComputedStyle(document.getElementById('heatmap-hours')).height,
      '27px',
      '时间轴高度是原来的 1.5 倍（27px）',
    );
    assert.deepEqual(
      [...document.querySelectorAll('#heatmap .heatmap-hour')].map((node) => node.textContent),
      Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0')),
      '时间轴按整点显示 00–23',
    );
    assert.ok(
      [...document.querySelectorAll('h2')].some((node) => node.textContent === 'Usage heatmap'),
      '热力图标题为 Usage heatmap（不再带 weekday × minute）',
    );
    const heatmapHint = document.getElementById('heatmap-hint').textContent;
    assert.match(heatmapHint, /drag the top axis/, '热力图提示说明可拖动选择时段');
    assert.doesNotMatch(heatmapHint, /30-min steps/, '提示里不再写 30-min steps');
    assert.doesNotMatch(heatmapHint, /\d{2}-\d{2} \d{2}:\d{2}/, '提示里不再显示覆盖时段');
    assert.doesNotMatch(heatmapHint, /samples/, '提示里不再显示样本数');
    assert.ok(
      [...document.querySelectorAll('h2')].some((node) => node.textContent === 'Inspection'),
      '剖面标题为 Inspection',
    );

    // 顶部时间轴交互（拖选时段 / 单击选分钟）
    const axis = document.getElementById('heatmap-hours');
    const axisEvent = (type, minute) =>
      new dom.window.MouseEvent(type, { clientX: (minute / 1440) * 900, clientY: 5, bubbles: true });
    const clickAxis = (minute) => {
      axis.dispatchEvent(axisEvent('mousedown', minute));
      axis.dispatchEvent(axisEvent('mouseup', minute));
    };

    // 历史剖面：默认 1 分钟线图；点行 → 该周几 1 分钟线图；点分钟 → 该分钟 7 天柱状图
    await waitFor(() => charts().profile && charts().profile.data.datasets[0]?.data.length === 1440, {
      label: '默认剖面（1 分钟 × 1440 槽）',
    });
    assert.equal(charts().profile.config.type, 'line', '默认剖面用线图');
    assert.deepEqual(
      Array.from(charts().profile.data.datasets, (dataset) => dataset.label),
      ['Washers in use', 'Dryers in use'],
      '时间剖面按机型分两条线',
    );
    assert.equal(
      document.getElementById('profile-hint').textContent,
      'Mon–Sun',
      '首次进入时默认显示 Mon–Sun（不再显示 "1-min profile · 时段"）',
    );

    // 横轴刻度间距只能是 15 / 30 / 60 / 120 分钟（线性时间轴），且必须是整数分钟
    const xOptions = charts().profile.options.scales.x;
    const fakeAxis = { ticks: [] };
    xOptions.afterBuildTicks(fakeAxis);
    assert.ok(fakeAxis.ticks.length >= 10, '应生成覆盖全天的刻度');
    assert.ok(
      fakeAxis.ticks.every(
        (tick) => Number.isInteger(tick.value) && tick.value % xOptions.ticks.stepSize === 0,
      ),
      '刻度必须是整数分钟（不再出现 239.833… 这种小数）',
    );
    assert.equal(xOptions.type, 'linear', '横轴使用分钟线性轴');
    assert.ok(
      [15, 30, 60, 120].includes(xOptions.ticks.stepSize),
      `横轴刻度间距应为 15/30/60/120 分钟，实际 ${xOptions.ticks.stepSize}`,
    );
    assert.match(xOptions.ticks.callback(720), /^12:00$/, '刻度标签仍按 hh:mm 显示');

    // 热力图内部点击：只弹出标签显示信息，不改变选择
    const profileHintBefore = document.getElementById('profile-hint').textContent;
    const canvas = document.getElementById('heatmap-canvas');
    canvas.dispatchEvent(
      new dom.window.MouseEvent('click', { clientX: (720 / 1440) * 900, clientY: 30, bubbles: true }),
    );
    const tooltip = document.getElementById('heatmap-tooltip');
    assert.ok(tooltip.classList.contains('visible'), '点击热力图应弹出标签');
    assert.match(tooltip.textContent, /(usage \d+% · \d+ samples|no data)/, '标签应显示该点信息');
    assert.equal(document.getElementById('profile-hint').textContent, profileHintBefore, '点击不改变选择');
    assert.equal(document.querySelectorAll('#heatmap .heatmap-row-label.active').length, 0);

    const tueLabel = [...document.querySelectorAll('#heatmap .heatmap-row-label')].find(
      (node) => node.textContent === 'Tue',
    );
    tueLabel.click();
    await waitFor(
      () =>
        charts().profile &&
        charts().profile.data.datasets[0]?.data.length === 1440 &&
        document.getElementById('profile-hint').textContent === 'Tue',
      { label: '点击周几行显示该天的 5 分钟剖面' },
    );
    assert.equal(charts().profile.config.type, 'line', '选中行时剖面用线图');
    assert.ok(charts().profile.data.datasets[0].borderColor, '线图使用 borderColor');
    await waitFor(
      () => document.getElementById('bars-range').textContent === 'Tue · 00:00–23:59',
      { label: 'State breakdown 跟随选中的星期几' },
    );
    assert.ok(
      [...document.querySelectorAll('#heatmap .heatmap-row-label')].some(
        (node) => node.classList.contains('active') && node.textContent === 'Tue',
      ),
      '选中的周几行应高亮',
    );

    // 多选星期：Mon + Tue 同时勾选
    const findRow = (label) =>
      [...document.querySelectorAll('#heatmap .heatmap-row-label')].find(
        (node) => node.textContent === label,
      );
    findRow('Mon').click();
    await waitFor(
      () =>
        document.querySelectorAll('#heatmap .heatmap-row-label.active').length === 2 &&
        document.getElementById('profile-hint').textContent === 'Mon–Tue',
      { label: '同时勾选 Mon + Tue' },
    );
    await waitFor(
      () => document.getElementById('bars-range').textContent === 'Mon–Tue · 00:00–23:59',
      { label: 'State breakdown 跟随多选的星期（连续合并为 Mon–Tue）' },
    );

    // 互斥：已选星期时拖动时段 → 星期选择被清空
    const pad2 = (value) => String(value).padStart(2, '0');
    const hhmm = (minute) => `${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}`;
    const t0 = new Date(T0);
    const rawFrom = t0.getHours() * 60 + t0.getMinutes();
    const rawTo = Math.min(1439, rawFrom + 5);
    // 时间轴选择按 30 分钟粒度吸附
    const snappedFrom = Math.floor(rawFrom / 30) * 30;
    const snappedTo = Math.min(1439, Math.floor(rawTo / 30) * 30 + 29);
    const rangeFrom = rawFrom;
    const rangeTo = rawTo;
    const rangeLabel = `${hhmm(snappedFrom)}–${hhmm(snappedTo)}`;
    const dragTo = (fromMinute, toMinute) => {
      axis.dispatchEvent(axisEvent('mousedown', fromMinute));
      axis.dispatchEvent(axisEvent('mousemove', toMinute));
      axis.dispatchEvent(axisEvent('mouseup', toMinute));
    };
    dragTo(rangeFrom, rangeTo);
    await waitFor(
      () =>
        document.querySelectorAll('#heatmap .heatmap-row-label.active').length === 0 &&
        charts().profile &&
        charts().profile.config.type === 'bar' &&
        charts().profile.data.labels.length === 7 &&
        document.getElementById('profile-hint').textContent === rangeLabel,
      { label: '拖动时段后清空星期选择并显示周几柱状图' },
    );
    assert.doesNotMatch(
      document.getElementById('profile-hint').textContent,
      /Mon–Tue|usage by weekday/,
      '柱状图只显示时间段，且时段选择与星期互斥',
    );
    // State breakdown 为时间范围时，标注 Mon–Sun + 时间段
    await waitFor(
      () => document.getElementById('bars-range').textContent === `Mon–Sun · ${rangeLabel}`,
      { label: 'State breakdown 时间范围标注 Mon–Sun + 时段' },
    );
    assert.deepEqual(
      Array.from(charts().profile.scales.x.ticks, (tick) => tick.label),
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      '柱状图横轴始终显示 Mon–Sun 7 个标签',
    );

    // 移动端：在时间轴上用手指滑动也能选择时段（touch 事件）
    const touchEvent = (type, minute) => {
      const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
      const touch = { clientX: (minute / 1440) * 900, clientY: 5 };
      Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [touch] });
      Object.defineProperty(event, 'changedTouches', { value: [touch] });
      return event;
    };
    axis.dispatchEvent(touchEvent('touchstart', 480));
    axis.dispatchEvent(touchEvent('touchmove', 540));
    axis.dispatchEvent(touchEvent('touchend', 540));
    await waitFor(
      () => document.getElementById('profile-hint').textContent === '08:00–09:29',
      { label: '触摸滑动选择时段' },
    );
    // 触摸选的是没有数据的时段，恢复回有数据的时段继续后面的测试
    dragTo(rangeFrom, rangeTo);
    await waitFor(
      () =>
        charts().profile?.config.type === 'bar' &&
        document.getElementById('profile-hint').textContent === rangeLabel,
      { label: '恢复鼠标拖选的时段' },
    );

    // Inspection 柱状图点击某根柱子 → 跳到该星期的线图（等效热力图左侧选中那一天）
    const barOptions = charts().profile.options;
    assert.equal(typeof barOptions.onClick, 'function', '柱状图应支持点击');
    // 点数据类型当天（fixture 只有那一天有数据）
    const barIndex = (t0.getDay() + 6) % 7;
    const dataWeekdayLabel = [...document.querySelectorAll('#heatmap .heatmap-row-label')].map(
      (node) => node.textContent,
    )[barIndex];
    barOptions.onClick({ native: {} }, [{ index: barIndex }]);
    await waitFor(
      () =>
        charts().profile &&
        charts().profile.config.type === 'line' &&
        charts().profile.data.datasets[0]?.data.length === 1440 &&
        document.getElementById('profile-hint').textContent === dataWeekdayLabel &&
        document.getElementById('bars-range').textContent === `${dataWeekdayLabel} · 00:00–23:59`,
      { label: '点击柱子跳到该星期的线图' },
    );
    assert.equal(document.querySelector('.axis-selection')?.style.opacity, '0', '时间段选择已清除');
    assert.ok(
      [...document.querySelectorAll('#heatmap .heatmap-row-label')].some(
        (node) => node.classList.contains('active') && node.textContent === dataWeekdayLabel,
      ),
      '等效于在热力图左侧选中该天',
    );
    // 还原为空选择，继续后面的互斥测试
    findRow(dataWeekdayLabel).click();
    await waitFor(
      () =>
        document.querySelectorAll('#heatmap .heatmap-row-label.active').length === 0 &&
        document.getElementById('profile-hint').textContent === 'Mon–Sun',
      { label: '取消该天选择' },
    );

    assert.equal(dayRequests.length, 0, '点分钟 / 选星期 / 拖时段都只在本地重算，不请求后端');

    // 互斥：时段已选时点星期 → 时段选择被清空（选 fixture 当天，保证有数据）
    const todayLabel = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][(t0.getDay() + 6) % 7];
    findRow(todayLabel).click();
    await waitFor(
      () =>
        document.querySelectorAll('#heatmap .heatmap-row-label.active').length === 1 &&
        charts().profile &&
        charts().profile.config.type === 'line' &&
        charts().profile.data.datasets[0]?.data.length === 1440 &&
        document.getElementById('profile-hint').textContent === todayLabel,
      { label: '点星期后清空时段选择' },
    );
    await waitFor(
      () => document.getElementById('bars-range').textContent === `${todayLabel} · 00:00–23:59`,
      { label: 'State breakdown 跟随星期' },
    );
    assert.equal(document.querySelector('.axis-selection')?.style.opacity, '0', '时段选区已清除');

    // 取消星期 → 默认剖面
    findRow(todayLabel).click();
    await waitFor(
      () =>
        document.querySelectorAll('#heatmap .heatmap-row-label.active').length === 0 &&
        charts().profile &&
        charts().profile.data.datasets[0]?.data.length === 1440 &&
        document.getElementById('profile-hint').textContent === 'Mon–Sun',
      { label: '取消星期后回到默认剖面' },
    );

    // Bug 回归：7 天全选时标签不能消失（连续合并为 Mon–Sun）
    const allLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    for (const label of allLabels) findRow(label).click();
    await waitFor(
      () =>
        document.querySelectorAll('#heatmap .heatmap-row-label.active').length === 7 &&
        document.getElementById('bars-range').textContent === 'Mon–Sun · 00:00–23:59',
      { label: '7 天全选时 State breakdown 显示 Mon–Sun' },
    );
    assert.equal(
      document.getElementById('profile-hint').textContent,
      'Mon–Sun',
      '7 天全选时 Inspection 也显示 Mon–Sun',
    );
    // 还原为空选择
    for (const label of allLabels) findRow(label).click();
    await waitFor(() => document.querySelectorAll('#heatmap .heatmap-row-label.active').length === 0, {
      label: '取消全选',
    });
    assert.equal(document.getElementById('profile-hint').textContent, 'Mon–Sun');

    // 3) 选择控件：Date range 输入 + 机器 chips
    assert.equal(document.querySelectorAll('#ranges').length, 0, '旧的相对窗口 chips 已移除');
    assert.ok(document.getElementById('date-from'), '应有开始日期输入');
    assert.ok(document.getElementById('date-to'), '应有结束日期输入');
    assert.ok(document.getElementById('date-all'), '应有 All dates 按钮');
    assert.equal(document.querySelectorAll('#presets').length, 0, 'Presets 已移除');
    // All dates：日期框显示实际数据范围，而不是 mm/dd/yyyy 占位
    const dateFromInput = document.getElementById('date-from');
    const dateToInput = document.getElementById('date-to');
    assert.match(dateFromInput.value, /^\d{4}-\d{2}-\d{2}$/, 'All dates 时开始日期显示实际日期');
    assert.match(dateToInput.value, /^\d{4}-\d{2}-\d{2}$/, 'All dates 时结束日期显示实际日期');
    assert.equal(document.querySelectorAll('#machine-chips .chip').length, 4, '4 个机器 chip');
    assert.equal(
      document.querySelectorAll('#machine-chips .swatch').length,
      0,
      '机器 chip 不再显示颜色标签',
    );
    assert.equal(document.querySelectorAll('#machine-chips .chip-tag').length, 2, 'washer chips carry detergent tags');

    const chipGroups = [...document.querySelectorAll('#machine-chips .chip-group')];
    assert.equal(chipGroups.length, 2, 'Machines 选择分 Washers / Dryers 两栏');
    assert.deepEqual(chipGroups.map((group) => group.dataset.kind), ['washer', 'dryer']);
    assert.match(document.getElementById('selected-count').textContent, /4\/4/);

    const selectAllButton = document.getElementById('select-all');
    assert.ok(selectAllButton, '应有 Select all 按钮');
    assert.equal(selectAllButton.textContent, 'Clear all', '全部选中时按钮显示 Clear all');

    // 4) 交互：单台取消 → Select all 恢复 → Clear all 清空
    document.querySelector('#machine-chips .chip').click();
    await waitFor(() => document.querySelectorAll('#machine-chips .chip.active').length === 3, {
      label: '取消勾选后只选中 3 台',
    });
    assert.match(document.getElementById('selected-count').textContent, /3\/4/);
    assert.equal(document.getElementById('select-all').textContent, 'Select all');
    await waitFor(() => charts().bars && charts().bars.data.labels.length === 3, {
      label: 'State breakdown 跟随机器选择（3 台）',
    });
    assert.equal(dayRequests.length, 0, '取消勾选机器只在本地重算，不请求后端');

    document.getElementById('select-all').click(); // Select all
    await waitFor(() => document.querySelectorAll('#machine-chips .chip.active').length === 4, {
      label: 'Select all 恢复全选',
    });

    document.getElementById('select-all').click(); // Clear all
    await waitFor(() => document.querySelectorAll('#machine-chips .chip.active').length === 0, {
      label: 'Clear all 清空选择',
    });
    assert.match(document.getElementById('selected-count').textContent, /0\/4/);

    // 清空选择后：所有面板都显示"请选择机器"
    await waitFor(() => document.querySelector('#chart-bars .empty'), { label: '占比图空状态' });
    await waitFor(() => document.querySelector('#heatmap .empty'), { label: '热力图空状态' });
    await waitFor(() => document.querySelector('#chart-profile .empty'), { label: '剖面空状态' });
    assert.equal(charts().bars, null);

    document.getElementById('select-all').click(); // 恢复全选
    await waitFor(() => charts().bars && charts().profile, {
      label: '恢复全选后图表重建',
    });
    await waitFor(() => document.getElementById('heatmap-canvas')?.dataset.minutes === '1440', {
      label: '恢复全选后热力图恢复',
    });

    // 4b) Inspection 跟随机器选择：只选洗衣机 → 图例仍保留两条线（烘干机线无数据）
    document.getElementById('select-all').click(); // Clear all
    await waitFor(() => document.querySelectorAll('#machine-chips .chip.active').length === 0, {
      label: '清空选择',
    });
    document.querySelector('#machine-chips .chip-group[data-kind="washer"] .chip').click();
    await waitFor(
      () =>
        charts().profile &&
        charts().profile.data.datasets.length === 2 &&
        charts().profile.data.datasets[0].label === 'Washers in use' &&
        charts().profile.data.datasets[1].label === 'Dryers in use',
      { label: 'Profile 图例始终显示两条机型线' },
    );
    assert.ok(
      charts().profile.data.datasets[1].data.every((point) => point.y === null),
      '未选烘干机时，烘干机线没有数据点',
    );
    assert.match(document.getElementById('selected-count').textContent, /1\/4/);
    assert.equal(dayRequests.length, 0, '新选机器的数据已缓存时不需要请求后端（只补 diff）');

    document.getElementById('select-all').click(); // 恢复全选
    await waitFor(() => charts().profile && charts().profile.data.datasets.length === 2, {
      label: '恢复全选后 Profile 两条线',
    });

    // 5) Date range：热力图 / 剖面 / State breakdown 都跟随
    const fromInput = document.getElementById('date-from');
    const toInput = document.getElementById('date-to');
    fromInput.value = '2020-01-01';
    fromInput.dispatchEvent(new dom.window.Event('change'));
    toInput.value = '2020-01-02';
    toInput.dispatchEvent(new dom.window.Event('change'));

    await waitFor(() => document.querySelector('#heatmap .empty'), { label: '日期范围外热力图空状态' });
    await waitFor(() => document.querySelector('#chart-profile .empty'), { label: '日期范围外剖面空状态' });
    await waitFor(() => document.querySelector('#chart-bars .empty'), { label: '日期范围外占比图空状态' });
    const emptyTexts = ['#heatmap .empty', '#chart-profile .empty', '#chart-bars .empty'].map(
      (selector) => document.querySelector(selector).textContent,
    );
    assert.deepEqual(
      emptyTexts,
      [
        'No data in the selected range',
        'No data in the selected range',
        'No data in the selected range',
      ],
      '空状态统一显示 No data in the selected range',
    );
    // 热力图空状态与 Inspection 一致：隐藏网格，居中显示 .empty 占位
    const heatmapEmpty = document.querySelector('#heatmap .heatmap-empty');
    assert.ok(heatmapEmpty?.classList.contains('empty'), '热力图空状态复用 .empty 样式');
    assert.equal(document.querySelector('#heatmap .heatmap-head').hidden, true, '空状态隐藏表头');
    assert.equal(document.querySelector('#heatmap .heatmap-body').hidden, true, '空状态隐藏网格');
    assert.equal(
      dayRequests.length,
      0,
      'date range 变化只补 diff：全部历史已缓存，切到没有数据的范围不需要请求',
    );

    // All dates → 恢复全部历史
    document.getElementById('date-all').click();
    await waitFor(() => document.getElementById('heatmap-canvas')?.dataset.minutes === '1440', {
      label: '清除日期后热力图恢复',
    });
    assert.equal(document.querySelector('#heatmap .heatmap-head').hidden, false, '恢复后显示表头');
    assert.equal(document.querySelector('#heatmap .heatmap-body').hidden, false, '恢复后显示网格');
    assert.equal(document.querySelector('#heatmap .heatmap-empty'), null, '恢复后移除空状态');
    await waitFor(() => charts().profile && charts().profile.data.datasets[0]?.data.length === 1440, {
      label: '清除日期后剖面恢复',
    });
    await waitFor(() => charts().bars && charts().bars.data.labels.length === 4, {
      label: '清除日期后占比图恢复',
    });
    assert.equal(dayRequests.length, 0, '切回全部历史也没有新请求（缓存已覆盖）');
    assert.match(
      document.getElementById('date-from').value,
      /^\d{4}-\d{2}-\d{2}$/,
      'All dates 后开始日期显示实际数据范围',
    );
    assert.match(
      document.getElementById('date-to').value,
      /^\d{4}-\d{2}-\d{2}$/,
      'All dates 后结束日期显示实际数据范围',
    );
    assert.notEqual(document.getElementById('date-from').value, '2020-01-01', '不再停留在旧的手选日期');

    // 自动/手动刷新只重取今天、已选机器的序列
    const today = new Date();
    const todayText = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
      today.getDate(),
    ).padStart(2, '0')}`;
    const beforeRefresh = dayRequests.length;
    document.getElementById('refresh').click();
    await waitFor(() => dayRequests.length === beforeRefresh + 1, { label: '刷新请求今天的序列' });
    const refreshUrl = dayRequests[dayRequests.length - 1];
    assert.match(refreshUrl, new RegExp(`from=${todayText}`), '刷新只请求今天');
    assert.match(refreshUrl, new RegExp(`to=${todayText}`), '刷新只请求今天');
    assert.match(refreshUrl, /machines=/, '刷新只请求已选机器');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(dayRequests.length, beforeRefresh + 1, '刷新只应产生一个 /api/days 请求');

    // 6) 主题：Auto → Light → Dark，图表用深色色板重建
    const root = document.documentElement;
    assert.ok(['light', 'dark'].includes(root.dataset.theme), '首屏应已确定 data-theme');
    assert.equal(document.getElementById('theme-label').textContent, 'Auto');
    const themeButton = document.getElementById('theme-toggle');

    themeButton.click(); // Auto -> Light
    await waitFor(() => document.getElementById('theme-label').textContent === 'Light', { label: '切换到 Light' });
    assert.equal(root.dataset.theme, 'light');

    themeButton.click(); // Light -> Dark
    await waitFor(() => root.dataset.theme === 'dark', { label: '切换到 Dark' });
    await waitFor(
      () => charts().profile && charts().profile.data.datasets[0].borderColor === '#22d3ee',
      { label: '深色主题下图表使用深色色板' },
    );
    assert.equal(dom.window.localStorage.getItem('laundry.theme'), 'dark');

    themeButton.click(); // Dark -> Auto
    await waitFor(() => document.getElementById('theme-label').textContent === 'Auto', { label: '回到 Auto' });
    assert.equal(root.dataset.theme, 'light', 'Auto 在浅色系统下应解析为 light');

    // 模拟系统切到深色：Auto 模式应自动跟随
    dom.window.__themeMedia.matches = true;
    for (const listener of dom.window.__themeMedia.listeners) listener({ matches: true });
    await waitFor(() => root.dataset.theme === 'dark', { label: 'Auto 跟随系统切到深色' });
    await waitFor(
      () => charts().profile && charts().profile.data.datasets[0].borderColor === '#22d3ee',
      { label: '跟随系统后图表同步深色' },
    );

    // 7) 移动端：容器宽度变化后按紧凑参数重建（刻度更少、占比图高度压缩）
    Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return dom.window.innerWidth;
      },
    });
    dom.window.innerWidth = 375;
    dom.window.dispatchEvent(new dom.window.Event('resize'));

    await waitFor(() => charts().profile?.options.scales.x.ticks.stepSize === 120, {
      label: '窄屏剖面刻度间距仍为允许值',
    });
    await waitFor(() => document.getElementById('chart-bars').style.height === '220px', {
      label: '窄屏占比图高度压缩',
    });

    // 移动端选择时段：粒度固定为 1 小时（整点开始、整点结束）
    const mobileSnapFrom = Math.floor(rawFrom / 60) * 60;
    const mobileDragTo = Math.min(1439, rawFrom + 5);
    const mobileSnapTo = Math.min(1439, Math.floor(mobileDragTo / 60) * 60 + 59);
    const mobileLabel = `${hhmm(mobileSnapFrom)}–${hhmm(mobileSnapTo)}`;
    const mobileTouch = (type, minute) => {
      const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
      const touch = { clientX: (minute / 1440) * 375, clientY: 10 };
      Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [touch] });
      Object.defineProperty(event, 'changedTouches', { value: [touch] });
      return event;
    };
    axis.dispatchEvent(mobileTouch('touchstart', rawFrom));
    axis.dispatchEvent(mobileTouch('touchmove', mobileDragTo));
    axis.dispatchEvent(mobileTouch('touchend', mobileDragTo));
    await waitFor(
      () =>
        charts().profile?.config.type === 'bar' &&
        document.getElementById('profile-hint').textContent === mobileLabel,
      { label: '移动端按 1 小时粒度选择时段' },
    );
    assert.deepEqual(
      Array.from(charts().profile.scales.x.ticks, (tick) => tick.label),
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      '窄屏下柱状图仍显示 Mon–Sun 7 个标签',
    );
    assert.match(
      document.getElementById('bars-range').textContent,
      /^Mon–Sun · \d{2}:00–\d{2}:59$/,
      '移动端选择结果是整小时区间',
    );

    // 回归：手机上反复拖动不会累积触摸监听器（否则一次触摸触发 N 次重绘，越来越卡）
    const activeTouchListeners = new Set();
    const originalAddEventListener = axis.addEventListener.bind(axis);
    const originalRemoveEventListener = axis.removeEventListener.bind(axis);
    axis.addEventListener = (type, listener, options) => {
      if (String(type).startsWith('touch')) activeTouchListeners.add(listener);
      return originalAddEventListener(type, listener, options);
    };
    axis.removeEventListener = (type, listener, options) => {
      if (String(type).startsWith('touch')) activeTouchListeners.delete(listener);
      return originalRemoveEventListener(type, listener, options);
    };
    for (let index = 0; index < 3; index += 1) {
      axis.dispatchEvent(mobileTouch('touchstart', rawFrom));
      axis.dispatchEvent(mobileTouch('touchmove', mobileDragTo));
      axis.dispatchEvent(mobileTouch('touchend', mobileDragTo));
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(activeTouchListeners.size, 4, '反复滑动后触摸监听器仍只有 4 个（不累积）');

    assert.deepEqual(errors, [], `页面不应有 JS 错误: ${errors.join(' | ')}`);
  } finally {
    if (dom) dom.window.close();
    if (web) await web.close();
    await app.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});
