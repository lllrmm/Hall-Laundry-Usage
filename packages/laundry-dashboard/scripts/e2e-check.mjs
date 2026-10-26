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
check('页面 /', html.includes('洗衣房监控') && html.includes('chart-trend'), `${html.length} bytes`);

const state = await get('/api/state');
check('/api/state meta', state.meta?.available === true, `lastObserved=${state.meta?.lastObservedAt}`);
check('/api/state 机器数', state.latest?.length === 12, `${state.latest?.length} 台`);
check('/api/state 最新状态完整', state.latest?.every((m) => typeof m.available === 'boolean' && m.name), '');

const series = await get('/api/series?since=1h');
check('/api/series 桶', Array.isArray(series.buckets) && series.buckets.length > 0, `${series.buckets?.length} 桶 / ${series.bucketSeconds}s`);
check('/api/series 机器', series.machines?.length === 12, `${series.machines?.length} 台`);
check('/api/series 数据点', Object.keys(series.series ?? {}).length === 12 && series.totals.available.some((v) => v !== null), '');

const bars = await get('/api/bars?since=1h');
check('/api/bars', bars.rows?.length === 12, `${bars.rows?.length} 行`);

const hourly = await get('/api/hourly?since=24h');
check('/api/hourly', hourly.hours?.length === 24 && hourly.hours.some((h) => h.samples > 0), '');

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
