# Helm 开源框架文档重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Helm 的技术文档完全重构为世界级开源框架水准，包含门面级 `README.md`、结构化 `docs/` 文档站（新手起步、架构原理、确定性工作流、插件系统、CLI 参考）与历史交接归档，严格遵循受控中文（STE-zh「中文-顺」模式）与极简工业质感（零 Emoji）。

**Architecture:** 采用分层多页面文档体系：根目录 `README.md` 作为项目主门面；`docs/` 拆分为 `getting-started/`、`architecture/`、`workflows/`、`plugins/`、`cli/` 五大专题模块与 `archive/` 历史交接归档；所有文档均严格按照 ASD-STE100 受控中文「中文-顺」规则（说明句 ≤ 40 字，指令句 ≤ 25 字，主动语态，动词优先，去除营销虚词）编写。

**Tech Stack:** Markdown, Mermaid Diagrams, GitHub Flavored Markdown, ASD-STE100 (受控中文).

## Global Constraints

- 严禁在任何文档标题、正文、列表、表格或流程图中使用任何 Emoji 表情图标；
- 遵循受控中文（STE-zh）「中文-顺」风格：动词优先、去除名词化虚动词（禁止“进行分析”等）、去除营销形容词、拆分长句、一词一义；
- 所有代码块、CLI 命令、配置字段与路径必须与 Helm 现有代码库 100% 保持事实一致，严禁伪造不存在的命令或参数；
- 所有文档在 `/root/code/helm` 目录下操作，提交遵循中文 Conventional Commits（如 `docs: ...`）。

---

### Task 1: 历史交接文档归档与结构整理

**Files:**
- Create: `docs/archive/README.md`
- Move:
  - `docs/20261106-核心开发交接.md` -> `docs/archive/20261106-核心开发交接.md`
  - `docs/20261106 helm极简微内核与双7扩展点设计文档.md` -> `docs/archive/20261106-helm极简微内核与双7扩展点设计文档.md`
  - `docs/20261107-Herdr开发交接.md` -> `docs/archive/20261107-Herdr开发交接.md`
  - `docs/20261107-Herdr总览修复验收.md` -> `docs/archive/20261107-Herdr总览修复验收.md`
  - `docs/20261107-SuperAgent开发交接.md` -> `docs/archive/20261107-SuperAgent开发交接.md`
  - `docs/20261107-Triggers开发交接.md` -> `docs/archive/20261107-Triggers开发交接.md`
  - `docs/20261108-核心地基加固验收.md` -> `docs/archive/20261108-核心地基加固验收.md`
  - `docs/20261108-插件收口与界面隔离验收.md` -> `docs/archive/20261108-插件收口与界面隔离验收.md`

- [ ] **Step 1: 创建归档目录并移动历史文件**

执行 git mv 命令归档历史文档：
```bash
mkdir -p docs/archive
git mv "docs/20261106-核心开发交接.md" docs/archive/20261106-核心开发交接.md
git mv "docs/20261106 helm极简微内核与双7扩展点设计文档.md" docs/archive/20261106-helm极简微内核与双7扩展点设计文档.md
git mv "docs/20261107-Herdr开发交接.md" docs/archive/20261107-Herdr开发交接.md
git mv "docs/20261107-Herdr总览修复验收.md" docs/archive/20261107-Herdr总览修复验收.md
git mv "docs/20261107-SuperAgent开发交接.md" docs/archive/20261107-SuperAgent开发交接.md
git mv "docs/20261107-Triggers开发交接.md" docs/archive/20261107-Triggers开发交接.md
git mv "docs/20261108-核心地基加固验收.md" docs/archive/20261108-核心地基加固验收.md
git mv "docs/20261108-插件收口与界面隔离验收.md" docs/archive/20261108-插件收口与界面隔离验收.md
```

- [ ] **Step 2: 编写 `docs/archive/README.md`**

说明归档目录的作用与历史记录清单，确保追溯通道明确。

- [ ] **Step 3: 验证 git 状态并提交**

```bash
git add docs/archive
git commit -m "docs: 归档早期开发交接与历史设计文档"
```

---

### Task 2: 门面级门户 `README.md` 彻底重写

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 编写全新的根目录 `README.md`**

核心包含：
1. Hero 标头与定位（极简持久微内核个人助理 · 多智能体确定性编排 · 跨平台终端协同主控台），技术栈徽标。
2. 为什么选择 Helm（痛点对比表格：套壳 Bot vs 常见 Python Agent 框架 vs Helm 架构）。
3. 全景架构拓扑（Mermaid 图）：展示 `@helm/protocol`、微内核、前后端对称双 7 扩展点与四大插件。
4. 5 分钟上手体验卡（3 步启动前后端服务、初始化管理员、登录 CLI、单兵对话、运行工作流）。
5. 四大杀手级特性演示（确定性 JS 编排、跨平台 EnvFabric、Herdr 终端主控、API/CLI 同权）。
6. 四大内置插件一览表与插件极速开发示例。
7. CLI 核心命令速查表。
8. 深度文档中心导航索引。

- [ ] **Step 2: 受控中文（STE-zh）与零 Emoji 自检**

检查：
- 无分号串联，说明句 ≤ 40 字，指令句 ≤ 25 字；
- 动词优先，去除“进行/加以/作出”等虚动词；
- 去除“强大/无缝/丝滑”等营销形容词；
- 严禁任何 Emoji。

- [ ] **Step 3: 提交代码**

```bash
git add README.md
git commit -m "docs: 重写根目录 README 门面文档"
```

---

### Task 3: 文档中心总览与新手入门专题

**Files:**
- Create: `docs/README.md`
- Create: `docs/getting-started/index.md`
- Create: `docs/getting-started/installation.md`
- Create: `docs/getting-started/first-workflow.md`

- [ ] **Step 1: 编写 `docs/README.md`**

文档中心导航总览，提供“初学者路径”、“编排开发者路径”、“插件开发者路径”、“运维部署路径”四大快速导航图。

- [ ] **Step 2: 编写 `docs/getting-started/index.md`**

快速起步导览与整体学习指引。

- [ ] **Step 3: 编写 `docs/getting-started/installation.md`**

环境准备（Node.js >= 24.12, pnpm）、完整部署流程、端口规划（3201/3202）、环境变量详解（`HELM_PORT`, `HELM_DATA_DIR`, `HELM_HUB_URL`）、凭据隔离存储机制（`cli-token` 与 `credentials.json`）。

- [ ] **Step 4: 编写 `docs/getting-started/first-workflow.md`**

从零编写并运行确定性多智能体工作流，手把手解释 `meta`、`agent()`、`parallel()`、`phase()` 与执行日志查看。

- [ ] **Step 5: 提交代码**

```bash
git add docs/README.md docs/getting-started/
git commit -m "docs: 建立文档中心总览与新手入门专题"
```

---

### Task 4: 架构原理专题

**Files:**
- Create: `docs/architecture/overview.md`
- Create: `docs/architecture/extension-points.md`
- Create: `docs/architecture/envfabric.md`
- Create: `docs/architecture/pi-durable.md`

- [ ] **Step 1: 编写 `docs/architecture/overview.md`**

阐述微内核哲学、为什么坚守“零业务角色硬编码”（无 router/worker/watchdog 硬编码，由 ProfileId + Tags 表达）、五包单向依赖拓扑与边界契约。

- [ ] **Step 2: 编写 `docs/architecture/extension-points.md`**

详解前后端对称「双 7 扩展点」：
- 后端 7 大 Hook：`trigger`, `input`, `before_turn`, `tool_call/tool_result`, `agent_spawn`, `turn_settled`, `watchdog_tick` 与 4 种控制流（`continue`, `transform`, `handled`, `block`）；
- 前端 7 大插槽：`sidebar`, `screen`, `timeline`, `tool.view`, `composer`, `workbench`, `commandPalette/settings`。

- [ ] **Step 3: 编写 `docs/architecture/envfabric.md`**

跨平台执行底座 `EnvFabric` 深度剖析：零入站 SSH 依赖、反向 WebSocket 连接（`/ws/node`）、节点令牌签发与身份绑定、受管 Shell 流式输出、双向文件流、安全原子升级与 SHA-512 校验。

- [ ] **Step 4: 编写 `docs/architecture/pi-durable.md`**

会话持久化与状态机：`Conversation(nodeId, cwd)` 五态模型、`state.sqlite` 与 FTS5 全文秒级搜索、`SecretStash` 脱敏边界、`AskDoc` 乐观锁（`expectedStateSeq`）审批机制。

- [ ] **Step 5: 提交代码**

```bash
git add docs/architecture/
git commit -m "docs: 建立架构原理深度专题"
```

---

### Task 5: 确定性多智能体编排专题

**Files:**
- Create: `docs/workflows/dsl-guide.md`
- Create: `docs/workflows/worktree-and-gate.md`
- Create: `docs/workflows/journaling-recovery.md`

- [ ] **Step 1: 编写 `docs/workflows/dsl-guide.md`**

原生 JavaScript 编排 DSL 完整参考：`agent()`、`parallel()`、`pipeline()`、`phase()`、`log()`、`action()`，状态与参数传递规范，实战范例。

- [ ] **Step 2: 编写 `docs/workflows/worktree-and-gate.md`**

代码沙箱与安全隔离：Git Worktree 自动创建、独立分支开发、代码门禁（Gate 语法校验与自动化测试）、安全回收机制与防丢代码保障。

- [ ] **Step 3: 编写 `docs/workflows/journaling-recovery.md`**

确定性执行流水（Journaling）：前缀调用复用、断点续跑、崩溃恢复与自愈诊断。

- [ ] **Step 4: 提交代码**

```bash
git add docs/workflows/
git commit -m "docs: 建立确定性工作流开发专题"
```

---

### Task 6: 插件系统与内置生态专题

**Files:**
- Create: `docs/plugins/overview.md`
- Create: `docs/plugins/assistant.md`
- Create: `docs/plugins/herdr.md`
- Create: `docs/plugins/superagent.md`
- Create: `docs/plugins/triggers.md`
- Create: `docs/plugins/magpie.md`
- Create: `docs/plugins/plugin-development.md`

- [ ] **Step 1: 编写 `docs/plugins/overview.md`**

插件系统设计与 `definePlugin(ctx)` 强类型契约，动作注册自动映射（HTTP / CLI / Agent Tool / Workflow Action / Web UI），在途任务安全保护机制。

- [ ] **Step 2: 编写 `docs/plugins/assistant.md`**

常驻单兵助理插件：根会话 `#1` 守护、独立的 `SYSTEM.md` 与 `MEMORY.md` 注入、动态技能（`references/*.md`）按需加载、Artifacts 产物管理。

- [ ] **Step 3: 编写 `docs/plugins/herdr.md`**

Herdr 终端协同主控插件：连接 Unix Socket / Named Pipe、调度 23 种终端 CLI、`.helm/wf-out-*` 文件结构化交接与原地自愈、终端总览与权威状态同步。

- [ ] **Step 4: 编写 `docs/plugins/superagent.md`**

SuperAgent 双层中枢与看门狗插件：0 阻塞路由、后台驻留 Worker、ThreadKey 直通、召回图谱（RecallGraph）、两层看门狗巡检与自愈规则。

- [ ] **Step 5: 编写 `docs/plugins/triggers.md`**

自动化触发器插件：Cron 定时编排（至多一次与 catchUp 补跑策略）、Webhook 入站（HMAC-SHA256 签名验签与 defang 防逃逸信封）。

- [ ] **Step 6: 编写 `docs/plugins/magpie.md`**

动态模型网关插件：原生协议分发（Responses, Messages, Completions）、动态模型目录热重载与配额诊断。

- [ ] **Step 7: 编写 `docs/plugins/plugin-development.md`**

自定义插件实战教程：目录规范、`plugin.json`、后端 Action / Hook 声明、前端 JSON Spec 与 `client.tsx` React 双轨开发、本地调试与验证。

- [ ] **Step 8: 提交代码**

```bash
git add docs/plugins/
git commit -m "docs: 建立插件系统与内置生态专题"
```

---

### Task 7: CLI 命令参考手册与全套文档闭环验证

**Files:**
- Create: `docs/cli/reference.md`

- [ ] **Step 1: 编写 `docs/cli/reference.md`**

按功能分类提供 `helm` 与 `helm-node` 的全量命令字典与 `--json` 管道范例（涵盖会话、工作流、节点、插件、环境、工作树、凭据等）。

- [ ] **Step 2: 全局超链接与路径验证**

遍历检查所有新文档中的相对路径、交叉引用链接、命令示例，确保无死链，Mermaid 流程图语法正确。

- [ ] **Step 3: 运行已有自动化测试与类型检查**

确保文档重构过程中未对代码库造成任何破坏：
```bash
pnpm typecheck
pnpm test
```

- [ ] **Step 4: 提交代码**

```bash
git add docs/cli/
git commit -m "docs: 新增 CLI 参考手册并完成全套文档重构"
```
