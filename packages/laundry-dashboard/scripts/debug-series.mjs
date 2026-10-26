/** 临时调试：series 聚合结果 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeResponse } from '../../laundry-machines/index.js';
import { MonitorDatabase } from '../../laundry-monitor/src/db.js';
import { DashboardDatabase } from '../src/queries.js';

const T0 = Date.now() - 5 * 60 * 1000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'));
const file = path.join(dir, 't.sqlite');
const db = new MonitorDatabase(file, { journalMode: 'DELETE' });

const payload = (now, dryerState) => ({
  meta: { code: 200, message: 'Success' },
  data: {
    laundry_room_machines: [
      {
        laundry_room_name: 'R',
        machines: [
          { _id: 'm-washer', status: 'enabled', state: 'available', name: 'UG4 Washer (01)', service_type: { _id: 'w', machine_type: 'washer', value: 'washing_machine_without_powder', label: 'W' }, laundry_room_name: 'R' },
          { _id: 'm-dryer', status: 'enabled', state: dryerState, name: 'UG4 Dryer (51)', service_type: { _id: 'd', machine_type: 'dryer', value: 'dryer_machine', label: 'D' }, laundry_room_name: 'R' },
        ],
      },
    ],
  },
});

for (const [i, dryer] of ['available', 'in_use', 'available'].entries()) {
  const now = T0 + i * 60_000;
  db.recordSuccessfulPoll(normalizeResponse(payload(now, dryer), now), {
    startedAt: new Date(now),
    finishedAt: new Date(now),
    durationMs: 10,
  });
}
db.close();

const dash = new DashboardDatabase(file);
const since = new Date(T0 - 120_000).toISOString();
const series = dash.series({ since, windowSeconds: 3600, machineIds: [] });

console.log('buckets', series.buckets.length, 'first', series.buckets[0], 'last', series.buckets.at(-1));
console.log('bucketSeconds', series.bucketSeconds);
console.log('machines', series.machines.map((m) => m.id));
console.log('washer sample', (series.series['m-washer']?.availableRatio ?? []).slice(0, 6));
console.log('dryer sample', (series.series['m-dryer']?.availableRatio ?? []).slice(0, 6));
console.log('totals available', series.totals.available.slice(0, 6));

const raw = new (await import('node:sqlite')).DatabaseSync(file, { readOnly: true });
const rows = raw
  .prepare(
    `SELECT machine_id AS id,
            CAST(CAST(strftime('%s', observed_at) AS INTEGER) / ? AS INTEGER) AS bucket,
            AVG(available) AS available_ratio, COUNT(*) AS samples
     FROM machine_snapshots WHERE observed_at >= ? GROUP BY id, bucket ORDER BY bucket`,
  )
  .all(series.bucketSeconds, since);
console.log('raw rows', JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
console.log('observed', raw.prepare('SELECT machine_id, observed_at FROM machine_snapshots ORDER BY observed_at').all());
raw.close();

dash.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
