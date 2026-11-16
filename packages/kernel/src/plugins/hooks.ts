/**
 * through use priority Hook pipeline (backend 8 mount point shared use mechanism, zero business special judge).
 *
 * semantics:
 * - priority count value relatively large first execute; same priority by register order (Array.prototype.sort stable).
 * - handle return void / undefined etc. price continue.
 * - transform.value via runtime payload validate after as downstream input continue pass.
 * - handled / block immediately short route, after continue handle no longer execute.
 * - illegal artifact (missing action, unknown action, the hook disallows action,transform missing value,
 *   transform after must want field by break,block missing reason)→ explicit invalid_hook_result,
 *   never static default when continue(honest discipline).
 * - handle throw exception → wrap HelmError(hook_execution_failed, 500) on throw,
 *   by caller decide pipeline failed semantics; forbidden swallow wrong continue run.
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
 * each Hook allows combine action (design document):
 * - trigger / input / tool_call can intercept or change write;
 * - before_turn only allows original ground modify;
 * - tool_result can change write result;agent_spawn can take over;
 * - turn_settled bias notify, do not provide block gate control.
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
  /** register ordinal, stable sort time level key. */
  seq: number;
  handler: HookHandler<K>;
}

// ---------------------------------------------------------------------------
// payload runtime validate: pipeline entry + each time transform after + runtime by default behavior before can re- use
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqString(o: Record<string, unknown>, k: string): string | null {
  return typeof o[k] === 'string' && (o[k] as string).length > 0 ? null : `field ${k} must be non-empty string`;
}

/** string type check but allows empty string:model not config when is legal empty string, by submitInput negative duty model_not_configured. */
function strAllowEmpty(o: Record<string, unknown>, k: string): string | null {
  return typeof o[k] === 'string' ? null : `field ${k} must be string (allows empty string)`;
}

function reqPositiveInt(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'number' && Number.isInteger(v) && (v as number) > 0
    ? null
    : `field ${k} must be positive integer`;
}

function reqNonNegativeInt(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'number' && Number.isInteger(v) && (v as number) >= 0
    ? null
    : `field ${k} must be non- negative integer`;
}

function reqArray(o: Record<string, unknown>, k: string): string | null {
  return Array.isArray(o[k]) ? null : `field ${k} must be array`;
}

function optString(o: Record<string, unknown>, k: string): string | null {
  return o[k] === undefined || typeof o[k] === 'string' ? null : `field ${k} if store in must be string`;
}

type PayloadCheck = (v: unknown) => string | null;

function checkConversationSummary(v: unknown): string | null {
  if (!isObj(v)) return 'conversation must be object';
  return (
    reqPositiveInt(v, 'id') ??
    reqString(v, 'title') ??
    reqString(v, 'profileId') ??
    reqArray(v, 'tags') ??
    reqString(v, 'cwd') ??
    strAllowEmpty(v, 'model') ??
    (['working', 'blocked', 'done', 'idle', 'error'].includes(String(v.status))
      ? null
      : 'field status must be five state of one') ??
    reqNonNegativeInt(v, 'stateChangeSeq') ??
    reqNonNegativeInt(v, 'completionSeq') ??
    (typeof v.unread === 'boolean' ? null : 'field unread must be boolean value') ??
    (typeof v.pinned === 'boolean' ? null : 'field pinned must be boolean value') ??
    reqNonNegativeInt(v, 'pendingAskCount') ??
    reqNonNegativeInt(v, 'createdAt') ??
    reqNonNegativeInt(v, 'updatedAt')
  );
}

function checkConversationInput(v: unknown): string | null {
  if (!isObj(v)) return 'inputs each items must be ConversationInput';
  return (
    reqString(v, 'id') ??
    strAllowEmpty(v, 'text') ??
    (['human', 'agent', 'trigger'].includes(String(v.origin)) ? null : 'field origin must be human|agent|trigger') ??
    (v.whenBusy === undefined || ['steer', 'followUp', 'reject'].includes(String(v.whenBusy))
      ? null
      : 'field whenBusy if store in must be steer|followUp|reject') ??
    reqNonNegativeInt(v, 'createdAt')
  );
}

const PAYLOAD_CHECKS: Record<HookName, PayloadCheck> = {
  trigger: (v) => {
    if (!isObj(v)) return 'must be ExternalTriggerEnvelope object';
    return (
      reqString(v, 'id') ??
      reqString(v, 'source') ??
      reqString(v, 'text') ??
      reqNonNegativeInt(v, 'createdAt') ??
      optString(v, 'threadKey')
    );
  },
  input: (v) => {
    if (!isObj(v)) return 'must be object';
    return reqPositiveInt(v, 'conversationId') ?? checkConversationInput(v.input);
  },
  before_turn: (v) => {
    if (!isObj(v)) return 'must be object';
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
        return 'field tools each items must be PluginToolSpec';
      }
    }
    for (const s of v.sections as unknown[]) {
      if (!isObj(s) || typeof s.id !== 'string' || typeof s.text !== 'string') {
        return 'field sections each items must be { id: string; text: string }';
      }
    }
    for (const m of v.messages as unknown[]) {
      if (!isObj(m)) return 'field messages each items must be object';
    }
    return null;
  },
  tool_call: (v) => {
    if (!isObj(v)) return 'must be object';
    return (
      reqPositiveInt(v, 'conversationId') ??
      reqString(v, 'callId') ??
      reqString(v, 'toolName') ??
      (isObj(v.input) ? null : 'field input must be object')
    );
  },
  tool_result: (v) => {
    if (!isObj(v)) return 'must be object';
    return (
      reqPositiveInt(v, 'conversationId') ??
      reqString(v, 'callId') ??
      reqString(v, 'toolName') ??
      (isObj(v.input) ? null : 'field input must be object') ??
      ('result' in v ? null : 'field result must store in (value can is null)')
    );
  },
  agent_spawn: (v) => {
    if (!isObj(v)) return 'must be AgentSpawnRequest object';
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
      optString(v, 'requestId') ??
      (v.fork === undefined || typeof v.fork === 'boolean' ? null : 'field fork if store in must be boolean value') ??
      (v.reattach === undefined || isObj(v.reattach) ? null : 'field reattach if present must be object') ??
      (v.isolation === undefined || typeof v.isolation === 'string' ? null : 'field isolation if store in must be string') ??
      (v.schema === undefined || isObj(v.schema) ? null : 'field schema if store in must be object') ??
      (v.onCreated === undefined || typeof v.onCreated === 'function' ? null : 'field onCreated if store in must be function') ??
      (v.signal === undefined || v.signal instanceof AbortSignal ? null : 'field signal if store in must be AbortSignal')
    );
  },
  turn_settled: (v) => {
    if (!isObj(v)) return 'must be TurnSettledPayload object';
    let err =
      checkConversationSummary(v.conversation) ?? reqArray(v, 'inputs') ?? optString(v, 'error') ?? reqNonNegativeInt(v, 'settledAt');
    if (err) return err;
    if (!['completed', 'failed', 'aborted'].includes(String(v.outcome))) {
      return 'field outcome must be completed|failed|aborted';
    }
    for (const i of v.inputs as unknown[]) if ((err = checkConversationInput(i))) return err;
    return null;
  },
};

/** validate a certain Hook payload must want field (entry / transform after / runtime by default behavior before all can invoke). */
export function assertHookPayload(name: HookName, value: unknown): void {
  const err = PAYLOAD_CHECKS[name](value);
  if (err) {
    throw new HelmError('invalid_hook_result', `hook ${name} payload validation failed:${err}`, 500, {
      hook: name,
      violation: err,
    });
  }
}

/** turn_settled single plugin exception isolated collect result (PluginHost alert use). */
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
    // Why: run/runAround iterate during will await any plugin handler, concurrency add() placement
    // sorted=false after another route runHook trigger original ground sort, will let is now iterate array heavy arrange
    //(handler skip or duplicate). return snapshot copy isolated;hook amount small, duplicate cost can ignore.
    return [...this.hooks];
  }

  private ensureSorted(): void {
    if (!this.sorted) {
      // V8 sort stable: same priority keep register order.
      this.hooks.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      this.sorted = true;
    }
  }

  /**
   * execute whole pipeline, return short route result (if has), eventually payload and turn_settled isolated error.
   * isParticipant is empty when execute all; otherwise only execute return true handle (host use it
   * isolated not enabled/correct deactivate plugin, never let its handler by invoke).
   * intercept/change write type hook any one handle exception or artifact violate about all explicit throw, never static default;
   * turn_settled(compute notify type) change is single plugin exception isolated: single handle throws or artifact
   * illegal when without interruption loop, does not override on a legal payload, error collect enter isolatedErrors
   * by host unify alert, after continue plugin per common compute.
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
    /** single handle execute and artifact validate;isolate pattern under violate about rotate is collect error while non- throw. */
    const isolateError = (hook: RegisteredHook<K>, err: unknown): void => {
      isolatedErrors.push({
        pluginId: hook.pluginId,
        error:
          err instanceof HelmError
            ? err
            : new HelmError(
                'hook_execution_failed',
                `plugin ${hook.pluginId}  ${this.name} hook execute throw exception:${err instanceof Error ? err.message : String(err)}`,
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
            `plugin ${hook.pluginId}  ${this.name} hook execute throw exception:${err instanceof Error ? err.message : String(err)}`,
            500,
            { pluginId: hook.pluginId, hook: this.name },
          );
        }
        isolateError(hook, err);
        continue;
      }
      if (result === undefined || result === null) continue; // void etc. price continue
      if (!isObj(result) || typeof result.action !== 'string') {
        const err = new HelmError(
          'invalid_hook_result',
          `plugin ${hook.pluginId}  ${this.name} hook return illegal result (missing action field)`,
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
          `plugin ${hook.pluginId}  ${this.name} hook return unsupported combine action "${result.action}"(allows:${[...allowed].join('|')})`,
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
            `plugin ${hook.pluginId}  ${this.name} hook return transform but missing value`,
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
            `plugin ${hook.pluginId}  ${this.name} hook return block but missing non-empty reason`,
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
   * single handle result archive one (run/runAround shared use):void archive continue; illegal artifact explicit throw.
   * return undefined means let through (continue).
   */
  private normalizeResult(
    hook: RegisteredHook<K>,
    result: HookResult<HookPayloadMap[K]> | void,
  ): Extract<HookResult<HookPayloadMap[K]>, { action: 'transform' | 'handled' | 'block' }> | undefined {
    if (result === undefined || result === null) return undefined; // void etc. price continue
    const allowed = HOOK_ALLOWED_ACTIONS[this.name];
    if (!isObj(result) || typeof result.action !== 'string') {
      throw new HelmError(
        'invalid_hook_result',
        `plugin ${hook.pluginId}  ${this.name} hook return illegal result (missing action field)`,
        500,
        { pluginId: hook.pluginId, hook: this.name, result },
      );
    }
    if (!allowed.has(result.action)) {
      throw new HelmError(
        'invalid_hook_result',
        `plugin ${hook.pluginId}  ${this.name} hook return unsupported combine action "${result.action}"(allows:${[...allowed].join('|')})`,
        500,
        { pluginId: hook.pluginId, hook: this.name, allowed: [...allowed] },
      );
    }
    if (result.action === 'continue') return undefined;
    if (result.action === 'transform') {
      if (result.value === undefined) {
        throw new HelmError(
          'invalid_hook_result',
          `plugin ${hook.pluginId}  ${this.name} hook return transform but missing value`,
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
          `plugin ${hook.pluginId}  ${this.name} hook return block but missing non-empty reason`,
          500,
          { pluginId: hook.pluginId, hook: this.name },
        );
      }
      return result;
    }
    return result; // handled
  }

  /**
   * around(continuation) pipeline: only agent_spawn. each handle gets subject to control next;
   * do not tune next while return handled = fully take over (short route, and run same semantics); tune next then
   * package wrap after continue pipeline and by default execute (defaultRun exactly once).
   *
   * contract (violate reverse explicit reject, never static default):
   * - next only can invoke once (duplicate invoke immediately explicit reject);
   * - already tune next handle: its result is exactly next result (host join the same promise,
   *   never repeat execution after continue chain); must not again stack add transform/handled/continue of outside artifact;
   * - not await  next(async trigger after mention before return/throws): host still join the same
   *   nextPromise after return its result (or such as on throw handler error) - - after continue chain exactly
   *   execute once, without concurrency double execute, without orphan child execute;
   * - next before throws: after continue pipeline do not execute, error such as on throw;
   * - handle return void/continue: semantics is do not package wrap,next chain by host automatically pass-through (the
   *   handle after link per common execute).
   */
  async runAround(
    payload: HookPayloadMap[K],
    defaultRun: (finalPayload: HookPayloadMap[K]) => Promise<unknown>,
    isParticipant?: (hook: RegisteredHook<K>) => boolean,
  ): Promise<unknown> {
    if (this.name !== 'agent_spawn') {
      throw new HelmError('invalid_hook_invocation', `runAround only applies to agent_spawn(receives ${this.name})`, 500, {
        hook: this.name,
      });
    }
    assertHookPayload(this.name, payload);
    const hooks = this.entries().filter((h) => (isParticipant ? isParticipant(h) : true));

    /**
     * from index handle start execute: return handled take over artifact or defaultRun eventually
     * result; handle can via next(finalRequest) enter index+1 start the same chain.
     */
    const dispatchFrom = async (index: number, current: HookPayloadMap[K]): Promise<unknown> => {
      for (let i = index; i < hooks.length; i += 1) {
        const hook = hooks[i]!;
        let called = false;
        /** first time next invoke create after continue chain promise(join unique fact, guard against double execute). */
        let nextPromise: Promise<unknown> | undefined;
        /** subject to control continuation: sync return promise(enter i+1 start after continue chain, contains defaultRun). */
        const next = (request: HookPayloadMap[K]): Promise<unknown> => {
          if (called) {
            throw new HelmError(
              'invalid_hook_result',
              `plugin ${hook.pluginId}  agent_spawn hook duplicate invoke next(continuation only can enter once)`,
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
          // handler throws but already trigger next(not await background chain):join the same promise
          // after such as on throw handler error (after continue chain exactly execute once, result such as discard).
          if (nextPromise !== undefined) await nextPromise.then(() => undefined, () => undefined);
          if (err instanceof HelmError) throw err;
          throw new HelmError(
            'hook_execution_failed',
            `plugin ${hook.pluginId}  ${this.name} hook execute throw exception:${err instanceof Error ? err.message : String(err)}`,
            500,
            { pluginId: hook.pluginId, hook: this.name },
          );
        }
        if (nextPromise !== undefined) {
          // already trigger continuation:join the same promise and its result as this handle
          // result return (after continue chain exactly execute once; never continue when before loop). stack add
          // transform/handled belong contract violate about:join after explicit reject.
          if (result !== undefined && result !== null && isObj(result) && result.action !== 'continue') {
            await nextPromise.then(() => undefined, () => undefined);
            throw new HelmError(
              'invalid_hook_result',
              `plugin ${hook.pluginId}  agent_spawn hook already invoke next, must not again return "${String((result as { action?: unknown }).action)}"(next result i.e. it result)`,
              500,
              { pluginId: hook.pluginId, hook: this.name, result },
            );
          }
          return nextPromise;
        }
        const normalized = this.normalizeResult(hook, result);
        if (normalized === undefined) continue; // continue: do not package wrap, pass-through
        if (normalized.action === 'transform') {
          current = normalized.value as HookPayloadMap[K];
          continue;
        }
        // handled / block: short route (handled.result i.e. take over artifact).
        if (normalized.action === 'block') {
          throw new HelmError(
            'hook_blocked',
            `plugin ${hook.pluginId}  agent_spawn hook intercept derive:${normalized.reason}`,
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

// supply test and runtime reference specific payload type
export type {
  AgentSpawnRequest,
  BeforeTurnHookPayload,
  ExternalTriggerEnvelope,
  InputHookPayload,
  ToolCallHookPayload,
  ToolResultHookPayload,
  TurnSettledPayload,
};
