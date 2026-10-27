/**
 * 运行时配置：前端独立部署（不经过 laundry-web 的反向代理）时，
 * 把 API 地址写在这里，例如：
 *   window.__LAUNDRY_API_BASE__ = 'http://192.168.1.23:8787';
 * 留空表示同源请求 /api/*（由 laundry-web 或 Nginx 反代到 dashboard）。
 */
window.__LAUNDRY_API_BASE__ = '';
