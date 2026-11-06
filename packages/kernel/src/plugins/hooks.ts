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
  type WatchdogTickHookPayload,
} from '@helm/protocol';

/**
 * 各 Hook 允许的组合动作（设计文档）：
 * - trigger / input / tool_call 可拦截或改写；
 * - before_turn 只允许原地修改；
 * - tool_result 可改写结果；agent_spawn 可接管；
 * - turn_settled / watchdog_tick 偏通知，不提供 block 门控。
 */
export const HOOK_ALLOWED_ACTIONS: Record<HookName, ReadonlySet<string>> = {
  trigger: new Set(['continue', 'transform', 'handled']),
  input: new Set(['continue', 'transform', 'handled']),
  before_turn: new Set(['continue', 'transform']),
  tool_call: new Set(['continue', 'transform', 'handled', 'block']),
  tool_result: new Set(['continue', 'transform', 'handled']),
  agent_spawn: new Set(['continue', 'transform', 'handled']),
  turn_settled: new Set(['continue', 'transform', 'handled']),
  watchdog_tick: new Set(['continue', 'transform', 'handled']),
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

function reqNumber(o: Record<string, unknown>, k: string): string | null {
  return typeof o[k] === 'number' && Number.isFinite(o[k] as number) ? null : `字段 ${k} 必须是有限数字`;
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
    reqNumber(v, 'id') ??
    reqString(v, 'title') ??
    reqString(v, 'profileId') ??
    reqArray(v, 'tags') ??
    reqString(v, 'cwd') ??
    reqString(v, 'model') ??
    (['working', 'blocked', 'done', 'idle', 'error'].includes(String(v.status))
      ? null
      : '字段 status 必须是五态之一') ??
    reqNumber(v, 'stateChangeSeq') ??
    reqNumber(v, 'completionSeq') ??
    (typeof v.unread === 'boolean' ? null : '字段 unread 必须是布尔值') ??
    (typeof v.pinned === 'boolean' ? null : '字段 pinned 必须是布尔值') ??
    reqNumber(v, 'pendingAskCount') ??
    reqNumber(v, 'createdAt') ??
    reqNumber(v, 'updatedAt')
  );
}

function checkConversationInput(v: unknown): string | null {
  if (!isObj(v)) return 'inputs 的每项必须是 ConversationInput';
  return (
    reqString(v, 'id') ??
    reqString(v, 'text') ??
    (['human', 'agent', 'trigger'].includes(String(v.origin)) ? null : '字段 origin 必须是 human|agent|trigger') ??
    (v.whenBusy === undefined || ['steer', 'followUp', 'reject'].includes(String(v.whenBusy))
      ? null
      : '字段 whenBusy 若存在必须是 steer|followUp|reject') ??
    reqNumber(v, 'createdAt')
  );
}

const PAYLOAD_CHECKS: Record<HookName, PayloadCheck> = {
  trigger: (v) => {
    if (!isObj(v)) return '必须是 ExternalTriggerEnvelope 对象';
    return reqString(v, 'source') ?? reqString(v, 'text') ?? reqNumber(v, 'createdAt') ?? optString(v, 'threadKey');
  },
  input: (v) => {
    if (!isObj(v)) return '必须是对象';
    return reqNumber(v, 'conversationId') ?? checkConversationInput(v.input);
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
      reqNumber(v, 'conversationId') ??
      reqString(v, 'callId') ??
      reqString(v, 'toolName') ??
      (isObj(v.input) ? null : '字段 input 必须是对象')
    );
  },
  tool_result: (v) => {
    if (!isObj(v)) return '必须是对象';
    return (
      reqNumber(v, 'conversationId') ??
      reqString(v, 'callId') ??
      reqString(v, 'toolName') ??
      (isObj(v.input) ? null : '字段 input 必须是对象') ??
      ('result' in v ? null : '字段 result 必须存在（值可为 null）')
    );
  },
  agent_spawn: (v) => {
    if (!isObj(v)) return '必须是 AgentSpawnRequest 对象';
    return (
      reqNumber(v, 'parentConversationId') ??
      reqString(v, 'prompt') ??
      optString(v, 'agentId') ??
      optString(v, 'agentType') ??
      optString(v, 'model') ??
      optString(v, 'effort') ??
      optString(v, 'cwd') ??
      optString(v, 'gate') ??
      optString(v, 'resume') ??
      (v.isolation === undefined || v.isolation === 'worktree' ? null : '字段 isolation 仅允许 worktree') ??
      (v.schema === undefined || isObj(v.schema) ? null : '字段 schema 若存在必须是对象') ??
      (v.onCreated === undefined || typeof v.onCreated === 'function' ? null : '字段 onCreated 若存在必须是函数') ??
      (v.signal === undefined || v.signal instanceof AbortSignal ? null : '字段 signal 若存在必须是 AbortSignal')
    );
  },
  turn_settled: (v) => {
    if (!isObj(v)) return '必须是 TurnSettledPayload 对象';
    let err = checkConversationSummary(v.conversation) ?? reqArray(v, 'inputs') ?? optString(v, 'error') ?? reqNumber(v, 'settledAt');
    if (err) return err;
    if (!['completed', 'failed', 'aborted'].includes(String(v.outcome))) {
      return '字段 outcome 必须是 completed|failed|aborted';
    }
    for (const i of v.inputs as unknown[]) if ((err = checkConversationInput(i))) return err;
    return null;
  },
  watchdog_tick: (v) => {
    if (!isObj(v)) return '必须是 WatchdogTickHookPayload 对象';
    let err = reqNumber(v, 'timestamp') ?? reqArray(v, 'conversations') ?? reqArray(v, 'probes');
    if (err) return err;
    for (const c of v.conversations as unknown[]) if ((err = checkConversationSummary(c))) return err;
    for (const p of v.probes as unknown[]) {
      if (
        !isObj(p) ||
        typeof p.targetId !== 'string' ||
        !['helm', 'bot', 'human'].includes(String(p.ownedBy)) ||
        typeof p.status !== 'string' ||
        (p.stalledMs !== undefined && typeof p.stalledMs !== 'number') ||
        (p.consecutiveErrors !== undefined && typeof p.consecutiveErrors !== 'number') ||
        (p.facts !== undefined && !isObj(p.facts))
      ) {
        return '字段 probes 的每项必须是 WatchdogProbe';
      }
    }
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
    return this.hooks;
  }

  private ensureSorted(): void {
    if (!this.sorted) {
      // V8 sort 稳定：同 priority 保持注册顺序。
      this.hooks.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      this.sorted = true;
    }
  }

  /**
   * 执行整条管道，返回短路结果（若有）与最终载荷。
   * 任一处理器异常或产物违约都显式抛出，绝不静默。
   */
  async run(
    payload: HookPayloadMap[K],
  ): Promise<{ finalPayload: HookPayloadMap[K]; shortCircuit?: Extract<HookResult<unknown>, { action: 'handled' | 'block' }> }> {
    assertHookPayload(this.name, payload);
    const allowed = HOOK_ALLOWED_ACTIONS[this.name];
    let current = payload;
    for (const hook of this.entries()) {
      let result: HookResult<HookPayloadMap[K]> | void;
      try {
        result = await hook.handler(current);
      } catch (err) {
        if (err instanceof HelmError) throw err;
        throw new HelmError(
          'hook_execution_failed',
          `插件 ${hook.pluginId} 的 ${this.name} 钩子执行抛出异常：${err instanceof Error ? err.message : String(err)}`,
          500,
          { pluginId: hook.pluginId, hook: this.name },
        );
      }
      if (result === undefined || result === null) continue; // void 等价 continue
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
      if (result.action === 'continue') continue;
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
        current = result.value;
        continue;
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
        return { finalPayload: current, shortCircuit: result };
      }
      return { finalPayload: current, shortCircuit: result }; // handled
    }
    return { finalPayload: current };
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
  WatchdogTickHookPayload,
};
