/** 独立性自检用的探针：输出数据库轮询次数 + 看板可达性（不做任何杀进程操作） */
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB = path.resolve('../laundry-monitor/data/laundry.sqlite');
const DASH = process.env.DASHBOARD_URL || 'http://127.0.0.1:8787';

function pollCount() {
  const db = new DatabaseSync(DB, { readOnly: true });
  try {
    return {
      runs: db.prepare('SELECT COUNT(*) AS n FROM poll_runs').get().n,
      snapshots: db.prepare('SELECT COUNT(*) AS n FROM machine_snapshots').get().n,
      lastObservedAt: db.prepare('SELECT MAX(observed_at) AS t FROM machine_snapshots').get().t,
    };
  } finally {
    db.close();
  }
}

async function dashboard() {
  try {
    const response = await fetch(`${DASH}/api/state`);
    if (!response.ok) return { reachable: false, status: response.status };
    const body = await response.json();
    return {
      reachable: true,
      pollCount: body.meta.pollCount,
      lastObservedAt: body.meta.lastObservedAt,
      machines: body.latest?.length ?? 0,
    };
  } catch (error) {
    return { reachable: false, error: error.message };
  }
}

const result = { at: new Date().toISOString(), db: pollCount(), dashboard: await dashboard() };
console.log(JSON.stringify(result));
