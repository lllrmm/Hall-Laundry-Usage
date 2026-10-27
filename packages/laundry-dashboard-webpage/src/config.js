/**
 * 看板前端配置：监听地址、端口，以及反向代理的 API 地址。
 *
 * `apiTarget` 让浏览器始终同源请求 `/api/*`，由本服务转发到 laundry-dashboard-api：
 *   - 生产/局域网：默认 http://127.0.0.1:8787，前端与 API 可以分开部署；
 *   - 设为 null 则不做代理，此时前端需要配置 window.__LAUNDRY_API_BASE__（见 public/config.js）。
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG_FILE = 'dashboard-webpage.config.json';

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 8788,
  apiTarget: 'http://127.0.0.1:8787',
};

/**
 * 校验并补全配置。
 * @param {Record<string, any>} input
 * @param {{sourcePath?: string}} [context]
 */
export function normalizeWebConfig(input, { sourcePath = null } = {}) {
  const where = sourcePath ? `（${sourcePath}）` : '';
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`配置必须是 JSON 对象${where}`);
  }

  const host = String(input.host ?? DEFAULTS.host).trim() || DEFAULTS.host;

  const port = Number(input.port ?? DEFAULTS.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`port 必须是 0-65535 的整数${where}`);
  }

  let apiTarget = input.apiTarget === undefined ? DEFAULTS.apiTarget : input.apiTarget;
  if (apiTarget !== null && apiTarget !== '') {
    if (typeof apiTarget !== 'string') {
      throw new Error(`apiTarget 必须是 URL 字符串或 null${where}`);
    }
    let parsed;
    try {
      parsed = new URL(apiTarget);
    } catch {
      throw new Error(`apiTarget 不是合法 URL${where}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`apiTarget 只支持 http/https${where}`);
    }
    apiTarget = apiTarget.replace(/\/+$/, '');
  } else {
    apiTarget = null;
  }

  return { host, port, apiTarget, sourcePath };
}

/** 读取配置文件（文件不存在时返回默认值，方便零配置启动）。 */
export function loadWebConfig(filePath, { baseDir } = {}) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    return normalizeWebConfig({}, { sourcePath: null });
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON（${absolute}）：${error.message}`);
  }
  const config = normalizeWebConfig(json, { sourcePath: absolute });
  config.configPath = absolute;
  config.baseDir = baseDir ?? path.dirname(absolute);
  return config;
}
