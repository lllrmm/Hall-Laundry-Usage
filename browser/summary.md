# Edge headless + CDP 抓包结论：失败（沙箱环境不可用）

## 一句话结论

**在这个 DSH 沙箱环境里，Edge headless 无法启动成功（浏览器进程启动约 0.1–0.2 秒即 FATAL 崩溃），因此 CDP 抓包不可行；`/json/version`、WebSocket 握手、`Network.enable`、截图这些后续步骤一步都没走到。**

## 失败阶段：进程启动阶段（不是 CDP 协议问题）

- Edge 能拉起进程、短暂打印 `DevTools listening on ws://127.0.0.1:<port>/devtools/browser/...`，但同一瞬间（<0.2s）就因命名管道创建失败而 `FATAL` 退出；
- `/json/version` 端口只在崩溃前的极短窗口存在，无法稳定用于 WebSocket 握手；
- 因此没有真实页面加载、没有任何 `/ldr/api/` 浏览器抓包记录、没有截图。

## 关键错误原文（各一行）

主因（Edge 浏览器进程创建 mojo IPC 命名管道被沙箱拒绝）：

```text
[43296:8696:1027/015509.943:FATAL:mojo\public\cpp\platform\platform_channel.cc:187] Check failed: . : Access is denied. (0x5)
```

伴随错误：

```text
[1027/015509.860:ERROR:third_party\crashpad\crashpad\client\crashpad_client_win.cc:457] OpenProcess: Access is denied. (0x5)
[3748:17452:1027/015915.780:ERROR:content\browser\network_sandbox.cc:418] Failed to grant sandbox access to cache directory ...\profile_A2\Default\Cache\Cache_Data: Access is denied. (0x5)
```

沙箱机制验证（子进程 ←→ 命名管道被拒，正是 Chromium IPC 的工作方式）：

```text
CHILD_CONNECT_ERR EPERM connect EPERM \\.\pipe\dsh_child_connect_probe
EPERM: spawnSync cmd.exe EPERM
```

受限制令牌证据（`browser/whoami_groups.txt`）：`Mandatory Label\Low Mandatory Level  S-1-16-4096`。

## 证据文件（均在 browser/ 下）

| 文件 | 说明 |
|------|------|
| `cdp_run.log` | cdp_capture.mjs 首次运行的完整日志（等待 /json/version 时 Edge 已退出） |
| `edge.log` | 首次启动的 Edge stderr，含 `FATAL ... platform_channel.cc:187 ... Access is denied` |
| `edge_A2.log` | 追加 `--disable-breakpad --disable-crash-reporter --no-crash-upload` 后的日志：DevTools 端口已打印但仍 FATAL，且 `network_sandbox.cc` 授权目录被拒 |
| `edge_sp.log` | 追加 `--single-process --no-zygote` 的日志：同样 FATAL |
| `edge_try_A.log` | 参数矩阵 A（非 single-process）完整启动日志 |
| `diag_pipe.mjs` / `diag_pipe_child.mjs` | 沙箱能力诊断脚本，输出命名管道/带管道 stdio 的 EPERM 证据 |
| `whoami_groups.txt` | 进程令牌组（Low Mandatory Level 受限令牌） |
| `network.json` | **失败记录**（不是抓包结果）：`ok:false` + 错误 + 日志，未伪造任何请求数据 |
| `cdp_capture.mjs` | 完整 CDP 抓包脚本（启动 Edge → /json/version → WebSocket → 注入 localStorage → Network 抓包 → 全页截图）。在未被沙箱限制的环境应可直接运行 |
| `tickets.png` | **不存在**（截图未生成） |

尝试过的启动参数矩阵（全部 <1s 崩溃）：
1. `--headless=new --no-sandbox --disable-gpu --user-data-dir=browser/profile`
2. 上组 + `--disable-breakpad --disable-crash-reporter --no-crash-upload`
3. 上组 + `--single-process --no-zygote`

## 补充：Firefox 也不能作为替代通道

本机 Firefox 158.0.1 在 `MOZ_FORCE_DISABLE_E10S=1` 单进程 headless 下进程能存活，但：
- `--remote-debugging-port` 的 Remote Agent 端口始终未监听（node fetch `/status`、`/json/version`、`/session` 全部 `fetch failed`）；
- `--screenshot` 未产出任何 PNG 文件。
因此 Firefox 也无法提供浏览器侧抓包/截图能力。

## 结论与建议

1. **明确回答：不能。** 该沙箱（Low Mandatory Level 受限令牌 + 禁止命名管道/句柄继承）与 Chromium 的 mojo IPC 架构不兼容，Edge/Chrome 系浏览器在本会话中无法运行，CDP 抓包无从谈起。
2. 本会话已有的真实数据均来自 **Node fetch 的 HTTP 层抓包**（见 `dump/api/*.json`），不含浏览器渲染层证据。
3. 如仍需要"真实浏览器 + CDP"证据，只有两条路：
   - 在不受该沙箱限制的普通 Windows 会话/CI 中运行 `node browser/cdp_capture.mjs`（脚本已就绪，token 从 `LDR_TOKEN` 环境变量或根目录 `token.txt` 读取，输出已脱敏）；
   - 由用户手动用同样的 Edge 参数（`--headless=new --remote-debugging-port=9222 --user-data-dir=<任意可写目录>`）在沙箱外启动 Edge，再由 agent 侧通过 `http://127.0.0.1:9222` 连接 CDP。
4. 清理：本次测试启动的 Edge/Firefox 进程已全部结束，无残留 debug 端口监听（12630/12631/12640/12641/12742/12743 均无监听）。

## 安全说明

响应中的 Bearer token 一律以 `<TOKEN>` 表示；`network.json`、日志中未写入 token 明文。真实 token 仅存在于 workspace 根目录的 `token.txt`（本机文件，勿提交 git）。
