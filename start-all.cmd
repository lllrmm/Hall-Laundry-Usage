@echo off
REM 一键启动两个服务（各自独立窗口，关掉窗口即停止对应服务）
REM   1. 采集服务：每 60 秒抓一次，写入 packages\laundry-monitor\data\laundry.sqlite
REM      + packages\laundry-monitor\data\laundry-series.sqlite（日序列库）
REM   2. 看板服务：http://127.0.0.1:8787（只读上述两个库，聚合在浏览器端）
cd /d "%~dp0"

start "laundry-monitor" cmd /k "cd /d "%~dp0packages\laundry-monitor" && node bin\cli.mjs run --config monitor.config.json"
start "laundry-dashboard" cmd /k "cd /d "%~dp0packages\laundry-dashboard" && node bin\serve.mjs --config dashboard.config.json"

echo.
echo 已启动：
echo   采集服务  -^> 关闭 "laundry-monitor" 窗口即停止
echo   看板服务  -^> http://127.0.0.1:8787 （关闭 "laundry-dashboard" 窗口即停止）
echo.
timeout /t 3 >nul
