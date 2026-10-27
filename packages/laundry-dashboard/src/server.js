/**
 * 前端看板 HTTP 服务：静态页面 + 只读 JSON API。
 *
 * 与轮询服务完全解耦 —— 只读同一个 SQLite 文件，两个进程可分别启停。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DashboardDatabase } from './queries.js';
import { parseRange } from './time.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const CACHE_MS = 4000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
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
 * @param {{databasePath: string, host: string, port: number, refreshSeconds: number}} options.config
 * @param {{info: Function, error: Function, warn: Function}} [options.logger]
 */
export function createDashboardServer({ config, logger = console }) {
  const database = new DashboardDatabase(config.databasePath);
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
    const sinceParam = url.searchParams.get('since');
    const machineIds = parseMachineIds(url.searchParams);

    if (route === '/api/meta') {
      sendJson(res, 200, cached(route, () => database.meta()));
      return true;
    }

    if (route === '/api/state') {
      const key = `${route}?${url.search}`;
      sendJson(
        res,
        200,
        cached(key, () => {
          const meta = database.meta();
          return { meta, machines: database.machines(), latest: database.latest() };
        }),
      );
      return true;
    }

    if (route === '/api/machines') {
      sendJson(res, 200, { machines: database.machines() });
      return true;
    }

    if (route === '/api/latest') {
      sendJson(res, 200, { machines: database.latest(), meta: database.meta() });
      return true;
    }

    if (route === '/api/series') {
      const range = parseRange(sinceParam);
      const key = `${route}?${range.label}:${machineIds.sort().join(',')}`;
      sendJson(res, 200, cached(key, () => database.series({ since: range.since, windowSeconds: range.windowSeconds, machineIds })));
      return true;
    }

    if (route === '/api/bars') {
      const range = parseRange(sinceParam);
      const key = `${route}?${range.label}:${machineIds.sort().join(',')}`;
      sendJson(res, 200, cached(key, () => database.bars({ since: range.since, machineIds })));
      return true;
    }

    if (route === '/api/hourly') {
      const range = parseRange(sinceParam);
      const key = `${route}?${range.label}:${machineIds.sort().join(',')}`;
      sendJson(res, 200, cached(key, () => database.hourly({ since: range.since, machineIds })));
      return true;
    }

    if (route === '/api/heatmap') {
      const range = parseRange(sinceParam);
      const key = `${route}?${range.label}:${machineIds.sort().join(',')}`;
      sendJson(res, 200, cached(key, () => database.heatmap({ since: range.since, machineIds })));
      return true;
    }

    return false;
  };

  const serveStatic = (urlPath, res) => {
    const relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.replace(/^\/+/, ''));
    const filePath = path.resolve(PUBLIC_DIR, relative);

    // 防目录穿越
    if (!filePath.startsWith(PUBLIC_DIR)) {
      sendText(res, 403, 'Forbidden');
      return;
    }

    fs.readFile(filePath, (error, content) => {
      if (error) {
        sendText(res, 404, 'Not found');
        return;
      }
      const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, {
        'content-type': type,
        'content-length': content.length,
        'cache-control': 'no-cache',
      });
      res.end(content);
    });
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
      serveStatic(url.pathname, res);
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
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
