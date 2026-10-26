#!/usr/bin/env node
/**
 * cdp_capture.mjs
 *
 * 用本机 Microsoft Edge（headless=new）+ 原生 Chrome DevTools Protocol（CDP）
 * 真实打开 https://laundry.ust.hk/ldr/app/tickets ，注入登录态，抓取全部网络请求，
 * 截全页 PNG，并生成 summary.md。
 *
 * 依赖：仅 Node >= 22（使用内置全局 WebSocket / fetch / AbortSignal.timeout），无需 npm install。
 *
 * 用法：
 *   node browser/cdp_capture.mjs
 *
 * token 来源（二选一）：
 *   1) 环境变量 LDR_TOKEN
 *   2) 同目录下的 .token 文件（内容为纯 token 字符串）
 *
 * 产物（全部写在脚本所在目录，即 workspace/browser/）：
 *   network.json  抓包结果（Authorization/token 已脱敏为 <TOKEN>）
 *   tickets.png   全页截图
 *   summary.md    人读摘要
 *   cdp_run.log   运行日志
 *   edge.log      Edge 进程 stdout/stderr
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = path.join(OUT_DIR, 'profile');
const NETWORK_JSON = path.join(OUT_DIR, 'network.json');
const SHOT_PNG = path.join(OUT_DIR, 'tickets.png');
const SUMMARY_MD = path.join(OUT_DIR, 'summary.md');
const RUN_LOG = path.join(OUT_DIR, 'cdp_run.log');
const EDGE_LOG = path.join(OUT_DIR, 'edge.log');

const START_URL = 'https://laundry.ust.hk/ldr/app/tickets';
const SITE_ORIGIN = 'https://laundry.ust.hk';
const API_MARK = '/ldr/api/';
const BODY_LIMIT = 3000;
const MASKED = '<TOKEN>';

// 账号信息（用于满足前端 getUsername()：ldr_student.user.email；来自该账号自身 API 数据）
const USER_EMAIL = 'rlidf@connect.ust.hk';
const USER_ID = '68cbac54f67f7b077d750a98';

const TOKEN = readToken();

const logLines = [];
function log(...args) {
  const line =
    `[${new Date().toISOString()}] ` +
    args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 0))).join(' ');
  console.log(line);
  logLines.push(line);
}
function mask(v) {
  if (typeof v !== 'string' || !TOKEN) return v;
  return v.split(TOKEN).join(MASKED);
}
function maskHeaders(h) {
  if (!h || typeof h !== 'object') return h || {};
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    out[k] = lk === 'authorization' || lk === 'cookie' || lk === 'set-cookie' ? MASKED : mask(String(v));
  }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readToken() {
  const env = process.env.LDR_TOKEN && process.env.LDR_TOKEN.trim();
  if (env) return env;
  const f = path.join(OUT_DIR, '.token');
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    /* ignore */
  }
  throw new Error('未找到 token：请设置环境变量 LDR_TOKEN，或写入 ' + f);
}

// ---------------------------------------------------------------- 基础工具

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

async function fetchJson(url, timeoutMs = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.json();
}

// ---------------------------------------------------------------- CDP 客户端

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    ws.addEventListener('message', (ev) => this._onMessage(ev));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP WebSocket 已关闭'));
      this.pending.clear();
    });
  }

  static connect(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(e);
        return;
      }
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error('WebSocket 连接超时: ' + url));
      }, timeoutMs);
      ws.addEventListener(
        'open',
        () => { clearTimeout(timer); resolve(new CDP(ws)); },
        { once: true }
      );
      ws.addEventListener(
        'error',
        (ev) => {
          clearTimeout(timer);
          reject(new Error('WebSocket error: ' + (ev && (ev.message || ev.type))));
        },
        { once: true }
      );
    });
  }

  _onMessage(ev) {
    let msg;
    try {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      else p.resolve(msg.result || {});
      return;
    }
    const arr = this.listeners.get(msg.method);
    if (!arr) return;
    for (const fn of arr.slice()) {
      try {
        fn(msg.params || {}, msg.sessionId);
      } catch (e) {
        log('CDP listener error', msg.method, e.message);
      }
    }
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
    return () => {
      const arr = this.listeners.get(method) || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('等待 CDP 事件超时: ' + method));
      }, timeoutMs);
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  send(method, params = {}, timeoutMs = 45000) {
    if (this.closed) return Promise.reject(new Error('CDP WebSocket 已关闭，无法发送 ' + method));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- 全局状态

const state = {
  port: 0,
  edgePid: null,
  edge: null,
  edgeExited: false,
  versionInfo: null,
  browserCdp: null,
  pageCdp: null,
  requests: new Map(),
  consoleLogs: [],
  exceptions: [],
  loadCount: 0,
  finalEval: null,
  pngBytes: 0,
};

function killEdge() {
  const pid = state.edgePid;
  if (!pid) return;
  try {
    if (state.browserCdp && !state.browserCdp.closed) {
      state.browserCdp.ws.send(JSON.stringify({ id: 999999, method: 'Browser.close', params: {} }));
    }
  } catch { /* ignore */ }
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  log('已结束 Edge 进程树 (taskkill /PID ' + pid + ' /T /F)');
}

// ---------------------------------------------------------------- 启动 Edge

async function waitForVersion(port, timeoutMs = 25000) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    if (state.edgeExited) {
      throw new Error('Edge 进程在就绪前退出，见 edge.log');
    }
    try {
      const info = await fetchJson(`http://127.0.0.1:${port}/json/version`, 2500);
      if (info && info.webSocketDebuggerUrl) return info;
    } catch (e) {
      lastErr = e;
    }
    await sleep(400);
  }
  throw new Error(
    `等待 Edge CDP 端口就绪超时（${timeoutMs}ms，端口 ${port}）: ${lastErr ? lastErr.message : '无响应'}`
  );
}

async function launchEdge(port) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (fs.existsSync(PROFILE)) fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const edgeOut = fs.openSync(EDGE_LOG, 'w');
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--hide-scrollbars',
    '--window-size=1280,2000',
    'about:blank',
  ];
  log('启动 Edge:', EDGE);
  log('参数:', args.join(' '));
  const child = spawn(EDGE, args, { stdio: ['ignore', edgeOut, edgeOut], windowsHide: true });
  state.edge = child;
  state.edgePid = child.pid;
  child.on('exit', (code, signal) => {
    state.edgeExited = true;
    log(`Edge 进程退出 code=${code} signal=${signal}`);
  });
  child.on('error', (e) => log('Edge spawn error:', e.message));
  log('Edge PID =', child.pid);
  return child;
}

async function findPageTarget(port) {
  let lastErr = null;
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, 3000);
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (e) {
      lastErr = e;
    }
    await sleep(250);
  }
  // 兜底：主动创建 target（新版 Chrome 要求 PUT）
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const t = await res.json();
      if (t.webSocketDebuggerUrl) return t;
    }
    lastErr = new Error('PUT /json/new -> HTTP ' + res.status);
  } catch (e) {
    lastErr = e;
  }
  throw new Error('找不到可用的 page target: ' + (lastErr ? lastErr.message : 'unknown'));
}

// ---------------------------------------------------------------- 注入脚本

const authPayload = JSON.stringify({
  token: TOKEN,
  user: { _id: USER_ID, email: USER_EMAIL },
  last_login: new Date().toISOString(),
});

const INJECT_SOURCE = `(() => {
  try {
    if (location.origin !== ${JSON.stringify(SITE_ORIGIN)}) return;
    localStorage.setItem('ldr_student', ${JSON.stringify(authPayload)});
    window.__LDR_TOKEN_INJECTED__ = true;
  } catch (e) { /* ignore */ }
})();`;

async function evaluate(expression, timeoutMs = 20000) {
  const res = await state.pageCdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, timeout: timeoutMs },
    timeoutMs + 5000
  );
  if (res.exceptionDetails) {
    throw new Error(
      'Runtime.evaluate 异常: ' +
        (res.exceptionDetails.exception
          ? res.exceptionDetails.exception.description || res.exceptionDetails.text
          : res.exceptionDetails.text)
    );
  }
  return res.result ? res.result.value : undefined;
}

const CHECK_AUTH_EXPR = `(() => {
  const out = { url: location.href, title: document.title };
  try {
    const raw = localStorage.getItem('ldr_student');
    if (!raw) { out.auth = 'MISSING'; return out; }
    const o = JSON.parse(raw);
    out.auth = o && o.token ? 'OK' : 'NO_TOKEN';
    out.last_login = o && o.last_login;
  } catch (e) { out.auth = 'ERR ' + e.message; }
  return out;
})()`;

// ---------------------------------------------------------------- 网络事件

function attachNetworkHandlers(cdp) {
  cdp.on('Network.requestWillBeSent', (p) => {
    const id = p.requestId;
    let r = state.requests.get(id);
    if (!r) {
      r = { requestId: id, redirects: [] };
      state.requests.set(id, r);
    }
    if (p.redirectResponse) {
      r.redirects.push({ status: p.redirectResponse.status, url: p.redirectResponse.url });
    }
    r.method = p.request.method;
    r.url = p.request.url;
    r.requestHeaders = p.request.headers;
    r.postData = typeof p.request.postData === 'string' ? p.request.postData.slice(0, 2000) : undefined;
    r.resourceType = p.type;
    r.initiatorType = p.initiator && p.initiator.type;
    r.wallTime = p.wallTime;
    r.timestamp = p.timestamp;
    if (!r.firstUrl) r.firstUrl = p.request.url;
  });

  cdp.on('Network.responseReceived', (p) => {
    const r = state.requests.get(p.requestId);
    if (!r) return;
    const resp = p.response || {};
    r.status = resp.status;
    r.statusText = resp.statusText;
    r.mimeType = resp.mimeType;
    r.responseHeaders = resp.headers;
    r.fromDiskCache = !!resp.fromDiskCache;
    r.fromServiceWorker = !!resp.fromServiceWorker;
    r.protocol = resp.protocol;
    r.remoteIPAddress = resp.remoteIPAddress;
    r.remotePort = resp.remotePort;
    r.responseUrl = resp.url;
  });

  cdp.on('Network.loadingFinished', (p) => {
    const r = state.requests.get(p.requestId);
    if (!r) return;
    r.finished = true;
    r.encodedDataLength = p.encodedDataLength;
  });

  cdp.on('Network.loadingFailed', (p) => {
    const r = state.requests.get(p.requestId);
    if (!r) return;
    r.failed = true;
    r.errorText = p.errorText;
    r.blockedReason = p.blockedReason;
  });

  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (state.consoleLogs.length >= 80) return;
    const text = (p.args || [])
      .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
      .join(' ');
    state.consoleLogs.push({ type: p.type, text: mask(text).slice(0, 500) });
  });

  cdp.on('Runtime.exceptionThrown', (p) => {
    if (state.exceptions.length >= 40) return;
    const d = p.exceptionDetails || {};
    state.exceptions.push(
      mask(`${d.text || 'exception'} ${d.exception ? d.exception.description || d.exception.value : ''}`).slice(0, 800)
    );
  });
}

async function waitForApiSettle(maxMs = 30000, quietMs = 2500) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const done = [...state.requests.values()].filter(
      (r) => r.url && r.url.includes(API_MARK) && (r.finished || r.failed)
    );
    if (done.length > 0) {
      await sleep(quietMs);
      return done.length;
    }
    await sleep(400);
  }
  return 0;
}

async function fetchResponseBodies() {
  for (const r of [...state.requests.values()]) {
    if (!r.url || !r.url.includes(API_MARK) || !r.finished) continue;
    try {
      const body = await state.pageCdp.send('Network.getResponseBody', { requestId: r.requestId }, 12000);
      let text = body.body || '';
      if (body.base64Encoded) {
        text = Buffer.from(text, 'base64').toString('utf8');
      }
      r.body = mask(text).slice(0, BODY_LIMIT);
      r.bodyLength = text.length;
    } catch (e) {
      r.bodyError = e.message;
    }
  }
}

// ---------------------------------------------------------------- 截图

async function captureScreenshot() {
  const metrics = await state.pageCdp.send('Page.getLayoutMetrics');
  const cs = metrics.cssContentSize || metrics.contentSize || { width: 1280, height: 2000 };
  const width = Math.max(1280, Math.ceil(cs.width));
  const height = Math.min(Math.max(900, Math.ceil(cs.height)), 12000);
  log('页面内容尺寸:', Math.ceil(cs.width) + 'x' + Math.ceil(cs.height), '=> 截图视口', width + 'x' + height);
  await state.pageCdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(1000);
  let shot;
  try {
    shot = await state.pageCdp.send(
      'Page.captureScreenshot',
      { format: 'png', fromSurface: true, captureBeyondViewport: true },
      60000
    );
  } catch (e) {
    log('captureBeyondViewport 失败，降级为普通视口截图:', e.message);
    shot = await state.pageCdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 60000);
  }
  const buf = Buffer.from(shot.data, 'base64');
  fs.writeFileSync(SHOT_PNG, buf);
  state.pngBytes = buf.length;
  log('截图已写入', SHOT_PNG, buf.length, 'bytes');
}

// ---------------------------------------------------------------- 主流程

async function main() {
  if (!fs.existsSync(EDGE)) throw new Error('找不到 Edge 可执行文件: ' + EDGE);
  log('=== CDP 抓包开始 ===');
  log('Node', process.version, '| workspace/browser =', OUT_DIR);

  state.port = await freePort();
  log('随机空闲端口:', state.port);

  await launchEdge(state.port);
  state.versionInfo = await waitForVersion(state.port, 25000);
  log('Edge 就绪:', state.versionInfo.Browser, '| Protocol', state.versionInfo['Protocol-Version']);
  log('browser ws:', state.versionInfo.webSocketDebuggerUrl);

  // 浏览器级别连接（用于最后 Browser.close）
  try {
    state.browserCdp = await CDP.connect(state.versionInfo.webSocketDebuggerUrl, 8000);
    log('已连接 browser-level CDP');
  } catch (e) {
    log('browser-level CDP 连接失败（不影响抓包）:', e.message);
    state.browserCdp = null;
  }

  const pageTarget = await findPageTarget(state.port);
  log('page target:', pageTarget.id, pageTarget.url);
  const cdp = await CDP.connect(pageTarget.webSocketDebuggerUrl, 15000);
  state.pageCdp = cdp;
  log('已连接 page-level CDP');

  attachNetworkHandlers(cdp);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable', {
    maxTotalBufferSize: 100 * 1024 * 1024,
    maxResourceBufferSize: 20 * 1024 * 1024,
    maxPostDataSize: 1024 * 1024,
  });
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 2000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
    acceptLanguage: 'en-US,en;q=0.9,zh-CN;q=0.8',
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT_SOURCE });
  log('已注册 localStorage 注入脚本（页面 origin 下 document_start 注入 ldr_student，token 用 <TOKEN> 表示）');

  // 首次导航
  const load1 = cdp.once('Page.loadEventFired', 40000).catch((e) => log('等待 load 事件:', e.message));
  log('导航到', START_URL);
  const nav = await cdp.send('Page.navigate', { url: START_URL }, 40000);
  log('Page.navigate 返回:', nav);
  await load1;
  state.loadCount++;
  log('load 事件已触发，等待 SPA 首次 API 请求...');
  let apiDone = await waitForApiSettle(30000, 2500);
  log('首轮 /ldr/api/ 完成请求数:', apiDone);

  // 校验登录态，必要时 evaluate 注入 + reload
  let auth = await evaluate(CHECK_AUTH_EXPR);
  log('登录态检查:', auth && auth.auth, '| url:', auth && auth.url);
  if (!auth || auth.auth !== 'OK') {
    log('注入未生效，使用 Runtime.evaluate 直接写入 localStorage 后 reload');
    await evaluate(`localStorage.setItem('ldr_student', ${JSON.stringify(authPayload)}); 'ok'`);
    const load2 = cdp.once('Page.loadEventFired', 40000).catch((e) => log('等待 reload load 事件:', e.message));
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(500);
    await load2;
    state.loadCount++;
    apiDone = await waitForApiSettle(30000, 3000);
    auth = await evaluate(CHECK_AUTH_EXPR);
    log('二次登录态检查:', auth && auth.auth, '| url:', auth && auth.url);
  }

  // 页面最终状态 + 文本
  state.finalEval = await evaluate(`(() => {
    const t = document.body ? document.body.innerText : '';
    return {
      url: location.href,
      title: document.title,
      auth: (() => { try { const r = localStorage.getItem('ldr_student'); return r ? (JSON.parse(r).token ? 'OK' : 'NO_TOKEN') : 'MISSING'; } catch (e) { return 'ERR'; } })(),
      text: t.slice(0, 8000),
      textLen: t.length,
      rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
      readyState: document.readyState,
    };
  })()`);
  log(
    '最终页面: url=' + (state.finalEval && state.finalEval.url),
    '| title=' + (state.finalEval && state.finalEval.title),
    '| readyState=' + (state.finalEval && state.finalEval.readyState),
    '| body 文本长度=' + (state.finalEval && state.finalEval.textLen)
  );

  // 截图
  await captureScreenshot();

  // 抓 API 响应体（截图后请求体仍在 buffer 中）
  await fetchResponseBodies();
  const apiReqs = [...state.requests.values()].filter((r) => r.url && r.url.includes(API_MARK));
  log('累计捕获 /ldr/api/ 请求数:', apiReqs.length);

  // 落盘 network.json
  const sorted = [...state.requests.values()].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const record = {
    capturedAt: new Date().toISOString(),
    environment: {
      browser: state.versionInfo.Browser,
      protocol: state.versionInfo['Protocol-Version'],
      edgePath: EDGE,
      node: process.version,
      viewport: '1280x2000',
      mode: 'headless=new',
    },
    startUrl: START_URL,
    finalUrl: state.finalEval && state.finalEval.url,
    title: state.finalEval && state.finalEval.title,
    readyState: state.finalEval && state.finalEval.readyState,
    token: MASKED,
    authState: state.finalEval && state.finalEval.auth,
    pageLoads: state.loadCount,
    counts: {
      totalRequests: sorted.length,
      apiRequests: apiReqs.length,
      apiFailed: apiReqs.filter((r) => r.failed).length,
      consoleMessages: state.consoleLogs.length,
      exceptions: state.exceptions.length,
    },
    pageText: (state.finalEval && state.finalEval.text) || '',
    consoleMessages: state.consoleLogs,
    exceptions: state.exceptions,
    apiRequests: apiReqs.map((r) => ({
      method: r.method,
      path: (r.url || '').replace(SITE_ORIGIN, ''),
      url: r.url,
      status: r.status,
      mimeType: r.mimeType,
      failed: !!r.failed,
      errorText: r.errorText,
      encodedDataLength: r.encodedDataLength,
      bodyLength: r.bodyLength,
    })),
    requests: sorted.map((r) => ({
      method: r.method,
      url: mask(r.url || ''),
      firstUrl: mask(r.firstUrl || ''),
      status: r.status !== undefined ? r.status : null,
      statusText: r.statusText,
      mimeType: r.mimeType,
      resourceType: r.resourceType,
      initiatorType: r.initiatorType,
      fromDiskCache: r.fromDiskCache,
      failed: !!r.failed,
      errorText: r.errorText,
      blockedReason: r.blockedReason,
      encodedDataLength: r.encodedDataLength,
      remoteIPAddress: r.remoteIPAddress,
      remotePort: r.remotePort,
      requestHeaders: maskHeaders(r.requestHeaders),
      responseHeaders: maskHeaders(r.responseHeaders),
      postData: mask(r.postData || ''),
      redirects: (r.redirects || []).map((x) => ({ status: x.status, url: mask(x.url) })),
      bodyLength: r.bodyLength,
      body: r.body,
      bodyError: r.bodyError,
    })),
  };
  fs.writeFileSync(NETWORK_JSON, JSON.stringify(record, null, 2), 'utf8');
  log('已写入', NETWORK_JSON, fs.statSync(NETWORK_JSON).size, 'bytes');

  // summary.md
  const summary = buildSummary(record, sorted, apiReqs);
  fs.writeFileSync(SUMMARY_MD, summary, 'utf8');
  log('已写入', SUMMARY_MD, fs.statSync(SUMMARY_MD).size, 'bytes');

  state.finalEval = { ...(state.finalEval || {}), ...(state.finalEval || {}) };
  log('=== CDP 抓包结束（成功）===');
}

// ---------------------------------------------------------------- summary.md

function prettyJsonSnippet(text, max = 900) {
  if (!text) return '';
  try {
    const obj = JSON.parse(text);
    return JSON.stringify(obj, null, 2).slice(0, max);
  } catch {
    return String(text).slice(0, max);
  }
}

function buildSummary(record, sorted, apiReqs) {
  const lines = [];
  lines.push('# Edge headless + CDP 抓包结果');
  lines.push('');
  lines.push(`- 抓包时间：${record.capturedAt}`);
  lines.push(`- 浏览器：${record.environment.browser}（headless=new，viewport 1280x2000）`);
  lines.push(`- 起点 URL：${record.startUrl}`);
  lines.push(`- 最终 URL：${record.finalUrl}`);
  lines.push(`- 页面标题：${record.title}`);
  lines.push(`- 登录态：${record.authState}（Bearer token 已脱敏为 ${MASKED}）`);
  lines.push(`- 请求总数：${record.counts.totalRequests}；/ldr/api/ 请求数：${record.counts.apiRequests}；失败：${record.counts.apiFailed}`);
  lines.push(`- 截图：tickets.png（${state.pngBytes} bytes，全页 ${record.environment.viewport} 视口）`);
  lines.push(`- JS 异常条数：${record.counts.exceptions}；console 消息条数：${record.counts.consoleMessages}`);
  lines.push('');
  lines.push('## 抓到的 /ldr/api/ 请求');
  lines.push('');
  lines.push('| # | 方法 | 路径 | 状态码 | MIME | 响应体长度 | 备注 |');
  lines.push('|---|------|------|--------|------|------------|------|');
  apiReqs.forEach((r, i) => {
    const note = r.failed ? `FAILED: ${r.errorText || ''}` : '';
    lines.push(
      `| ${i + 1} | ${r.method} | \`${(r.url || '').replace(SITE_ORIGIN, '')}\` | ${r.status ?? '-'} | ${r.mimeType || '-'} | ${r.bodyLength ?? '-'} | ${note} |`
    );
  });
  if (apiReqs.length === 0) lines.push('| - | - | （未捕获到 /ldr/api/ 请求） | - | - | - | - |');
  lines.push('');
  lines.push('## 全部网络请求（含静态资源）');
  lines.push('');
  lines.push('| 方法 | 状态 | 类型 | URL |');
  lines.push('|------|------|------|-----|');
  for (const r of sorted) {
    lines.push(
      `| ${r.method || '-'} | ${r.status !== undefined ? r.status : r.failed ? 'FAILED' : '-'} | ${r.resourceType || '-'} | ${mask((r.url || '').slice(0, 150))} |`
    );
  }
  lines.push('');
  lines.push('## 页面文本（可见内容摘要）');
  lines.push('');
  const text = (record.pageText || '').replace(/\n{3,}/g, '\n\n').trim();
  lines.push(text ? '```text\n' + text.slice(0, 4000) + '\n```' : '_（页面无可见文本）_');
  lines.push('');
  lines.push('## 关键 API 响应体摘要');
  lines.push('');
  for (const r of apiReqs) {
    const req = record.requests.find((x) => x.url === r.url && x.status === r.status && x.body);
    lines.push(`### ${r.method} ${(r.url || '').replace(SITE_ORIGIN, '')} -> ${r.status ?? '-'}`);
    if (!req || !req.body) {
      lines.push('');
      lines.push('_（无响应体或获取失败）_');
      lines.push('');
      continue;
    }
    lines.push('```json');
    lines.push(prettyJsonSnippet(req.body));
    lines.push('```');
    lines.push('');
  }
  if (record.exceptions.length) {
    lines.push('## JS 异常（浏览器控制台）');
    lines.push('');
    for (const e of record.exceptions) lines.push('- ' + e);
    lines.push('');
  }
  return lines.join('\n');
}

function buildFailureSummary(err) {
  const lines = [
    '# Edge headless + CDP 抓包结果（失败）',
    '',
    `- 时间：${new Date().toISOString()}`,
    `- Node：${process.version}`,
    `- Edge：${EDGE}`,
    `- 失败阶段：启动/连接/抓包过程中抛出异常`,
    '',
    '## 错误原文',
    '',
    '```text',
    String(err && (err.stack || err.message || err)).slice(0, 4000),
    '```',
    '',
    '## 运行日志',
    '',
    '```text',
    logLines.join('\n'),
    '```',
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------- 入口

try {
  await main();
  process.exitCode = 0;
} catch (err) {
  log('FATAL:', err.stack || err.message);
  try {
    fs.writeFileSync(SUMMARY_MD, buildFailureSummary(err), 'utf8');
    fs.writeFileSync(
      NETWORK_JSON,
      JSON.stringify(
        {
          ok: false,
          capturedAt: new Date().toISOString(),
          error: mask(String(err && (err.stack || err.message || err))),
          log: logLines.map(mask),
        },
        null,
        2
      ),
      'utf8'
    );
  } catch (e2) {
    log('写失败记录时出错:', e2.message);
  }
  process.exitCode = 1;
} finally {
  try {
    if (state.pageCdp) state.pageCdp.close();
    if (state.browserCdp) state.browserCdp.close();
  } catch { /* ignore */ }
  killEdge();
  try {
    fs.writeFileSync(RUN_LOG, logLines.join('\n') + '\n', 'utf8');
  } catch { /* ignore */ }
  log('日志已写入', RUN_LOG);
}
