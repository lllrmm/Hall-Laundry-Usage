@echo off
REM 独立启动只读看板服务：http://127.0.0.1:8787
cd /d "%~dp0"
node bin\serve.mjs --config dashboard.config.json
