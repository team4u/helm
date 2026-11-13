# Helm Desktop

Electron 窗口与系统托盘复用现有 Web 界面。Hub 独立运行在子进程中，开发端口仍为 `3202`；已有 Hub 运行时直接附着，退出桌面端不会停止外部 Hub。

## 本地开发

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @helm/desktop exec electron .
pnpm --filter @helm/desktop test
```

无桌面环境也可以验证真实窗口：

```bash
pnpm --filter @helm/desktop run dist:dir
xvfb-run -a node scripts/desktop-smoke.mjs --packaged --port=32020
```

测试会使用独立数据目录，检查 Hub、React 首帧、渲染进程隔离、Workflow/Mermaid 原生编译、退出后的端口释放，并保存截图、JSON 报告与日志。测试端口被占用时明确拒绝；可以显式传 `--port=32020` 使用其他测试端口。本机以 root 运行时，测试包装器才会增加 `--no-sandbox`。

## 安装包

```bash
pnpm build
pnpm --filter @helm/desktop run dist:dir  # 解包应用，便于验证
node scripts/desktop-smoke.mjs --packaged
pnpm --filter @helm/desktop run dist     # 当前平台安装包
```

Linux 运行窗口测试时使用 `xvfb-run -a`。打包产物在 `packages/desktop/release/`，包括 macOS DMG/ZIP、Windows NSIS EXE、Linux AppImage/DEB。各平台原生依赖在对应 runner 上准备，不能拿 Linux 的 Hub 依赖直接交叉打包给 macOS。

安装包在 `resources/hub/` 内携带基线 Hub、Web、CLI、生产依赖和 npm CLI，均位于 ASAR 之外；用户无需先安装 Node 或 npm。图形界面关闭时隐藏到托盘；托盘不可用时，关闭窗口会退出。真正退出时，桌面端通过 IPC 要求受管 Hub 优雅关闭，超时才终止进程。数据保存在 `~/.helm`，浏览器缓存位于其 `desktop/` 子目录。

## 更新

业务更新源由基线包的 `package.json.name` 确定，默认构建名为 `@team4u/helm-hub`；可在构建时通过 `HELM_PAYLOAD_PACKAGE` 指定其他公开 npm 包。正式自动更新需要先在 npm 发布该包，并为 GitHub 发布流程配置对应权限。

启动时优先尝试已下载的候选，候选通过 Hub 就绪与 React 首帧检查后才写入当前版本。候选启动失败时记录诊断、阻断该候选，并启动上一版或内置基线。该保护针对启动故障，不承诺恢复新版本已经改写的业务数据。

界面启动后以及每隔六小时后台检查 npm、验证 SHA-512、解包到独立候选目录。若业务载荷缺少依赖，使用应用内置的 npm CLI 安装。下载完成只暂存，托盘提示下次启动安装；不会中断正在运行的会话或工作流。附着外部 Hub 时，更新由它原来的安装渠道负责。

Electron 底座目前通过托盘「下载桌面新版」打开 GitHub Releases 更新。当前仓库没有签名证书，安装包未签名、未公证；完整应用的无人值守替换尚未接入。macOS 和 Windows 的首次安装可能需要处理系统的开发者验证提示。

## 配置

| 变量 | 含义 |
| --- | --- |
| `HELM_DESKTOP_PORT` | Hub 端口，默认 `3202`；禁止使用项目保留的外部/历史系统端口 |
| `HELM_DATA_DIR` / `HELM_DESKTOP_DATA_DIR` | 数据目录，后者优先 |
| `HELM_DESKTOP_HUB_ENTRY` | 覆盖基线 Hub 入口 |
| `HELM_DESKTOP_WEB_DIST` | 覆盖静态资源目录 |
| `HELM_DESKTOP_PAYLOAD_ENTRY` | 显式指定 Hub 入口，优先于已安装候选 |
| `HELM_DESKTOP_PAYLOAD_ENTRY_ARGS` | 手动指定启动器时的参数；`start.mjs` 需要 `start` |
| `HELM_DESKTOP_HUB_NODE` | 显式指定运行 Hub 的 Node |
| `HELM_PAYLOAD_PACKAGE` | 覆盖 npm 更新包名称 |
| `HELM_PAYLOAD_REGISTRY` | npm 更新源，默认 `https://registry.npmjs.org` |
| `HELM_PAYLOAD_VERSION` | 锁定业务载荷版本，默认跟踪 `latest` |
| `HELM_DESKTOP_HEADLESS=1` | 只运行监督器，不创建 Electron 窗口 |

安装状态在 `<dataDir>/payload/`，候选目录不可变。安装锁占用时等待或明确报错，不能按超时偷取仍在运行的安装任务。崩溃遗留锁需要确认没有安装进程后人工移除。

`desktop-ci.yml` 在 Linux、Windows、macOS 上构建并验证打包后的应用，上传截图、报告和安装产物；tag 发布流程见 [发布说明](../../docs/releasing.md)。
