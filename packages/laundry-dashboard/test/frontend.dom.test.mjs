/**
 * 前端渲染闭环测试：用 jsdom 真跑一遍 public/ 里的页面，
 * 验证首屏状态卡片、四张图表、筛选交互、自动刷新都能正常工作。
 *
 * 说明：本环境无法启动真实浏览器（沙箱禁止 Chromium 的命名管道），
 * 用 jsdom 做 DOM + 网络 + 脚本执行级别的验证。
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

function waitFor(check, { timeout = 5000, interval = 50, label = 'condition' } = {}) {
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

test('jsdom 渲染：状态卡片 + 四张图表 + 筛选交互', { skip: isBun ? 'jsdom 测试仅在 node 下运行' : false }, async () => {
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
        // jsdom 没有完整的 matchMedia：用可控 stub 模拟系统深浅色
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
      },
    });

    const { document } = dom.window;
    await waitFor(() => document.readyState === 'complete', { label: '页面加载完成' });

    // 1) 当前状态卡片：4 台机器
    await waitFor(() => document.querySelectorAll('.machine').length === 4, { label: '状态卡片渲染' });
    const cards = [...document.querySelectorAll('.machine')];
    assert.equal(cards.length, 4);
    assert.ok(cards.every((card) => card.classList.contains('free')), '最后一轮全部空闲，卡片应为 free');
    assert.match(document.getElementById('last-update').textContent, /\d{2}:\d{2}:\d{2}/);

    // 1.1) 洗衣机洗粉标注
    const withPowder = document.querySelectorAll('#machine-grid .powder.with');
    const withoutPowder = document.querySelectorAll('#machine-grid .powder.without');
    assert.equal(withPowder.length, 1, 'should mark one washer "With detergent"');
    assert.equal(withPowder[0].textContent, 'With detergent');
    assert.equal(withoutPowder.length, 1, 'should mark one washer "No detergent"');
    assert.equal(withoutPowder[0].textContent, 'No detergent');
    assert.equal(document.querySelectorAll('#machine-grid .powder').length, 2, 'dryers should not show detergent badges');

    // 2) 三张图表都渲染出 SVG（每台机器空闲率图已移除）
    assert.equal(document.querySelector('#chart-series'), null, '不再渲染每台机器空闲率图');
    for (const id of ['chart-trend', 'chart-bars', 'chart-hourly']) {
      await waitFor(() => document.querySelector(`#${id} svg`), { label: `${id} 图表渲染` });
    }

    const trendSvg = document.querySelector('#chart-trend svg');
    assert.ok(trendSvg, '趋势图应有 svg');
    const trendLines = trendSvg.querySelectorAll('path.series-line');
    assert.equal(trendLines.length, 1, '趋势图只画"在用"一条线');
    assert.ok(
      ['#f59e0b', '#fbbf24'].includes(trendLines[0].getAttribute('stroke')),
      `趋势线应为 in-use 颜色，实际 ${trendLines[0].getAttribute('stroke')}`,
    );
    assert.equal(document.querySelectorAll('#chart-bars svg rect').length > 3, true, '占比图应画出柱段');
    // 小时图：只有有数据的那个小时会画柱子（测试数据集中在几分钟内）
    assert.ok(document.querySelectorAll('#chart-hourly svg rect').length >= 1, '小时图应有柱子');
    assert.match(document.getElementById('chart-hourly').textContent, /Best time/, 'hourly chart should label the best time');

    // 3) 选择控件
    assert.equal(document.querySelectorAll('#ranges .chip').length, 6, '6 个时间跨度');
    const presetLabels = [...document.querySelectorAll('#presets .chip')].map((chip) => chip.textContent);
    assert.deepEqual(presetLabels, ['All', 'Washers only', 'Dryers only'], 'Presets 只保留按机型筛选');
    assert.equal(document.querySelectorAll('#machine-chips .chip').length, 4, '4 个机器 chip');
    assert.equal(document.querySelectorAll('#machine-chips .chip-tag').length, 2, 'washer chips carry detergent tags');
    assert.match(document.getElementById('selected-count').textContent, /4\/4/);

    // 4) 交互：取消一台机器 → chip 取消高亮；Preset 按机型筛选；切到 7 天 → chip 高亮
    const firstMachineChip = document.querySelector('#machine-chips .chip');
    firstMachineChip.click();
    await waitFor(() => document.querySelectorAll('#machine-chips .chip.active').length === 3, {
      label: '取消勾选后只选中 3 台',
    });
    assert.match(document.getElementById('selected-count').textContent, /3\/4/);

    const dryersOnly = [...document.querySelectorAll('#presets .chip')].find((chip) => chip.textContent === 'Dryers only');
    dryersOnly.click();
    await waitFor(() => document.querySelectorAll('#machine-chips .chip.active').length === 2, {
      label: 'Dryers only 只剩 2 台烘干机',
    });
    assert.match(document.getElementById('selected-count').textContent, /2\/4/);

    const weekChip = [...document.querySelectorAll('#ranges .chip')].find((chip) => chip.textContent.includes('7 days'));
    weekChip.click();
    // 点击后 chips 会重建，需要重新查询
    await waitFor(
      () => {
        const active = [...document.querySelectorAll('#ranges .chip')].find((chip) => chip.classList.contains('active'));
        return active && active.textContent.includes('7 days');
      },
      { label: '7 days chip highlighted' },
    );
    assert.ok(document.querySelector('#chart-trend svg'), '切换时间跨度后图表仍存在');

    // 5) 主题：Auto → Light → Dark → Auto
    const root = document.documentElement;
    assert.ok(['light', 'dark'].includes(root.dataset.theme), '首屏应已确定 data-theme');
    assert.equal(document.getElementById('theme-label').textContent, 'Auto');
    const themeButton = document.getElementById('theme-toggle');

    themeButton.click(); // Auto -> Light
    await waitFor(() => document.getElementById('theme-label').textContent === 'Light', { label: '切换到 Light' });
    assert.equal(root.dataset.theme, 'light');

    themeButton.click(); // Light -> Dark
    await waitFor(() => root.dataset.theme === 'dark', { label: '切换到 Dark' });
    assert.equal(document.getElementById('theme-label').textContent, 'Dark');
    assert.equal(dom.window.localStorage.getItem('laundry.theme'), 'dark');
    assert.ok(document.querySelector('#chart-trend svg'), '切换深色后图表仍存在');
    assert.ok(document.querySelector('#chart-hourly svg'), '切换深色后小时图仍存在');

    themeButton.click(); // Dark -> Auto
    await waitFor(() => document.getElementById('theme-label').textContent === 'Auto', { label: '回到 Auto' });
    assert.equal(root.dataset.theme, 'light', 'Auto 在浅色系统下应解析为 light');

    // 模拟系统切到深色：Auto 模式应自动跟随，且不写入 localStorage
    dom.window.__themeMedia.matches = true;
    for (const listener of dom.window.__themeMedia.listeners) listener({ matches: true });
    await waitFor(() => root.dataset.theme === 'dark', { label: 'Auto 跟随系统切到深色' });
    assert.equal(document.getElementById('theme-label').textContent, 'Auto', '跟随系统时模式仍显示 Auto');
    assert.equal(dom.window.localStorage.getItem('laundry.theme'), 'auto');

    // 6) 移动端：375px 宽度下按窄屏参数重绘
    Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return dom.window.innerWidth;
      },
    });
    dom.window.innerWidth = 375;
    dom.window.dispatchEvent(new dom.window.Event('resize'));

    await waitFor(
      () => document.querySelector('#chart-trend svg')?.getAttribute('width') === '375',
      { label: '移动端图表按 375px 重绘' },
    );
    assert.equal(document.querySelector('#chart-bars svg').getAttribute('width'), '375');
    assert.equal(document.querySelector('#chart-hourly svg').getAttribute('width'), '375');

    // 窄屏柱状图标签用短名（去掉 "UG4 " 前缀）
    const barLabels = [...document.querySelectorAll('#chart-bars svg text.bar-label')].map((node) => node.textContent);
    assert.ok(barLabels.length > 0, '柱状图应有机器标签');
    assert.ok(barLabels.every((label) => !label.startsWith('UG')), `窄屏应使用短名，实际：${barLabels.join(', ')}`);
    assert.ok(barLabels.includes('Dryer (51)'), '短名应保留机器编号');

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
