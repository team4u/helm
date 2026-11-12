/**
 * 通用优先级 Hook 管道（后端 8 挂载点共用机制，零业务特判）。
 *
 * 语义：
 * - priority 数值较大者先执行；同优先级按注册顺序（Array.prototype.sort 稳定）。
 * - 处理器返回 void / undefined 等价 continue。
 * - transform.value 经运行时载荷校验后作为下游输入继续传递。
 * - handled / block 立即短路，后续处理器不再执行。
 * - 非法产物（缺 action、未知 action、该钩子不允许的 action、transform 缺 value、
 *   transform 后必要字段被破坏、block 缺 reason）→ 显式 invalid_hook_result，
 *   绝不静默当 continue（诚实性纪律）。
 * - 处理器抛异常 → 包装 HelmError(hook_execution_failed, 500) 上抛，
 *   由调用方决定管道失败语义；禁止吞错继续跑。
 */
import {
  HelmError,
  type AgentSpawnRequest,
  type BeforeTurnHookPayload,
  type ExternalTriggerEnvelope,
  type HookHandler,
  type HookName,
  type HookPayloadMap,
  type HookResult,
  type InputHookPayload,
  type ToolCallHookPayload,
  type ToolResultHookPayload,
  type TurnSettledPayload,
} from '@helm/protocol';

/**
 * 各 Hook 允许的组合动作（设计文档）：
 * - trigger / input / tool_call 可拦截或改写；
 * - before_turn 只允许原地修改；
 * - tool_result 可改写结果；agent_spawn 可接管；
 * - turn_settled 偏通知，不提供 block 门控。
 */
export const HOOK_ALLOWED_ACTIONS: Record<HookName, ReadonlySet<string>> = {
  trigger: new Set(['continue', 'transform', 'handled']),
  input: new Set(['continue', 'transform', 'handled']),
  before_turn: new Set(['continue', 'transform']),
  tool_call: new Set(['continue', 'transform', 'handled', 'block']),
  tool_result: new Set(['continue', 'transform', 'handled']),
  agent_spawn: new Set(['continue', 'transform', 'handled']),
  turn_settled: new Set(['continue', 'transform', 'handled']),
};

export interface RegisteredHook<K extends HookName = HookName> {
  pluginId: string;
  priority: number;
  /** 注册序号，稳定排序的次级键。 */
  seq: number;
  handler: HookHandler<K>;
}

// ---------------------------------------------------------------------------
// 载荷运行时校验：管道入口 + 每次 transform 后 + runtime 默认行为前可复用
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqString(o: Record<string, unknown>, k: string): string | null {
  return typeof o[k] === 'string' && (o[k] as string).length > 0 ? null : `字段 ${k} 必须是非空字符串`;
}

/** 字符串类型检查但允许空串：model 未配置时是合法的空串，由 submitInput 负责 model_not_configured。 */
function strAllowEmpty(o: Record<string, unknown>, k: string): string | null {
  return typeof o[k] === 'string' ? null : `字段 ${k} 必须是字符串（允许空串）`;
}

function reqPositiveInt(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'number' && Number.isInteger(v) && (v as number) > 0
    ? null
    : `字段 ${k} 必须是正整数`;
}

function reqNonNegativeInt(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'number' && Number.isInteger(v) && (v as number) >= 0
    ? null
    : `字段 ${k} 必须是非负整数`;
}

function reqArray(o: Record<string, unknown>, k: string): string | null {
  return Array.isArray(o[k]) ? null : `字段 ${k} 必须是数组`;
}

function optString(o: Record<string, unknown>, k: string): string | null {
  return o[k] === undefined || typeof o[k] === 'string' ? null : `字段 ${k} 若存在必须是字符串`;
}

type PayloadCheck = (v: unknown) => string | null;

function checkConversationSummary(v: unknown): string | null {
  if (!isObj(v)) return 'conversation 必须是对象';
  return (
    reqPositiveInt(v, 'id') ??
    reqString(v, 'title') ??
    reqString(v, 'profileId') ??
    reqArray(v, 'tags') ??
    reqString(v, 'cwd') ??
    strAllowEmpty(v, 'model') ??
    (['working', 'blocked', 'done', 'idle', 'error'].includes(String(v.status))
      ? null
      : '字段 status 必须是五态之一') ??
    reqNonNegativeInt(v, 'stateChangeSeq') ??
    reqNonNegativeInt(v, 'completionSeq') ??
    (typeof v.unread === 'boolean' ? null : '字段 unread 必须是布尔值') ??
    (typeof v.pinned === 'boolean' ? null : '字段 pinned 必须是布尔值') ??
    reqNonNegativeInt(v, 'pendingAskCount') ??
    reqNonNegativeInt(v, 'createdAt') ??
    reqNonNegativeInt(v, 'updatedAt')
  );
}

function checkConversationInput(v: unknown): string | null {
  if (!isObj(v)) return 'inputs 的每项必须是 ConversationInput';
  return (
    reqString(v, 'id') ??
    strAllowEmpty(v, 'text') ??
    (['human', 'agent', 'trigger'].includes(String(v.origin)) ? null : '字段 origin 必须是 human|agent|trigger') ??
    (v.whenBusy === undefined || ['steer', 'followUp', 'reject'].includes(String(v.whenBusy))
      ? null
      : '字段 whenBusy 若存在必须是 steer|followUp|reject') ??
    reqNonNegativeInt(v, 'createdAt')
  );
}

const PAYLOAD_CHECKS: Record<HookName, PayloadCheck> = {
  trigger: (v) => {
    if (!isObj(v)) return '必须是 ExternalTriggerEnvelope 对象';
    return (
      reqString(v, 'id') ??
      reqString(v, 'source') ??
      reqString(v, 'text') ??
      reqNonNegativeInt(v, 'createdAt') ??
      optString(v, 'threadKey')
    );
  },
  input: (v) => {
    if (!isObj(v)) return '必须是对象';
    return reqPositiveInt(v, 'conversationId') ?? checkConversationInput(v.input);
  },
  before_turn: (v) => {
    if (!isObj(v)) return '必须是对象';
    let err =
      checkConversationSummary(v.conversation) ??
      reqArray(v, 'inputs') ??
      reqArray(v, 'tools') ??
      reqArray(v, 'sections') ??
      reqArray(v, 'messages');
    if (err) return err;
    for (const i of v.inputs as unknown[]) if ((err = checkConversationInput(i))) return err;
    for (const t of v.tools as unknown[]) {
      if (!isObj(t) || typeof t.name !== 'string' || typeof t.description !== 'string' || !isObj(t.inputSchema)) {
        return '字段 tools 的每项必须是 PluginToolSpec';
      }
    }
    for (const s of v.sections as unknown[]) {
      if (!isObj(s) || typeof s.id !== 'string' || typeof s.text !== 'string') {
        return '字段 sections 的每项必须是 { id: string; text: string }';
      }
    }
    for (const m of v.messages as unknown[]) {
      if (!isObj(m)) return '字段 messages 的每项必须是对象';
    }
    return null;
  },
  tool_call: (v) => {
    if (!isObj(v)) return '必须是对象';
    return (
      reqPositiveInt(v, 'conversationId') ??
      reqString(v, 'callId') ??
      reqString(v, 'toolName') ??
      (isObj(v.input) ? null : '字段 input 必须是对象')
    );
  },
  tool_result: (v) => {
    if (!isObj(v)) return '必须是对象';
    return (
      reqPositiveInt(v, 'conversationId') ??
      reqString(v, 'callId') ??
      reqString(v, 'toolName') ??
      (isObj(v.input) ? null : '字段 input 必须是对象') ??
      ('result' in v ? null : '字段 result 必须存在（值可为 null）')
    );
  },
  agent_spawn: (v) => {
    if (!isObj(v)) return '必须是 AgentSpawnRequest 对象';
    return (
      reqPositiveInt(v, 'parentConversationId') ??
      reqString(v, 'prompt') ??
      optString(v, 'agentId') ??
      optString(v, 'agentType') ??
      optString(v, 'model') ??
      optString(v, 'effort') ??
      optString(v, 'cwd') ??
      optString(v, 'gate') ??
      optString(v, 'resume') ??
      (v.isolation === undefined || typeof v.isolation === 'string' ? null : '字段 isolation 若存在必须是字符串') ??
      (v.schema === undefined || isObj(v.schema) ? null : '字段 schema 若存在必须是对象') ??
      (v.onCreated === undefined || typeof v.onCreated === 'function' ? null : '字段 onCreated 若存在必须是函数') ??
      (v.signal === undefined || v.signal instanceof AbortSignal ? null : '字段 signal 若存在必须是 AbortSignal')
    );
  },
  turn_settled: (v) => {
    if (!isObj(v)) return '必须是 TurnSettledPayload 对象';
    let err =
      checkConversationSummary(v.conversation) ?? reqArray(v, 'inputs') ?? optString(v, 'error') ?? reqNonNegativeInt(v, 'settledAt');
    if (err) return err;
    if (!['completed', 'failed', 'aborted'].includes(String(v.outcome))) {
      return '字段 outcome 必须是 completed|failed|aborted';
    }
    for (const i of v.inputs as unknown[]) if ((err = checkConversationInput(i))) return err;
    return null;
  },
};

/** 校验某 Hook 载荷的必要字段（入口 / transform 后 / runtime 默认行为前均可调用）。 */
export function assertHookPayload(name: HookName, value: unknown): void {
  const err = PAYLOAD_CHECKS[name](value);
  if (err) {
    throw new HelmError('invalid_hook_result', `钩子 ${name} 载荷校验失败：${err}`, 500, {
      hook: name,
      violation: err,
    });
  }
}

/** turn_settled 单插件异常隔离的收集结果（PluginHost 发告警用）。 */
export interface IsolatedHookError {
  pluginId: string;
  error: HelmError;
}

export class HookPipeline<K extends HookName> {
  private hooks: Array<RegisteredHook<K>> = [];
  private nextSeq = 0;
  private sorted = true;

  constructor(public readonly name: K) {}

  add(pluginId: string, handler: HookHandler<K>, priority = 0): void {
    this.hooks.push({ pluginId, priority, seq: this.nextSeq++, handler });
    this.sorted = false;
  }

  removeByPlugin(pluginId: string): void {
    this.hooks = this.hooks.filter((h) => h.pluginId !== pluginId);
  }

  get size(): number {
    return this.hooks.length;
  }

  entries(): Array<RegisteredHook<K>> {
    this.ensureSorted();
    // Why: run/runAround 遍历期间会 await 任意插件 handler，并发 add() 置
    // sorted=false 后另一路 runHook 触发原地 sort，会让正在遍历的活数组重排
    //（handler 跳过或重复）。返回快照副本隔离；hook 数量小，复制成本可忽略。
    return [...this.hooks];
  }

  private ensureSorted(): void {
    if (!this.sorted) {
      // V8 sort 稳定：同 priority 保持注册顺序。
      this.hooks.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      this.sorted = true;
    }
  }

  /**
   * 执行整条管道，返回短路结果（若有）、最终载荷与 turn_settled 隔离错误。
   * isParticipant 为空时执行全部；否则只执行返回 true 的处理器（宿主用它
   * 隔离未启用/正停用插件，绝不让其 handler 被调用）。
   * 拦截/改写型钩子任一处理器异常或产物违约都显式抛出，绝不静默；
   * turn_settled（结算通知型）改为单插件异常隔离：单个处理器抛错或产物
   * 非法时不中断循环、不覆盖上一个合法载荷，错误收集进 isolatedErrors
   * 由宿主统一发告警，后续插件照常结算。
   */
  async run(
    payload: HookPayloadMap[K],
    isParticipant?: (hook: RegisteredHook<K>) => boolean,
  ): Promise<{
    finalPayload: HookPayloadMap[K];
    shortCircuit?: Extract<HookResult<unknown>, { action: 'handled' | 'block' }>;
    isolatedErrors?: IsolatedHookError[];
  }> {
    assertHookPayload(this.name, payload);
    const allowed = HOOK_ALLOWED_ACTIONS[this.name];
    const isolate = this.name === 'turn_settled';
    const isolatedErrors: IsolatedHookError[] = [];
    /** 单处理器执行与产物校验；isolate 模式下违约转为收集错误而非抛出。 */
    const isolateError = (hook: RegisteredHook<K>, err: unknown): void => {
      isolatedErrors.push({
        pluginId: hook.pluginId,
        error:
          err instanceof HelmError
            ? err
            : new HelmError(
                'hook_execution_failed',
                `插件 ${hook.pluginId} 的 ${this.name} 钩子执行抛出异常：${err instanceof Error ? err.message : String(err)}`,
                500,
                { pluginId: hook.pluginId, hook: this.name },
              ),
      });
    };
    let current = payload;
    for (const hook of this.entries()) {
      if (isParticipant && !isParticipant(hook)) continue;
      let result: HookResult<HookPayloadMap[K]> | void;
      try {
        result = await (hook.handler as (payload: HookPayloadMap[K]) => unknown)(current) as HookResult<HookPayloadMap[K]> | void;
      } catch (err) {
        if (!isolate) {
          if (err instanceof HelmError) throw err;
          throw new HelmError(
            'hook_execution_failed',
            `插件 ${hook.pluginId} 的 ${this.name} 钩子执行抛出异常：${err instanceof Error ? err.message : String(err)}`,
            500,
            { pluginId: hook.pluginId, hook: this.name },
          );
        }
        isolateError(hook, err);
        continue;
      }
      if (result === undefined || result === null) continue; // void 等价 continue
      if (!isObj(result) || typeof result.action !== 'string') {
        const err = new HelmError(
          'invalid_hook_result',
          `插件 ${hook.pluginId} 的 ${this.name} 钩子返回了非法结果（缺少 action 字段）`,
          500,
          { pluginId: hook.pluginId, hook: this.name, result },
        );
        if (!isolate) throw err;
        isolateError(hook, err);
        continue;
      }
      if (!allowed.has(result.action)) {
        const err = new HelmError(
          'invalid_hook_result',
          `插件 ${hook.pluginId} 的 ${this.name} 钩子返回了不支持的组合动作 "${result.action}"（允许：${[...allowed].join('|')}）`,
          500,
          { pluginId: hook.pluginId, hook: this.name, allowed: [...allowed] },
        );
        if (!isolate) throw err;
        isolateError(hook, err);
        continue;
      }
      if (result.action === 'continue') continue;
      if (result.action === 'transform') {
        if (result.value === undefined) {
          const err = new HelmError(
            'invalid_hook_result',
            `插件 ${hook.pluginId} 的 ${this.name} 钩子返回 transform 但缺少 value`,
            500,
            { pluginId: hook.pluginId, hook: this.name },
          );
          if (!isolate) throw err;
          isolateError(hook, err);
          continue;
        }
        try {
          assertHookPayload(this.name, result.value);
        } catch (err) {
          if (!isolate) throw err;
          isolateError(hook, err);
          continue;
        }
        current = result.value;
        continue;
      }
      if (result.action === 'block') {
        if (typeof result.reason !== 'string' || result.reason.length === 0) {
          const err = new HelmError(
            'invalid_hook_result',
            `插件 ${hook.pluginId} 的 ${this.name} 钩子返回 block 但缺少非空 reason`,
            500,
            { pluginId: hook.pluginId, hook: this.name },
          );
          if (!isolate) throw err;
          isolateError(hook, err);
          continue;
        }
        return { finalPayload: current, shortCircuit: result };
      }
      return { finalPayload: current, shortCircuit: result }; // handled
    }
    return {
      finalPayload: current,
      ...(isolatedErrors.length > 0 ? { isolatedErrors } : {}),
    };
  }

  /**
   * 单处理器结果归一（run/runAround 共用）：void 归 continue；非法产物显式抛。
   * 返回 undefined 表示放行（continue）。
   */
  private normalizeResult(
    hook: RegisteredHook<K>,
    result: HookResult<HookPayloadMap[K]> | void,
  ): Extract<HookResult<HookPayloadMap[K]>, { action: 'transform' | 'handled' | 'block' }> | undefined {
    if (result === undefined || result === null) return undefined; // void 等价 continue
    const allowed = HOOK_ALLOWED_ACTIONS[this.name];
    if (!isObj(result) || typeof result.action !== 'string') {
      throw new HelmError(
        'invalid_hook_result',
        `插件 ${hook.pluginId} 的 ${this.name} 钩子返回了非法结果（缺少 action 字段）`,
        500,
        { pluginId: hook.pluginId, hook: this.name, result },
      );
    }
    if (!allowed.has(result.action)) {
      throw new HelmError(
        'invalid_hook_result',
        `插件 ${hook.pluginId} 的 ${this.name} 钩子返回了不支持的组合动作 "${result.action}"（允许：${[...allowed].join('|')}）`,
        500,
        { pluginId: hook.pluginId, hook: this.name, allowed: [...allowed] },
      );
    }
    if (result.action === 'continue') return undefined;
    if (result.action === 'transform') {
      if (result.value === undefined) {
        throw new HelmError(
          'invalid_hook_result',
          `插件 ${hook.pluginId} 的 ${this.name} 钩子返回 transform 但缺少 value`,
          500,
          { pluginId: hook.pluginId, hook: this.name },
        );
      }
      assertHookPayload(this.name, result.value);
      return result;
    }
    if (result.action === 'block') {
      if (typeof result.reason !== 'string' || result.reason.length === 0) {
        throw new HelmError(
          'invalid_hook_result',
          `插件 ${hook.pluginId} 的 ${this.name} 钩子返回 block 但缺少非空 reason`,
          500,
          { pluginId: hook.pluginId, hook: this.name },
        );
      }
      return result;
    }
    return result; // handled
  }

  /**
   * around（continuation）管道：仅 agent_spawn。每个处理器拿到受控 next；
   * 不调 next 而返回 handled = 完全接管（短路，与 run 同语义）；调 next 则
   * 包裹后续管道与默认执行（defaultRun 恰好一次）。
   *
   * 契约（违反显式拒绝，绝不静默）：
   * - next 只可调用一次（重复调用立即显式拒绝）；
   * - 已调 next 的处理器：其结果就是 next 的结果（宿主 join 同一 promise，
   *   绝不重复执行后续链）；不得再叠加 transform/handled/continue 之外的产物；
   * - 未 await 的 next（异步触发后提前返回/抛错）：宿主仍 join 同一
   *   nextPromise 后返回其结果（或如实上抛 handler 错误）——后续链恰好
   *   执行一次，无并发双执行、无孤儿执行；
   * - next 前抛错：后续管道不执行，错误如实上抛；
   * - 处理器返回 void/continue：语义为不包裹，next 链由宿主自动透传（该
   *   处理器之后的链路照常执行）。
   */
  async runAround(
    payload: HookPayloadMap[K],
    defaultRun: (finalPayload: HookPayloadMap[K]) => Promise<unknown>,
    isParticipant?: (hook: RegisteredHook<K>) => boolean,
  ): Promise<unknown> {
    if (this.name !== 'agent_spawn') {
      throw new HelmError('invalid_hook_invocation', `runAround 仅适用于 agent_spawn（收到 ${this.name}）`, 500, {
        hook: this.name,
      });
    }
    assertHookPayload(this.name, payload);
    const hooks = this.entries().filter((h) => (isParticipant ? isParticipant(h) : true));

    /**
     * 从第 index 个处理器起执行：返回 handled 接管产物或 defaultRun 的最终
     * 结果；处理器可经 next(finalRequest) 进入 index+1 起的同一链。
     */
    const dispatchFrom = async (index: number, current: HookPayloadMap[K]): Promise<unknown> => {
      for (let i = index; i < hooks.length; i += 1) {
        const hook = hooks[i]!;
        let called = false;
        /** 首次 next 调用创建的后续链 promise（join 唯一事实，防双执行）。 */
        let nextPromise: Promise<unknown> | undefined;
        /** 受控 continuation：同步返回 promise（进入 i+1 起的后续链，含 defaultRun）。 */
        const next = (request: HookPayloadMap[K]): Promise<unknown> => {
          if (called) {
            throw new HelmError(
              'invalid_hook_result',
              `插件 ${hook.pluginId} 的 agent_spawn 钩子重复调用 next（continuation 仅可进入一次）`,
              500,
              { pluginId: hook.pluginId, hook: this.name },
            );
          }
          called = true;
          const finalPayload = request === undefined || request === current ? current : request;
          if (finalPayload !== current) assertHookPayload(this.name, finalPayload);
          nextPromise = dispatchFrom(i + 1, finalPayload as HookPayloadMap[K]);
          return nextPromise;
        };
        let result: HookResult<HookPayloadMap[K]> | void;
        try {
          result = await (hook.handler as unknown as (
            payload: HookPayloadMap[K],
            next: (req: HookPayloadMap[K]) => Promise<unknown>,
          ) => unknown)(current, next as never) as HookResult<HookPayloadMap[K]> | void;
        } catch (err) {
          // handler 抛错但已触发 next（未 await 的后台链）：join 同一 promise
          // 后如实上抛 handler 错误（后续链恰好执行一次，结果如实丢弃）。
          if (nextPromise !== undefined) await nextPromise.then(() => undefined, () => undefined);
          if (err instanceof HelmError) throw err;
          throw new HelmError(
            'hook_execution_failed',
            `插件 ${hook.pluginId} 的 ${this.name} 钩子执行抛出异常：${err instanceof Error ? err.message : String(err)}`,
            500,
            { pluginId: hook.pluginId, hook: this.name },
          );
        }
        if (nextPromise !== undefined) {
          // 已触发 continuation：join 同一 promise 并把其结果作为本处理器的
          // 结果返回（后续链恰好执行一次；绝不继续当前循环）。叠加
          // transform/handled 属契约违约：join 后显式拒绝。
          if (result !== undefined && result !== null && isObj(result) && result.action !== 'continue') {
            await nextPromise.then(() => undefined, () => undefined);
            throw new HelmError(
              'invalid_hook_result',
              `插件 ${hook.pluginId} 的 agent_spawn 钩子已调用 next，不得再返回 "${String((result as { action?: unknown }).action)}"（next 的结果即它的结果）`,
              500,
              { pluginId: hook.pluginId, hook: this.name, result },
            );
          }
          return nextPromise;
        }
        const normalized = this.normalizeResult(hook, result);
        if (normalized === undefined) continue; // continue：不包裹，透传
        if (normalized.action === 'transform') {
          current = normalized.value as HookPayloadMap[K];
          continue;
        }
        // handled / block：短路（handled.result 即接管产物）。
        if (normalized.action === 'block') {
          throw new HelmError(
            'hook_blocked',
            `插件 ${hook.pluginId} 的 agent_spawn 钩子拦截了派生：${normalized.reason}`,
            403,
            { pluginId: hook.pluginId, hook: this.name, reason: normalized.reason },
          );
        }
        return normalized.result;
      }
      return defaultRun(current);
    };

    return dispatchFrom(0, payload);
  }
}

// 供测试与 runtime 引用具体载荷类型
export type {
  AgentSpawnRequest,
  BeforeTurnHookPayload,
  ExternalTriggerEnvelope,
  InputHookPayload,
  ToolCallHookPayload,
  ToolResultHookPayload,
  TurnSettledPayload,
};
