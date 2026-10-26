@echo off
REM 独立启动轮询服务（30s 一次），关闭窗口或 Ctrl+C 即可停止
cd /d "%~dp0"
node bin\cli.mjs run --config monitor.config.json
