/** 端到端自检：验证看板页面与 API（独立于轮询进程） */
const BASE = process.env.DASHBOARD_URL || 'http://127.0.0.1:8787';

async function get(path, asJson = true) {
  const response = await fetch(BASE + path);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}: ${text.slice(0, 120)}`);
  return asJson ? JSON.parse(text) : text;
}

async function status(path) {
  const response = await fetch(BASE + path);
  await response.text();
  return response.status;
}

const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const html = await get('/', false);
check(
  '页面 /',
  html.includes('Laundry Monitor') &&
    html.includes('chart-bars') &&
    html.includes('chart-profile') &&
    html.includes('aggregate.js') &&
    html.includes('history.js'),
  `${html.length} bytes`,
);
check('主题切换控件', html.includes('id="theme-toggle"') && html.includes('data-theme'), '');
check('Date range 控件', html.includes('Date range') && !html.includes('chart-trend'), '');

const css = await get('/styles.css', false);
const appJs = await get('/app.js', false);
const aggregateJs = await get('/aggregate.js', false);
const historyJs = await get('/history.js', false);
check('响应式样式', css.includes('@media (max-width: 720px)') && css.includes('@media (max-width: 420px)'), '');
check(
  '浏览器端聚合脚本',
  aggregateJs.includes('buildHeatmap') &&
    aggregateJs.includes('buildProfile') &&
    aggregateJs.includes('buildStateBreakdown') &&
    historyJs.includes('planDiff') &&
    appJs.includes('Aggregate.buildHeatmap') &&
    appJs.includes('History.planDiff'),
  '',
);
check(
  '前端只重取 diff',
  appJs.includes('/api/days') &&
    appJs.includes('fetchedAllMachines') &&
    appJs.includes('loadHistoryForRefresh') &&
    !appJs.includes('/api/bars') &&
    !appJs.includes('/api/heatmap') &&
    !appJs.includes('/api/profile'),
  '',
);

const vendor = await get('/vendor/chart.umd.js', false);
check(
  'Chart.js 本地 vendor',
  html.includes('/vendor/chart.umd.js') && vendor.includes('Chart') && vendor.length > 100_000,
  `${Math.round(vendor.length / 1024)} KB`,
);
check(
  'Chart.js 图表代码',
  appJs.includes('new Chart(') && appJs.includes("type: 'line'") && appJs.includes("type: 'bar'"),
  '',
);

const state = await get('/api/state');
check('/api/state meta', state.meta?.available === true, `lastObserved=${state.meta?.lastObservedAt}`);
check('/api/state 机器数', state.latest?.length === 12, `${state.latest?.length} 台`);
check('/api/state 最新状态完整', state.latest?.every((m) => typeof m.available === 'boolean' && m.name), '');
check('/api/state firstObservedAt', Boolean(state.meta?.firstObservedAt), `${state.meta?.firstObservedAt}`);

const series = await get('/api/series?since=1h');
check('/api/series 桶', Array.isArray(series.buckets) && series.buckets.length > 0, `${series.buckets?.length} 桶 / ${series.bucketSeconds}s`);
check('/api/series 机器', series.machines?.length === 12, `${series.machines?.length} 台`);

const days = await get('/api/days');
check(
  '/api/days 日序列',
  days.available === true && days.count >= 12,
  `source=${days.source} ${days.count} 条 / ${days.firstDay} ~ ${days.lastDay}`,
);
check('/api/days 编码表', days.encoding?.inUse === 0 && days.encoding?.available === 1 && days.encoding?.noData === 255, '');
check(
  '/api/days 每台机器每天 1440 字节',
  days.days.length > 0 &&
    days.days.every((row) => Buffer.from(row.seq, 'base64').length === 1440 && row.updatedAt),
  '',
);

if (days.days.length) {
  const seq = Buffer.from(days.days[0].seq, 'base64');
  const seen = new Set(seq);
  check(
    '/api/days 字节内容合理',
    seen.has(0x01) || seen.has(0x00),
    `states: ${[...seen].sort((a, b) => a - b).join(',')}`,
  );
}

const oneMachine = state.latest[0];
const scopedDays = await get(`/api/days?machines=${oneMachine.id}`);
check(
  '/api/days 按机器过滤',
  scopedDays.count >= 1 && scopedDays.days.every((row) => row.machineId === oneMachine.id),
  `${scopedDays.count} 条`,
);

if (days.firstDay) {
  const oneDay = await get(`/api/days?from=${days.firstDay}&to=${days.firstDay}`);
  check(
    '/api/days 按日期过滤',
    oneDay.count >= 12 && oneDay.days.every((row) => row.day === days.firstDay),
    `${oneDay.count} 条 @ ${days.firstDay}`,
  );
}

const removed = [];
for (const route of ['/api/bars', '/api/hourly', '/api/heatmap', '/api/profile', '/api/profile/days']) {
  removed.push(`${route}=${await status(route)}`);
}
check(
  '旧聚合接口已移除',
  removed.every((entry) => entry.endsWith('=404')),
  removed.join(' '),
);

console.log('\nlastObservedAt:', state.meta.lastObservedAt);
console.log('lastPoll:', JSON.stringify(state.meta.lastPoll));
console.log('pollCount:', state.meta.pollCount, '| snapshots:', state.meta.snapshots);
console.log('days source:', days.source, '| rows:', days.count);

const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  console.error(`\n${failed.length} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
