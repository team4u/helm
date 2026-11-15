# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS base

# 基础工具（git 供插件管理，ca-certificates/curl 供 HTTPS 调用与健康检查）
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

# 启用 corepack 并自动对齐 package.json 的 packageManager (pnpm@12.16.1)
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# 1. 仅复制 workspace 依赖清单，最大化利用 Docker 层缓存加速 pnpm install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/
COPY packages/desktop/package.json packages/desktop/
COPY packages/env-io/package.json packages/env-io/
COPY packages/hub/package.json packages/hub/
COPY packages/kernel/package.json packages/kernel/
COPY packages/node/package.json packages/node/
COPY packages/payload/package.json packages/payload/
COPY packages/plugin-build/package.json packages/plugin-build/
COPY packages/plugin-client/package.json packages/plugin-client/
COPY packages/plugins/package.json packages/plugins/
COPY packages/protocol/package.json packages/protocol/
COPY packages/web/package.json packages/web/

# 跳过桌面端 Electron 二进制下载（Hub 容器无需桌面壳）
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# 2. 复制源码并按拓扑顺序构建 Hub 运行时及 Web 前端静态产物
COPY . .
RUN pnpm --filter @helm/protocol \
         --filter @helm/env-io \
         --filter @helm/node \
         --filter @helm/plugin-build \
         --filter @helm/plugin-client \
         --filter @helm/kernel \
         --filter @helm/plugins \
         --filter @helm/hub \
         --filter @helm/web \
         --filter @helm/cli \
         run build

# 3. 运行时环境配置
ENV NODE_ENV=production \
    HELM_HOST=0.0.0.0 \
    HELM_PORT=3202 \
    HELM_DATA_DIR=/data/.helm

VOLUME ["/data/.helm"]
EXPOSE 3202

# 启动 Hub（自动探测同级 packages/web/dist 托管前端页面，同时提供 API 与 /ws/node）
CMD ["node", "packages/hub/dist/main.js"]
