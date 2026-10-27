/**
 * 前端看板 HTTP 服务：静态页面 + 只读 JSON API。
 *
 * 与轮询服务完全解耦 —— 只读同一个 SQLite 文件，两个进程可分别启停。
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { DashboardDatabase } from './queries.js';
import { DaysDatabase, normalizeDay } from './days.js';
import { parseRange } from './time.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const CACHE_MS = 4000;

/** 小于该字节数的响应不压缩（压缩反而更大/不值得） */
const GZIP_MIN_BYTES = 1024;

/** 适合压缩的静态文件类型 */
const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.js', '.css', '.json', '.svg']);

/** 静态文件 gzip 结果缓存：`path:mtime:size` → Buffer */
const STATIC_GZIP_CACHE = new Map();
const STATIC_GZIP_CACHE_LIMIT = 32;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req?.headers?.['accept-encoding'] ?? ''));
}

/** 压缩静态文件并缓存结果（按 path + mtime + size 失效） */
function gzipStatic(filePath, content) {
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    // 文件刚被删除等，按内容长度缓存
  }
  const key = `${filePath}:${stat?.mtimeMs ?? 0}:${content.length}`;
  let gzipped = STATIC_GZIP_CACHE.get(key);
  if (!gzipped) {
    gzipped = zlib.gzipSync(content);
    if (STATIC_GZIP_CACHE.size >= STATIC_GZIP_CACHE_LIMIT) STATIC_GZIP_CACHE.clear();
    STATIC_GZIP_CACHE.set(key, gzipped);
  }
  return gzipped;
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

/** 解析可选 YYYY-MM-DD 参数；非法抛错（交给上层转 500 JSON） */
function parseDayParam(value) {
  if (value === null || value === undefined || value === '') return null;
  const day = normalizeDay(value);
  if (!day) throw new Error(`无法解析日期参数：${value}`);
  return day;
}

/**
 * 创建服务实例（不监听）。
 * @param {object} options
 * @param {{databasePath: string, host: string, port: number, refreshSeconds: number}} options.config
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

    if (route === '/api/days') {
      // 历史图表用的原始日序列（每台机器每天 1,440 字节的 base64）。
      // 聚合全部交给浏览器端 public/aggregate.js，交互不再请求后端。
      const fromDay = parseDayParam(url.searchParams.get('from'));
      const toDay = parseDayParam(url.searchParams.get('to'));
      const key = `${route}?${fromDay ?? ''}~${toDay ?? ''}:${machineIds.sort().join(',')}`;
      sendJson(res, 200, cached(key, () => daysDatabase.days({ fromDay, toDay, machineIds })));
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
      const extension = path.extname(filePath).toLowerCase();
      const type = MIME_TYPES[extension] ?? 'application/octet-stream';
      const headers = {
        'content-type': type,
        'cache-control': 'no-cache',
        vary: 'accept-encoding',
      };
      let body = content;
      if (
        COMPRESSIBLE_EXTENSIONS.has(extension) &&
        content.length >= GZIP_MIN_BYTES &&
        acceptsGzip(res.req)
      ) {
        body = gzipStatic(filePath, content);
        headers['content-encoding'] = 'gzip';
      }
      headers['content-length'] = body.length;
      res.writeHead(200, headers);
      res.end(body);
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
      daysDatabase.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
