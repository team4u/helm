# 安装与配置 Helmx

如果只想在本机试用，装 CLI 并启动 Hub 就够了。Hub 保存会话和配置，提供 Web 界面。只有要用另一台机器的文件或工具时，才需要在那台机器上装 `helmx-node`。

## 用 npm 启动本机 Hub

先安装 Node.js 24.12 或更新版本。有些工作流会创建 Git worktree，这时还要在执行任务的机器上安装 Git。直接用 npm 安装运行时只需要以下两条命令。

```bash
npm install -g @helmx/cli
helmx update --watch
```

首次运行会下载并校验 `@helmx/hub`。启动后访问 <http://127.0.0.1:3202>，根据页面提示设置管理员密码。然后在「模型与凭证中心」添加供应商凭据、选择默认模型，就能开始对话。`--watch` 在前台运行，按 `Ctrl+C` 会停止它启动的 Hub。安装完成后，`--watch` 可以离线启动已有版本。

### 更新和查看状态

| 命令 | 用法 |
| --- | --- |
| `helmx update` | 安装并启动本机 Hub，或更新现有安装。 |
| `helmx update --check --json` | 查询可用的更新。 |
| `helmx update --status --json` | 查看已安装的版本、运行状态和上一次更新失败的信息。 |
| `helmx update --stop` | 在 Linux 上验证进程身份后停止 Hub。macOS 和 Windows 上用 `--watch` 所在终端停止。 |

`--watch` 默认每 15 分钟检查 `latest`。`--channel beta` 选择预发布通道，`--interval-ms` 调整检查间隔。遇到在跑的会话、工具、上下文压缩或排队任务，候选版本会等到下一次检查确认空闲再切换。无法确认活动状态时也会等。`--force` 可以跳过这项检查。切换会短暂停机，新版启动失败时会尝试恢复上一版。空闲检查结束后刚接入的回合，仍可能在重启后恢复执行。

`helmx update` 管的是 Hub。升级 `helmx` 命令本身时，重新执行 `npm install -g @helmx/cli`。全局 CLI 的 `helmx plugins build` 使用本机 Hub 发行包里的编译器，需要先安装 Hub。

## 用 CLI 登录和配置模型

另开一个终端。如果已经在浏览器里设置过管理员密码，执行 `helmx login`。想从 CLI 初始化时，用 `helmx setup`，它会同时保存登录凭据。

```bash
helmx login --password '<管理员密码>'
helmx status --json
```

状态中的 `configured` 和 `authenticated` 都应为 `true`。`login` 和 `setup` 也支持从非 TTY 的 stdin 读一行密码。连接另一台 Hub 时，用 `HELMX_HUB_URL` 指定它的地址。如果目标地址和保存的登录地址不同，CLI 会保留旧凭据并要求你为目标 Hub 登录或提供 `HELMX_TOKEN`。

从命令行添加模型时，先查可用供应商。把命令里的 `provider-id`、`api-key` 和 `provider/model` 换成实际值。

```bash
helmx models providers --json
helmx credentials set '<provider-id>' --value '<api-key>'
helmx models refresh --json
helmx models list --json
helmx models default --set '<provider/model>' --json
```

## 接入远端节点

在 Hub 的「计算节点」页面点击「接入节点」，为那台机器起一个名字，比如 `dev-win`，再签发接入令牌。CLI 的对应命令是 `helmx nodes issue dev-win --json`。请保存返回的令牌，完整值只在签发时显示。

在远端机器上安装 Node.js 24.12 或更新版本，再执行下面两条命令。把地址换成这台机器能访问的 Hub 地址，把令牌换成刚才签发的值。Hub 默认监听 `127.0.0.1`，远端接入时需要一个能到达它的地址。跨网络连接时使用提供 TLS 的 Hub 地址。

```bash
npm install -g @helmx/node
helmx-node start -d --hub 'https://hub.example.com' --token 'dev-win:<secret>'
```

在「计算节点」页面或用 `helmx nodes list` 确认节点在线。创建会话时选 `dev-win`，工作目录填那台机器上的绝对路径。也可以先用 CLI 确认目标仓库，以下是从控制端检查 Windows 节点的例子。

```bash
helmx env exec --node dev-win --cwd 'C:\Users\alice\repo' --stream -- git status
```

节点主动连接 Hub，因此只需让它能访问 Hub。节点离线时，针对该节点的执行会等待重连或明确报错，执行目标始终是你选的机器。节点升级可从 Hub 发起，端口转发也可从 CLI 管理。 [节点升级和 TCP 隧道](../architecture/envfabric.md) · [节点命令](../cli/reference.md#节点与跨节点执行)

## 用 Docker 部署 Hub

仓库自带的 Compose 配置把宿主机的 `3333` 映射到容器里的 `3202`，并把 Hub 数据保存在宿主机的 `~/.helmx-hub-docker`。在已克隆的仓库根目录运行以下命令。

```bash
docker compose up -d --build
```

在宿主机打开 <http://127.0.0.1:3333>。这份 Compose 配置也会监听宿主机的局域网地址。在可信网络内，可用宿主机的局域网地址和同一端口访问。需要让容器里的 Hub 操作宿主机仓库时，在宿主机装 `helmx-node`，接入后将会话的节点选为宿主机，再填宿主机上的仓库路径。复制浏览器生成的接入命令时，核对 URL 是否能从目标机器访问。

更新镜像时可以再次执行 `docker compose up -d --build`。容器会重建，节点随后重连。会话、凭据和产物沿用挂载的数据目录。 [Compose 配置](../../docker-compose.yml)

## 从源码启动

在 Linux、macOS 或 WSL2 上准备 Node.js、pnpm 12 和 Git，再运行以下命令。

```bash
git clone https://github.com/team4u/helmx.git
cd helmx
pnpm install
pnpm build
HELMX_PORT=3202 pnpm dev
```

Web 开发服务器在 <http://127.0.0.1:3201>，把 `/api` 和 `/ws` 代理到 `3202` 上的 Hub。分开调试时，在两个终端分别运行 `HELMX_PORT=3202 pnpm dev:kernel` 和 `pnpm dev:web`。

源码仓根目录可以直接用 `pnpm helmx`、`pnpm helmx-node` 和 `pnpm helmx-hub`。也可以在 Linux 或 macOS 上执行 `pnpm link:bins`，生成指向源码的命令包装脚本。安装位置默认是 `/usr/local/bin`，可用 `HELMX_BIN_DIR` 覆盖。已有的其他同名命令会受到保护。用 `pnpm unlink:bins` 移除包装脚本。 [开发约定](../../AGENTS.md)

## 目录与环境变量

Hub 运行文件默认放在 `~/.helmx-hub`，会话、凭据和插件数据默认放在 `~/.helmx`。修改目录时，请让这两个位置各自独立。启动配置优先使用命令行参数，其次是环境变量和上一次保存的配置。用 `helmx update --help` 查看启动选项。

| 变量 | 用途 |
| --- | --- |
| `HELMX_HUB_INSTALL_ROOT` | npm 模式下的 Hub 版本安装根，默认 `~/.helmx-hub`。 |
| `HELMX_DATA_DIR` | 组件的运行数据目录，默认 `~/.helmx`。 |
| `HELMX_HOST` / `HELMX_PORT` | Hub 的监听地址和端口，默认 `127.0.0.1:3202`。 |
| `HELMX_WEB_DIST_DIR` | Hub 托管的 Web 静态文件目录。`false`、`0` 或空字符串关闭托管。 |
| `HELMX_HUB_URL` | CLI 或节点访问的 Hub 地址。 |
| `HELMX_TOKEN` | CLI 显式使用的令牌，优先于已保存的登录凭据。 |
| `HELMX_CONVERSATION_ID` / `HELMX_NODE_ID` | 支持 `--current` 的命令用它们识别当前会话或节点。 |
| `HELMX_CWD` | Hub 的默认工作目录。受管执行中表示会话的工作目录。 |
| `HELMX_MODEL` | 覆盖 Hub 启动时的默认模型。 |
| `HELMX_NODE_JOIN_GRACE_MS` | Hub 重启时为「恢复所依赖且已注册的远端节点」等待回连的上限毫秒数，默认 10000；`0` 关闭等待。超时后照常启动，绑定该节点的工作按真实在线状态显式失败。 |
| `VITE_HOST` | Web 开发服务器的监听地址，默认 `0.0.0.0`。 |
| `HERDR_SOCKET_PATH` | 覆盖 Herdr 的本机 socket 或命名管道路径。 |

## 凭据存放在哪里

| 文件 | 内容 |
| --- | --- |
| CLI 的 `cli-token` | `setup` 或 `login` 保存的 Hub 地址和令牌。 |
| Hub 的 `credentials.json` | 模型供应商密钥和插件私密配置。 |
| 节点机的 `node.json` | 节点身份和接入令牌。可以用 `helmx-node doctor` 检查绑定。 |

三个文件都位于各自组件的数据目录。会话临时机密由 Hub 的 `SecretStash` 保存在内存中。获得机密的进程可以读取自己的环境变量，安装的插件也以宿主权限运行。Helmx 当前采用单管理员账户。如果需要从另一台机器访问，优先放在可信内网或受控的反向代理后面。 [会话机密与审批](../architecture/pi-durable.md) · [插件权限](../plugins/overview.md)
