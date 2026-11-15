# Helm 全套开源框架文档重构设计文档

- **创建日期**：2026-11-09
- **状态**：待评审 (Pending Review)
- **文档风格**：受控中文（ASD-STE100「中文-顺」模式）+ 极简工业质感（零 Emoji）
- **覆盖范围**：根目录 `README.md`、`docs/` 完整专题体系、历史交接文档归档

---

## 1. 背景与目标

### 1.1 现状问题
当前项目的 `README.md` 存在以下问题：
1. **行文结构平铺**：近 200 行文本未作清晰分节，技术细节与防御性说明混合堆叠。
2. **缺乏价值呈现**：未突出微内核、确定性原生 JS 工作流、零 SSH 跨机执行等核心优势。
3. **上手门槛高**：安装、配置、登录与第一个工作流运行的步骤被文字淹没。
4. **文档目录散乱**：`docs/` 根目录下堆放着 118KB 原始设计文档与多次历史交接日志，缺少结构化指引。

### 1.2 重构目标
1. **建立一流开源门面**：将根目录 `README.md` 打造为结构清晰、代码直观、引导顺畅的门户。
2. **构建完整分层文档站**：在 `docs/` 下建立新手指南、架构原理、工作流开发、插件系统、CLI 参考五大专题目录。
3. **归档历史交接文件**：将阶段性交接文档移至 `docs/archive/`，保留工程记录同时净化主干阅读路径。
4. **严格执行写作规范**：
   - 遵循受控中文（STE-zh）「中文-顺」模式：说明句 ≤ 40 字，指令句 ≤ 25 字，主动语态，动词优先，去除营销修饰词与套话。
   - 遵循界面与文档零 Emoji 规范，使用统一代码块与列表排版。
   - 确保代码示例与命令 100% 真实可执行。

---

## 2. 文档体系架构与目录规划

```
helm/
├── README.md                          # 门面门户（Hero、破局对比、全景架构、快速上手、核心特性演示、CLI速查）
└── docs/
    ├── README.md                      # 文档中心总览与学习路线
    ├── getting-started/               # 【新手指南】
    │   ├── index.md                   # 导读与学习路径
    │   ├── installation.md            # 环境要求、安装、配置与环境变量
    │   └── first-workflow.md          # 5 分钟上手第一个确定性编排
    ├── architecture/                  # 【架构与原理】
    │   ├── overview.md                # 极简微内核哲学与单向依赖设计
    │   ├── extension-points.md        # 前后端对称「双 7 扩展点」详解
    │   ├── envfabric.md               # EnvFabric 跨平台分布式执行织网
    │   └── pi-durable.md              # 持久会话状态机、FTS5 与 AskDoc 乐观锁
    ├── workflows/                     # 【确定性多智能体编排】
    │   ├── dsl-guide.md               # 原生 JS 编排语法（agent, parallel, pipeline, phase）
    │   ├── worktree-and-gate.md       # Git Worktree 沙箱隔离与代码门禁
    │   └── journaling-recovery.md     # 状态流水（Journaling）与崩溃恢复
    ├── plugins/                       # 【插件系统与内置生态】
    │   ├── overview.md                # 插件宿主机制与 definePlugin(ctx) 契约
    │   ├── assistant.md               # 常驻个人助理（Memory, Skills 动态挂载, Artifacts）
    │   ├── herdr.md                   # Herdr 终端 Agent 主控（23 种 CLI 调度与交接自愈）
    │   ├── superagent.md              # SuperAgent 双层中枢与权威看门狗
    │   ├── triggers.md                # Cron 定时任务与 Webhook 签名入站
    │   ├── magpie.md                  # 动态模型网关与原生协议分发
    │   └── plugin-development.md      # 自定义插件实战（后端 Action/Hook + 前端组件）
    ├── cli/                           # 【CLI 完整参考手册】
    │   └── reference.md               # helm 与 helm-node 命令速查字典
    ├── conventions/                   # 【规范保留】
    │   └── web-navigation.md          # Web 导航与 URL Hash 约定
    └── archive/                       # 【历史记录归档】
        ├── 20261106-核心开发交接.md
        ├── 20261106-helm极简微内核与双7扩展点设计文档.md
        ├── 20261107-Herdr开发交接.md
        ├── 20261107-Herdr总览修复验收.md
        ├── 20261107-SuperAgent开发交接.md
        ├── 20261107-Triggers开发交接.md
        ├── 20261108-核心地基加固验收.md
        └── 20261108-插件收口与界面隔离验收.md
```

---

## 3. 各模块内容详细规范

### 3.1 根目录 `README.md`
- **定位**：项目第一门面，3 分钟讲清价值，5 分钟完成本地跑通。
- **章节规划**：
  1. **Hero 标头**：定位语句「极简持久微内核个人助理 · 多智能体确定性编排 · 跨平台终端协同主控台」，技术栈徽标（Node >= 24.12, TypeScript, pnpm, Zero-SSH, 100% CLI Parity）。
  2. **设计哲学与特性对比**：对比传统套壳 Chatbot、黑盒 Python Agent 框架与 Helm 的架构差异（会话持久化、编排确定性、跨机调度方式、终端控制、CLI 同权）。
  3. **架构拓扑（Mermaid 图）**：直观展示 `@helm/protocol` 契约核心、内核微架构、前后端对称「双 7 扩展点」与四大内置插件关系。
  4. **5 分钟快速上手**：安装依赖、编译、启动服务、管理员初始化、CLI 登录与单兵对话。
  5. **四大杀手级特性演示**：
     - 特性一：原生 JavaScript 确定性编排（代码示例：`hello-orchestra.workflow.js`）。
     - 特性二：跨平台执行底座 `EnvFabric`（`helm-node` 零 SSH 反向连接与 Worktree 隔离）。
     - 特性三：Herdr 终端 CLI Agent 调度（标签页交互、结构化交接与自愈追问）。
     - 特性四：API 与 CLI 严格同权（`helm --json` 命令行与管道流转）。
  6. **四大内置插件一览**：表格列出 `assistant`、`herdr`、`superagent`、`triggers` 与 `magpie` 的职责与启用命令。
  7. **CLI 核心命令速查**：会话、工作流、节点与插件管理的高频命令表。
  8. **文档中心导航**：指向 `docs/` 下各专题的结构化入口。

### 3.2 新手起步 (`docs/getting-started/`)
- **`index.md`**：整体导览与学习路径推荐。
- **`installation.md`**：系统要求（Node.js >= 24.12, pnpm）、完整部署步骤、端口规划（3201 Web / 3202 Hub）、环境变量与多端凭据隔离（`cli-token` 与 `credentials.json`）。
- **`first-workflow.md`**：手把手教学，从创建工作流文件、定义 `meta`、调用 `agent()` 到并行聚合与运行调试。

### 3.3 架构原理 (`docs/architecture/`)
- **`overview.md`**：微内核核心机制，坚持零业务角色硬编码（以 ProfileId + Tags 表达），五包单向依赖拓扑与职责划分。
- **`extension-points.md`**：后端 7 大 Hook（`trigger`, `input`, `before_turn`, `tool_call/tool_result`, `agent_spawn`, `turn_settled`, `watchdog_tick`）与 4 种控制流（`continue`, `transform`, `handled`, `block`）；前端 7 大扩展点（`sidebar`, `screen`, `timeline`, `tool.view`, `composer`, `workbench`, `commandPalette/settings`）。
- **`envfabric.md`**：跨平台执行底座 `EnvFabric` 详解：反向 WebSocket（`/ws/node`）、节点身份与令牌机制、远程 Shell 流式执行、双向文件流、安全原子升级与 SHA-512 校验。
- **`pi-durable.md`**：持久会话增强：`Conversation(nodeId, cwd)` 五态状态机、`state.sqlite` 与 FTS5 全文搜索、`SecretStash` 机密脱敏、`AskDoc` 乐观锁（`expectedStateSeq`）审批机制。

### 3.4 确定性工作流 (`docs/workflows/`)
- **`dsl-guide.md`**：原生 JavaScript DSL 完整语法参考：`agent(prompt, options)`, `parallel([tasks])`, `pipeline([steps])`, `phase(name)`, `log(msg)`, `action(id, input)`，参数注入与结果校验。
- **`worktree-and-gate.md`**：Git Worktree 沙箱隔离机制、基于源提交创建分支、自动化代码门禁（Gate 语法校验与测试套件）、生命周期安全回收。
- **`journaling-recovery.md`**：确定性执行日志（Journaling）、前缀调用复用、断点续跑、意外崩溃恢复与自愈诊断。

### 3.5 插件系统 (`docs/plugins/`)
- **`overview.md`**：插件系统设计原理，`definePlugin(ctx)` 强类型契约，动作注册自动映射（HTTP / CLI / Agent Tool / Workflow Action / Web UI），在途任务安全保护。
- **`assistant.md`**：常驻个人助理插件：根会话 `#1` 守护、独立的 `SYSTEM.md` 与 `MEMORY.md` 注入、动态技能（`references/*.md`）按需加载、Artifacts 产物管理。
- **`herdr.md`**：Herdr 终端协同主控插件：Unix Socket / Named Pipe 通信、23 种终端 CLI 调度、`.helm/wf-out-*` 文件结构化交接与原地自愈、终端总览与权威状态同步。
- **`superagent.md`**：SuperAgent 双层中枢与看门狗插件：0 阻塞路由、派生后台驻留 Worker、ThreadKey 直通、召回图谱（RecallGraph）、两层看门狗巡检与自愈规则。
- **`triggers.md`**：自动化触发器插件：Cron 定时编排（至多一次与 catchUp 策略）、Webhook 入站（HMAC-SHA256 签名验签与 defang 防逃逸信封）。
- **`magpie.md`**：动态模型网关插件：原生协议分发（Responses, Messages, Completions）、动态模型目录热重载与配额诊断。
- **`plugin-development.md`**：自定义插件实战教程：目录结构、`plugin.json`、后端 Action / Hook、前端 JSON Spec 与 `client.tsx` React 双轨开发、本地调试与验证。

### 3.6 CLI 参考手册 (`docs/cli/`)
- **`reference.md`**：`helm` 客户端与 `helm-node` 守护进程完整命令字典，包含会话、工作流、节点、插件等全量命令，提供 `--json` 管道流转范例。

---

## 4. 受控中文（STE-zh）写作对照表

编写文档时，必须执行以下受控中文规则：

| 规则维度 | 严格禁止模式 | 规范受控模式 |
| :--- | :--- | :--- |
| **虚动词去名词化** | 「对工作流进行执行」、「进行验证」 | 「执行工作流」、「验证代码」 |
| **套话与营销修饰** | 「值得注意的是，Helm 提供了极致强大的无缝体验」 | 「Helm 提供以下机制」并列举事实 |
| **长句拆分** | 一句话使用逗号/分号串联三层因果 | 一句只讲一件事；说明句 ≤ 40 字，指令句 ≤ 25 字 |
| **一词一义** | 混用「用户 / 客户端 / 终端」、「校验 / 检查 / 确认」 | 全文统一术语（如统一使用「受控节点」、「验证」） |
| **语态** | 大量使用被动语态（如「令牌被节点接收」） | 使用主动语态（「节点接收令牌」） |
| **Emoji 规范** | 标题和文案中出现 Emoji 图标 | 严禁使用任何 Emoji，统一使用文本排版与结构化表格 |

---

## 5. 迁移与归档方案

1. 创建 `docs/archive/` 目录。
2. 将以下历史记录完整移动至归档目录：
   - `docs/20261106-核心开发交接.md`
   - `docs/20261106 helm极简微内核与双7扩展点设计文档.md` -> `docs/archive/20261106-helm极简微内核与双7扩展点设计文档.md`
   - `docs/20261107-Herdr开发交接.md`
   - `docs/20261107-Herdr总览修复验收.md`
   - `docs/20261107-SuperAgent开发交接.md`
   - `docs/20261107-Triggers开发交接.md`
   - `docs/20261108-核心地基加固验收.md`
   - `docs/20261108-插件收口与界面隔离验收.md`
3. 在 `docs/archive/README.md` 中简要说明历史归档内容，确保历史追溯不断链。
4. 保留 `docs/conventions/web-navigation.md` 并使其可在主文档中正常引用。
