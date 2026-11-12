# 安装与配置指南

本文覆盖从环境依赖、服务启动、管理员初始化到端口规划与凭据隔离的完整部署流程。按顺序执行即可得到一个可用的单机环境；远端节点的接入方式见 [EnvFabric 分布式执行底座](../architecture/envfabric.md)。

## 环境要求

| 组件 | 最低版本 | 说明 |
| :--- | :--- | :--- |
| Node.js | `>= 24.12.0` | `package.json` 的 `engines` 字段强制约束 |
| pnpm | `>= 9.0.0` | Monorepo 依赖与脚本管理 |
| Git | `>= 2.30.0` | 支撑 Worktree 沙箱派生 |
| 操作系统 | Linux / macOS / WSL2 | 主流 POSIX 环境 |

获取代码并安装依赖：

```bash
git clone <仓库地址> && cd helm
pnpm install
pnpm build
```

当前没有发布制品，上述流程即源代码模式安装：所有命令直接从仓库运行。下文启动服务、挂载 CLI 均在此模式下进行。

## 三个可执行命令的分工

| 命令 | 角色 | 说明 |
| :--- | :--- | :--- |
| `helm-hub` | 服务端 | 启动内核 Hub 进程：监听 `HELM_PORT`（默认 3202，仅本机回环），加载插件与 Web 静态资源；等价于 `pnpm dev:kernel` 的入口 |
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

启动后 Web 控制台在 `http://localhost:3201`，Hub API 在 `http://localhost:3202`。需要分窗口调试时用组件分离启动：

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

以下端口为本机其他系统预留，Helm 任何组件不得占用：`3000`（外部公共开发服务）、`3001` / `3002`（`botd`）、`3101` / `3102`（`botx`）。

## 初始化管理员与登录

首次部署需要初始化管理员密码（密码以 scrypt 哈希存储），随后登录 CLI 并检查状态：

```bash
pnpm helm setup --password '<your-admin-password>'   # 初始化管理员并写入 CLI 凭据
pnpm helm login --password '<your-admin-password>'   # 后续登录（凭据已存在时）
pnpm helm status --json                              # 验证：configured 与 authenticated 均为 true
```

`setup` 与 `login` 均会把 `{ hubUrl, token }` 写入 `<HELM_DATA_DIR>/cli-token`（权限 `0600`），此后所有 `helm` 命令自动携带该凭据。

## 环境变量参考

| 变量 | 默认值 | 适用组件 | 说明 |
| :--- | :--- | :--- | :--- |
| `HELM_PORT` | `3202` | `@helm/kernel` / `@helm/web` | Hub 监听端口（前端代理目标跟随该值） |
| `HELM_HOST` | `127.0.0.1` | `@helm/kernel` | Hub 绑定地址；远端节点接入需显式 `0.0.0.0` 或反代 |
| `HELM_DATA_DIR` | `~/.helm` | 全部包 | 数据与凭据主目录，与旧系统 `~/.botx`、`~/.botd` 完全隔离 |
| `HELM_HUB_URL` | `http://127.0.0.1:3202` | `@helm/cli` | CLI 目标 Hub 地址；与 `cli-token` 同源绑定 |
| `HELM_TOKEN` | 无 | `@helm/cli` | 显式令牌，优先级高于磁盘凭据（不触碰磁盘） |
| `HELM_CONVERSATION_ID` | 无 | `@helm/cli` | 供所有 `--current` 标志解析当前会话 |
| `HELM_NODE_ID` | 无 | `@helm/cli` | 供节点命令的 `--current` 解析目标节点 |

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
- 数据目录遵循隔离约定：只读写 `~/.helm`（或 `HELM_DATA_DIR` 覆盖值），不得触碰旧系统运行数据。
