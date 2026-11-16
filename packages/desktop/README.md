# @helm/desktop

Helm 全平台 Electron 桌面壳：attach-or-spawn `127.0.0.1` Hub 监督器 + BrowserWindow / 系统托盘。本文只覆盖本包的职责、开发命令、构建产物、测试与限制；发布流水线见[发布流程](../../docs/releasing.md)。

## 职责

- 复用现有 Web 界面渲染窗口；Hub 独立运行在子进程中（开发端口仍 `3202`），已有 Hub 运行时直接附着，退出桌面端不停止外部 Hub；
- 携带基线业务载荷（Hub、Web、CLI、生产依赖与内置 npm CLI，位于 ASAR 之外的 `resources/hub/`），用户无需预装 Node；
- 业务载荷自动更新：启动候选验证（Hub 就绪 + React 首帧）后提交；后台定期从 npm 检查、SHA-512 校验、解包到不可变候选目录，托盘提示下次启动安装，不中断运行中的会话。

本包不直接 import kernel/web——Hub 一律子进程启动。Electron 底座自身更新目前经托盘打开 GitHub Releases（无自动替换）。

## 开发命令

```bash
pnpm install --frozen-lockfile
pnpm build                                  # tsc（assemble-hub 依赖全仓 dist，先跑根构建）
pnpm --filter @helm/desktop exec electron . # 开发运行
pnpm --filter @helm/desktop test            # tsx --test（独立临时数据目录）
pnpm --filter @helm/desktop run dist:dir    # 解包应用（验证用）
pnpm --filter @helm/desktop run dist        # 当前平台安装包（--publish never）
node scripts/desktop-smoke.mjs --packaged [--port=32020]   # 打包 App 冒烟
```

无桌面环境（Linux）用 `xvfb-run -a` 运行窗口测试；本机以 root 运行时测试包装器才增加 `--no-sandbox`；测试端口被占明确拒绝，可显式 `--port`。**不能拿 Linux 的 Hub 依赖交叉打包给 macOS**——各平台原生依赖在对应 runner 上准备。

## 构建产物

- `dist/`：tsc 编译的主进程产物（`main.js`）；
- `release/`：electron-builder 输出（`dist:dir` 解包应用与 `dist` 安装包：macOS DMG/ZIP、Windows NSIS EXE、Linux AppImage/DEB）。两者不是同一目录。

## 测试

`test/*.test.ts`：bootstrap/config/supervisor/updater/payload-tar/runners/pre-ready 等真实进程与可控 procfs/信号/时钟测试；冒烟（`src/smoke.ts` 与 `scripts/desktop-smoke.mjs`）验证 Hub 启动、React 首帧、渲染进程隔离、workflow/mermaid 原生编译与退出后端口释放，产出 `smoke.json` / 截图 / 日志。

## 限制与诚实边界

- 安装包**未签名 / 未公证**（无证书资产）：macOS 与 Windows 首次安装可能触发系统开发者验证提示；
- 真实 AppImage 与 Wayland 门户尚未现场验收；主进程被 SIGKILL 或原生崩溃时退出回调无法执行（Linux AppImage 的同步退出清理只覆盖可执行的退出路径，子进程归属逐项复核 `ppid` / `starttime`）；
- 更新保护针对启动故障，不承诺恢复新版本已改写的业务数据；附着外部 Hub 时更新由原安装渠道负责；
- 环境变量（`HELM_DESKTOP_PORT` 默认 3202、`HELM_DESKTOP_DATA_DIR`、`HELM_PAYLOAD_PACKAGE` / `HELM_PAYLOAD_REGISTRY` / `HELM_PAYLOAD_VERSION`、`HELM_DESKTOP_HEADLESS` 等）与安装状态（`<dataDir>/payload/`，候选目录不可变）见[发布流程](../../docs/releasing.md)与 `src/config.ts`；崩溃遗留安装锁需确认无安装进程后人工移除。
