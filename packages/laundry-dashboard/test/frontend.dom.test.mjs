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
import { createDashboardServer } from '../src/server.js';

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
    config: { databasePath: file, host: '127.0.0.1', port: 0, refreshSeconds: 30 },
    logger: { info() {}, warn() {}, error() {} },
  });

  const errors = [];
  let dom = null;

  try {
    const address = await app.listen(0, '127.0.0.1');
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', (error) => errors.push(error.message));
    virtualConsole.on('error', (...args) => errors.push(args.join(' ')));

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

    // 2) 三张 Chart.js 图表
    await waitFor(() => {
      const charts = dom.window.__laundryCharts;
      return charts?.trend && charts?.bars && charts?.hourly;
    }, { label: 'Chart.js 图表实例创建' });

    const charts = () => dom.window.__laundryCharts;

    for (const id of ['chart-trend', 'chart-bars', 'chart-hourly']) {
      assert.ok(document.querySelector(`#${id} canvas`), `${id} 应渲染出 canvas`);
    }

    // 趋势图：washer / dryer 两条线
    const trend = charts().trend;
    assert.equal(trend.config.type, 'line');
    assert.equal(trend.data.datasets.length, 2, '趋势图两条线');
    assert.deepEqual(Array.from(trend.data.datasets, (dataset) => dataset.label), ['Washers in use', 'Dryers in use']);
    assert.deepEqual(Array.from(trend.data.datasets, (dataset) => dataset.borderColor), ['#0891b2', '#d97706']);
    assert.ok(trend.data.labels.length > 0, '趋势图应有时间标签');
    assert.equal(trend.data.datasets[0].data.length, trend.data.labels.length);

    // 状态占比：横向堆叠柱，In use → Free → Unavailable
    const bars = charts().bars;
    assert.equal(bars.config.type, 'bar');
    assert.equal(bars.options.indexAxis, 'y');
    assert.equal(bars.options.scales.x.stacked, true);
    assert.equal(bars.options.interaction.mode, 'index');
    assert.equal(bars.options.interaction.intersect, false);
    assert.equal(bars.options.interaction.axis, 'y', '横向柱状图 tooltip 必须按 y 轴定位行');
    assert.deepEqual(Array.from(bars.data.datasets, (dataset) => dataset.label), ['In use', 'Free', 'Unavailable']);
    assert.equal(bars.data.labels.length, 4, '始终展示全部 4 台机器');
    assert.ok(bars.data.datasets[0].data.some((value) => value > 0), '烘干机应有 in use 占比');

    // 按小时：24 根柱子 + 最佳时段文案
    const hourly = charts().hourly;
    assert.equal(hourly.config.type, 'bar');
    assert.equal(hourly.data.labels.length, 24);
    assert.equal(hourly.data.datasets[0].data.length, 24);
    assert.equal(hourly.data.datasets[0].backgroundColor.length, 24);
    assert.match(document.getElementById('hourly-hint').textContent, /Best time/);

    // 3) 选择控件
    assert.equal(document.querySelectorAll('#ranges .chip').length, 6, '6 个时间跨度');
    assert.equal(document.querySelectorAll('#presets').length, 0, 'Presets 已移除');
    assert.equal(document.querySelectorAll('#machine-chips .chip').length, 4, '4 个机器 chip');
    assert.equal(document.querySelectorAll('#machine-chips .chip-tag').length, 2, 'washer chips carry detergent tags');

    const chipGroups = [...document.querySelectorAll('#machine-chips .chip-group')];
    assert.equal(chipGroups.length, 2, 'Machines 选择分 Washers / Dryers 两栏');
    assert.deepEqual(chipGroups.map((group) => group.dataset.kind), ['washer', 'dryer']);
    assert.match(document.getElementById('selected-count').textContent, /4\/4/);

    const selectAllButton = document.getElementById('select-all');
    assert.ok(selectAllButton, '应有 Select all 按钮');
    assert.equal(selectAllButton.textContent, 'Clear all', '全部选中时按钮显示 Clear all');

    // 4) 交互：单台取消 → Select all 恢复 → Clear all 清空 → 占比图仍显示全部机器
    document.querySelector('#machine-chips .chip').click();
    await waitFor(() => document.querySelectorAll('#machine-chips .chip.active').length === 3, {
      label: '取消勾选后只选中 3 台',
    });
    assert.match(document.getElementById('selected-count').textContent, /3\/4/);
    assert.equal(document.getElementById('select-all').textContent, 'Select all');

    document.getElementById('select-all').click(); // Select all
    await waitFor(() => document.querySelectorAll('#machine-chips .chip.active').length === 4, {
      label: 'Select all 恢复全选',
    });

    document.getElementById('select-all').click(); // Clear all
    await waitFor(() => document.querySelectorAll('#machine-chips .chip.active').length === 0, {
      label: 'Clear all 清空选择',
    });
    assert.match(document.getElementById('selected-count').textContent, /0\/4/);

    // 清空选择后：趋势图/小时图显示占位，状态占比仍是 4 台机器
    await waitFor(() => document.querySelector('#chart-trend .empty'), { label: '趋势图空状态' });
    assert.equal(charts().trend, null, '清空选择后趋势图实例应销毁');
    await waitFor(() => charts().bars && charts().bars.data.labels.length === 4, {
      label: '状态占比始终显示全部 4 台机器',
    });

    document.getElementById('select-all').click(); // 恢复全选
    await waitFor(() => charts().trend && charts().bars && charts().hourly, {
      label: '恢复全选后图表重建',
    });

    // 5) 时间跨度切换
    const weekChip = [...document.querySelectorAll('#ranges .chip')].find((chip) => chip.textContent.includes('7 days'));
    weekChip.click();
    await waitFor(
      () => [...document.querySelectorAll('#ranges .chip')].some(
        (chip) => chip.classList.contains('active') && chip.textContent.includes('7 days'),
      ),
      { label: '7 days chip 高亮' },
    );
    await waitFor(() => charts().trend, { label: '切换跨度后趋势图仍在' });

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
      () => charts().trend && charts().trend.data.datasets[0].borderColor === '#22d3ee',
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
      () => charts().trend && charts().trend.data.datasets[0].borderColor === '#22d3ee',
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

    await waitFor(() => charts().trend?.options.scales.x.ticks.maxTicksLimit === 4, {
      label: '窄屏趋势图使用紧凑刻度',
    });
    assert.equal(document.getElementById('chart-bars').style.height, '220px', '窄屏占比图高度压缩');
    assert.equal(charts().hourly.data.labels.length, 24);

    assert.deepEqual(errors, [], `页面不应有 JS 错误: ${errors.join(' | ')}`);
  } finally {
    if (dom) dom.window.close();
    await app.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});
