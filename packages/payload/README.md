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

退出码：`0` 校验通过（布局 + 三入口依赖解析 + node:sqlite/esbuild 实测）；`1` 用法错误或
manifest/布局/checksum/路径契约损坏；`3` 布局合法但依赖缺失或运行时能力实测失败。依赖判定以
dist 根 `package.json` 的 `dependencies` 为契约清单，从 kernel/protocol/cli 三个入口用
`createRequire(entry).resolve`（含 ESM-only exports 回退）做真实解析；`check` 另行实测
`node:sqlite` 与 esbuild transform（覆盖插件 client 编译链路与平台二进制），绝不执行 Hub。

## 依赖补齐契约（发布包 + 消费侧 npm install）

dist 根 `package.json` 是可直接 `npm pack` / `npm publish` 的独立包（默认名
`@team4u/helm-hub`，构建 env `HELM_PAYLOAD_PACKAGE` 可覆盖；`manifest.name` 与其同源）：

- `files` 显式白名单（kernel/protocol/cli/web/start.mjs/manifest.json），tarball 内
  manifest/start 位于包根（不是 dist/ 子目录）；
- 外部直接依赖锁定到仓库已安装的精确版本；`@helm/protocol` 以 `file:./protocol.tgz`
  安装为真实目录，避免 Windows junction 在候选改名后失效。dist 同时携带原始 protocol 产物；
- 自动扫描闭包 peer 冲突生成 `overrides`（npm 严格 peer 解析 vs pnpm 宽松语义，如 chord
  钉 peer ws@8.21.0 而仓库锁定 8.22.1）——`.npmrc` 无法随 tarball 分发（npm 永久排除它），
  发布包携带 overrides，安装过程使用相同的根依赖版本；
- 消费侧契约：解包 tgz 后在包根执行 `npm install --omit=dev --ignore-scripts`（esbuild
  平台包经 optionalDependencies 按目标平台自动安装），随后 `node start.mjs check` 验收。

诚实边界：payload tarball 本身仍不携带 node_modules（跨平台平台二进制决定 vendoring 须按
平台多包发布，未做）；安装包（desktop）自包含 baseline 由 `packages/desktop/scripts/
assemble-hub.mjs` 按当前打包 runner 架构物化依赖闭包解决，与本包发布契约互补。

## 测试

`packages/payload/test/payload.test.ts`（integration 档）：真实执行组装与启动子进程，
覆盖 manifest/checksum 契约、资产落位、web 同级探测命中、无 node_modules 断言、依赖
缺失/篡改场景的显式退出码。网络验收由 CI 专门设置 `PAYLOAD_NPM_SMOKE=1` 执行，
验证真实 npm pack、安装、候选目录改名与 Hub 启动；默认全量测试跳过该网络用例。
