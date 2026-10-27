/**
 * 单次采集：调库 → 归一化状态 → 落库。
 *
 * 失败也要落一条 poll_runs（ok=0），这样"抓取成功率/失败原因"本身也能分析。
 */

/**
 * @param {object} options
 * @param {import('hkust-laundry-machines').LaundryClient} options.client
 * @param {import('./db.js').MonitorDatabase} options.db
 * @param {import('./series.js').SeriesDatabase} [options.series] 序列库（raw 的日级压缩派生层）
 * @param {{info: Function, error: Function, debug: Function, warn: Function}} [options.logger]
 * @param {() => Date} [options.now]
 */
export async function pollOnce({ client, db, series, logger, now = () => new Date() }) {
  const startedAt = now();
  const startedMs = Date.now();

  try {
    const status = await client.getMachines({ now: startedAt.getTime() });
    const finishedAt = now();
    const result = db.recordSuccessfulPoll(status, {
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedMs,
    });

    // 序列库是派生数据：写失败只告警，不影响原始记录
    if (series) {
      try {
        series.recordPoll(status.machines, finishedAt);
      } catch (error) {
        logger?.warn(`写序列库失败（不影响原始记录）：${error.message}`);
      }
    }

    const changed = result.transitions.length;
    logger?.info(
      `采集成功：${status.counts.total} 台（可用 ${status.counts.available} / 在用 ${status.counts.inUse} / 不可用 ${status.counts.unavailable}）` +
        `${changed ? `，状态变化 ${changed} 条` : ''}`,
    );

    return {
      ok: true,
      runId: result.runId,
      counts: status.counts,
      transitions: result.transitions,
      fetchedAt: status.fetchedAt,
    };
  } catch (error) {
    const finishedAt = now();
    const failed = db.recordFailedPoll({
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedMs,
      error,
    });

    logger?.error(`采集失败 [${failed.code ?? 'UNKNOWN'}]：${failed.message}`);

    return { ok: false, runId: failed.runId, error };
  }
}
