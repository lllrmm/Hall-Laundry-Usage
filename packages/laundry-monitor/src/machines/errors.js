/**
 * 统一错误类型。
 *
 * 这个 API 的业务错误始终返回 HTTP 200，真实结果在 `meta.code` 里，
 * 所以错误对象同时保留 HTTP status 与业务 code，便于调用方区分处理。
 */

export class LaundryError extends Error {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {number|string|null} [options.code] 业务错误码（meta.code），或内部错误标识
   * @param {string|null} [options.endpoint] 出错的接口路径
   * @param {number|null} [options.status] HTTP 状态码
   * @param {unknown} [options.data] 服务端返回的 data（如字段校验错误详情）
   * @param {unknown} [options.cause] 底层异常
   */
  constructor(message, { code = null, endpoint = null, status = null, data = null, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LaundryError';
    this.code = code;
    this.endpoint = endpoint;
    this.status = status;
    this.data = data;
  }
}

/** token 缺失 / 失效（meta.code 4031、4032）。调用方应提示用户重新取 token，而不是重试。 */
export class LaundryAuthError extends LaundryError {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'LaundryAuthError';
  }
}
