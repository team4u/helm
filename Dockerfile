# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS base

# Base tools (git for plugin management; ca-certificates/curl for HTTPS calls and health checks)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

# Enable corepack and auto-align with package.json packageManager (pnpm@12.16.1)
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# 1. Copy only the workspace dependency manifests to maximize Docker layer caching for pnpm install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/
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

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# 2. Copy sources and build the Hub runtime and the Web frontend static assets in topological order
#    (@helm/env-io carries the shared update engine consumed by @helm/node; the CLI's local Hub
#    lifecycle surface lives in packages/cli/src/launcher).
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

# 3. Runtime environment configuration
ENV NODE_ENV=production \
    HELM_HOST=0.0.0.0 \
    HELM_PORT=3202 \
    HELM_DATA_DIR=/data/.helm

VOLUME ["/data/.helm"]
EXPOSE 3202

# Start the Hub (auto-detects the sibling packages/web/dist to serve the frontend, and provides both the API and /ws/node)
CMD ["node", "packages/hub/dist/main.js"]
