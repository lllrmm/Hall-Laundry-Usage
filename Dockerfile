# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# 三个服务 + 共享契约；全部零运行时依赖，无需 npm install
COPY packages/shared packages/shared
COPY packages/laundry-monitor packages/laundry-monitor
COPY packages/laundry-dashboard-api packages/laundry-dashboard-api
COPY packages/laundry-dashboard-webpage packages/laundry-dashboard-webpage

EXPOSE 8787 8788

# 默认启动前端；compose 会按服务覆盖 command
CMD ["node", "packages/laundry-dashboard-webpage/bin/serve.mjs", "--config", "/config/dashboard-webpage.config.json"]
