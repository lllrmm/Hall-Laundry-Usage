/**
 * 配置文件加载与校验。
 *
 * 配置文件是 JSON（示例见 monitor.config.example.json），支持 `${ENV_VAR}` 展开，
 * 相对路径（database）以配置文件所在目录为基准解析。
 *
 * 必填：bearer（或 bearerEnv 指向的环境变量，或环境变量 LDR_TOKEN）
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG_FILE = 'monitor.config.json';

/** 站点没有公开限流策略，间隔过小既没必要也有风险 */
export const MIN_POLL_INTERVAL_SECONDS = 5;
export const RECOMMENDED_POLL_INTERVAL_SECONDS = 15;

export const DEFAULTS = {
  baseUrl: 'https://laundry.ust.hk/ldr/api',
  pollIntervalSeconds: 60,
  timeoutMs: 15_000,
  database: './data/laundry.sqlite',
  seriesDatabase: './data/laundry-series.sqlite',
  retentionDays: 30,
  logLevel: 'info',
};

const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'silent']);

/**
 * 把字符串里的 `${NAME}` 替换成环境变量值；缺失的变量替换为空串。
 * @param {unknown} value
 * @param {Record<string, string | undefined>} [env]
 */
export function expandEnv(value, env = process.env) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => env[name] ?? '');
}

function resolveBearer(input, env) {
  const explicit = input.bearer === undefined ? '' : String(expandEnv(input.bearer, env)).trim();
  if (explicit) return explicit;

  if (input.bearerEnv) {
    const fromNamedEnv = String(env[String(input.bearerEnv)] ?? '').trim();
    if (fromNamedEnv) return fromNamedEnv;
  }

  const fallback = String(env.LDR_TOKEN ?? '').trim();
  return fallback || null;
}

/**
 * 校验并补全配置。
 * @param {Record<string, any>} input 配置对象
 * @param {object} [context]
 * @param {Record<string, string | undefined>} [context.env]
 * @param {string} [context.baseDir] 相对路径基准目录
 * @param {string} [context.sourcePath] 配置文件路径（仅用于错误信息）
 */
export function normalizeConfig(
  input,
  { env = process.env, baseDir = process.cwd(), sourcePath = null, requireBearer = true } = {},
) {
  const where = sourcePath ? `（${sourcePath}）` : '';
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`配置必须是 JSON 对象${where}`);
  }

  const bearer = resolveBearer(input, env);
  if (!bearer && requireBearer) {
    throw new Error(
      `配置缺少 bearer${where}：填写 "bearer"，或用 "bearerEnv" 指向环境变量，或设置 LDR_TOKEN。` +
        'token 来自网页 localStorage["ldr_student"].token',
    );
  }

  const baseUrl = String(input.baseUrl ?? DEFAULTS.baseUrl).trim();
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error(`baseUrl 必须是 http(s) 地址${where}，当前为 ${JSON.stringify(baseUrl)}`);
  }

  const pollIntervalSeconds = Number(input.pollIntervalSeconds ?? DEFAULTS.pollIntervalSeconds);
  if (!Number.isFinite(pollIntervalSeconds) || pollIntervalSeconds <= 0) {
    throw new Error(`pollIntervalSeconds 必须是正数${where}`);
  }
  if (pollIntervalSeconds < MIN_POLL_INTERVAL_SECONDS) {
    throw new Error(
      `pollIntervalSeconds 不能小于 ${MIN_POLL_INTERVAL_SECONDS} 秒${where}；` +
        `站点未公开限流，建议 >= ${RECOMMENDED_POLL_INTERVAL_SECONDS} 秒`,
    );
  }

  const timeoutMs = Number(input.timeoutMs ?? DEFAULTS.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`timeoutMs 必须是正数${where}`);
  }

  const databaseRaw = input.database ?? DEFAULTS.database;
  if (typeof databaseRaw !== 'string' || !databaseRaw.trim()) {
    throw new Error(`database 必须是非空路径字符串${where}`);
  }
  const databasePath = path.resolve(baseDir, expandEnv(databaseRaw.trim(), env));

  const seriesRaw = input.seriesDatabase ?? DEFAULTS.seriesDatabase;
  if (typeof seriesRaw !== 'string' || !seriesRaw.trim()) {
    throw new Error(`seriesDatabase 必须是非空路径字符串${where}`);
  }
  const seriesDatabasePath = path.resolve(baseDir, expandEnv(seriesRaw.trim(), env));

  let retentionDays = input.retentionDays === undefined ? DEFAULTS.retentionDays : input.retentionDays;
  if (retentionDays !== null) {
    retentionDays = Number(retentionDays);
    if (!Number.isFinite(retentionDays) || retentionDays < 0) {
      throw new Error(`retentionDays 必须是 >= 0 的数字，或 null 表示不清理${where}`);
    }
  }

  const logLevel = String(input.logLevel ?? DEFAULTS.logLevel);
  if (!LOG_LEVELS.has(logLevel)) {
    throw new Error(`logLevel 只能是 ${[...LOG_LEVELS].join(' / ')}${where}`);
  }

  const warnings = [];
  if (!bearer) {
    warnings.push('配置里没有 bearer：stats/export 不需要，但 run/once 必须有');
  }
  if (pollIntervalSeconds < RECOMMENDED_POLL_INTERVAL_SECONDS) {
    warnings.push(
      `pollIntervalSeconds=${pollIntervalSeconds} 偏小；站点没有公开限流策略，建议 >= ${RECOMMENDED_POLL_INTERVAL_SECONDS} 秒`,
    );
  }

  return {
    bearer,
    baseUrl,
    pollIntervalSeconds,
    pollIntervalMs: Math.round(pollIntervalSeconds * 1000),
    timeoutMs,
    databasePath,
    seriesDatabasePath,
    retentionDays,
    logLevel,
    warnings,
    sourcePath,
  };
}

/**
 * 从文件加载配置。
 * @param {string} filePath
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {boolean} [options.requireBearer] stats/export 这类只读命令可以传 false
 */
export function loadConfig(filePath, { env = process.env, requireBearer = true } = {}) {
  const absolute = path.resolve(filePath);

  let text;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new Error(`读不到配置文件 ${absolute}：${error.message}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON（${absolute}）：${error.message}`);
  }

  const config = normalizeConfig(json, {
    env,
    baseDir: path.dirname(absolute),
    sourcePath: absolute,
    requireBearer,
  });
  config.configPath = absolute;
  return config;
}
