# @helm/payload — Hub npm payload（最小骨架）

Electron 桌面薄壳的目标：从公开 npm 拉取最新 Hub 内容并直接运行。本包是仓库内的
payload 组装器：把 Hub 组合根、kernel、官方插件、共享运行时包、web dist、CLI 与内置插件运行时资产（client /
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
  hub/                 # Hub 产品组合根（组合 kernel/plugins/plugin-build）
  kernel/
    package.json       # 内核运行时依赖声明
    dist/              # kernel tsc 产物
  plugins/             # 官方插件包
  plugins/dist/<plugin>/{client,skill,assets}  # 插件运行时资产
  plugin-build/        # 插件源码编译实现
  plugin-client/       # 共享浏览器 SDK 源码入口
  protocol/            # 通用协议包归档安装
  env-io/              # 执行侧共享 I/O 实现
  web/dist/            # Vite 产物，由 Hub 产品入口显式定位静态目录
  cli/dist/            # CLI tsc 产物
```

所有 `entries` 路径相对 payload 根、POSIX 分隔；`entryChecksums` 为对应文件 sha256。
`manifest.version` 恒等于 `@helm/payload` 包版本（单一版本源）。

## 启动入口 start.mjs

```bash
node start.mjs check   # 校验布局、八个运行时入口依赖与内置能力
node start.mjs start   # 依赖可解析时拉起 Hub 组合根（透传环境变量与信号）
```

退出码：`0` 校验通过（布局 + 八入口依赖解析 + node:sqlite/esbuild 实测）；`1` 用法错误或
manifest/布局/checksum/路径契约损坏；`3` 布局合法但依赖缺失或运行时能力实测失败。`start.mjs`
从 Hub、kernel、plugins、plugin-build、plugin-client、env-io、protocol 与 CLI 八个运行时入口创建
`createRequire` 并解析根 dependencies（含 ESM-only exports 回退）；`check` 另行实测
`node:sqlite` 与 esbuild transform，绝不执行 Hub。

## 依赖补齐契约（发布包 + 消费侧 npm install）

dist 根 `package.json` 是可直接 `npm pack` / `npm publish` 的独立包（默认名
`@team4u/helm-hub`，构建 env `HELM_PAYLOAD_PACKAGE` 可覆盖；`manifest.name` 与其同源）：

- `files` 显式白名单涵盖 Hub、kernel、plugins、plugin-build、plugin-client、env-io、protocol、CLI、web 和启动清单；tarball 内
  manifest/start 位于包根（不是 dist/ 子目录）；
- 外部直接依赖锁定到仓库已安装的精确版本；`@helm/env-io`、`@helm/protocol` 等共享包分别以 `file:./<package>.tgz` 安装为真实目录，避免 Windows junction 在候选改名后失效。
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
