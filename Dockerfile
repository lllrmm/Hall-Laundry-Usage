# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# 采集 + API；前端是纯静态文件，由 GitHub Pages / 静态托管提供，不再进镜像
COPY packages/shared packages/shared
COPY packages/laundry-monitor packages/laundry-monitor
COPY packages/laundry-dashboard-api packages/laundry-dashboard-api

EXPOSE 8787

# 默认启动 API；compose 会按服务覆盖 command
CMD ["node", "packages/laundry-dashboard-api/bin/serve.mjs", "--config", "/config/dashboard-api.config.json"]
