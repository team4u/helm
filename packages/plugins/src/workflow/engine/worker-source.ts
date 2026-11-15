/**
 * worker-source.ts — 工作流 worker 线程内执行的 JavaScript 源码（内联字符串）。
 *
 * 自 @tintinweb/pi-subagents v0.23.1 (MIT) 移植并做两处 helm 适配：
 * 1. 确定性 Prelude 额外替换 realm 全局的 `globalThis.Date`（上游仅词法 shadow
 *    `const Date`，`new globalThis.Date()` 仍可读到真实时钟）；`Date.now` /
 *    `Math.random` / 无参 `new Date()` 继续全部拒绝。
 * 2. 新增 `action(actionId, input)` 原语（helm：零 Token 调用 ctx.action）。
 * 3. 多级编排原语（设计 §2.2-2.3/§4.1）：`agent.withMeta(prompt, opts)` 与
 *    `goal(spec)`（默认 maxAttempts=3）；AGENT_OPTIONS 新增 cwd / timeoutMs /
 *    gateTimeoutMs / maxAttempts；workflow() 嵌套放宽到 4 层，scope 分配递增
 *    scopeId（根为 0）并随 agent payload 下发。
 *
 * 两层边界（与上游一致）：
 *
 *   host thread ←postMessage→ worker thread ←vm context→ workflow script
 * worker 层负责可杀性（terminate 停死循环）；vm 层负责确定性与事故防范。
 * `codeGeneration: { strings: false, wasm: false }` 使 eval/Function 抛 EvalError。
 * 这是确定性与可终止性边界，不是对恶意代码的安全沙箱——注入的宿主闭包
 * （agent/action）本身持有宿主 Function 构造器，我们缩小表面但不声称封闭。
 *
 * 拆分说明：worker 源码内联字符串拆为三段逐字搬运——运行底座段在
 * worker-source-prelude.ts（含 MAX_WORKFLOW_NESTING_DEPTH 与确定性 Prelude），
 * 业务原语段在 worker-source-primitives.ts，run 引导尾段留在本文件；
 * buildWorkerSource() 顺序拼接，生成代码与拆分前逐字节一致（worker-source.test.ts 锁定）。
 */

import { MAX_WORKFLOW_NESTING_DEPTH, WORKER_PRELUDE_SOURCE } from './worker-source-prelude.js'
import { WORKER_PRIMITIVES_SOURCE } from './worker-source-primitives.js'

export { MAX_WORKFLOW_NESTING_DEPTH }

/**
 * `agent.withMeta(prompt, opts)` / `goal(spec)` 的返回契约（设计 §2.3）。
 *
 * 本文件是内联 worker 源码的宿主模块：这些类型描述 worker ↔ host 消息面上的
 * JSON 形状，按设计文档自包含声明，不导入 host 侧类型（protocol 的
 * AgentGateResult 扩展字段与 contracts 的 WorktreeExecutionDescriptor 扩展
 * 字段合入后以那两处为权威；此处只锁消息面形状）。
 */
export interface AgentWithMetaResult<T = unknown> {
  ok: boolean
  output: T | null
  attempts: number
  error?: string
  timedOut?: boolean
  execution?: AgentWithMetaExecution
  gate?: AgentWithMetaGateResult
}

/** 子代理执行环境元数据（onResolved 快照的回传侧投影）。 */
export interface AgentWithMetaExecution {
  nodeId?: string
  conversationId?: number
  executionId?: string
  effectiveCwd?: string
  worktree?: AgentWithMetaWorktree
}

/** 门禁结果（设计 §2.1：ok/output 之外扩展 exitCode 与 timedOut）。 */
export interface AgentWithMetaGateResult {
  ok: boolean
  output: string
  exitCode?: number | null
  timedOut?: boolean
}

/** isolation: 'worktree' 兑现后的最小工作树描述。 */
export interface AgentWithMetaWorktree {
  path: string
  branch: string
  id?: string
  repoRoot?: string
  baseCommit?: string
}

/** 分片三：budget / main 引导与错误上报尾段。 */
const WORKER_RUN_SOURCE = `function makeBudget() {
  return {
    total: null,
    spent: function () {
      return spentOutput;
    },
    remaining: function () {
      return Infinity;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

async function main() {
  rootScope = makeScope(undefined, 0);
  const sandbox = {
    agent: rootScope.agent,
    goal: rootScope.goal,
    parallel: parallel,
    pipeline: pipeline,
    phase: rootScope.phase,
    log: rootScope.log,
    workflow: rootScope.workflow,
    action: rootScope.action,
    budget: makeBudget(),
    console: rootScope.console,
  };
  const context = vm.createContext(sandbox, {
    name: "workflow",
    codeGeneration: { strings: false, wasm: false },
  });

  realmObjectPrototype = vm.runInContext("Object.prototype", context);
  realmNewArray = vm.runInContext("(function () { return []; })", context);
  realmPush = vm.runInContext("(function (array, value) { array.push(value); })", context);
  realmParse = vm.runInContext("JSON.parse", context);
  realmContext = context;

  sandbox.meta = realmParse(workerData.metaJson);
  sandbox.args = workerData.argsJson === undefined ? undefined : realmParse(workerData.argsJson);

  const script = new vm.Script("(async () => {" + PRELUDE + "\\n" + workerData.body + "\\n})()", {
    filename: "workflow.js",
    lineOffset: -1,
  });

  const value = await journalContext.run({ ownerId: rootScope.id, state: rootScope }, function () {
    return script.runInContext(context);
  });
  checkBoundary(value, "the workflow result");
  flushProgress();
  port.postMessage({
    type: "complete",
    resultJson: value === undefined ? undefined : JSON.stringify(value),
  });
}

main().catch(function (error) {
  flushProgress();
  port.postMessage({
    type: "error",
    message: error && error.message ? String(error.message) : String(error),
    stack: error && error.stack ? String(error.stack) : undefined,
  });
});
`

/** 顺序拼接三段分片；与拆分前的单一模板字面量逐字节一致。 */
export function buildWorkerSource(): string {
  return WORKER_PRELUDE_SOURCE + WORKER_PRIMITIVES_SOURCE + WORKER_RUN_SOURCE
}

export const WORKER_SOURCE = buildWorkerSource()
