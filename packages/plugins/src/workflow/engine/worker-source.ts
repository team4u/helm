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
 */

/**
 * 在 realm 内、脚本体之前运行；单行（行号偏移补偿依赖它恰好占一行）。
 *
 * - RealDate.now / Math.random 原地替换为抛错函数（Date/Math 来自 realm，
 *   无法通过注入覆盖，只能在 realm 内改写）。
 * - 返回受限子类：无参构造抛错，有参构造放行（时间戳经 args 传入是合法用法）。
 * - 同时写回 globalThis.Date：词法 shadow 只保护脚本源码里的裸 `Date`，
 *   `globalThis.Date` 别名不受 shadow 影响（helm 加固点）。
 */
/**
 * workflow() 嵌套深度上限（设计 §4.1）：根 scope 为第 0 层，depth 达到该值后
 * 禁止再嵌套（即整棵工作流树最多 4 层）。与 runtime.ts 的 WORKFLOW_NESTED_CAP
 * （单 run 内嵌套调用总量 256）正交：一个限深度，一个限总量。
 */
export const MAX_WORKFLOW_NESTING_DEPTH = 4

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

const DETERMINISM_PRELUDE =
  'const Date = (function () {' +
  ' const RealDate = globalThis.Date;' +
  ' const die = function (what) {' +
  ' throw new Error(what + " is unavailable in workflow scripts (breaks resume). " +' +
  '   "Stamp results after the workflow returns, or pass timestamps via args.");' +
  ' };' +
  ' RealDate.now = function () { return die("Date.now()"); };' +
  ' Math.random = function () { return die("Math.random()"); };' +
  ' const Restricted = class WorkflowDate extends RealDate {' +
  ' constructor() { if (arguments.length === 0) die("new Date()"); super(...arguments); }' +
  ' };' +
  ' globalThis.Date = Restricted;' +
  ' return Restricted;' +
  '})();'

export const WORKER_SOURCE = `"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");

const port = parentPort;
const ITEM_CAP = workerData.itemCap;
const PRELUDE = ${JSON.stringify(DETERMINISM_PRELUDE)};
const MAX_WORKFLOW_NESTING_DEPTH = ${MAX_WORKFLOW_NESTING_DEPTH};

/* ------------------------------------------------------------------ *
 * RPC to the host。脚本接触不到 agent/动作总线：一切副作用都以 "call"
 * 消息出走、以 "response" 回来，宿主因此持有信号量、上限与中止语义。
 * ------------------------------------------------------------------ */

let nextCallId = 1;
const pendingCalls = new Map();

let spentOutput = 0;

function callHost(method, payload) {
  flushProgress();
  return new Promise(function (resolve, reject) {
    const callId = nextCallId++;
    pendingCalls.set(callId, { resolve: resolve, reject: reject });
    port.postMessage({ type: "call", callId: callId, method: method, payload: payload });
  });
}

port.on("message", function (message) {
  if (!message || message.type !== "response") return;
  if (typeof message.spent === "number") spentOutput = message.spent;
  const waiter = pendingCalls.get(message.callId);
  if (!waiter) return;
  pendingCalls.delete(message.callId);
  if (message.ok) {
    waiter.resolve(message.value);
    return;
  }
  const error = new Error(message.error || "The workflow host rejected the call.");
  // Fatal 错误属于整个 run 而非单个 item：parallel()/pipeline() 把普通失败
  // 吞为 null，上限突破与账本失效不得被那样静默吸收。
  if (message.fatal) error.workflowFatal = true;
  waiter.reject(error);
});

function isFatal(error) {
  return !!(error && typeof error === "object" && error.workflowFatal === true);
}

/* ------------------------------------------------------------------ *
 * Progress entries（macrotask 批量刷新）
 * ------------------------------------------------------------------ */

let progressQueue = [];
let flushTimer = null;

function emit(entry) {
  progressQueue.push(entry);
  if (flushTimer === null) flushTimer = setTimeout(flushProgress, 0);
}

function flushProgress() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (progressQueue.length === 0) return;
  const batch = progressQueue;
  progressQueue = [];
  port.postMessage({ type: "progress", entries: batch });
}

/* ------------------------------------------------------------------ *
 * JSON 边界：这里检查而非依赖 structured clone（后者会愉快携带循环、
 * BigInt、Map——进度日志与重放账本无法表达它们）。
 * ------------------------------------------------------------------ */

let realmObjectPrototype = null;
let realmParse = null;
let rootScope = null;
let realmContext = null;
let nestedCount = 0;

function boundaryError(what, path) {
  return new Error("Cannot pass " + what + " across the workflow VM boundary (at " + path + ").");
}

function assertBoundary(value, path, seen) {
  if (value === null) return;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return;
  if (kind === "number") {
    if (!Number.isFinite(value)) throw boundaryError("a non-finite number", path);
    return;
  }
  if (kind === "undefined") {
    if (path === "the workflow result") return;
    throw boundaryError("undefined", path);
  }
  if (kind === "bigint") throw boundaryError("a BigInt", path);
  if (kind === "symbol") throw boundaryError("a symbol", path);
  if (kind === "function") throw boundaryError("a function", path);
  if (kind !== "object") throw boundaryError("a " + kind, path);

  if (seen.has(value)) throw boundaryError("a circular structure", path);
  seen.add(value);

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw boundaryError("an object with symbol keys", path);
  }

  if (Array.isArray(value)) {
    const length = value.length;
    for (let i = 0; i < length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) {
        throw boundaryError("a sparse array", path + "[" + i + "]");
      }
      assertBoundary(value[i], path + "[" + i + "]", seen);
    }
    seen.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== realmObjectPrototype && prototype !== Object.prototype) {
    throw boundaryError("a non-plain object", path);
  }

  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    assertBoundary(value[keys[i]], path + "." + keys[i], seen);
  }
  seen.delete(value);
}

function checkBoundary(value, path) {
  assertBoundary(value, path, new Set());
  return value;
}

/* ------------------------------------------------------------------ *
 * Realm helpers
 * ------------------------------------------------------------------ */

let realmNewArray = null;
let realmPush = null;

function toRealmArray(items) {
  const array = realmNewArray();
  for (let i = 0; i < items.length; i++) realmPush(array, items[i]);
  return array;
}

function toList(value, what) {
  if (!Array.isArray(value)) throw new Error(what + " expects an array.");
  const length = value.length >>> 0;
  if (length > ITEM_CAP) {
    throw new Error(what + " was given " + length + " items, over the limit of " + ITEM_CAP + ".");
  }
  const out = [];
  for (let i = 0; i < length; i++) out.push(value[i]);
  return out;
}

function requireText(value, what) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(what + " requires a non-empty string.");
  }
  return value;
}

function optionalText(value, what) {
  if (value === undefined || value === null) return undefined;
  return requireText(value, what);
}

const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

const AGENT_OPTIONS = ["label", "phase", "model", "agentType", "isolation", "gate", "resume", "effort", "schema", "attachments", "maxSubagentDepth", "cwd", "timeoutMs", "gateTimeoutMs", "maxAttempts"];

/* ------------------------------------------------------------------ *
 * Script globals
 * ------------------------------------------------------------------ */

let nextPhaseIndex = 0;
let nextScopeId = 0;

function makeScope(name, depth, path) {
  const scope = {
    // live label 使用会话内编号；恢复使用由调用位置决定的稳定路径。
    id: nextScopeId++,
    path: path || "root",
    nextJournalCallIndex: 0,
    nextWorkflowIndex: 0,
    name: name,
    depth: depth,
    prefix: name === undefined ? "" : "\\u25b8 " + name,
    ambientPhaseIndex: undefined,
    ambientPhaseTitle: undefined,
    phaseIndexByTitle: new Map(),
  };
  scope.agent = function (prompt, opts) {
    return agentIn(scope, prompt, opts);
  };
  scope.agent.withMeta = function (prompt, opts) {
    return agentWithMetaIn(scope, prompt, opts);
  };
  scope.goal = function (spec) {
    return goalIn(scope, spec);
  };
  scope.phase = function (title) {
    return phaseIn(scope, title);
  };
  scope.log = function (message) {
    return logIn(scope, message);
  };
  scope.workflow = function (ref, args) {
    return workflowIn(scope, ref, args);
  };
  scope.action = function (actionId, input, opts) {
    return actionIn(scope, actionId, input, opts);
  };
  scope.console = makeConsole(scope);
  return scope;
}

function scopedTitle(scope, title) {
  if (scope.prefix === "") return title;
  return title === undefined ? scope.prefix : scope.prefix + " \\u203a " + title;
}

function definePhaseIn(scope, title) {
  let index = scope.phaseIndexByTitle.get(title);
  if (index !== undefined) return index;
  index = nextPhaseIndex++;
  scope.phaseIndexByTitle.set(title, index);
  emit({ type: "workflow_phase", index: index, title: scopedTitle(scope, title) });
  return index;
}

function phaseIn(scope, title) {
  const text = requireText(title, "phase(title)");
  scope.ambientPhaseIndex = definePhaseIn(scope, text);
  scope.ambientPhaseTitle = scopedTitle(scope, text);
}

function describe(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.message === "string" && typeof value.stack === "string") {
    return value.message;
  }
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    /* 循环与 BigInt 落入 String() */
  }
  return String(value);
}

function logPrefix(scope) {
  return scope.prefix === "" ? "" : scope.prefix + ": ";
}

function logIn(scope, message) {
  emit({ type: "workflow_log", message: logPrefix(scope) + describe(message) });
}

function makeConsole(scope) {
  const write = function () {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) parts.push(describe(arguments[i]));
    emit({ type: "workflow_log", message: logPrefix(scope) + parts.join(" ") });
  };
  return { log: write, info: write, warn: write, error: write, debug: write };
}

async function agentIn(scope, prompt, opts) {
  const options = readAgentOptions(prompt, opts);
  const result = await callAgentHost(scope, options, false);
  if (result === undefined || result === null) return null;
  if (options.schema === undefined) return result;
  try {
    return realmParse(result);
  } catch (error) {
    logIn(scope, "agent(): the host returned a structured result that is not JSON");
    return null;
  }
}

/**
 * agent(prompt, opts) / agent.withMeta(prompt, opts) 共用的参数读取与校验。
 * 返回已归一化的选项对象；两个入口共享同一套规则，差别只在返回包装。
 */
function readAgentOptions(prompt, opts) {
  const text = requireText(prompt, "agent(prompt)");
  const options = opts === undefined || opts === null ? {} : opts;
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new Error("agent(prompt, opts) expects opts to be an object.");
  }

  for (const key of Object.keys(options)) {
    if (AGENT_OPTIONS.indexOf(key) !== -1) continue;
    throw new Error(
      "agent() opts." + key + " is not a recognised option. Supported: " + AGENT_OPTIONS.join(", ") + "."
    );
  }

  const label = optionalText(options.label, "agent() opts.label");
  const phaseName = optionalText(options.phase, "agent() opts.phase");
  const model = optionalText(options.model, "agent() opts.model");
  const agentType = optionalText(options.agentType, "agent() opts.agentType");
  const isolation = optionalText(options.isolation, "agent() opts.isolation");
  if (isolation !== undefined && isolation !== "worktree") {
    throw new Error('agent() opts.isolation must be "worktree".');
  }
  const gate = optionalText(options.gate, "agent() opts.gate");
  const resume = optionalText(options.resume, "agent() opts.resume");
  const effort = optionalText(options.effort, "agent() opts.effort");
  const schema = options.schema;
  if (schema !== undefined) {
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      throw new Error("agent() opts.schema must be a JSON Schema object.");
    }
    checkBoundary(schema, "agent() opts.schema");
  }
  // attachments：产物 ID 列表。非数组、非字符串项、空/纯空白 ID 一律显式拒绝
  //（宿主按 ID 解析产物，空串无意义且可能掩盖上游 bug）；空数组允许（= 无附件）。
  // 语义不归一化：未提供（undefined）与空数组（[]）在重放指纹上是不同调用。
  const attachments = options.attachments;
  if (attachments !== undefined) {
    if (!Array.isArray(attachments)) {
      throw new Error("agent() opts.attachments must be an array of artifact IDs.");
    }
    for (let i = 0; i < attachments.length; i++) {
      if (typeof attachments[i] !== "string" || attachments[i].trim() === "") {
        throw new Error(
          "agent() opts.attachments requires non-empty string artifact IDs; item " + i + " is empty or blank."
        );
      }
    }
  }
  if (effort !== undefined && EFFORT_LEVELS.indexOf(effort) === -1) {
    throw new Error("agent() opts.effort must be one of: " + EFFORT_LEVELS.join(", ") + ".");
  }
  // 显式设置目标子树的绝对层级上限；宿主验证不得超过受管发起方的授权。
  // resume 缺省沿用已登记事实，显式设置时同样参与校验与重放指纹。
  const maxSubagentDepth = options.maxSubagentDepth;
  if (
    maxSubagentDepth !== undefined &&
    (typeof maxSubagentDepth !== "number" || !Number.isInteger(maxSubagentDepth) || maxSubagentDepth < 1 || maxSubagentDepth > 5)
  ) {
    throw new Error("agent() opts.maxSubagentDepth must be an integer between 1 and 5.");
  }
  // 目标节点绝对路径：不带 isolation 时直接在该目录运行；带 isolation:
  // 'worktree' 时从该 cwd 切出于工作树（设计 §2.2）。与 resume 互斥。
  const cwd = optionalText(options.cwd, "agent() opts.cwd");
  // 单回合超时与门禁超时（毫秒整数）：范围在 worker 侧先行拒绝，宿主只做二次校验。
  const timeoutMs = options.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000)
  ) {
    throw new Error("agent() opts.timeoutMs must be an integer between 1000 and 3600000 (milliseconds).");
  }
  const gateTimeoutMs = options.gateTimeoutMs;
  if (
    gateTimeoutMs !== undefined &&
    (typeof gateTimeoutMs !== "number" || !Number.isInteger(gateTimeoutMs) || gateTimeoutMs < 1000 || gateTimeoutMs > 600000)
  ) {
    throw new Error("agent() opts.gateTimeoutMs must be an integer between 1000 and 600000 (milliseconds).");
  }
  if (gateTimeoutMs !== undefined && gate === undefined) {
    throw new Error("agent() opts.gateTimeoutMs requires opts.gate: it bounds how long the gate command may run.");
  }
  // 失败自动重试次数（门禁失败/门禁超时/回合超时才触发，重试循环在宿主）。
  const maxAttempts = options.maxAttempts;
  if (
    maxAttempts !== undefined &&
    (typeof maxAttempts !== "number" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)
  ) {
    throw new Error("agent() opts.maxAttempts must be an integer between 1 and 10.");
  }

  if (resume !== undefined) {
    if (agentType !== undefined) {
      throw new Error(
        "agent() opts.resume and opts.agentType are mutually exclusive: a resumed agent keeps the agent type it was started with."
      );
    }
    if (model !== undefined) {
      throw new Error(
        "agent() opts.resume and opts.model are mutually exclusive: a resumed agent keeps the model it was started with."
      );
    }
    if (isolation !== undefined) {
      throw new Error(
        "agent() opts.resume and opts.isolation are mutually exclusive: a resumed agent keeps the working tree it was started in."
      );
    }
    if (cwd !== undefined) {
      throw new Error(
        "agent() opts.resume and opts.cwd are mutually exclusive: a resumed agent keeps the working directory it was started in."
      );
    }
    if (effort !== undefined) {
      throw new Error(
        "agent() opts.resume and opts.effort are mutually exclusive: a resumed agent keeps the reasoning effort it was started with."
      );
    }
    // schema 与 gate/attachments 允许与 resume 组合：续接回合可带新的输出契约、
    // 验收门禁与本轮附件（附件只属于本轮提交，绝不自动沿用原任务的附件列表）。
    // schema/gate 经 resumeAgent options 下传实际执行环境（原生补挂 StructuredOutput
    // 扩展；gate 在实际执行环境内恰好一次执行并经 onGateResult 回报）。
  }

  return {
    text: text,
    label: label,
    phaseName: phaseName,
    model: model,
    agentType: agentType,
    isolation: isolation,
    gate: gate,
    resume: resume,
    effort: effort,
    schema: schema,
    attachments: attachments,
    maxSubagentDepth: maxSubagentDepth,
    cwd: cwd,
    timeoutMs: timeoutMs,
    gateTimeoutMs: gateTimeoutMs,
    maxAttempts: maxAttempts,
  };
}

/** 统一的 agent 下发面：scopeId 标识调用方 scope，withMeta 标记需要带执行元数据的返回包装。 */
async function callAgentHost(scope, options, withMeta) {
  const phaseIndex = options.phaseName !== undefined ? definePhaseIn(scope, options.phaseName) : scope.ambientPhaseIndex;
  const phaseTitle = options.phaseName !== undefined ? scopedTitle(scope, options.phaseName) : scope.ambientPhaseTitle;

  return await callHost("agent", {
    prompt: options.text,
    label: options.label,
    model: options.model,
    agentType: options.agentType,
    isolation: options.isolation,
    phaseIndex: phaseIndex,
    phaseTitle: phaseTitle,
    gate: options.gate,
    resume: options.resume,
    effort: options.effort,
    schema: options.schema,
    attachments: options.attachments,
    maxSubagentDepth: options.maxSubagentDepth,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    gateTimeoutMs: options.gateTimeoutMs,
    maxAttempts: options.maxAttempts,
    scopeId: scope.id,
    scopePath: scope.path,
    scopeCallIndex: scope.nextJournalCallIndex++,
    ...(withMeta ? { withMeta: true } : {}),
  });
}

/**
 * agent.withMeta(prompt, opts) — 与 agent() 同一参数面，但返回带执行元数据的
 * AgentWithMetaResult（ok/output/attempts/execution/gate）。宿主必须回传
 * { ok: boolean, ... } 元数据对象；回退为文本或 null 时显式报错，绝不把裸
 * 文本伪装成元数据对象（诚实性红线：能力未支持就报错，不静默降级）。
 */
async function agentWithMetaIn(scope, prompt, opts) {
  const options = readAgentOptions(prompt, opts);
  const result = await callAgentHost(scope, options, true);
  if (result === null || typeof result !== "object" || typeof result.ok !== "boolean") {
    throw new Error(
      "agent.withMeta(): the host returned a result that is not an execution meta object " +
        "(expected { ok: boolean, output, attempts, ... })."
    );
  }
  // 宿主回传的是 worker realm 的 structured-clone 对象；经 JSON 往返重建为
  // VM realm 原生对象（与 schema 结果同构处理），杜绝跨 realm prototype 泄入脚本。
  return realmParse(JSON.stringify(result));
}

/**
 * goal(spec) — agent.withMeta(objective, opts) 的简写，默认 maxAttempts = 3
 *（设计 §2.3：面向门禁/超时自动重试的目标式调用）。spec 键 = objective +
 * 全部 AGENT_OPTIONS；其余语义与 agent.withMeta 完全一致。
 */
async function goalIn(scope, spec) {
  if (spec === undefined || spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("goal(spec) expects an options object.");
  }
  for (const key of Object.keys(spec)) {
    if (key === "objective" || AGENT_OPTIONS.indexOf(key) !== -1) continue;
    throw new Error(
      "goal() spec." + key + " is not a recognised option. Supported: objective, " + AGENT_OPTIONS.join(", ") + "."
    );
  }
  const objective = requireText(spec.objective, "goal() spec.objective");
  const options = {};
  for (const key of Object.keys(spec)) {
    if (key === "objective" || spec[key] === undefined) continue;
    options[key] = spec[key];
  }
  if (options.maxAttempts === undefined) options.maxAttempts = 3;
  return agentWithMetaIn(scope, objective, options);
}

const ACTION_OPT_KEYS = ["idempotent", "label", "phase"];

/**
 * action(actionId, input, opts) — helm 扩展原语。
 *
 * 零 Token 确定性调用宿主动作总线。input 必须是可序列化 JSON（可选参数，
 * 缺省为 {}）；opts 支持 idempotent/label/phase；宿主负责 manifest 精确匹配、
 * schema 校验与账本重放语义，worker 侧只做边界检查与转发。
 */
async function actionIn(scope, actionId, input, opts) {
  const id = requireText(actionId, "action(actionId, input, opts)");
  if (input === undefined) input = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("action(actionId, input, opts) expects input to be a JSON object.");
  }
  checkBoundary(input, "action('" + id + "') input");

  let idempotent = undefined;
  let label = undefined;
  let phaseName = undefined;

  if (opts !== undefined) {
    if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
      throw new Error("action(actionId, input, opts) expects opts to be an object.");
    }
    const keys = Object.keys(opts);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (ACTION_OPT_KEYS.indexOf(k) === -1) {
        throw new Error("action() unknown option '" + k + "'. Allowed: " + ACTION_OPT_KEYS.join(", ") + ".");
      }
    }
    if (opts.idempotent !== undefined) {
      if (typeof opts.idempotent !== "boolean") {
        throw new Error("action() opts.idempotent must be a boolean.");
      }
      idempotent = opts.idempotent;
    }
    if (opts.label !== undefined) {
      label = requireText(opts.label, "action() opts.label");
    }
    if (opts.phase !== undefined) {
      phaseName = requireText(opts.phase, "action() opts.phase");
    }
  }

  const phaseIndex = phaseName !== undefined ? definePhaseIn(scope, phaseName) : scope.ambientPhaseIndex;
  const phaseTitle = phaseName !== undefined ? scopedTitle(scope, phaseName) : scope.ambientPhaseTitle;

  return await callHost("action", {
    scopePath: scope.path,
    scopeCallIndex: scope.nextJournalCallIndex++,
    actionId: id,
    input: input,
    label: label,
    idempotent: idempotent,
    phaseIndex: phaseIndex,
    phaseTitle: phaseTitle,
  });
}

async function parallel(thunks) {
  const list = toList(thunks, "parallel(thunks)");
  for (let i = 0; i < list.length; i++) {
    if (typeof list[i] !== "function") {
      throw new Error("parallel(thunks) expects an array of functions; item " + i + " is not one.");
    }
  }
  const settled = await Promise.all(
    list.map(async function (thunk) {
      try {
        return await thunk();
      } catch (error) {
        if (isFatal(error)) throw error;
        return null;
      }
    })
  );
  return toRealmArray(settled);
}

async function pipeline(items, ...stages) {
  const list = toList(items, "pipeline(items, ...stages)");
  for (let i = 0; i < stages.length; i++) {
    if (typeof stages[i] !== "function") {
      throw new Error("pipeline(items, ...stages) expects stages to be functions; stage " + i + " is not one.");
    }
  }
  const settled = await Promise.all(
    list.map(async function (item, index) {
      let value = item;
      for (let s = 0; s < stages.length; s++) {
        try {
          value = await stages[s](value, item, index);
        } catch (error) {
          if (isFatal(error)) throw error;
          return null;
        }
      }
      return value;
    })
  );
  return toRealmArray(settled);
}

async function workflowIn(scope, nameOrRef, args) {
  if (scope.depth >= MAX_WORKFLOW_NESTING_DEPTH) {
    throw new Error(
      "workflow() cannot be nested more than " + MAX_WORKFLOW_NESTING_DEPTH + " levels deep — you are already inside the workflow '" +
        scope.name + "'. Call the agents inline instead."
    );
  }

  let ref;
  if (typeof nameOrRef === "string") {
    if (nameOrRef.trim() === "") throw new Error("workflow(nameOrRef) expects a non-empty name.");
    ref = { name: nameOrRef };
  } else if (nameOrRef && typeof nameOrRef === "object" && !Array.isArray(nameOrRef)) {
    const scriptPath = optionalText(nameOrRef.scriptPath, "workflow() scriptPath");
    const name = optionalText(nameOrRef.name, "workflow() name");
    if (scriptPath === undefined && name === undefined) {
      throw new Error("workflow({ ... }) expects a \`name\` or a \`scriptPath\`.");
    }
    ref = { name: name, scriptPath: scriptPath };
  } else {
    throw new Error("workflow(nameOrRef) expects a saved workflow name or { scriptPath }.");
  }

  const label = ref.name !== undefined ? ref.name : ref.scriptPath;
  if (args !== undefined) checkBoundary(args, 'workflow("' + label + '") args');

  if (nestedCount >= workerData.nestedCap) {
    const error = new Error(
      "Workflow exceeded its cap of " + workerData.nestedCap + " nested workflow() calls."
    );
    error.workflowFatal = true;
    throw error;
  }
  nestedCount++;
  const workflowIndex = scope.nextWorkflowIndex++;

  let loaded;
  try {
    loaded = await callHost("workflow", ref);
  } catch (error) {
    if (isFatal(error)) throw error;
    throw new Error('workflow("' + label + '"): ' + describe(error));
  }

  const childPath = scope.path + "/" + workflowIndex;
  const child = makeScope(loaded.name, scope.depth + 1, childPath);
  child.ambientPhaseIndex = definePhaseIn(child, undefined);
  child.ambientPhaseTitle = scopedTitle(child, undefined);

  let run;
  try {
    const compiled = new vm.Script(
      "(async (agent, phase, log, workflow, action, console, args, goal) => {" + PRELUDE + "\\n" + loaded.body + "\\n})",
      { filename: "workflow:" + loaded.name + ".js", lineOffset: -1 }
    );
    run = compiled.runInContext(realmContext);
  } catch (error) {
    throw new Error('workflow("' + label + '"): ' + describe(error));
  }

  const value = await run(child.agent, child.phase, child.log, child.workflow, child.action, child.console, args, child.goal);
  checkBoundary(value, 'the result of workflow("' + label + '")');
  return value;
}

function makeBudget() {
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

  const value = await script.runInContext(context);
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
`;
