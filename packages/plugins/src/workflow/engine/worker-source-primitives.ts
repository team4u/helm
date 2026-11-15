/**
 * worker-source-primitives.ts — worker 源码分片二：编排业务原语。
 *
 * 自 worker-source.ts 拆出（生成代码逐字节不变）：agent() / agent.withMeta() /
 * goal() 的参数校验与宿主下发面、action(actionId, input) 零 Token 原语、
 * parallel / pipeline 分支账本并发原语，以及 workflow() 嵌套加载与深度上限。
 * 依赖 worker-source-prelude.ts 的 callHost / makeScope / checkBoundary 等底座；
 * 组装见 worker-source.ts。
 */
export const WORKER_PRIMITIVES_SOURCE = `async function agentIn(scope, prompt, opts) {
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
  const journalScope = journalScopeIn(scope);
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
    scopePath: journalScope.path,
    scopeCallIndex: journalScope.nextJournalCallIndex++,
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

  const journalScope = journalScopeIn(scope);
  return await callHost("action", {
    scopePath: journalScope.path,
    scopeCallIndex: journalScope.nextJournalCallIndex++,
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
  const inBranch = branchRunner();
  const settled = await Promise.all(
    list.map(function (thunk, index) {
      return inBranch(index, async function () {
        try {
          return await thunk();
        } catch (error) {
          if (isFatal(error)) throw error;
          return null;
        }
      });
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
  const inBranch = branchRunner();
  const settled = await Promise.all(
    list.map(function (item, index) {
      return inBranch(index, async function () {
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
      });
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
  const parentJournal = journalScopeIn(scope);
  const workflowIndex = parentJournal.nextChildIndex++;

  let loaded;
  try {
    loaded = await callHost("workflow", ref);
  } catch (error) {
    if (isFatal(error)) throw error;
    throw new Error('workflow("' + label + '"): ' + describe(error));
  }

  const childPath = parentJournal.path + "/" + workflowIndex;
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

  const value = await journalContext.run({ ownerId: child.id, state: child }, function () {
    return run(child.agent, child.phase, child.log, child.workflow, child.action, child.console, args, child.goal);
  });
  checkBoundary(value, 'the result of workflow("' + label + '")');
  return value;
}

`
