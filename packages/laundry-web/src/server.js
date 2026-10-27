/**
 * 看板前端 HTTP 服务：只做静态文件托管 + `/api/*` 反向代理。
 *
 * 与 laundry-dashboard 完全解耦：
 *   browser ──静态资源──► laundry-web
 *   browser ──/api/*────► laundry-web ──反向代理──► laundry-dashboard（只读 API）
 * 这样浏览器始终同源，生产环境也可以把静态资源换成 Nginx/CDN，API 继续走 dashboard。
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const GZIP_MIN_BYTES = 1024;
const COMPRESSIBLE_EXTENSIONS = new Set(['.html', '.js', '.css', '.json', '.svg']);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

/** 静态文件 gzip 结果缓存：`path:mtime:size` → Buffer */
const STATIC_GZIP_CACHE = new Map();
const STATIC_GZIP_CACHE_LIMIT = 32;

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req?.headers?.['accept-encoding'] ?? ''));
}

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

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
  });
  res.end(body);
}

/**
 * 创建服务实例（不监听）。
 * @param {object} options
 * @param {{host: string, port: number, apiTarget: string|null}} options.config
 * @param {string} [options.publicDir] 覆盖静态目录（测试用）
 * @param {{info: Function, error: Function, warn: Function}} [options.logger]
 */
export function createWebServer({ config, publicDir = PUBLIC_DIR, logger = console }) {
  const staticRoot = path.resolve(publicDir);
  const apiTarget = config.apiTarget ?? null;
  const targetUrl = apiTarget ? new URL(apiTarget) : null;
  const proxyModule = targetUrl?.protocol === 'https:' ? https : http;

  const serveStatic = (urlPath, res) => {
    const relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.replace(/^\/+/, ''));
    const filePath = path.resolve(staticRoot, relative);

    // 防目录穿越
    if (filePath !== staticRoot && !filePath.startsWith(staticRoot + path.sep)) {
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

  const proxyApi = (req, res, url) => {
    if (!targetUrl) {
      sendJson(res, 404, {
        error: 'API 代理未配置：设置 apiTarget，或在前端 config.js 指向 API 地址',
      });
      return;
    }

    const upstreamPath = `${url.pathname}${url.search}`;
    const headers = { ...req.headers, host: targetUrl.host };
    delete headers.connection;

    const proxyReq = proxyModule.request(
      {
        protocol: targetUrl.protocol,
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: upstreamPath,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (error) => {
      logger.warn?.(`API 代理失败 ${upstreamPath}: ${error.message}`);
      if (!res.headersSent) sendJson(res, 502, { error: 'API upstream unavailable' });
      else res.destroy();
    });

    req.pipe(proxyReq);
  };

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      sendText(res, 400, 'Bad Request');
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      proxyApi(req, res, url);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method Not Allowed');
      return;
    }

    try {
      serveStatic(url.pathname, res);
    } catch (error) {
      logger.error?.(`请求失败 ${url.pathname}: ${error.message}`);
      if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
    }
  });

  return {
    server,
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
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
