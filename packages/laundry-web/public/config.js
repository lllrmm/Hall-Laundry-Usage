/**
 * 运行时 API 地址解析。
 *
 * 优先级：
 *   1. URL 参数 ?api=https://api.example.com   （GitHub Pages 等静态托管用）
 *   2. window.__LAUNDRY_API_BASE__             （例如写死在本文件，用于固定部署）
 *   3. 空字符串                                （同源，由 laundry-web / Nginx 反代 /api）
 *
 * 只接受 http/https；地址末尾的 / 会被去掉（后续拼 /api/xxx）。
 */
(function (root) {
  'use strict';

  /** 固定部署时可直接改这里，例如 'https://laundry-api.example.com'；同源留空 */
  root.__LAUNDRY_API_BASE__ = '';

  function normalize(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    let parsed;
    try {
      parsed = new URL(value.trim());
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const base = `${parsed.origin}${parsed.pathname}`;
    return base.replace(/\/+$/, '');
  }

  /**
   * 解析页面应使用的 API 基址。
   * @param {string} [search] 页面的 location.search，例如 '?api=https%3A%2F%2Fapi.example.com'
   * @returns {string} 空字符串表示同源
   */
  root.__resolveLaundryApiBase__ = function resolveLaundryApiBase(search) {
    let fromParam = null;
    try {
      fromParam = normalize(new URLSearchParams(search ?? '').get('api'));
    } catch {
      fromParam = null;
    }
    if (fromParam) return fromParam;
    return normalize(root.__LAUNDRY_API_BASE__) || '';
  };
})(typeof window !== 'undefined' ? window : globalThis);
