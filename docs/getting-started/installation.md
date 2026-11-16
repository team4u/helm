# 安装与配置指南

本文覆盖从环境依赖、服务启动、管理员初始化到端口规划、数据目录与凭据隔离的完整部署流程。按顺序执行即可得到一个可用的单机环境；远端节点的接入方式见 [EnvFabric 分布式执行底座](../architecture/envfabric.md)。

## 前置条件

| 组件 | 版本要求 | 说明 |
| :--- | :--- | :--- |
| Node.js | `>= 24.12.0` | 根 `package.json` 的 `engines` 字段强制约束 |
| pnpm | `12.x` | 根 `package.json` 的 `packageManager` 固定为 `pnpm@12.16.1` |
| Git | 已安装 | `builtin:workflow` 的 Worktree 隔离与代码门禁需要 Git |
| 操作系统 | Linux / macOS / WSL2 | 主流 POSIX 环境 |

当前未发布安装制品，以下流程即源代码模式安装：所有命令直接从仓库运行。

```bash
git clone https://github.com/team4u/helm.git && cd helm
pnpm install
pnpm build
```

## 三个可执行命令的分工

| 命令 | 角色 | 说明 |
| :--- | :--- | :--- |
| `helm-hub` | 服务端 | 启动内核 Hub 进程：监听 `HELM_PORT`（约定 `3202`），加载插件与 Web 静态资源；等价于 `pnpm dev:kernel` 的入口 |
| `helm` | 客户端 | 控制端 CLI：经 HTTP/WS 连接已运行的 Hub，管理会话、调用动作与工作流 |
| `helm-node` | 被控端 | 节点守护进程：部署在远端机器，经 `/ws/node` 反向接入 Hub 承载命令执行 |

三者关系：`你 ── helm（CLI）/ Web ──→ helm-hub（Hub 内核）──→ helm-node（远端节点）`。`helm` 的动态插件命令（如 `helm workflows`）依赖 Hub 在线：Hub 未启动或未登录时仅静态命令可用。

## 源代码模式挂载全局命令（可选）

仓库根的 `pnpm helm` / `pnpm helm-node` / `pnpm helm-hub` 脚本可在仓内直接使用；若希望在任何目录直接敲 `helm` 等命令：

```bash
pnpm link:bins      # 在 /usr/local/bin 安装 helm / helm-node / helm-hub 包装脚本
pnpm unlink:bins    # 一键撤销
```

特性与注意：

- 包装脚本经仓库内 `tsx` 直跑各包 `src/` 入口，源码改动即时生效，无需重新 `pnpm build`（区别于 `npm link`：其软链指向 `dist/`，改码后须重新构建才能生效）；
- 安装目录默认 `/usr/local/bin`，可用 `HELM_BIN_DIR` 覆盖；脚本仅支持 Linux/macOS；
- 若目标位置已存在非本脚本产物的同名文件（例如 Kubernetes 的 `helm` 二进制），安装会显式拒绝覆盖，需人工处理；
- `helm` 与 Kubernetes Helm 撞名：本机若同时需要 K8s Helm，请为其改用别名（如 `khelm`），或临时 `pnpm unlink:bins` 让位。

## 启动服务

推荐一条命令同时启动 Web 前端与内核 Hub：

```bash
HELM_PORT=3202 pnpm dev
```

启动后 Web 控制台在 `http://127.0.0.1:3201`，Hub API 在 `http://127.0.0.1:3202`。需要分窗口调试时用组件分离启动：

```bash
HELM_PORT=3202 pnpm dev:kernel   # 窗口 1：仅内核 Hub
pnpm dev:web                     # 窗口 2：仅前端（需 Hub 已在 3202 运行）
```

### 端口规划

前端 dev 服务器固定占用 `3201`（`strictPort: true`），并把 `/api` 与 `/ws` 代理到 Hub；Hub 监听端口由 `HELM_PORT` 控制，约定取 `3202`。

| 服务 | 端口 | 说明 |
| :--- | :--- | :--- |
| Web 前端（Vite dev） | `3201` | 代理 `/api` 与 `/ws` 到 Hub |
| 内核 Hub | `3202` | `HELM_PORT` 约定值，承载 HTTP API 与 WebSocket |

以下端口为本机其他系统保留，Helm 任何组件不得占用：`3000`（外部公共开发服务）、`3001` / `3002`（`botd`）、`3101` / `3102`（`botx`）。

### 数据目录

全部运行数据固定写入 `~/.helm`，可用 `HELM_DATA_DIR` 覆盖；该目录与旧系统 `~/.botx`、`~/.botd` 完全物理隔离，Helm 任何组件不读写旧系统运行数据。卸载重装或排障时，清理该目录即可完全重置（开发阶段无数据迁移承诺）。

## Docker 容器部署 Hub 与宿主机节点接入

若将 Helm 作为日常主力工具持续开发或自举迭代，推荐采用「Docker 容器运行稳定 Hub + 宿主机运行 `helm-node` 挂载真实开发环境」的分离拓扑：容器内 Hub 托管编译好的 Web 静态产物并将状态持久化至独立目录，宿主机的源码改动或测试重启不会中断主力 Hub；会话通过 `EnvFabric` 路由回宿主机节点执行读写、测试、Git Worktree 与 Herdr 终端协同。

### 1. 构建并启动 Docker Hub

仓库根已提供 `Dockerfile`、`docker-compose.yml` 与 `.dockerignore`。在宿主机仓库根执行：

```bash
# 1. 将 helm / helm-node / helm-hub 挂载到 /usr/local/bin（直跑宿主机源码）
pnpm link:bins

# 2. 构建镜像并后台拉起 Hub 容器
docker compose up -d --build
```

默认配置说明（见 `docker-compose.yml`）：

- **端口映射**：对外绑定 `0.0.0.0:3333:3202`（宿主机 3333 映射容器内 3202），容器内 Hub 同时托管 `packages/web/dist` 前端静态资源、HTTP API 与 `/ws/node` 网关；局域网内任意机器可直接通过 `http://<服务器局域网IP>:3333` 访问完整 Web 主控台；
- **数据目录隔离**：容器内 `/data/.helm` 挂载在宿主机 `~/.helm-hub-docker`，与宿主机 CLI / `helm-node` 使用的 `~/.helm` 物理隔离，避免争抢 SQLite 与凭据文件锁。

### 2. 在 Web 界面一键生成命令并接入宿主机节点

1. 在浏览器打开 `http://<服务器局域网IP>:3333`，首次访问根据界面引导完成管理员密码初始化与登录；
2. 点击左侧边栏底部的「计算节点」（路由 `#/settings/nodes`）进入计算节点中心，点击右上角「接入节点」；
3. 输入节点 ID（如 `host-dev`），点击「签发接入令牌」；界面基于当前浏览器访问地址（`window.location.origin`）自动生成带局域网 IP 的一键接入命令：
   ```bash
   helm-node start -d --hub http://<服务器局域网IP>:3333 --token host-dev:<secret>
   ```
4. 点击「复制命令」，在宿主机（或任何待接入机器）终端粘贴执行，即可绑定节点身份并拉起后台守护进程；Web 节点中心卡片会实时变为「在线」；
5. 新建会话或配置 Profile 时，将节点选为 `host-dev`、工作目录填宿主机源码路径（如 `/root/code/helm`），即可用容器内的 Hub 驱动宿主机代码库。

### 3. 日常升级 Docker Hub

当宿主机源码完成新一轮迭代并通过测试后，执行以下命令即可平滑重建容器，宿主机 `helm-node` 会在容器就绪后自动重连，所有会话与凭据完整保留：

```bash
docker compose up -d --build
```

## 初始化管理员与登录

首次部署需要初始化管理员密码（密码以 scrypt 哈希存储），随后登录 CLI 并检查状态：

```bash
pnpm helm setup --password '<your-admin-password>'   # 初始化管理员并自动登录写入凭据
pnpm helm login --password '<your-admin-password>'   # 后续登录（凭据已存在时）
pnpm helm status --json                              # 验证：configured 与 authenticated 均为 true
```

`setup` 与 `login` 均会把 `{ hubUrl, token }` 写入 `<HELM_DATA_DIR>/cli-token`（权限 `0600`），此后所有 `helm` 命令自动携带该凭据。密码也可经 stdin 传入（`--password` 缺省且 stdin 非 TTY 时读一行），避免进入 shell 历史。

## 配置模型供应商凭据

会话调用模型前，需要至少配置一个供应商的 API Key 并选定默认模型：

```bash
pnpm helm models providers --json                              # 查看支持的供应商与认证方式
pnpm helm credentials set <provider-id> --value '<api-key>'    # 写入 API Key（明文不回读）
pnpm helm models refresh --json                                # 刷新动态模型目录
pnpm helm models default --set '<provider>/<model>' --json     # 选定全局默认模型
```

凭据写入 `<HELM_DATA_DIR>/credentials.json`，由 Hub 的 CredentialService 独占管理（见下节）。

## 环境变量参考

| 变量 | 默认值 | 适用组件 | 说明 |
| :--- | :--- | :--- | :--- |
| `HELM_PORT` | `3202` | `@helm/hub` / `@helm/kernel` / `@helm/web` | Hub 监听端口（前端代理目标跟随该值） |
| `HELM_HOST` | `127.0.0.1` | `@helm/hub` | Hub 绑定地址；远端节点接入需显式 `0.0.0.0` 或反代 |
| `HELM_WEB_DIST_DIR` | 产品入口旁的 `web/dist` | `@helm/hub` | 显式指定 Web 产物目录；`false` / `0` / 空串关闭静态托管。直接嵌入内核时通过 `webDistDir` 参数指定 |
| `HELM_DATA_DIR` | `~/.helm` | 全部包 | 数据与凭据主目录，与旧系统 `~/.botx`、`~/.botd` 完全隔离 |
| `HELM_HUB_URL` | `http://127.0.0.1:3202` | `@helm/cli`、`@helm/node` | CLI 目标 Hub 地址；节点 CLI 用于指定连接目标 |
| `HELM_TOKEN` | 无 | `@helm/cli` | 显式令牌，优先级高于磁盘凭据（不触碰磁盘） |
| `HELM_CONVERSATION_ID` | 无 | `@helm/cli` | 供所有 `--current` 标志解析当前会话 |
| `HELM_NODE_ID` | 无 | `@helm/cli` | 供节点命令的 `--current` 解析目标节点 |
| `HELM_CWD` | Hub 进程 cwd | `@helm/hub`、受管子进程 | Hub 缺省工作目录；受管执行中表示会话工作目录 |
| `HELM_MODEL` | 无 | `@helm/hub` | Hub 启动时的默认模型覆盖 |
| `VITE_HOST` | `0.0.0.0` | `@helm/web` | Vite dev 服务器绑定地址；本机使用可设为 `127.0.0.1` |
| `HERDR_SOCKET_PATH` | 平台默认路径 | `@helm/node`、`builtin:herdr` | Herdr IPC socket/pipe 路径覆盖 |

凭据解析优先级为 `HELM_TOKEN` / `HELM_HUB_URL` 环境变量优先，其次 `cli-token` 文件。令牌与 `hubUrl` 同源绑定：当 `HELM_HUB_URL` 指向另一个 Hub 时，CLI 不会把旧 Hub 的令牌发送过去。

## 凭据物理隔离

三类凭据分别由三个组件独占管理，物理上互不读写，文件权限恒为 `0600`（被外部放宽时读路径会自动收敛修复）：

| 凭据文件 | 归属组件 | 内容 | 写入来源 |
| :--- | :--- | :--- | :--- |
| `<dataDir>/cli-token` | `@helm/cli` 独占 | `{ hubUrl, token }` | `helm setup` / `helm login` |
| `<dataDir>/credentials.json` | `@helm/kernel` 独占 | 模型 API Key（`providers.<id>.value`）与插件私密配置 | Hub 的 CredentialService |
| 节点机 `<dataDir>/node.json` | `@helm/node` 独占 | 节点 ID 与接入令牌 | `helm-node connect <hubUrl> --token <token>` |

`cli-token` 的写入走独立文件锁 + 临时文件原子重命名；`credentials.json` 具备进程内队列与跨进程文件锁双层互斥；`node.json` 由 `helm-node doctor` 校验完整性。

### 边界与约束

- `SecretStash` 承诺「不落库、不进模型上下文」，但任意 shell 命令与进程内插件拥有本地宿主权限，天然可读环境变量与内存——不承诺对它们的零泄漏。
- CLI 绝不读取或修改模型密钥文件，Hub 绝不接触 `cli-token`，节点身份与 Hub 侧令牌体系彼此独立。
- 当前为单管理员账户模型（管理员密码 + 令牌），无多用户权限隔离；对外暴露时请置于反向代理或内网之后。
