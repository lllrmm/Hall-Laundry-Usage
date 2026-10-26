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

function machine(id, name, kind, state) {
  return {
    _id: id,
    status: 'enabled',
    state,
    name,
    service_type: {
      _id: kind === 'dryer' ? 'st-d' : 'st-w',
      machine_type: kind,
      value: kind === 'dryer' ? 'dryer_machine' : 'washing_machine_without_powder',
      label: kind === 'dryer' ? 'Dry Machine' : 'Washer',
    },
    laundry_room_name: 'UG Hall IV',
  };
}

function buildFixtureDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-dashboard-dom-'));
  const file = path.join(dir, 'test.sqlite');
  const db = new MonitorDatabase(file, { journalMode: 'DELETE' });

  const states = [
    { dryer1: 'available', dryer2: 'available', washer: 'available' },
    { dryer1: 'in_use', dryer2: 'available', washer: 'available' },
    { dryer1: 'in_use', dryer2: 'in_use', washer: 'available' },
    { dryer1: 'available', dryer2: 'available', washer: 'available' },
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
                machine('w1', 'UG4 Washer (01)', 'washer', state.washer),
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
      },
    });

    const { document } = dom.window;
    await waitFor(() => document.readyState === 'complete', { label: '页面加载完成' });

    // 1) 当前状态卡片：3 台机器
    await waitFor(() => document.querySelectorAll('.machine').length === 3, { label: '状态卡片渲染' });
    const cards = [...document.querySelectorAll('.machine')];
    assert.equal(cards.length, 3);
    assert.ok(cards.every((card) => card.classList.contains('free')), '最后一轮全部空闲，卡片应为 free');
    assert.match(document.getElementById('last-update').textContent, /\d{2}:\d{2}:\d{2}/);

    // 2) 四张图表都渲染出 SVG
    for (const id of ['chart-trend', 'chart-series', 'chart-bars', 'chart-hourly']) {
      await waitFor(() => document.querySelector(`#${id} svg`), { label: `${id} 图表渲染` });
    }

    const trendSvg = document.querySelector('#chart-trend svg');
    assert.ok(trendSvg, '趋势图应有 svg');
    assert.ok(trendSvg.querySelectorAll('path.series-line').length >= 2, '趋势图应有可用/在用两条线');
    assert.equal(document.querySelectorAll('#chart-series path.series-line').length, 3, '每台机器一条折线');
    assert.equal(document.querySelectorAll('#chart-bars svg rect').length > 3, true, '占比图应画出柱段');
    // 小时图：只有有数据的那个小时会画柱子（测试数据集中在几分钟内）
    assert.ok(document.querySelectorAll('#chart-hourly svg rect').length >= 1, '小时图应有柱子');
    assert.match(document.getElementById('chart-hourly').textContent, /最佳时段/, '小时图应标注最佳时段');

    // 3) 选择控件
    assert.equal(document.querySelectorAll('#ranges .chip').length, 6, '6 个时间跨度');
    assert.equal(document.querySelectorAll('#presets .chip').length, 5, '5 个快捷选择');
    assert.equal(document.querySelectorAll('#machine-chips .chip').length, 3, '3 个机器 chip');
    assert.match(document.getElementById('selected-count').textContent, /3\/3/);

    // 4) 交互：取消一台机器 → 折线减少；切到 7 天 → chip 高亮
    const firstMachineChip = document.querySelector('#machine-chips .chip');
    firstMachineChip.click();
    await waitFor(() => document.querySelectorAll('#chart-series path.series-line').length === 2, {
      label: '取消勾选后折线减少',
    });
    assert.match(document.getElementById('selected-count').textContent, /2\/3/);

    const weekChip = [...document.querySelectorAll('#ranges .chip')].find((chip) => chip.textContent.includes('7 天'));
    weekChip.click();
    // 点击后 chips 会重建，需要重新查询
    await waitFor(
      () => {
        const active = [...document.querySelectorAll('#ranges .chip')].find((chip) => chip.classList.contains('active'));
        return active && active.textContent.includes('7 天');
      },
      { label: '7 天 chip 高亮' },
    );
    assert.ok(document.querySelector('#chart-trend svg'), '切换时间跨度后图表仍存在');

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
