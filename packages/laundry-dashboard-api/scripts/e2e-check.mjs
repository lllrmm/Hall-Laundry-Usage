/** 端到端自检：前端（laundry-dashboard-webpage）+ 只读 API（laundry-dashboard-api），独立于轮询进程 */
const API_BASE = process.env.DASHBOARD_URL || 'http://127.0.0.1:8787';
const WEB_BASE = process.env.WEB_URL || 'http://127.0.0.1:8788';

async function get(path, asJson = true, base = API_BASE) {
  const response = await fetch(base + path);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}: ${text.slice(0, 120)}`);
  return asJson ? JSON.parse(text) : text;
}

async function status(path, base = API_BASE) {
  const response = await fetch(base + path);
  await response.text();
  return response.status;
}

const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const html = await get('/', false, WEB_BASE);
check(
  '页面 /',
  html.includes('Laundry Monitor') &&
    html.includes('chart-bars') &&
    html.includes('chart-profile') &&
    html.includes('aggregate.js') &&
    html.includes('history.js') &&
    html.includes('./config.js'),
  `${html.length} bytes`,
);
check('主题切换控件', html.includes('id="theme-toggle"') && html.includes('data-theme'), '');
check('Date range 控件', html.includes('Date range') && !html.includes('chart-trend'), '');
check(
  'dashboard 只提供 API',
  (await status('/', API_BASE)) === 404,
  '页面已移至 laundry-dashboard-webpage',
);

const css = await get('/styles.css', false, WEB_BASE);
const appJs = await get('/app.js', false, WEB_BASE);
const aggregateJs = await get('/aggregate.js', false, WEB_BASE);
const historyJs = await get('/history.js', false, WEB_BASE);
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
    appJs.includes('effectiveRange') &&
    appJs.includes('loadHistoryForRefresh') &&
    !appJs.includes('/api/bars') &&
    !appJs.includes('/api/heatmap') &&
    !appJs.includes('/api/profile'),
  '',
);

const vendor = await get('/vendor/chart.umd.js', false, WEB_BASE);
check(
  'Chart.js 本地 vendor',
  html.includes('./vendor/chart.umd.js') && vendor.includes('Chart') && vendor.length > 100_000,
  `${Math.round(vendor.length / 1024)} KB`,
);
check(
  'Chart.js 图表代码',
  appJs.includes('new Chart(') && appJs.includes("type: 'line'") && appJs.includes("type: 'bar'"),
  '',
);

const state = await get('/api/state');
check('/api/state meta', state.meta?.available === true, `lastObserved=${state.meta?.lastObservedAt}`);
check(
  '/api/state meta 不含内部字段',
  state.meta && !('database' in state.meta) && !('durationMs' in (state.meta.lastPoll ?? {})),
  'database / durationMs 已移除',
);
check('/api/state 机器数', state.machines?.length === 12, `${state.machines?.length} 台`);
check(
  '/api/state machines 含最新状态',
  state.machines?.every((m) => typeof m.available === 'boolean' && m.name && m.observedAt) &&
    !('latest' in state),
  'latest 已合并进 machines',
);
check('/api/state firstObservedAt', Boolean(state.meta?.firstObservedAt), `${state.meta?.firstObservedAt}`);
check(
  '/api/state meta.span',
  Boolean(state.meta?.span?.firstDay && state.meta?.span?.lastDay) && !('span' in state),
  `${state.meta?.span?.firstDay} ~ ${state.meta?.span?.lastDay}`,
);

const metaPayload = await get('/api/meta');
check(
  '/api/meta meta.span',
  Boolean(metaPayload.span?.firstDay && metaPayload.span?.lastDay),
  `${metaPayload.span?.firstDay} ~ ${metaPayload.span?.lastDay}`,
);

const allIds = state.machines.map((machine) => machine.id).join(',');
const { firstDay, lastDay } = state.meta.span;

const days = await get(`/api/days?machines=${allIds}&from=${firstDay}&to=${lastDay}`);
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

const oneMachine = state.machines[0];
const scopedDays = await get(`/api/days?machines=${oneMachine.id}&from=${firstDay}&to=${lastDay}`);
check(
  '/api/days 按机器过滤',
  scopedDays.count >= 1 && scopedDays.days.every((row) => row.machineId === oneMachine.id),
  `${scopedDays.count} 条`,
);

if (days.firstDay) {
  const oneDay = await get(`/api/days?machines=${allIds}&from=${days.firstDay}&to=${days.firstDay}`);
  check(
    '/api/days 按日期过滤',
    oneDay.count >= 12 && oneDay.days.every((row) => row.day === days.firstDay),
    `${oneDay.count} 条 @ ${days.firstDay}`,
  );
}

const dayList = [...new Set([firstDay, lastDay])];
const listResult = await get(`/api/days?machines=${oneMachine.id}&days=${dayList.join(',')}`);
check(
  '/api/days days 日期列表',
  listResult.count >= 1 &&
    listResult.days.every((row) => dayList.includes(row.day)) &&
    listResult.fromDay === firstDay &&
    listResult.toDay === lastDay,
  `${listResult.count} 条 / ${dayList.join(',')}`,
);

const badRequests = [];
for (const query of [
  '',
  '?machines=',
  `?machines=${oneMachine.id}`,
  `?machines=${oneMachine.id}&from=${firstDay}`,
  `?machines=${oneMachine.id}&from=2026-01-02&to=2026-01-01`,
  `?machines=${oneMachine.id}&from=${firstDay}&to=${lastDay}&days=${firstDay}`,
]) {
  badRequests.push(`${query || '(空)'}=${await status(`/api/days${query}`)}`);
}
check(
  '/api/days 强约束参数校验',
  badRequests.every((entry) => entry.endsWith('=400')),
  badRequests.join(' '),
);

const removed = [];
for (const route of [
  '/api/series',
  '/api/latest',
  '/api/bars',
  '/api/hourly',
  '/api/heatmap',
  '/api/profile',
  '/api/profile/days',
]) {
  removed.push(`${route}=${await status(route)}`);
}
check(
  '旧聚合接口已移除',
  removed.every((entry) => entry.endsWith('=404')),
  removed.join(' '),
);

// gzip：大响应压缩、静态 JS 压缩、小响应不压缩
const gzDays = await fetch(`${API_BASE}/api/days?machines=${allIds}&from=${firstDay}&to=${lastDay}`, {
  headers: { 'accept-encoding': 'gzip' },
});
const gzDaysBody = await gzDays.json();
check(
  'gzip /api/days',
  gzDays.headers.get('content-encoding') === 'gzip' &&
    /accept-encoding/i.test(gzDays.headers.get('vary') ?? '') &&
    gzDaysBody.count > 0,
  `content-encoding=${gzDays.headers.get('content-encoding')} content-length=${gzDays.headers.get('content-length')}`,
);

const gzScript = await fetch(`${WEB_BASE}/app.js`, { headers: { 'accept-encoding': 'gzip' } });
const gzScriptText = await gzScript.text();
check(
  'gzip 静态 JS',
  gzScript.headers.get('content-encoding') === 'gzip' && gzScriptText.includes('LaundryAggregate'),
  `content-length=${gzScript.headers.get('content-length')}`,
);

const plainMeta = await fetch(`${API_BASE}/api/meta`);
check(
  '小响应不压缩',
  plainMeta.headers.get('content-encoding') === null,
  `content-length=${plainMeta.headers.get('content-length')}`,
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
