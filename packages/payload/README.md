# @helm/payload

Hub npm payload 组装器：把 Hub 组合根、kernel、官方插件、共享运行时包、web dist、CLI 与内置插件运行时资产（client / skill / assets）组织为一个自描述、可直接 `npm pack` / `npm publish` 的目录，并提供零依赖启动入口与 manifest/version/entry 契约。它是桌面端（`@helm/desktop`）业务更新的下载物。本文只覆盖本包的职责、构建、产物、测试与限制；发布流水线见[发布流程](../../docs/releasing.md)。

## 职责

- `build.mjs` 组装 `dist/` 发布包：以 hub/kernel/plugins/plugin-build/plugin-client/env-io/protocol/cli 的构建产物为输入，外部依赖取仓库已安装 pnpm 精确版本锁定，`@helm/*` 物化为 `file:./<pkg>.tgz`，携带 `web/dist` 与内置插件运行时资产；
- 产出 `start.mjs`（零依赖启动入口）与 `manifest.json`（`formatVersion=1` / `name` / `version` / `builtAt` / `nodeEngines` / `entries` / `entryChecksums`）；
- 自动扫描依赖闭包 peer 冲突生成 npm `overrides`（`.npmrc` 无法随 tarball 分发）。

## 构建命令

```bash
pnpm build                              # 仓库根：全仓拓扑构建，payload 最后执行
pnpm --filter @helm/payload run build   # 单独组装（要求 kernel/web/cli dist 已存在，缺失显式报错）
```

本包永远 `private: true`（组装器不是发布物）；发布只认 `dist/package.json`（默认名 `@team4u/helm-hub`，构建 env `HELM_PAYLOAD_PACKAGE` 可覆盖；`manifest.name` 与其同源，`manifest.version` 恒等于本包版本）。

## 产物布局

```text
dist/
  package.json        # 可直接 npm pack/publish 的独立包（files 白名单）
  manifest.json       # 契约（entries 相对 payload 根、POSIX 分隔；entryChecksums 为 sha256）
  start.mjs           # 零依赖启动入口（check | start）
  hub/ kernel/ plugins/ plugin-build/ protocol/ env-io/ cli/
  plugin-client/      # 浏览器 SDK 源码入口（exports 指向 src）
  web/dist/           # Vite 产物（start.mjs 以 HELM_WEB_DIST_DIR 显式定位）
```

tarball 内 manifest / start 位于包根（不是 `dist/` 子目录）。

## 启动入口

```bash
node start.mjs check   # 校验布局 + 八个运行时入口依赖解析 + node:sqlite/esbuild 实测（绝不执行 Hub）
node start.mjs start   # 依赖可解析时拉起 Hub 组合根（透传环境变量与信号）
```

退出码：`0` 校验通过；`1` 用法错误或 manifest/布局/checksum/路径契约损坏；`3` 布局合法但依赖缺失或运行时能力实测失败。

## 依赖补齐契约

- 消费侧（桌面 updater）：解包 tgz 后在包根执行 `npm install --omit=dev --ignore-scripts`（esbuild 平台包经 optionalDependencies 按目标平台自动安装），随后 `node start.mjs check` 验收；
- 诚实边界：tarball 本身**不携带 node_modules**（跨平台平台二进制决定 vendoring 须按平台多包发布，未做）；桌面安装包的自包含 baseline 由 `packages/desktop/scripts/assemble-hub.mjs` 按打包 runner 架构物化依赖闭包解决，与本包契约互补。

## 测试

`test/payload.test.ts`（integration 档）：真实执行组装与启动子进程，覆盖 manifest/checksum 契约、资产落位、web 同级探测命中、无 node_modules 断言、依赖缺失/篡改的显式退出码。网络验收（真实 npm pack、安装、候选目录改名与 Hub 启动）由 CI 以 `PAYLOAD_NPM_SMOKE=1` 执行，默认跳过。
