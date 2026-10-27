/** 端到端自检：验证看板页面与 API（独立于轮询进程） */
const BASE = process.env.DASHBOARD_URL || 'http://127.0.0.1:8787';

async function get(path, asJson = true) {
  const response = await fetch(BASE + path);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}: ${text.slice(0, 120)}`);
  return asJson ? JSON.parse(text) : text;
}

const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const html = await get('/', false);
check('页面 /', html.includes('Laundry Monitor') && html.includes('chart-trend'), `${html.length} bytes`);
check('主题切换控件', html.includes('id="theme-toggle"') && html.includes('data-theme'), '');

const css = await get('/styles.css', false);
const appJs = await get('/app.js', false);
check('响应式样式', css.includes('@media (max-width: 720px)') && css.includes('@media (max-width: 420px)'), '');
check('移动端图表逻辑', appJs.includes('compact') && appJs.includes('shortMachineName'), '');

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

const series = await get('/api/series?since=1h');
check('/api/series 桶', Array.isArray(series.buckets) && series.buckets.length > 0, `${series.buckets?.length} 桶 / ${series.bucketSeconds}s`);
check('/api/series 机器', series.machines?.length === 12, `${series.machines?.length} 台`);
check('/api/series 数据点', Object.keys(series.series ?? {}).length === 12 && series.totals.available.some((v) => v !== null), '');
check(
  '/api/series 按机型聚合',
  series.totalsByKind?.washer?.inUse?.length > 0 && series.totalsByKind?.dryer?.inUse?.length > 0,
  `byKind: ${Object.keys(series.totalsByKind ?? {}).join(', ')}`,
);

const bars = await get('/api/bars?since=1h');
check('/api/bars', bars.rows?.length === 12, `${bars.rows?.length} 行`);
check('/api/bars 时段', Boolean(bars.since && bars.until), `${bars.since} – ${bars.until}`);

const scopedBars = await get('/api/bars?since=all&weekday=1');
check(
  '/api/bars 按热力图行筛选',
  scopedBars.scope?.weekday === 1 && Array.isArray(scopedBars.rows),
  `${scopedBars.rows?.length} 行`,
);

const hourly = await get('/api/hourly?since=24h');
check('/api/hourly', hourly.hours?.length === 24 && hourly.hours.some((h) => h.samples > 0), '');
check(
  '/api/hourly 使用率',
  hourly.hours.some((h) => h.usageRatio > 0) &&
    hourly.hours.every((h) => h.usageRatio === null || (h.usageRatio >= 0 && h.usageRatio <= 1)),
  '',
);

const heatmap = await get('/api/heatmap?since=30d');
check(
  '/api/heatmap',
  heatmap.cells?.length > 0 &&
    heatmap.cells.every(
      (cell) => cell.weekday >= 0 && cell.weekday <= 6 && cell.hour >= 0 && cell.hour <= 23 && cell.samples > 0,
    ),
  `${heatmap.cells?.length} 个格子`,
);

const profile = await get('/api/profile?since=all&weekday=1');
check(
  '/api/profile 5 分钟剖面',
  profile.slots?.length === 288 && profile.bucketSeconds === 300,
  `${profile.slots?.filter((slot) => slot.samples > 0).length ?? 0} 个有数据槽`,
);

const filtered = await get('/api/series?since=1h&machines=' + state.latest.filter((m) => m.kind === 'dryer').map((m) => m.id).join(','));
check('/api/series 按机器过滤', filtered.machines?.length === 6, `${filtered.machines?.length} 台烘干机`);

console.log('\nlastObservedAt:', state.meta.lastObservedAt);
console.log('lastPoll:', JSON.stringify(state.meta.lastPoll));
console.log('pollCount:', state.meta.pollCount, '| snapshots:', state.meta.snapshots);

const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  console.error(`\n${failed.length} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
