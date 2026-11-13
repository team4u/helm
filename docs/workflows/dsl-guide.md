# 原生 JavaScript 编排 DSL 手册

本手册是 Helm 工作流编排 DSL 的权威参考。工作流就是一段普通 JavaScript：脚本在独立的 Worker 线程与 `node:vm` 上下文中执行，所有副作用（派生智能体、调用动作）都以 RPC 消息出走宿主统一记账——这层边界换来两个核心性质：脚本是确定性的（同输入同执行轨迹，可安全前缀重放），且任意时刻可终止（`worker.terminate()` 能停掉自旋或卡死的脚本）。

## 执行模型与脚本结构

两层边界构成执行模型：宿主线程与 Worker 线程之间以 `postMessage` 通信（Worker 层负责可杀性与消息协议），Worker 线程内再用 `node:vm` 创建受限 realm（VM 层负责确定性与事故防范）。`codeGeneration: { strings: false, wasm: false }` 使 `eval` 与 `Function` 构造器直接抛 `EvalError`。需要说明：这是确定性与可终止性边界，不是对恶意代码的安全沙箱——注入的宿主原语本身持有宿主能力，我们缩小表面但不声称封闭。

脚本由两部分组成。顶部是静态元数据 `meta`，引擎在执行前经字符串扫描提取并在空 VM 上下文求值该片段（阶段声明用于界面首帧分组）；其余部分是顶层 `await` 风格的执行体。`meta` 必须是纯静态字面量，支持的字段如下：

```javascript
export const meta = {
  name: "code-review-pipeline",        // 必填：工作流唯一标识
  description: "多维度代码审查流水线",   // 必填：功能描述
  whenToUse: "需要对拉取请求做全面静态分析时使用",  // 可选：适用场景
  phases: [                            // 可选：阶段声明，供界面预渲染
    { title: "并行审查", detail: "多维度并行分析" },
    { title: "汇总报告", detail: "聚合结果并输出建议", model: "openai/gpt-5" },
  ],
}
```

变量、函数调用、扩展运算符、模板插值（`${...}`）都是非法的，违规声明会在求值时抛错并拒绝执行。动态输入经全局 `args` 访问，CLI 传入的 JSON 字符串会被自动解包（最多两层，防模型双重序列化）：

```bash
helm workflows run ./review.js --args '{"pr": 1024, "strict": true}'
```

## 全局注入原语

沙箱为脚本注入以下全局量。所有 `agent` / `action` / `workflow` 调用必须被 `await` 或 `return`，脚本完成时仍存在未等待的调用会以致命错误收尾。

### `args`

外部传入的任意 JSON 值（对象、数组或标量均可），脚本内直接读取，如 `args?.pr ?? 0`。

### `agent(prompt, options)`

派生子智能体执行推理与工具调用任务，返回其最终文本（失败或被跳过时返回 `null`）。

| 选项 | 类型 | 说明 |
| :--- | :--- | :--- |
| `label` | `string` | 展示名；同时是本 run 内 `resume` 的引用句柄 |
| `phase` | `string` | 所属阶段名（覆盖当前 ambient 阶段） |
| `model` | `string` | 模型覆盖，如 `'provider/model'` |
| `agentType` | `string` | Profile ID（专家 Bot 标识）或外部运行时标识（如 `herdr:agy`） |
| `isolation` | `'worktree'` | 启用独立 Git Worktree 隔离（唯一合法值） |
| `gate` | `string` | 验收 shell 命令，退出码非 0 判定失败 |
| `resume` | `string` | 续接本 run 内既有智能体的 label |
| `effort` | `string` | 思考力度：`minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `schema` | `object` | 结构化输出的 JSON Schema |
| `attachments` | `string[]` | 本次调用携带的产物 ID 列表 |
| `maxSubagentDepth` | `number` | 相对任务树根的绝对子代理层级上限（1..5 整数；默认继承上限 2，根会话为第 0 层）。根会话可为大任务提高上限；受管子代理不得提高继承上限。续接未传时保留授权，显式设置重新校验；字段参与恢复缓存指纹 |

选项互斥规则：`resume` 与 `agentType`、`model`、`isolation`、`effort` 互斥（续接会话保持它启动时的类型、模型、工作目录与思考配置），但允许与 `schema`、`gate`、`attachments`、`maxSubagentDepth` 组合（续接回合可携带新的输出契约、门禁与本轮附件；附件只属于本轮提交，不自动沿用原任务的附件列表）。传未知选项名会直接报错，可用键固定为 `label, phase, model, agentType, isolation, gate, resume, effort, schema, attachments, maxSubagentDepth`。

**结构化输出**：配置 `schema` 时宿主为子智能体挂载结构化契约，引擎解析其 JSON 回复并按 Schema 校验，通过则返回原生对象，不通过（非 JSON 或不合契约）返回 `null`：

```javascript
const result = await agent("提取提交的修改范围与风险点", {
  label: "风险提取",
  schema: {
    type: "object",
    properties: {
      scope: { type: "string" },
      riskLevel: { type: "string", enum: ["low", "medium", "high"] },
    },
    required: ["scope", "riskLevel"],
  },
})
if (result === null) throw new Error("结构化输出校验失败")
```

**跨 Profile 点名**：`agentType` 填真实 Profile ID（如 `reviewer`），不带 `@` 前缀，也不是显示名。用户在会话里写 `@reviewer` 是向当前智能体点名——那只是认知约定，实际执行仍由当前会话经 `subagent` 的 `agentType`（或脚本内 `agent()`）落地，点名本身不构成授权、也不改变派生方会话的生命周期缺省。目标 Profile 的类型（原生或外部运行时）同样不改变生命周期缺省（见 workflow 插件文档「默认后台协同」）。外部运行时标识采用 `namespace:kind` 形式（含冒号），如 `herdr:agy`。

**同步节点语义**：`agent()` 没有也不接受 `background` 选项——run 内的 DSL 节点始终等待真实结果（可用键固定列表不含 `background`，传未知选项名直接报错）。后台策略发生在工具层：`subagent` / `SubagentWorkflow` 模型工具按当前会话归属缺省（人类直连会话缺省后台、自动化会话缺省同步且显式 `background: true` 被拒绝）；CLI/动作 `helm workflows run` 则是缺省启动即返回、`--wait` 才同步。三个入口互不混同，不要在脚本里期待后台句柄。

**attachments 授权边界**：只允许当前编排会话及其父链有权使用的产物；数组不能包含空 ID、纯空白 ID 或非字符串项（空数组合法，且与未提供在重放指纹上是不同调用）。宿主会校验产物存在性与授权。当前授权不覆盖子会话或兄弟会话——不能把上一个子代理产出的产物 ID 直接转交给下一个子代理，需要交接时先由有权读取的会话显式导出内容，再按接收方有权使用的方式登记。不同节点、目录与 Worktree 之间没有自动文件同步。

**resume 的边界**：只有该子会话仍存在、归属校验通过且不忙时才能真正续接。`resume` 续接的是会话上下文，`resumeFromRunId` 重放的是工作流账本，两者是不同操作。前缀失配后命中「仅存在于账本缓存」的子结果时，引擎会显式失败而不是伪造续接。

### `parallel(thunks)` 与 `pipeline(items, ...stages)`

`parallel` 接收无参异步函数数组，并发执行全部任务并按原顺序返回结算结果；`pipeline` 接收数据项数组与若干顺序处理函数，对每个 item 依次流过全部 stage（stage 签名为 `(value, item, index)`）。两者容错语义一致：普通失败折叠为 `null`（`parallel` 不影响其余任务；`pipeline` 跳过该 item 的后续 stage），只有致命错误（配额突破、账本失效）才向外抛出。

```javascript
// pipeline：item 在 stage 间流水推进，无需等全部 item 完成第一个 stage
const reports = await pipeline(
  ["src/a.ts", "src/b.ts"],
  async (file) => await agent(`检查文件语法: ${file}`),
  async (syntaxReport, file) => await agent(`基于语法报告优化: ${syntaxReport}`),
)
```

优先用 `pipeline` 而非手写 `parallel` 分批：`parallel` 的每一批是一次完整同步屏障（全部完成才进入下一步），`pipeline` 让不同 item 的 stage 天然错峰推进，减少不必要的等待。

两者共享单次列表容量上限（4096 项，见配额表）。

### `action(id, input, options)`

零 Token 调用插件注册的动作或内建命令执行，适合一切不需要模型推理的确定性步骤。

- `id`（必填）：动作标识。全限定形式 `pluginId.actionName`（如 `memory.get`）；短名唯一时可用（如 `get`）；歧义短名会以 `ambiguous_action` 报错并列出候选。
- `input`（可选，缺省 `{}`）：传给动作的 JSON 对象，经边界校验后由宿主做 inputSchema 校验。
- `options.idempotent`（boolean）：调用端的幂等承诺声明，覆盖动作定义端的默认值。
- `options.label` / `options.phase`：节点展示标签与阶段覆盖。

`idempotent` 的准确语义：它是对「该动作可安全重复执行（包括部分完成或中断后重试）」的承诺，由动作作者或脚本作者作出，不是引擎检测所得。引擎用它决定恢复策略——已声明幂等的动作失败或中断后允许 `resumeFromRunId` 放行并断链重跑；未声明幂等的动作失败或存在悬挂意图行时，恢复会被保守拒绝（见[状态流水与故障恢复](journaling-recovery.md)）。注意内建 `env.exec` 定义为非幂等：脚本里对它显式标 `idempotent: true` 前，请确认命令真的可安全重放（如纯只读查询）。

**内建动作 `env.exec`（短名 `exec`）**：经内核 EnvFabric 在节点上执行命令。输入结构与返回值如下：

| 输入字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `command` | `string \| string[]` | 必填。命令行或 argv 数组（数组不经 shell 解析，跨平台同构） |
| `nodeId` | `string` | 可选。目标节点，缺省当前会话所在节点 |
| `cwd` | `string` | 可选。跨平台绝对路径工作目录 |
| `env` | `Record<string, string>` | 可选。注入的环境变量字典（普通参数，机密传递应走 SecretStash） |
| `timeoutMs` | `number` | 可选。1 ~ 600000 毫秒 |
| `allowFailure` | `boolean` | 可选。`true` 时非零退出码不抛异常，返回带退出码的结果对象 |

返回 `{ ok: boolean, exitCode: number | null, output: string, timedOut: boolean }`（`output` 为聚合的 stdout+stderr 且已经宿主脱敏）：

```javascript
const diff = await action("env.exec", {
  command: ["git", "diff", "--stat", "origin/main"],
}, { idempotent: true, label: "差异提取" })
if (diff.ok) log(diff.output)
```

### `workflow(ref, args)`

嵌套调用其他工作流。`ref` 是已保存工作流名字符串，或 `{ scriptPath }` 对象（不提供则抛错）；`args` 原样传给子工作流。嵌套深度上限为 1：你已经在某个工作流内部时不能再 `workflow()`，应直接内联编排。子工作流的名字用于进度前缀与错误定位（进度条目会带子工作流派生前缀）。

### `phase(title)` 与 `log(message)`

`phase(title)` 声明进入指定业务阶段（非空字符串），之后的 `agent` / `action` 自动归入该阶段，直至下一次调用；`agent` / `action` 各自的 `options.phase` 可覆盖当前 ambient 阶段。阶段在首次出现时分配序号并发出进度事件，同名阶段复用同一序号。`log(message)` 输出一条时间线日志（自动附加嵌套作用域前缀）。`console.log` / `info` / `warn` / `error` / `debug` 是 `log` 的同义别名。

### `budget`

`budget.spent()` 返回当前 run 已消耗的模型输出 Token 数；`budget.remaining()` 返回剩余配额（当前实现恒为 `Infinity`）。`budget.total` 为 `null`。

## 确定性约束与配额

### 禁用的非确定性 API

脚本体之前注入确定性前导垫片：`Date.now()`、`Math.random()`、无参 `new Date()` 全部抛出明确异常（`globalThis.Date` 别名同样被替换，不能绕过）；带参数的 `new Date(timestamp)` 放行。`eval` 与 `Function` 构造器因 VM 关闭代码生成而不可用。需要时间戳时经 `args` 外部传入，或在脚本返回后由宿主统一记录。

### 严格 JSON 边界

所有跨越沙箱边界的值（`args`、`agent` 附件与结果、`action` 输入输出、脚本根返回值）必须是可 JSON 往返的普通数据。深度递归检查拒绝：`undefined`（仅脚本根返回值豁免）、`BigInt`、`Symbol`（含 Symbol 键对象）、`Function`、非有限数值（`NaN` / `Infinity`）、稀疏数组、非普通对象（自定义原型链实例）、循环引用。

### 资源配额

| 配额 | 常量 | 值 |
| :--- | :--- | :--- |
| 脚本源码长度 | `MAX_SCRIPT_LENGTH` | 512 KB |
| 单 run 智能体总数 | `WORKFLOW_AGENT_CAP` | 1000 |
| 单次 `parallel` / `pipeline` 列表项 | `WORKFLOW_ITEM_CAP` | 4096 |
| 嵌套 `workflow()` 调用总数 | `WORKFLOW_NESTED_CAP` | 256 |

脚本含控制字符（制表符、回车、换行除外）会在编译前被拒绝。并发智能体数量由宿主按 CPU 核数调度（上限 16，给宿主线程留两个核），超出并发的调用在信号量上排队。

## 完整示例

```javascript
export const meta = {
  name: "comprehensive-audit",
  description: "结合 Worktree 沙箱、并行审查与门禁的完整流程",
  phases: [
    { title: "环境准备" },
    { title: "并行审查" },
    { title: "门禁验证" },
    { title: "总结报告" },
  ],
}

const targetBranch = args?.targetBranch ?? "main"
log(`针对分支 ${targetBranch} 执行审计`)

phase("环境准备")
const diff = await action("env.exec", {
  command: ["git", "diff", "--stat", `origin/${targetBranch}`],
}, { idempotent: true, label: "差异提取" })

phase("并行审查")
const [security, style] = await parallel([
  () => agent(`审查以下提交的安全隐患:\n${diff.output}`, {
    label: "安全审查",
    effort: "high",
    schema: {
      type: "object",
      properties: {
        vulnerabilities: { type: "array", items: { type: "string" } },
        score: { type: "number" },
      },
      required: ["vulnerabilities", "score"],
    },
  }),
  () => agent(`审查代码架构与设计规范:\n${diff.output}`, { label: "架构审查", effort: "medium" }),
])

phase("门禁验证")
const fix = await agent("修复安全审查中发现的严重漏洞并验证测试", {
  label: "自动化修复",
  isolation: "worktree",
  gate: "pnpm test",
})

phase("总结报告")
const verdict = await agent("整理各阶段发现，生成最终审查简报", {
  label: "报告汇总",
  schema: {
    type: "object",
    properties: { approved: { type: "boolean" }, summary: { type: "string" } },
    required: ["approved", "summary"],
  },
})

return { security, style, fix, verdict }
```

`isolation: 'worktree'` 分配独立 Git Worktree、`gate` 执行恰好一次验收命令，两者的完整生命周期（租约、清理安全链）见[Git Worktree 与代码门禁](worktree-and-gate.md)；失败语义与恢复策略见[状态流水与故障恢复](journaling-recovery.md)。
