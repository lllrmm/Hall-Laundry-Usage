/**
 * 验证 README 里的分析 SQL（不参与发布）。
 *
 *   node scripts/verify-sql.mjs
 *
 * 1) 对真实库 data/laundry.sqlite 跑统计查询（文件不存在则跳过）
 * 2) 造一个已知使用周期的临时库，验证"使用周期时长"查询
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizeResponse } from 'hkust-laundry-machines';

import { MonitorDatabase } from '../src/db.js';

const QUERIES = {
  可用率: `
    SELECT m.name, m.kind,
           ROUND(AVG(s.available) * 100, 1) AS available_pct,
           COUNT(*) AS samples
    FROM machine_snapshots s
    JOIN machines m ON m.id = s.machine_id
    WHERE s.observed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
    GROUP BY m.id
    ORDER BY available_pct DESC
    LIMIT 5`,
  小时空闲率: `
    SELECT strftime('%H', s.observed_at) AS hour_utc,
           ROUND(AVG(s.available) * 100, 1) AS free_pct,
           COUNT(*) AS samples
    FROM machine_snapshots s
    JOIN machines m ON m.id = s.machine_id
    WHERE m.kind = 'dryer'
      AND s.observed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 day')
    GROUP BY hour_utc
    ORDER BY free_pct DESC`,
  使用周期时长: `
    SELECT t1.machine_id,
           t1.observed_at AS started_at,
           t2.observed_at AS ended_at,
           ROUND((julianday(t2.observed_at) - julianday(t1.observed_at)) * 86400) AS seconds
    FROM machine_transitions t1
    JOIN machine_transitions t2
      ON t2.machine_id = t1.machine_id
     AND t2.from_state = 'in_use'
     AND t2.to_state != 'in_use'
     AND t2.observed_at > t1.observed_at
    WHERE t1.to_state = 'in_use'
    ORDER BY t1.observed_at DESC
    LIMIT 20`,
  抓取成功率: `
    SELECT COUNT(*) AS runs, SUM(ok) AS ok_runs,
           ROUND(AVG(duration_ms)) AS avg_ms,
           MIN(started_at) AS first_at, MAX(started_at) AS last_at
    FROM poll_runs`,
};

function runQueries(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    for (const [label, sql] of Object.entries(QUERIES)) {
      const rows = db.prepare(sql).all();
      console.log(`\n=== ${label}（${rows.length} 行）===`);
      for (const row of rows.slice(0, 5)) console.log(JSON.stringify(row));
    }
  } finally {
    db.close();
  }
}

// 1) 真实库
const livePath = path.resolve('data/laundry.sqlite');
if (fs.existsSync(livePath)) {
  console.log(`### 真实库 ${livePath}`);
  runQueries(livePath);
} else {
  console.log('### 真实库不存在，跳过（先跑 npm run once）');
}

// 2) 合成库：已知一个 5 分钟的使用周期
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laundry-sql-'));
const syntheticPath = path.join(dir, 'synthetic.sqlite');
const synthetic = new MonitorDatabase(syntheticPath, { journalMode: 'DELETE' });

const t0 = Date.parse('2026-10-27T02:00:00.000Z');
const makeStatus = (now, state, job) =>
  normalizeResponse(
    {
      meta: { code: 200, message: 'Success' },
      data: {
        laundry_room_machines: [
          {
            laundry_room_name: 'Synthetic Room',
            machines: [
              {
                _id: 'm-dryer',
                status: 'enabled',
                state,
                name: 'Synthetic Dryer (01)',
                service_type: { _id: 'st', machine_type: 'dryer', value: 'dryer_machine', label: 'Dry Machine' },
                laundry_room_name: 'Synthetic Room',
                ...(job ? { job } : {}),
              },
            ],
          },
        ],
      },
    },
    now,
  );

const steps = [
  [t0, 'available', undefined],
  [t0 + 60_000, 'in_use', { created_at: new Date(t0 + 60_000).toISOString(), ticket: { number_of_minutes: 45 } }],
  [t0 + 60_000 + 300_000, 'available', undefined],
];
for (const [now, state, job] of steps) {
  synthetic.recordSuccessfulPoll(makeStatus(now, state, job), {
    startedAt: new Date(now),
    finishedAt: new Date(now),
    durationMs: 10,
  });
}
synthetic.close();

console.log('\n### 合成库（已知 5 分钟使用周期）');
runQueries(syntheticPath);

try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  // 忽略 Windows 文件占用
}
