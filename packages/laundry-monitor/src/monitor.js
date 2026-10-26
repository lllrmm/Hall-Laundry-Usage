/**
 * 采集循环：按配置的周期反复采集，直到收到停止信号。
 * 采用"上一轮结束再计时"的方式，避免请求变慢时任务堆积。
 */

import { pollOnce } from './collector.js';

/**
 * @param {object} options
 * @param {import('hkust-laundry-machines').LaundryClient} options.client
 * @param {import('./db.js').MonitorDatabase} options.db
 * @param {object} options.config 由 loadConfig 返回
 * @param {{info: Function, error: Function, debug: Function, warn: Function}} options.logger
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.purgeEveryPolls] 每多少次轮询做一次历史清理
 */
export async function startMonitor({ client, db, config, logger, signal, purgeEveryPolls = 120 }) {
  const intervalMs = config.pollIntervalMs;
  const retention = config.retentionDays;
  let polls = 0;

  logger.info(
    `开始监控：间隔 ${config.pollIntervalSeconds}s，数据库 ${config.databasePath}` +
      `，保留 ${retention === null ? '全部历史' : `${retention} 天`}`,
  );

  while (!signal?.aborted) {
    await pollOnce({ client, db, logger });
    polls += 1;

    if (retention !== null && (polls === 1 || polls % purgeEveryPolls === 0)) {
      try {
        const purged = db.purgeOlderThan(retention);
        if (purged.runs || purged.snapshots || purged.transitions) {
          logger.debug(
            `清理历史：runs=${purged.runs} snapshots=${purged.snapshots} transitions=${purged.transitions}`,
          );
        }
      } catch (error) {
        logger.warn(`清理历史失败：${error.message}`);
      }
    }

    if (signal?.aborted) break;
    await delay(intervalMs, signal);
  }

  logger.info(`监控已停止（共完成 ${polls} 次采集）`);
}

/** 可被 AbortSignal 打断的 sleep */
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();

    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
