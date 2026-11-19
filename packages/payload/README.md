# @helmx/payload

Hub npm payload 组装器：把 Hub 组合根、kernel、官方插件、共享运行时包、web dist、CLI 与内置插件运行时资产（client / skill / assets）组织为一个自描述、可直接 `npm pack` / `npm publish` 的目录，并提供零依赖启动入口与 manifest/version/entry 契约。同一构建还组装**稳定 CLI 制品**（`dist-cli/`：完整 `helmx` 控制端的零依赖单文件 bundle，消费者一步 `npm install -g`，bin `helmx`）与**节点守护进程制品**（`dist-node/`：`helmx-node` 守护进程 bundle，bin `helmx-node` 指向 `dist/cli.js`，外部依赖恰为 `@earendil-works/chord` / `@earendil-works/pi-durable` / `birpc` / `ws` 四个精确版本，远端节点一步 `npm install -g` 即用；CLI 与 node 包均为发布硬依赖，缺失即组装失败）。本文只覆盖本包的职责、构建、产物、测试与限制；发布流水线见[发布流程](../../docs/releasing.md)。

## 职责

- `build.mjs` 组装 `dist/` 发布包：以 hub/kernel/plugins/plugin-build/env-io/protocol/cli 的构建产物为输入，外部依赖取仓库已安装 pnpm 精确版本锁定，六个 `@helmx` 运行时包（hub/kernel/plugins/plugin-build/env-io/protocol）**只以 npm 归档形式随包**（`file:./<pkg>.tgz`，各携自身 `dist/` 与 `package.json`；解包 staging 目录仅是打包输入，归档产出后即删）；CLI bundle 与 `web/dist` 直接位于 payload 根；
- 产出 `start.mjs`（零依赖启动入口）与 `manifest.json`（`formatVersion=1` / `name` / `version` / `builtAt` / `nodeEngines` / `entries` / `entryChecksums`）：六个运行时包条目指向消费侧 npm install 后的 `node_modules/@helmx/<pkg>/...` 布局，校验和**钉归档内打包字节**（npm 按 `file:` tarball 逐字节物化，装后 `checkLayout` 即证明安装树与发行字节一致）；`*Archive` 条目对归档字节本身做 sha256（装配稳定的运输完整性，与安装状态无关）；
- 自动扫描依赖闭包 peer 冲突生成 npm `overrides`（`.npmrc` 无法随 tarball 分发）；
- 归档内的 hub `package.json` **不携带 bin**（payload 内 hub 是经 `start.mjs` 启动的 `file:` 依赖，`start.mjs` 拥有环境契约；安装出的 bin 链接只会落向已废弃的旧布局）：payload 的唯一进程入口是 `start.mjs`；
- 组装 `dist-cli/` CLI 发布包（`src/assemble-cli.mjs`）：esbuild 把 `packages/cli/dist/index.js`（完整控制 CLI：核心命令表、经 HTTP 的动态插件命令、经 `packages/cli/src/launcher/` 实现的 `helmx update` 生命周期面）连同 `@helmx/env-io`（含共享更新引擎）→ `@helmx/protocol` → `typebox`、`tar` 闭包内联为单文件 ESM（保留 shebang），manifest 零 `dependencies`、bin `helmx`（单一来源 `packages/cli/package.json`）、版本与 payload 同源。组装期以 esbuild metafile 为权威硬校验 bundle 不得残留任何外部 `@helmx/*` import（本仓库不发布 `@helmx/*` 源码包，残留即全局安装必坏）；
- 组装 `dist-node/` 节点发布包（`src/assemble-node.mjs`）：esbuild 把 `@helmx/node` 的守护进程入口连同 `@helmx/env-io`（含共享更新引擎）与 `@helmx/protocol` 内联为 bundle，入口 `dist/cli.js`、bin `helmx-node`（单一来源 `packages/node/package.json`）、版本与 payload 同源；manifest 的 `dependencies` 恒为且仅为四个外部精确版本（`@earendil-works/chord` / `@earendil-works/pi-durable` / `birpc` / `ws`，取仓库 pnpm 实际安装版本，绝不携带 `^`/`~` 浮动范围）——守护进程的自升级按精确版本绑定，组装期同样硬校验不得残留外部 `@helmx/*` import；
- Hub payload 内的 `cli/dist/index.js` 与 `dist-cli/index.js` 是**同一份 bundle 字节**（一次 esbuild 输出、两个消费方）：payload 侧 `helmx` 与全局安装的 `helmx` 是同一个 CLI，且 CLI 的 workspace 闭包已内联，自包含地留在 payload 根而非随归档走；`cli/` 的 `package.json` 保留用于定位与审计；
- `helmx plugins build` 的编译器（`@helmx/plugin-build`）**有意不内联**进 bundle（其平台原生 esbuild 二进制只在真实执行过 npm install 的位置存在，内联即伪可用）：CLI 侧为计算式动态导入，按运行位置解析——Hub payload 布局内由 `node_modules/@helmx/plugin-build`（`plugin-build.tgz` 安装产物）提供；全局 CLI 依赖本机 Helmx 管理的 payload release 提供该编译器，否则显式报 `plugin_build_unavailable`。

## 构建命令

```bash
pnpm build                              # 仓库根：全仓拓扑构建，payload 最后执行
pnpm --filter @helmx/payload run build   # 单独组装（要求 kernel/web/cli/node dist 已存在，缺失显式报错）
```

本包永远 `private: true`（组装器不是发布物）；发布只认三个构建产物 manifest：`dist/package.json`（默认名 `@helmx/hub`，env `HELMX_PAYLOAD_PACKAGE` 可覆盖；`manifest.name` 与其同源，`manifest.version` 恒等于本包版本）、`dist-cli/package.json`（默认名 `@helmx/cli`，env `HELMX_CLI_PACKAGE` 可覆盖；版本与 payload 同源，`dependencies` 恒为空）与 `dist-node/package.json`（默认名 `@helmx/node`，env `HELMX_NODE_PACKAGE` 可覆盖；版本与 payload 同源，`dependencies` 恒为四个外部精确版本）。

## 产物布局

```text
dist/
  package.json        # 可直接 npm pack/publish 的独立包：六个 @helmx/* file:./<pkg>.tgz 条目 +
                      # 显式 files 白名单 12 项（六归档 + cli + web + start.mjs + manifest.json +
                      # LICENSE + THIRD_PARTY_NOTICES.md），不含任何解包组件目录
  manifest.json       # 契约（entries 相对 payload 根、POSIX 分隔；entryChecksums 为 sha256）
  start.mjs           # 零依赖启动入口（check | start）
  hub.tgz kernel.tgz plugins.tgz plugin-build.tgz env-io.tgz protocol.tgz
                      # 六个 @helmx 运行时包的 npm 归档（各携 package.json 与 dist/；
                      # 内置插件运行时资产打在 plugins.tgz 内；解包 staging 目录是临时打包
                      # 输入，归档产出后即删，payload 根不携带解包副本）
  cli/                # 自包含 CLI bundle（cli/dist/index.js 与 dist-cli/index.js 同字节；
                      # package.json 保留用于定位与审计）
  web/dist/           # Vite 产物（start.mjs 以 HELMX_WEB_DIST_DIR 显式定位）

dist-cli/
  package.json        # CLI 发布包（bin helmx、零依赖）
  index.js            # 单文件 CLI bundle（shebang ESM）

dist-node/
  package.json        # 节点发布包（bin helmx-node -> ./dist/cli.js、四个外部精确版本依赖）
  dist/cli.js         # 守护进程 bundle（内联 @helmx/node + @helmx/env-io + @helmx/protocol）
```

tarball 内 manifest / start 位于包根（不是 `dist/` 子目录）。CLI 与 node 制品同理：`dist-cli/`、`dist-node/` 即包根，发布须进入该目录 `npm pack` / `npm publish`。

## 启动入口

```bash
node start.mjs check   # 先校验安装状态（node_modules/@helmx/* 条目缺失即退出 3 并给出 npm install
                       # 补齐指引——未安装不等于损坏），再校验 manifest/entries/checksums 与严格相对
                       # 路径、跨七个运行时入口解析依赖（node_modules 下六包 + payload 根 cli bundle）、
                       # 实测 node:sqlite 与 esbuild 转译（绝不执行 Hub）
node start.mjs start   # 依赖可解析时拉起 Hub 组合根（node_modules/@helmx/hub/dist/main.js，透传环境
                       # 变量与信号；web/dist 存在且未显式配置时设置 HELMX_WEB_DIST_DIR——node_modules
                       # 安装布局下 hub 包的同级探测按设计落空，静态托管由此显式保障）
```

退出码：`0` 校验通过；`1` 用法错误或 manifest/布局/checksum/路径契约损坏；`3` 布局合法但——依赖尚未安装（先于校验和检出）、依赖缺失、或运行时能力实测失败（如 esbuild 原生二进制缺失）。

## 依赖补齐契约

- 消费侧：解包 tgz 后在包根执行 `npm install --omit=dev --ignore-scripts`——六个 `file:./<pkg>.tgz` 归档被 npm **逐字节物化**到 `node_modules/@helmx/*`（esbuild 平台包经 optionalDependencies 按目标平台自动安装），随后 `node start.mjs check` 验收安装树与发行字节一致；
- 诚实边界：tarball 本身**不携带 node_modules**（跨平台平台二进制决定 vendoring 须按平台多包发布，未做）。

## 测试

`test/payload.test.ts`（integration 档）：真实执行组装、npm pack、隔离 npm install 与启动子进程。组装契约（六归档 tgz-only、归档成员镜像仓库 dist 树、cli/web 落根、无解包组件目录、无 node_modules、node_modules 条目校验和钉归档内打包字节）、发布包契约（files 白名单、六 `file:` 条目、精确外部版本、manifest.name 同源）；负路径（未安装先于校验和退出 3 并附补齐指引、归档物化后篡改校验和退出 1、manifest 路径逃逸退出 1、依赖缺失时拒绝启动）；正路径（真实 pack → 安全解包 → 真实 install → check → 启动 Hub 并 HTTP 探测 `/api/auth/status` → 干净退出）。网络验收（真实 npm registry 交互）由 CI 以 `PAYLOAD_NPM_SMOKE=1` 执行，默认跳过。

CLI 与 node 制品验收同在 `test/payload.test.ts`（单文件共享一次组装——runner 按文件并发分进程，拆文件会与清理 `dist/` 的组装竞争）：CLI 组装契约（零依赖、bin、files 白名单、shebang、payload `cli/dist/index.js` 与制品 bundle 字节一致）、bundle 真跑（`--help` 与死端点的诚实错误信封）、真实 tarball `npm install -g` 到隔离 prefix 后 bin 可用；node 制品契约（四外部精确版本、唯一 bin、无外部 `@helmx/*` import）；payload e2e 内含 bundle CLI 对运行中 Hub 的真实 HTTP `status` 验收；黄金序列（全局 `helmx` 从真实 payload tarball 安装并健康门控启停：`update --tarball --version` → `update --status` → `update --stop`）由 CI 以 `PAYLOAD_NPM_SMOKE=1` 执行，默认跳过。
