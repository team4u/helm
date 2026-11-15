/**
 * worker-source-prelude.ts — worker 源码分片一：确定性沙箱与运行底座。
 *
 * 自 worker-source.ts 拆出（生成代码逐字节不变）：承载 worker 线程源的基础设施段——
 * 确定性 Prelude（Date / Math.random 封锁）、与宿主的 RPC 通信底座（call/response、
 * fatal 传播、progress 批量刷新）、JSON 边界校验、realm 工具（toList/requireText…）
 * 以及 scope 运行底座（makeScope / 分支账本 / phase / log / console）。
 * 业务原语分片见 worker-source-primitives.ts；组装与导出见 worker-source.ts。
 */

/**
 * workflow() 嵌套深度上限（设计 §4.1）：根 scope 为第 0 层，depth 达到该值后
 * 禁止再嵌套（即整棵工作流树最多 4 层）。与 runtime.ts 的 WORKFLOW_NESTED_CAP
 * （单 run 内嵌套调用总量 256）正交：一个限深度，一个限总量。
 */
export const MAX_WORKFLOW_NESTING_DEPTH = 4

/**
 * 在 realm 内、脚本体之前运行；单行（行号偏移补偿依赖它恰好占一行）。
 *
 * - RealDate.now / Math.random 原地替换为抛错函数（Date/Math 来自 realm，
 *   无法通过注入覆盖，只能在 realm 内改写）。
 * - 返回受限子类：无参构造抛错，有参构造放行（时间戳经 args 传入是合法用法）。
 * - 同时写回 globalThis.Date：词法 shadow 只保护脚本源码里的裸 `Date`，
 *   `globalThis.Date` 别名不受 shadow 影响（helm 加固点）。
 */
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

/** 分片一：模板开始（"use strict"）至 scope 运行底座（makeConsole）结束。 */
export const WORKER_PRELUDE_SOURCE = `"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const { AsyncLocalStorage } = require("node:async_hooks");
const journalContext = new AsyncLocalStorage();

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
    nextChildIndex: 0,
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

function journalScopeIn(scope) {
  const active = journalContext.getStore();
  return active && active.ownerId === scope.id ? active.state : scope;
}

function branchRunner() {
  const active = journalContext.getStore();
  if (!active) throw new Error("Workflow journal context is unavailable.");
  const path = active.state.path + "/" + active.state.nextChildIndex++;
  return function (index, run) {
    const state = { path: path + "/" + index, nextJournalCallIndex: 0, nextChildIndex: 0 };
    return journalContext.run({ ownerId: active.ownerId, state: state }, run);
  };
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

`
