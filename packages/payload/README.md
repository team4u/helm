# @helm/payload — Hub npm payload（最小骨架）

Electron 桌面薄壳的目标：从公开 npm 拉取最新 Hub 内容并直接运行。本包是仓库内的
payload 组装器：把 kernel dist、web dist、CLI dist 与内置插件运行时资产（client /
skill / assets）组织为一个自描述的可发布目录，并提供零依赖启动入口与
manifest/version/entry 契约。**本阶段不做 Electron UI，不解决依赖自包含。**

## 构建

```bash
pnpm build                 # 仓库根：全仓拓扑构建，payload 最后执行
pnpm --filter @helm/payload run build   # 单独组装（要求 kernel/web/cli dist 已存在，缺失显式报错）
```

组装产物在 `packages/payload/dist/`：

```
dist/
  manifest.json        # 契约：formatVersion=1 / name / version / builtAt / nodeEngines / entries / entryChecksums
  start.mjs            # 零依赖启动入口（check | start）
  kernel/
    package.json       # 内核依赖声明（start.mjs 依赖解析清单的来源）
    dist/              # kernel tsc 产物
    dist/builtin-plugins/<name>/{client,skill,assets}   # 运行时资产（各解析器 dist 侧首选探测位）
  web/dist/            # Vite 产物；与 kernel 同级，命中 hub.ts 默认探测 ../../../web/dist
  cli/dist/            # CLI tsc 产物
```

所有 `entries` 路径相对 payload 根、POSIX 分隔；`entryChecksums` 为对应文件 sha256。
`manifest.version` 恒等于 `@helm/payload` 包版本（单一版本源）。

## 启动入口 start.mjs

```bash
node start.mjs check   # 校验 manifest/entries/checksums，并报告 kernel 运行时依赖解析状态
node start.mjs start   # 依赖可解析时拉起 kernel/dist/main.js（透传环境变量与信号）
```

退出码：`0` 校验通过且依赖可解析；`1` 用法错误或布局/checksum 损坏；`3` 布局合法但
kernel 运行时依赖缺失。依赖判定按 `kernel/package.json` 的 `dependencies` 逐说明符做
ESM 解析（`import.meta.resolve`，不执行模块），缺失时列出完整清单并显式退出，绝不静默降级。

## 已知阻塞：无 npm install 的自包含（未解决，勿宣称）

桌面壳预期「下载 tarball → 解包 → 直接运行」，**不执行 npm install**。当前做不到，事实如下：

1. **npm pack 不打包 node_modules**。tarball 只含包自身文件；本 payload 目录也未携带
   node_modules（组装脚本与测试显式断言这一点）。`bundleDependencies` 路线在本仓库不可行：
   workspace 依赖是 pnpm 符号链接，且 kernel 的依赖闭包（`@earendil-works/*`、ws、esbuild、
   mermaid 等）体量大、含平台差异。
2. **esbuild 含平台原生二进制**（`@esbuild/linux-x64` 等 optionalDependencies），跨平台
   单一 tarball 无法携带正确平台版本。
3. **workspace 协议依赖**：`@helm/protocol` 以 `workspace:*` 链接，发布前必须物化为真实
   版本号，本骨架未做发布物化。

因此当前契约是「仅构建 payload 目录」：`check` 会诚实报告依赖缺失并退出码 3。可行的
后续路线（任选其一，均未实现）：

- payload 目录内置 vendored `node_modules`（按平台发布多个 tarball）；
- 用 esbuild 把 kernel 入口 bundle 为单文件（需处理动态 require 与原生模块）;
- 桌面壳侧改为下载 tarball 后自行执行受控 `npm install --omit=dev`。

## 测试

`packages/payload/test/payload.test.ts`（integration 档）：真实执行组装与启动子进程，
覆盖 manifest/checksum 契约、资产落位、web 同级探测命中、无 node_modules 断言、依赖
缺失/篡改场景的显式退出码。
