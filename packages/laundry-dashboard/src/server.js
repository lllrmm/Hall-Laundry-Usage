/**
 * 看板只读 JSON API（不含前端静态资源；前端由 laundry-web 独立托管/反代）。
 *
 * 与轮询服务完全解耦 —— 只读同一个 SQLite 文件，两个进程可分别启停。
 */

import http from 'node:http';
import zlib from 'node:zlib';

import { DashboardDatabase } from './queries.js';
import { DaysDatabase, normalizeDay } from './days.js';

const CACHE_MS = 4000;

/** 小于该字节数的响应不压缩（压缩反而更大/不值得） */
const GZIP_MIN_BYTES = 1024;

/** /api/days 单次最多查询的天数（防止日期列表无限膨胀） */
const MAX_DAYS_PER_QUERY = 366;

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req?.headers?.['accept-encoding'] ?? ''));
}

/**
 * 发送 JSON：响应体 ≥ 1KB 且客户端支持 gzip 时压缩。
 * 用 res.req 取请求头，调用方不用改签名。
 */
function sendJson(res, statusCode, payload) {
  const json = JSON.stringify(payload);
  const raw = Buffer.from(json, 'utf8');
  const useGzip = raw.length >= GZIP_MIN_BYTES && acceptsGzip(res.req);
  const body = useGzip ? zlib.gzipSync(raw) : raw;

  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    vary: 'accept-encoding',
  };
  if (useGzip) headers['content-encoding'] = 'gzip';

  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** 解析 ?machines=id1,id2（也支持重复参数） */
function parseMachineIds(params) {
  const fromComma = params.getAll('machines').flatMap((value) => value.split(','));
  return [...new Set(fromComma.map((id) => id.trim()).filter(Boolean))];
}

/**
 * 创建服务实例（不监听）。
 * @param {object} options
 * @param {{databasePath: string, host: string, port: number}} options.config
 * @param {{info: Function, error: Function, warn: Function}} [options.logger]
 */
export function createDashboardServer({ config, logger = console }) {
  const database = new DashboardDatabase(config.databasePath);
  const daysDatabase = new DaysDatabase({
    rawPath: config.databasePath,
    seriesPath: config.seriesDatabasePath ?? null,
  });
  const cache = new Map();

  const cached = (key, build) => {
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && hit.expires > now) return hit.payload;
    const payload = build();
    cache.set(key, { payload, expires: now + CACHE_MS });
    if (cache.size > 200) {
      for (const [entryKey, entry] of cache) {
        if (entry.expires <= now) cache.delete(entryKey);
      }
    }
    return payload;
  };

  const handleApi = (url, res) => {
    const route = url.pathname;
    const machineIds = parseMachineIds(url.searchParams);

    if (route === '/api/meta') {
      sendJson(
        res,
        200,
        cached(route, () => ({ ...database.meta(), span: daysDatabase.span() })),
      );
      return true;
    }

    if (route === '/api/state') {
      const key = `${route}?${url.search}`;
      sendJson(
        res,
        200,
        cached(key, () => {
          // meta 里附带数据覆盖的本地日期范围：前端把"全部历史"换算成 /api/days 必填的 from/to
          const meta = { ...database.meta(), span: daysDatabase.span() };
          return { meta, machines: database.machinesWithLatest() };
        }),
      );
      return true;
    }

    if (route === '/api/machines') {
      sendJson(res, 200, { machines: database.machinesWithLatest() });
      return true;
    }

    if (route === '/api/days') {
      // 历史图表用的原始日序列（每台机器每天 1,440 字节的 base64）。
      // 聚合全部交给前端（laundry-web 的 aggregate.js），交互不再请求后端。
      // 强约束：machines 必填；日期用 from+to 或 days 列表（互斥），避免无参数拉全库。
      const badRequest = (message) => {
        sendJson(res, 400, { error: message });
        return true;
      };

      if (!machineIds.length) {
        return badRequest('machines 参数必填（逗号分隔的机器 id）');
      }

      const rawDays = url
        .searchParams.getAll('days')
        .flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .filter(Boolean);
      const rawFrom = url.searchParams.get('from');
      const rawTo = url.searchParams.get('to');
      const hasFrom = Boolean(rawFrom && rawFrom.trim());
      const hasTo = Boolean(rawTo && rawTo.trim());
      const hasDays = rawDays.length > 0;

      if (hasDays && (hasFrom || hasTo)) {
        return badRequest('from/to 与 days 不能同时使用');
      }
      if (hasDays && rawDays.length > MAX_DAYS_PER_QUERY) {
        return badRequest(`days 最多 ${MAX_DAYS_PER_QUERY} 天`);
      }

      let dayList = null;
      let fromDay = null;
      let toDay = null;

      if (hasDays) {
        const requested = new Set();
        for (const value of rawDays) {
          const day = normalizeDay(value);
          if (!day) return badRequest(`days 列表里包含非法日期：${value}`);
          requested.add(day);
        }
        dayList = [...requested].sort();
      } else {
        if (!hasFrom || !hasTo) {
          return badRequest('machines 之外还需要 from 和 to（YYYY-MM-DD），或改用 days 日期列表');
        }
        fromDay = normalizeDay(rawFrom);
        if (!fromDay) return badRequest(`无法解析日期参数：${rawFrom}`);
        toDay = normalizeDay(rawTo);
        if (!toDay) return badRequest(`无法解析日期参数：${rawTo}`);
        if (fromDay > toDay) return badRequest('from 不能晚于 to');
      }

      const dateKey = dayList ? `days=${dayList.join(',')}` : `${fromDay}~${toDay}`;
      const key = `${route}?${dateKey}:${machineIds.slice().sort().join(',')}`;
      sendJson(
        res,
        200,
        cached(key, () => daysDatabase.days({ machineIds, fromDay, toDay, days: dayList })),
      );
      return true;
    }

    return false;
  };

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method Not Allowed');
      return;
    }

    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      sendText(res, 400, 'Bad Request');
      return;
    }

    try {
      if (url.pathname.startsWith('/api/')) {
        const handled = handleApi(url, res);
        if (!handled) sendJson(res, 404, { error: `Unknown API route: ${url.pathname}` });
        return;
      }
      // 本服务只提供 API；页面/静态资源由 laundry-web 托管
      sendJson(res, 404, {
        error: 'API only. Open the dashboard via laundry-web (default http://127.0.0.1:8788/)',
      });
    } catch (error) {
      logger.error?.(`请求失败 ${url.pathname}: ${error.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: error.message });
    }
  });

  return {
    server,
    database,
    /** 监听并返回实际地址（端口 0 时有用） */
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const address = server.address();
          resolve({ port: address.port, host: address.address, url: `http://${host}:${address.port}` });
        });
      });
    },
    close() {
      database.close();
      daysDatabase.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
