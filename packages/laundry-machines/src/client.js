import { LaundryError, LaundryAuthError } from './errors.js';
import { normalizeResponse } from './normalize.js';
import { resolveToken } from './token.js';

/** 生产环境 API 基址 */
export const DEFAULT_BASE_URL = 'https://laundry.ust.hk/ldr/api';

/** 机器状态接口路径 */
export const MACHINES_ENDPOINT = '/app/laundry-rooms/machines';

/**
 * 只读客户端：查询 HKUST 洗衣房机器实时状态。
 *
 * token 取自网页登录态：localStorage["ldr_student"].token
 *
 * @example
 * import { createClient } from 'hkust-laundry-machines';
 *
 * const client = createClient({ token: process.env.LDR_TOKEN });
 * const status = await client.getMachines();
 * const dryers = status.machines.filter((m) => m.kind === 'dryer');
 * console.log('free dryers:', dryers.filter((m) => m.available).length);
 */
export class LaundryClient {
  /**
   * @param {object} [options]
   * @param {string} [options.token] Bearer token；不传则依次读 LDR_TOKEN 环境变量、./token.txt
   * @param {string} [options.baseUrl] API 基址，默认生产环境
   * @param {typeof fetch} [options.fetch] 自定义 fetch 实现（测试/代理用）
   * @param {number} [options.timeoutMs] 单次请求超时，默认 15000
   * @param {string} [options.userAgent] User-Agent
   * @param {string} [options.tokenFile] token.txt 文件名，默认 "token.txt"
   */
  constructor({
    token,
    baseUrl = DEFAULT_BASE_URL,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = 15_000,
    userAgent = 'hkust-laundry-machines/0.1.0',
    tokenFile = 'token.txt',
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new LaundryError('global fetch is not available; Node.js >= 18 is required (or pass options.fetch)');
    }

    const resolvedToken = resolveToken({ token, file: tokenFile });
    if (!resolvedToken) {
      throw new LaundryError(
        'Missing token: pass { token }, set env LDR_TOKEN, or create token.txt. ' +
          'Get it from the web app: localStorage["ldr_student"].token',
        { code: 4031 },
      );
    }

    /** @private */ this._token = resolvedToken;
    /** @private */ this._baseUrl = String(baseUrl).replace(/\/+$/, '');
    /** @private */ this._fetch = fetchImpl;
    /** @private */ this._timeoutMs = timeoutMs;
    /** @private */ this._userAgent = userAgent;
  }

  /** 当前使用的 API 基址 */
  get baseUrl() {
    return this._baseUrl;
  }

  /**
   * 拉取原始响应（不做归一化，保留服务端结构）。
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] 外部取消信号
   * @returns {Promise<{meta: {code: number, message: string}, data: any}>}
   */
  async getMachinesRaw({ signal } = {}) {
    const url = this._baseUrl + MACHINES_ENDPOINT;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new LaundryError(`Request timed out after ${this._timeoutMs} ms`, {
        code: 'TIMEOUT',
        endpoint: MACHINES_ENDPOINT,
      }));
    }, this._timeoutMs);

    const onAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      let response;
      try {
        response = await this._fetch(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this._token}`,
            'User-Agent': this._userAgent,
          },
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof LaundryError) throw error; // 超时原因
        if (signal?.aborted || error?.name === 'AbortError') {
          throw new LaundryError('Request aborted', { code: 'ABORTED', endpoint: MACHINES_ENDPOINT, cause: error });
        }
        throw new LaundryError(`Network error: ${error?.message ?? error}`, {
          code: 'NETWORK_ERROR',
          endpoint: MACHINES_ENDPOINT,
          cause: error,
        });
      }

      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new LaundryError(`Non-JSON response (HTTP ${response.status})`, {
          code: 'INVALID_RESPONSE',
          endpoint: MACHINES_ENDPOINT,
          status: response.status,
          data: text.slice(0, 200),
        });
      }

      const code = payload?.meta?.code;
      const message = payload?.meta?.message ?? '';
      const info = { code, endpoint: MACHINES_ENDPOINT, status: response.status, data: payload?.data };

      if (code === 4031) {
        throw new LaundryAuthError('Missing bearer token (4031)', info);
      }
      if (code === 4032) {
        throw new LaundryAuthError(
          'Invalid or expired bearer token (4032); re-login and copy localStorage["ldr_student"].token',
          info,
        );
      }
      if (code !== 200) {
        throw new LaundryError(`API error ${code}: ${message}`, info);
      }

      return payload;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 查询机器状态（推荐用法）：返回归一化后的结构。
   * @param {object} [options]
   * @param {AbortSignal} [options.signal] 外部取消信号
   * @param {number} [options.now] 计算剩余时间的基准时间（测试用）
   * @returns {Promise<ReturnType<typeof normalizeResponse>>}
   */
  async getMachines({ signal, now = Date.now() } = {}) {
    const payload = await this.getMachinesRaw({ signal });
    return normalizeResponse(payload, now);
  }
}

/**
 * 创建客户端的快捷函数。
 * @param {ConstructorParameters<typeof LaundryClient>[0]} [options]
 * @returns {LaundryClient}
 */
export function createClient(options) {
  return new LaundryClient(options);
}
