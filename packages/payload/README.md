# @helm/payload

Hub npm payload 组装器：把 Hub 组合根、kernel、官方插件、共享运行时包、web dist、CLI 与内置插件运行时资产（client / skill / assets）组织为一个自描述、可直接 `npm pack` / `npm publish` 的目录，并提供零依赖启动入口与 manifest/version/entry 契约。同一构建还组装**稳定 CLI 制品**（`dist-cli/`：完整 `helm` 控制端的零依赖单文件 bundle，消费者一步 `npm install -g`，bin `helm`）与**节点守护进程制品**（`dist-node/`：`helm-node` 守护进程 bundle，bin `helm-node` 指向 `dist/cli.js`，外部依赖恰为 `@earendil-works/chord` / `@earendil-works/pi-durable` / `birpc` / `ws` 四个精确版本，远端节点一步 `npm install -g` 即用；CLI 与 node 包均为发布硬依赖，缺失即组装失败）。本文只覆盖本包的职责、构建、产物、测试与限制；发布流水线见[发布流程](../../docs/releasing.md)。

## 职责

- `build.mjs` 组装 `dist/` 发布包：以 hub/kernel/plugins/plugin-build/env-io/protocol/cli 的构建产物为输入，外部依赖取仓库已安装 pnpm 精确版本锁定，`@helm/*` 物化为 `file:./<pkg>.tgz`，携带 `web/dist` 与内置插件运行时资产；
- 产出 `start.mjs`（零依赖启动入口）与 `manifest.json`（`formatVersion=1` / `name` / `version` / `builtAt` / `nodeEngines` / `entries` / `entryChecksums`）；
- 自动扫描依赖闭包 peer 冲突生成 npm `overrides`（`.npmrc` 无法随 tarball 分发）；
- 组装 `dist-cli/` CLI 发布包（`src/assemble-cli.mjs`）：esbuild 把 `packages/cli/dist/index.js`（完整控制 CLI：核心命令表、经 HTTP 的动态插件命令、经 `packages/cli/src/launcher/` 实现的 `helm update` 生命周期面）连同 `@helm/env-io`（含共享更新引擎）→ `@helm/protocol` → `typebox`、`tar` 闭包内联为单文件 ESM（保留 shebang），manifest 零 `dependencies`、bin `helm`（单一来源 `packages/cli/package.json`）、版本与 payload 同源。组装期以 esbuild metafile 为权威硬校验 bundle 不得残留任何外部 `@helm/*` import（本仓库不发布 `@helm/*` 源码包，残留即全局安装必坏）；
- 组装 `dist-node/` 节点发布包：esbuild 把 `@helm/node` 的守护进程入口连同 `@helm/env-io`（含共享更新引擎）与 `@helm/protocol` 内联为 bundle，入口 `dist/cli.js`、bin `helm-node`（单一来源 `packages/node/package.json`）、版本与 payload 同源；manifest 的 `dependencies` 恒为且仅为四个外部精确版本（`@earendil-works/chord` / `@earendil-works/pi-durable` / `birpc` / `ws`）——守护进程的双包自升级（`@team4u/helm-node` + `@team4u/helm-cli`）按精确版本绑定，组装期同样硬校验不得残留外部 `@helm/*` import 或浮动范围；
- Hub payload 内的 `cli/dist/index.js` 与 `dist-cli/index.js` 是**同一份 bundle 字节**（一次 esbuild 输出、两个消费方）：payload 侧 `helm` 与全局安装的 `helm` 是同一个 CLI，且 CLI 的 workspace 闭包已内联，payload 根依赖集无需为此新增条目；`cli/dist` 的其余 tsc 产物保留为布局/审计辅助资产；
- `helm plugins build` 的编译器（`@helm/plugin-build`）**有意不内联**进 bundle（其平台原生 esbuild 二进制只在真实执行过 npm install 的位置存在，内联即伪可用）：CLI 侧为计算式动态导入，按运行位置解析——Hub payload 布局内由同级 `node_modules/@helm/plugin-build`（`plugin-build.tgz` 安装产物）提供；全局 CLI 依赖本机 Helm 管理的 payload release 提供该编译器，否则显式报 `plugin_build_unavailable`。

## 构建命令

```bash
pnpm build                              # 仓库根：全仓拓扑构建，payload 最后执行
pnpm --filter @helm/payload run build   # 单独组装（要求 kernel/web/cli/node dist 已存在，缺失显式报错）
```

本包永远 `private: true`（组装器不是发布物）；发布只认三个构建产物 manifest：`dist/package.json`（默认名 `@team4u/helm-hub`，env `HELM_PAYLOAD_PACKAGE` 可覆盖；`manifest.name` 与其同源，`manifest.version` 恒等于本包版本）、`dist-cli/package.json`（默认名 `@team4u/helm-cli`，env `HELM_CLI_PACKAGE` 可覆盖；版本与 payload 同源，`dependencies` 恒为空）与 `dist-node/package.json`（默认名 `@team4u/helm-node`，env `HELM_NODE_PACKAGE` 可覆盖；版本与 payload 同源，`dependencies` 恒为四个外部精确版本）。

## 产物布局

```text
dist/
  package.json        # 可直接 npm pack/publish 的独立包（files 白名单）
  manifest.json       # 契约（entries 相对 payload 根、POSIX 分隔；entryChecksums 为 sha256）
  start.mjs           # 零依赖启动入口（check | start）
  hub/ kernel/ plugins/ plugin-build/ protocol/ env-io/ cli/
  cli/dist/index.js   # 与 dist-cli/index.js 相同字节的零依赖 CLI bundle
  web/dist/           # Vite 产物（start.mjs 以 HELM_WEB_DIST_DIR 显式定位）

dist-cli/
  package.json        # CLI 发布包（bin helm、零依赖）
  index.js            # 单文件 CLI bundle（shebang ESM）

dist-node/
  package.json        # 节点发布包（bin helm-node -> dist/cli.js、四个外部精确版本依赖）
  dist/cli.js         # 守护进程 bundle（内联 @helm/node + @helm/env-io + @helm/protocol）
```

tarball 内 manifest / start 位于包根（不是 `dist/` 子目录）。CLI 与 node 制品同理：`dist-cli/`、`dist-node/` 即包根，发布须进入该目录 `npm pack` / `npm publish`。

## 启动入口

```bash
node start.mjs check   # 校验布局 + 七个运行时入口依赖解析 + node:sqlite/esbuild 实测（绝不执行 Hub）
node start.mjs start   # 依赖可解析时拉起 Hub 组合根（透传环境变量与信号）
```

退出码：`0` 校验通过；`1` 用法错误或 manifest/布局/checksum/路径契约损坏；`3` 布局合法但依赖缺失或运行时能力实测失败。

## 依赖补齐契约

- 消费侧（桌面 updater）：解包 tgz 后在包根执行 `npm install --omit=dev --ignore-scripts`（esbuild 平台包经 optionalDependencies 按目标平台自动安装），随后 `node start.mjs check` 验收；
- 诚实边界：tarball 本身**不携带 node_modules**（跨平台平台二进制决定 vendoring 须按平台多包发布，未做）；桌面安装包的自包含 baseline 由 `packages/desktop/scripts/assemble-hub.mjs` 按打包 runner 架构物化依赖闭包解决，与本包契约互补。

## 测试

`test/payload.test.ts`（integration 档）：真实执行组装与启动子进程，覆盖 manifest/checksum 契约、资产落位、web 同级探测命中、无 node_modules 断言、依赖缺失/篡改的显式退出码。网络验收（真实 npm pack、安装、候选目录改名与 Hub 启动）由 CI 以 `PAYLOAD_NPM_SMOKE=1` 执行，默认跳过。

CLI 制品验收同在 `test/payload.test.ts`（单文件共享一次组装——runner 按文件并发分进程，拆文件会与清理 `dist/` 的组装竞争）：组装契约（零依赖、bin、files 白名单、shebang、payload `cli/dist/index.js` 与制品 bundle 字节一致）、bundle 真跑（`--help` 与死端点的诚实错误信封）、真实 tarball `npm install -g` 到隔离 prefix 后 bin 可用；payload e2e 内含 bundle CLI 对运行中 Hub 的真实 HTTP `status` 验收；黄金序列（全局 `helm` 从真实 payload tarball 安装并健康门控启停：`update --tarball --version` → `update --status` → `update --stop`）由 CI 以 `PAYLOAD_NPM_SMOKE=1` 执行，默认跳过。
