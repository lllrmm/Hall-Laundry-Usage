/** 前端/程序配置：数据库路径、监听地址、CORS 允许的浏览器来源。 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG_FILE = 'dashboard.config.json';

export const DEFAULTS = {
  database: '../laundry-monitor/data/laundry.sqlite',
  seriesDatabase: '../laundry-monitor/data/laundry-series.sqlite',
  host: '127.0.0.1',
  port: 8787,
  corsOrigins: [],
};

/**
 * 校验并补全配置。
 * @param {Record<string, any>} input
 * @param {object} [context]
 * @param {string} [context.baseDir]
 * @param {string} [context.sourcePath]
 */
export function normalizeConfig(input, { baseDir = process.cwd(), sourcePath = null } = {}) {
  const where = sourcePath ? `（${sourcePath}）` : '';
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`配置必须是 JSON 对象${where}`);
  }

  const databaseRaw = input.database ?? DEFAULTS.database;
  if (typeof databaseRaw !== 'string' || !databaseRaw.trim()) {
    throw new Error(`database 必须是非空路径${where}`);
  }
  const databasePath = path.resolve(baseDir, databaseRaw.trim());

  const seriesRaw = input.seriesDatabase ?? DEFAULTS.seriesDatabase;
  if (typeof seriesRaw !== 'string' || !seriesRaw.trim()) {
    throw new Error(`seriesDatabase 必须是非空路径${where}`);
  }
  const seriesDatabasePath = path.resolve(baseDir, seriesRaw.trim());

  const port = Number(input.port ?? DEFAULTS.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`port 必须是 0-65535 的整数${where}`);
  }

  const host = String(input.host ?? DEFAULTS.host).trim() || DEFAULTS.host;

  const rawCors = input.corsOrigins ?? DEFAULTS.corsOrigins;
  if (!Array.isArray(rawCors)) {
    throw new Error(`corsOrigins 必须是数组，例如 ["https://yourname.github.io"] 或 ["*"]${where}`);
  }
  const corsOrigins = rawCors.map((value) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`corsOrigins 里的每一项必须是非空字符串${where}`);
    }
    const origin = value.trim();
    if (origin === '*') return origin;
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`corsOrigins 不是合法来源：${origin}${where}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' && parsed.pathname !== '') {
      throw new Error(`corsOrigins 只接受 http/https 的 origin（不要带路径）：${origin}${where}`);
    }
    return parsed.origin;
  });

  return { databasePath, seriesDatabasePath, host, port, corsOrigins, sourcePath };
}

/** 读取配置文件（文件不存在时返回默认值，方便零配置启动）。 */
export function loadConfig(filePath, { baseDir } = {}) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) {
    return normalizeConfig({}, { baseDir: baseDir ?? path.dirname(absolute), sourcePath: null });
  }
  let json;
  try {
    json = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON（${absolute}）：${error.message}`);
  }
  const config = normalizeConfig(json, { baseDir: path.dirname(absolute), sourcePath: absolute });
  config.configPath = absolute;
  return config;
}
