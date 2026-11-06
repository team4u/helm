/**
 * PluginHost / Hook 管道 / 动作总线 / 在途任务保护 测试。
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HelmError,
  type ConversationSummary,
  type ExternalTriggerEnvelope,
  type HelmHostApi,
  type PluginDefinition,
  type PluginDocHandle,
} from '@helm/protocol';
import {
  PluginHost,
  actionToolAlias,
  validatePluginInput,
  type PluginDocStore,
  type PluginConfigStore,
} from '../src/plugins/index.js';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

function makeConversation(id: number): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'default',
    tags: [],
    cwd: '/tmp',
    model: 'test/model',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeHostApi(events: string[] = []): HelmHostApi {
  return {
    dispatchTrigger: async () => {
      events.push('dispatchTrigger');
    },
    submitInput: async () => {
      events.push('submitInput');
    },
    createConversation: async (init) => ({
      ...makeConversation(42),
      title: init.title ?? 'new',
    }),
    listConversations: () => [makeConversation(1)],
    getConversation: (id) => makeConversation(id),
    createAsk: async () => ({ answer: 'y' }),
    cancelAsk: async () => {},
    emitEvent: (type) => events.push(`event:${type}`),
  };
}

class MemoryDocStore implements PluginDocStore {
  store = new Map<string, unknown>();
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial;
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value));
  }
}

class MemoryConfigStore implements PluginConfigStore {
  store = new Map<string, Record<string, unknown>>();
  get(pluginId: string): Record<string, unknown> {
    return { ...this.store.get(pluginId) };
  }
  set(pluginId: string, value: Record<string, unknown>): void {
    this.store.set(pluginId, { ...value });
  }
}

function makeEnvelope(over: Partial<ExternalTriggerEnvelope> = {}): ExternalTriggerEnvelope {
  return {
    id: 'evt-1',
    source: 'cron',
    text: '<external_event>hello</external_event>',
    createdAt: 1,
    ...over,
  };
}

let dataDir: string;
let docs: MemoryDocStore;
let events: string[];

/** 断言 Promise 以指定 code/status 的 HelmError 拒。 */
async function rejectsCode(promise: Promise<unknown>, code: string, status?: number): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HelmError, `期望 HelmError，实际：${String(err)}`);
    assert.equal(err.code, code);
    if (status !== undefined) assert.equal(err.status, status);
    return true;
  });
}

/** 断言同步函数抛指定 code 的 HelmError。 */
function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HelmError, `期望 HelmError，实际：${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

function makeHost(config?: PluginConfigStore): PluginHost {
  return new PluginHost({ dataDir, host: makeHostApi(events), docs, config });
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'helm-plugins-test-'));
  docs = new MemoryDocStore();
  events = [];
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Hook 管道：优先级 / transform / handled / block / 非法产物
// ---------------------------------------------------------------------------

test('优先级与同优先级注册顺序：高 priority 先跑，同 priority 按注册顺序', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const order: string[] = [];
  await host.register({
    id: 'p:a',
    definePlugin: (ctx) => {
      ctx.hook.onTrigger(() => {
        order.push('a-p0');
        return { action: 'continue' };
      });
      ctx.hook.onTrigger(
        () => {
          order.push('a-p10');
          return { action: 'continue' };
        },
        { priority: 10 },
      );
    },
  });
  await host.register({
    id: 'p:b',
    definePlugin: (ctx) => {
      ctx.hook.onTrigger(
        () => {
          order.push('b-p10');
          return { action: 'continue' };
        },
        { priority: 10 },
      );
    },
  });
  await host.runHook('trigger', makeEnvelope());
  assert.deepEqual(order, ['a-p10', 'b-p10', 'a-p0']);
});

test('transform.value 传下游：后续处理器看到改写后的载荷', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const seen: string[] = [];
  await host.register({
    id: 'p:route',
    definePlugin: (ctx) => {
      ctx.hook.onTrigger(
        (env) => ({ action: 'transform', value: { ...env, targetConversationId: 7 } }),
        { priority: 10 },
      );
      ctx.hook.onTrigger((env) => {
        seen.push(`low:${env.targetConversationId}`);
        return { action: 'continue' };
      });
    },
  });
  const result = await host.runHook('trigger', makeEnvelope());
  assert.equal(result.action, 'transform');
  if (result.action === 'transform') {
    assert.equal(result.value.targetConversationId, 7);
  }
  assert.deepEqual(seen, ['low:7']);
});

test('handled 短路：后续处理器不执行，默认行为被接管', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let downstreamRan = false;
  await host.register({
    id: 'p:gate',
    definePlugin: (ctx) => {
      ctx.hook.onTrigger(
        () => ({ action: 'handled', result: { dropped: true } }),
        { priority: 10 },
      );
      ctx.hook.onTrigger(() => {
        downstreamRan = true;
        return { action: 'continue' };
      });
    },
  });
  const result = await host.runHook('trigger', makeEnvelope());
  assert.deepEqual(result, { action: 'handled', result: { dropped: true } });
  assert.equal(downstreamRan, false);
});

test('tool_call block 携带 reason 短路；block 缺 reason 显式报错', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:guard',
    definePlugin: (ctx) => {
      ctx.hook.onToolCall((p) =>
        p.toolName === 'bash' ? { action: 'block', reason: '敏感命令需人工确认' } : { action: 'continue' },
      );
    },
  });
  const blocked = await host.runHook('tool_call', {
    conversationId: 1,
    callId: 'c1',
    toolName: 'bash',
    input: { command: 'rm -rf /' },
  });
  assert.deepEqual(blocked, { action: 'block', reason: '敏感命令需人工确认' });

  const host2 = makeHost();
  await host2.register({
    id: 'p:bad-block',
    definePlugin: (ctx) => {
      ctx.hook.onToolCall(() => ({ action: 'block', reason: '' }) as never);
    },
  });
  await assert.rejects(
    host2.runHook('tool_call', { conversationId: 1, callId: 'c1', toolName: 'bash', input: {} }),
    (err: unknown) => {
      assert.ok(err instanceof HelmError);
      assert.equal(err.code, 'invalid_hook_result');
      assert.equal(err.status, 500);
      return true;
    },
  );
});

test('钩子返回不支持的动作组合（turn_settled block）显式 invalid_hook_result', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:illegal',
    definePlugin: (ctx) => {
      ctx.hook.onTurnSettled(() => ({ action: 'block', reason: 'not allowed' }) as never);
    },
  });
  await assert.rejects(
    host.runHook('turn_settled', {
      conversation: makeConversation(1),
      inputs: [],
      outcome: 'completed',
      settledAt: 1,
    }),
    (err: unknown) => {
      assert.ok(err instanceof HelmError);
      assert.equal(err.code, 'invalid_hook_result');
      return true;
    },
  );
});

test('钩子返回 undefined 等价 continue；transform 缺 value / 破坏必要字段 / 未知 action 均显式报错', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:void',
    definePlugin: (ctx) => {
      ctx.hook.onTrigger(() => undefined);
    },
  });
  const ok = await host.runHook('trigger', makeEnvelope());
  assert.equal(ok.action, 'transform'); // 管道只有 void 处理器，载荷原样传出

  // transform 缺 value
  const h2 = makeHost();
  await h2.register({
    id: 'p:no-value',
    definePlugin: (ctx) => {
      ctx.hook.onTrigger(() => ({ action: 'transform' }) as never);
    },
  });
  await rejectsCode(h2.runHook('trigger', makeEnvelope()), 'invalid_hook_result');

  // transform 破坏必要字段（source 被删）
  const h3 = makeHost();
  await h3.register({
    id: 'p:break',
    definePlugin: (ctx) => {
      ctx.hook.onTrigger((env) => {
        const broken = { ...env, source: '' };
        return { action: 'transform', value: broken };
      });
    },
  });
  await assert.rejects(h3.runHook('trigger', makeEnvelope()), (err: unknown) => {
    assert.ok(err instanceof HelmError);
    assert.equal(err.code, 'invalid_hook_result');
    return true;
  });

  // 未知 action
  const h4 = makeHost();
  await h4.register({
    id: 'p:unknown-action',
    definePlugin: (ctx) => {
      ctx.hook.onTrigger(() => ({ action: 'resend' }) as never);
    },
  });
  await rejectsCode(h4.runHook('trigger', makeEnvelope()), 'invalid_hook_result');
});

test('钩子执行抛异常：包装 hook_execution_failed 且不静默', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:throw',
    definePlugin: (ctx) => {
      ctx.hook.onInput(() => {
        throw new Error('插件内部崩溃');
      });
    },
  });
  await assert.rejects(
    host.runHook('input', {
      conversationId: 1,
      input: { id: 'i1', text: 'hi', origin: 'human', createdAt: 1 },
    }),
    (err: unknown) => {
      assert.ok(err instanceof HelmError);
      assert.equal(err.code, 'hook_execution_failed');
      assert.equal(err.status, 500);
      assert.match(err.message, /插件内部崩溃/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 动作总线：schema 校验 / 全限定 id 解析 / 五端共用入口
// ---------------------------------------------------------------------------

test('invokeAction：入参校验失败 400 validation_error，输出违约 500 invalid_plugin_output', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'builtin:demo',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'echo',
        description: '回显',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        outputSchema: { type: 'object', properties: { greeting: { type: 'string' } }, required: ['greeting'] },
        handler: (input: { name: string }) => ({ greeting: `hello ${input.name}` }),
      });
      ctx.action({
        id: 'bad-output',
        description: '输出违约',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object', properties: { must: { type: 'number' } }, required: ['must'] },
        handler: () => ({ must: 'not-a-number' }) as never,
      });
    },
  });

  const ok = (await host.invokeAction('builtin:demo', 'echo', { name: 'helm' })) as { greeting: string };
  assert.equal(ok.greeting, 'hello helm');

  await assert.rejects(host.invokeAction('builtin:demo', 'echo', {}), (err: unknown) => {
    assert.ok(err instanceof HelmError);
    assert.equal(err.code, 'validation_error');
    assert.equal(err.status, 400);
    return true;
  });

  await assert.rejects(host.invokeAction('builtin:demo', 'bad-output', {}), (err: unknown) => {
    assert.ok(err instanceof HelmError);
    assert.equal(err.code, 'invalid_plugin_output');
    assert.equal(err.status, 500);
    return true;
  });

  await assert.rejects(host.invokeAction('builtin:demo', 'missing', {}), (err: unknown) => {
    assert.ok(err instanceof HelmError);
    assert.equal(err.code, 'unknown_action');
    assert.equal(err.status, 404);
    return true;
  });
});

test('parseQualifiedActionId：pluginId 含 ":" 时按首个 "." 正确分割', { timeout: 60_000 }, () => {
  assert.deepEqual(PluginHost.parseQualifiedActionId('builtin:assistant.update_memory'), {
    pluginId: 'builtin:assistant',
    actionId: 'update_memory',
  });
  assert.deepEqual(PluginHost.parseQualifiedActionId('triggers.cron.create'), {
    pluginId: 'triggers',
    actionId: 'cron.create',
  });
  assert.throws(() => PluginHost.parseQualifiedActionId('no-dot'), HelmError);
  assert.throws(() => PluginHost.parseQualifiedActionId('trailing.'), HelmError);
});

test('listActions / listTools：manifest 字段准确，exposeAsTool 动作派生工具', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'builtin:mixed',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'visible',
        description: '直投工具',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        exposeAsTool: true,
        handler: () => ({}),
      });
      ctx.action({
        id: 'hidden_tool',
        description: '经 run_action 调用',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => ({}),
      });
      ctx.tool({
        name: 'dedicated_tool',
        description: '专用工具',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        execute: () => 'ok',
      });
    },
  });

  const actions = host.listActions();
  assert.equal(actions.length, 2);
  const visible = actions.find((a) => a.id === 'visible')!;
  assert.equal(visible.pluginId, 'builtin:mixed');
  assert.equal(visible.id, 'visible');
  assert.equal(visible.exposeAsTool, true);

  const tools = host.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('dedicated_tool'));
  // 动作派生工具使用 provider-safe 别名（不含 ':'/'.'），manifest 仍全限定 ID
  const derived = tools.find((t) => t.sourceKind === 'action')!;
  assert.equal(derived.qualifiedId, 'builtin:mixed.visible');
  assert.match(derived.name, /^[A-Za-z0-9_-]{1,64}$/);
  assert.ok(!derived.name.includes(':') && !derived.name.includes('.'));
  assert.ok(!names.includes('builtin:mixed.hidden_tool'));

  // executeTool 走派生动作：别名与全限定名皆可，输入经同一 schema 校验
  const r = await host.executeTool(derived.name, {}, { conversationId: 1 });
  assert.deepEqual(r, {});
  const r2 = await host.executeTool('builtin:mixed.visible', {}, { conversationId: 1 });
  assert.deepEqual(r2, {});
  await assert.rejects(
    host.executeTool('dedicated_tool', { q: 123 }, { conversationId: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof HelmError);
      assert.equal(err.code, 'validation_error');
      return true;
    },
  );
});

test('动作声明缺 inputSchema/outputSchema 在注册边界显式拒绝', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await assert.rejects(
    host.register({
      id: 'p:bad-schema',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'x',
          description: '缺 schema',
          inputSchema: undefined as never,
          outputSchema: { type: 'object' },
          handler: () => ({}),
        });
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof HelmError);
      assert.equal(err.code, 'invalid_action_spec');
      return true;
    },
  );
  // 注册失败即回滚：不出现在清单
  assert.equal(host.list().length, 0);
});

// ---------------------------------------------------------------------------
// 在途任务保护（409 plugin_has_live_tasks）
// ---------------------------------------------------------------------------

test('disable 遇在途 action / tool / 挂起 spawn 一律 409，结束后可停用', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  await host.register({
    id: 'p:busy',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'slow',
        description: '慢动作',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: async () => {
          await gate;
          return { done: true };
        },
      });
    },
  });

  const running = host.invokeAction('p:busy', 'slow', {});
  await new Promise((r) => setTimeout(r, 20));
  await rejectsCode(host.disable('p:busy'), 'plugin_has_live_tasks', 409);

  release();
  assert.deepEqual(await running, { done: true });
  await host.disable('p:busy');
  assert.equal(host.list().find((p) => p.id === 'p:busy')!.enabled, false);
});

test('挂起 agent_spawn 与自定义 task 也计入在途保护', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:spawner',
    definePlugin: (ctx) => {
      void ctx;
    },
  });
  host.beginSpawnTask('p:spawner', 'spawn-1');
  await rejectsCode(host.disable('p:spawner'), 'plugin_has_live_tasks');
  host.endSpawnTask('p:spawner', 'spawn-1');

  const task = host.withTask('p:spawner', 'custom', async () => {
    await new Promise((r) => setTimeout(r, 30));
    return 1;
  });
  await rejectsCode(host.disable('p:spawner'), 'plugin_has_live_tasks');
  assert.equal(await task, 1);
  await host.disable('p:spawner');
});

test('runHook 执行期间 disable 被拒绝（钩子在途计为任务）', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  await host.register({
    id: 'p:hooky',
    definePlugin: (ctx) => {
      ctx.hook.onTrigger(async () => {
        await gate;
        return { action: 'continue' };
      });
    },
  });
  const running = host.runHook('trigger', makeEnvelope());
  await new Promise((r) => setTimeout(r, 20));
  await rejectsCode(host.disable('p:hooky'), 'plugin_has_live_tasks');
  release();
  await running;
  await host.disable('p:hooky');
});

// ---------------------------------------------------------------------------
// 服务生命周期：rollback 与逆向 stop
// ---------------------------------------------------------------------------

test('服务 start 失败：已启动者逆向 stop，注册整体回滚', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const events: string[] = [];
  await assert.rejects(
    host.register({
      id: 'p:svc-fail',
      definePlugin: (ctx) => {
        ctx.service({
          id: 'a',
          start: () => {
            events.push('a:start');
          },
          stop: () => {
            events.push('a:stop');
          },
        });
        ctx.service({
          id: 'b',
          start: () => {
            events.push('b:start');
            throw new Error('b 启动崩溃');
          },
          stop: () => {
            events.push('b:stop');
          },
        });
        ctx.action({
          id: 'never',
          description: 'x',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          handler: () => ({}),
        });
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof HelmError);
      assert.equal(err.code, 'plugin_service_start_failed');
      assert.equal(err.status, 500);
      return true;
    },
  );
  assert.deepEqual(events, ['a:start', 'b:start', 'a:stop']);
  // 回滚后插件不存在，动作不可见
  assert.equal(host.list().length, 0);
  assert.equal(host.listActions().length, 0);
});

test('正常 disable：服务按注册逆序 stop', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const stops: string[] = [];
  await host.register({
    id: 'p:svc-ok',
    definePlugin: (ctx) => {
      ctx.service({ id: 'first', start: () => {}, stop: () => { stops.push('first'); } });
      ctx.service({ id: 'second', start: () => {}, stop: () => { stops.push('second'); } });
    },
  });
  await host.disable('p:svc-ok');
  assert.deepEqual(stops, ['second', 'first']);
  // 再 enable：服务重新启动
  await host.enable('p:svc-ok');
  assert.equal(host.list().find((p) => p.id === 'p:svc-ok')!.enabled, true);
});

// ---------------------------------------------------------------------------
// locked 插件 / doc 命名空间 / config 诚实性
// ---------------------------------------------------------------------------

test('locked 插件 disable/unregister 403 plugin_locked', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'builtin:assistant',
    locked: true,
    definePlugin: () => {},
  });
  await assert.rejects(host.disable('builtin:assistant'), (err: unknown) => {
    assert.ok(err instanceof HelmError);
    assert.equal(err.code, 'plugin_locked');
    assert.equal(err.status, 403);
    return true;
  });
  await rejectsCode(host.unregister('builtin:assistant'), 'plugin_locked', 403);
});

test('doc 命名空间隔离 pluginId:name；get 返回 clone 防未持久化突变', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:docs',
    definePlugin: (ctx) => {
      const doc = ctx.doc('counter', { n: 0, items: [] as string[] });
      doc.update((s) => ({ ...s, n: s.n + 1 }));
      doc.set({ n: 99, items: ['a'] });
      // get 的 clone：原地 push 不应污染 store
      doc.get().items.push('MUTANT');
    },
  });
  await host.register({
    id: 'p:docs2',
    definePlugin: (ctx) => {
      const doc = ctx.doc('counter', { n: 0, items: [] as string[] });
      doc.update((s) => ({ ...s, n: s.n + 5 }));
    },
  });

  const a = docs.get('p:docs:counter', { n: -1, items: [] as string[] });
  const b = docs.get('p:docs2:counter', { n: -1, items: [] as string[] });
  assert.equal(a.n, 99);
  assert.deepEqual(a.items, ['a']); // MUTANT 未泄漏
  assert.equal(b.n, 5); // 命名空间隔离
});

test('未提供 ConfigStore 时 setConfig 显式 501，不假持久化；提供时可写', { timeout: 60_000 }, async () => {
  const noStore = makeHost();
  await noStore.register({ id: 'p:cfg', definePlugin: () => {} });
  await assert.rejects(noStore.setConfig('p:cfg', { k: 1 }), (err: unknown) => {
    assert.ok(err instanceof HelmError);
    assert.equal(err.code, 'config_store_unavailable');
    assert.equal(err.status, 501);
    return true;
  });

  const store = new MemoryConfigStore();
  const withStore = makeHost(store);
  await withStore.register({
    id: 'p:cfg2',
    definePlugin: (ctx) => {
      ctx.configSchema({ token: { type: 'string', secret: true } });
    },
  });
  await withStore.setConfig('p:cfg2', { token: 'abc' });
  assert.deepEqual(store.get('p:cfg2'), { token: 'abc' });
  assert.equal(withStore.getConfigSchema('p:cfg2').token?.type, 'string');
});

// ---------------------------------------------------------------------------
// 路由 / UI 收集 / dispose
// ---------------------------------------------------------------------------

test('路由限定 /api/plugins/<enc>/routes 前缀：越界/点段/查询串/空段拒绝', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'triggers',
    definePlugin: (ctx) => {
      ctx.route({
        method: 'POST',
        path: '/api/plugins/triggers/routes/hook',
        public: true,
        handler: () => new Response('ok'),
      });
    },
  });
  const routes = host.listRoutes();
  assert.equal(routes.length, 1);
  assert.equal(routes[0]!.path, '/api/plugins/triggers/routes/hook');
  assert.equal(routes[0]!.public, true);

  // 冒号插件 id 需 encodeURIComponent 前缀
  const h2 = makeHost();
  await h2.register({
    id: 'builtin:webhook',
    definePlugin: (ctx) => {
      ctx.route({ method: 'GET', path: '/api/plugins/builtin%3Awebhook/routes/cb', handler: () => new Response('ok') });
    },
  });
  assert.equal(h2.listRoutes()[0]!.path, '/api/plugins/builtin%3Awebhook/routes/cb');

  // 越界：内核路由、其他插件命名空间、plugins 下非 routes 子树一律拒绝
  await assert.rejects(
    host.register({
      id: 'p:evil',
      definePlugin: (ctx) => {
        ctx.route({ method: 'GET', path: '/api/conversations', handler: () => new Response('x') });
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof HelmError);
      assert.equal(err.code, 'route_prefix_violation');
      assert.equal(err.status, 403);
      return true;
    },
  );
  // 同前缀但非 routes 子树（可覆盖 core config/disable 等路由的旧洞）
  await rejectsCode(
    host.register({
      id: 'p:evil2',
      definePlugin: (ctx) => void ctx.route({ method: 'GET', path: '/api/plugins/triggers/config', handler: () => new Response('x') }),
    }),
    'route_prefix_violation',
  );
  // 点段 / 编码点段 / 查询串 / 片段 / 空段 / 尾斜杠：前缀匹配但路径非法
  const rejectPath = async (suffix: string, code: string) => {
    const pluginId = `p:seg-${suffix.length}-${suffix.replaceAll(/[^A-Za-z0-9]/g, 'p')}`;
    await rejectsCode(
      host.register({
        id: pluginId,
        definePlugin: (ctx) => {
          const prefix = `/api/plugins/${encodeURIComponent(pluginId)}/routes`;
          ctx.route({ method: 'GET', path: `${prefix}${suffix}`, handler: () => new Response('x') });
        },
      }),
      code,
    );
  };
  await rejectPath('/../x', 'invalid_route_path');
  await rejectPath('/%2E%2E/x', 'invalid_route_path');
  await rejectPath('/a?b=1', 'invalid_route_path');
  await rejectPath('/a#frag', 'invalid_route_path');
  await rejectPath('//x', 'invalid_route_path');
  await rejectPath('/x/', 'invalid_route_path');
});

test('UI 七类十函数统一收集可序列化 spec；不可序列化 spec 拒绝', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:ui',
    definePlugin: (ctx) => {
      ctx.ui.sidebarItem({ id: 'home', label: '个人助理', target: 'conversation:1' });
      ctx.ui.sidebarSection({ id: 'workers', label: 'Worker' });
      ctx.ui.screen({ id: 'graph', label: '召回图谱', json: { render: 'mermaid' } });
      ctx.ui.timelineRenderer({ id: 'report', kinds: ['worker.report'] });
      ctx.ui.toolView({ id: 'term', toolNames: ['bash'] });
      ctx.ui.composerPill({ id: 'pill', label: 'P' });
      ctx.ui.composerWidget({ id: 'widget' });
      ctx.ui.workbenchPanel({ id: 'panel', label: '产物' });
      ctx.ui.command({ id: 'cmd', title: '跑巡检', actionId: 'superagent.patrol' });
      ctx.ui.settingsPanel({ id: 'set', label: '设置' });
    },
  });
  const ui = host.listUi();
  assert.equal(ui.length, 10);
  const surfaces = new Set(ui.map((u) => u.surface));
  for (const expected of [
    'sidebar.item',
    'sidebar.section',
    'screen',
    'timeline.renderer',
    'tool.view',
    'composer.pill',
    'composer.widget',
    'workbench.panel',
    'commandPalette',
    'settings.panel',
  ]) {
    assert.ok(surfaces.has(expected), `缺少 ${expected}`);
  }
  const home = ui.find((u) => u.surface === 'sidebar.item')!;
  assert.deepEqual(home.spec, { id: 'home', label: '个人助理', target: 'conversation:1' });

  await assert.rejects(
    host.register({
      id: 'p:ui-bad',
      definePlugin: (ctx) => {
        ctx.ui.screen({ id: 'fn', label: 'x', json: { cb: () => 1 } as never });
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof HelmError);
      assert.equal(err.code, 'invalid_ui_spec');
      return true;
    },
  );
});

test('dispose 逆序停用全部插件；dispose 后调用显式报错', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const stops: string[] = [];
  await host.register({
    id: 'p:first',
    definePlugin: (ctx) => {
      ctx.service({ id: 's', start: () => {}, stop: () => { stops.push('first'); } });
    },
  });
  await host.register({
    id: 'p:second',
    definePlugin: (ctx) => {
      ctx.service({ id: 's2', start: () => {}, stop: () => { stops.push('second'); } });
    },
  });
  await host.dispose();
  assert.deepEqual(stops, ['second', 'first']);
  throwsCode(() => host.listActions(), 'plugin_host_disposed');
  await rejectsCode(host.register({ id: 'p:x', definePlugin: () => {} }), 'plugin_host_disposed');
  await host.dispose(); // 幂等
});

test('cli.command 语义化命令路径：合法声明透传 manifest，非法声明拒绝', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'builtin:triggers',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'cron.create',
        description: '创建定时任务',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        cli: { command: ['cron', 'create'] },
        handler: () => ({}),
      });
    },
  });
  const manifest = host.listActions().find((a) => a.id === 'cron.create')!;
  assert.deepEqual(manifest.cli?.command, ['cron', 'create']);

  const h2 = makeHost();
  await rejectsCode(
    h2.register({
      id: 'p:bad-cli',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'x',
          description: 'x',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          cli: { command: [] },
          handler: () => ({}),
        });
      },
    }),
    'invalid_action_spec',
  );
  await rejectsCode(
    h2.register({
      id: 'p:bad-cli2',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'x',
          description: 'x',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          cli: { command: ['ok', ''] },
          handler: () => ({}),
        });
      },
    }),
    'invalid_action_spec',
  );
});

test('重复注册 / 未知插件 / 未启用插件动作调用均显式报错', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const def: PluginDefinition = { id: 'p:dup', definePlugin: () => {} };
  await host.register(def);
  await rejectsCode(host.register(def), 'plugin_already_registered');

  await rejectsCode(host.disable('p:none'), 'unknown_plugin');
  await rejectsCode(host.invokeAction('p:none', 'a', {}), 'unknown_plugin');

  await host.register({ id: 'p:off', definePlugin: () => {} });
  await host.disable('p:off');
  await rejectsCode(host.invokeAction('p:off', 'x', {}), 'plugin_disabled');
});

// ---------------------------------------------------------------------------
// 回归：enable 重建周期 / epoch 防护 / dataDir
// ---------------------------------------------------------------------------

test('disable→enable 重建完整注册周期：重复 ctx.doc / configSchema 不再抛 duplicate，持久数据保留', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:cycle',
    definePlugin: (ctx) => {
      const doc = ctx.doc('state', { n: 0 });
      doc.set({ n: doc.get().n + 1 }); // 每周期 +1
      ctx.configSchema({ token: { type: 'string', secret: true } });
      ctx.action({
        id: 'ping',
        description: 'x',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => ({ pong: true }),
      });
      ctx.hook.onTrigger(() => undefined);
    },
  });
  await host.disable('p:cycle');
  await host.enable('p:cycle'); // 旧实现此处抛 duplicate_doc
  await host.enable('p:cycle'); // 再来一轮也不抛 duplicate_config_schema

  // doc 持久数据跨周期保留：两周期各 +1
  const seen = docs.get('p:cycle:state', { n: -1 });
  assert.equal(seen.n, 2);
  // 动作/钩子/schema 均重建
  assert.deepEqual(await host.invokeAction('p:cycle', 'ping', {}), { pong: true });
  assert.equal(host.getConfigSchema('p:cycle').token?.type, 'string');
  assert.deepEqual(host.list().find((p) => p.id === 'p:cycle')!.hooks, ['trigger']);
});

test('旧 context 在 disable 后不允许继续注册/修改：epoch 使句柄即刻失效', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let stolen: Parameters<NonNullable<PluginDefinition['definePlugin']>>[0] | undefined;
  let stolenDoc: ReturnType<Parameters<NonNullable<PluginDefinition['definePlugin']>>[0]['doc']> | undefined;
  await host.register({
    id: 'p:steal',
    definePlugin: (ctx) => {
      stolen = ctx;
      stolenDoc = ctx.doc('k', { n: 0 });
      stolenDoc.set({ n: 0 }); // 周期内写入基准值，验证后续失效拒绝不产生新写入
    },
  });
  await host.disable('p:steal');

  // 旧 context：一切注册方法拒绝
  throwsCode(() => stolen!.action({ id: 'x', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, handler: () => ({}) }), 'plugin_context_closed');
  throwsCode(() => stolen!.hook.onTrigger(() => undefined), 'plugin_context_closed');
  throwsCode(() => stolen!.configSchema({ a: { type: 'string' } }), 'plugin_context_closed');
  throwsCode(() => stolen!.route({ method: 'GET', path: `/api/plugins/${encodeURIComponent('p:steal')}/routes/x`, handler: () => new Response('x') }), 'plugin_context_closed');
  // 旧 doc 句柄：读写拒绝，且未污染持久层（仍是周期内写入的 0）
  throwsCode(() => stolenDoc!.set({ n: 1 }), 'plugin_context_expired');
  throwsCode(() => stolenDoc!.get(), 'plugin_context_expired');
  assert.equal(docs.get('p:steal:k', { n: -1 }).n, 0);

  // 新周期重新拿到的 doc 句柄恢复正常（重新注册后写入验证持久层）
  await host.unregister('p:steal');
  await host.register({
    id: 'p:steal',
    definePlugin: (ctx) => {
      const fresh = ctx.doc('k', { n: 0 });
      fresh.set({ n: 5 });
    },
  });
  assert.equal(docs.get('p:steal:k', { n: -1 }).n, 5);
  void stolen;
});

test('ctx.dataDir 是插件专属子目录 join(root, plugins, id) 且已创建', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let seen: string | undefined;
  await host.register({
    id: 'builtin:sub',
    definePlugin: (ctx) => {
      seen = ctx.dataDir;
    },
  });
  assert.equal(seen, join(dataDir, 'plugins', 'builtin:sub'));
  assert.ok(existsSync(seen!), '插件数据目录应在注册时创建');
});

// ---------------------------------------------------------------------------
// 回归：生命周期异步竞态
// ---------------------------------------------------------------------------

test('disable 的 await 期间新 invokeAction/executeTool/runHook 被隔离；stop 失败不产生虚假 enabled 状态', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((res) => (releaseStop = res));
  let stopStarted = false;
  await host.register({
    id: 'p:race',
    definePlugin: (ctx) => {
      ctx.service({
        id: 'svc',
        start: () => {},
        stop: () => {
          stopStarted = true;
          return stopGate;
        },
      });
      ctx.action({
        id: 'ping',
        description: 'x',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => ({}),
      });
      ctx.hook.onTrigger(() => undefined);
    },
  });

  const disabling = host.disable('p:race');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(stopStarted, 'stop 应已开始（处于 await）');
  // await 期间新任务一律拒绝；runHook 不执行其 handler（无参与者走 continue）
  await rejectsCode(host.invokeAction('p:race', 'ping', {}), 'plugin_disabled');
  await rejectsCode(host.executeTool('nope', {}, { conversationId: 1 }), 'unknown_tool');
  const hookResult = await host.runHook('trigger', makeEnvelope());
  assert.equal(hookResult.action, 'continue');
  releaseStop();
  await disabling;
  assert.equal(host.list().find((p) => p.id === 'p:race')!.enabled, false);
});

test('runHook 在 disable await 期间不被执行：未启用插件的 handler 绝不调用', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((res) => (releaseStop = res));
  let hookRan = false;
  await host.register({
    id: 'p:dying',
    definePlugin: (ctx) => {
      ctx.service({ id: 'svc', start: () => {}, stop: () => stopGate });
      ctx.hook.onTrigger(() => {
        hookRan = true;
        return { action: 'continue' };
      });
    },
  });
  const disabling = host.disable('p:dying');
  await new Promise((r) => setTimeout(r, 20));
  // stop await 中（enabled 仍 true 但 phase=deactivating）：handler 不执行
  const r = await host.runHook('trigger', makeEnvelope());
  assert.equal(r.action, 'continue');
  assert.equal(hookRan, false);
  releaseStop();
  await disabling;
});

test('register 途中（definePlugin await 挂起）runHook 不执行未启用插件 handler', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let releaseDefine!: () => void;
  const defineGate = new Promise<void>((res) => (releaseDefine = res));
  let hookRan = false;
  const registering = host.register({
    id: 'p:defining',
    definePlugin: async (ctx) => {
      ctx.hook.onTrigger(() => {
        hookRan = true;
        return { action: 'continue' };
      });
      await defineGate;
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  const r = await host.runHook('trigger', makeEnvelope());
  assert.equal(r.action, 'continue');
  assert.equal(hookRan, false);
  releaseDefine();
  await registering;
  // 注册完成后可执行
  const r2 = await host.runHook('trigger', makeEnvelope());
  assert.equal(r2.action, 'transform');
  assert.equal(hookRan, true);
});

test('同插件 enable/disable 串行化：并发调用不交错执行', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const order: string[] = [];
  let gateA!: () => void;
  const g = new Promise<void>((r) => (gateA = r));
  await host.register({
    id: 'p:serial',
    definePlugin: (ctx) => {
      void ctx;
    },
  });
  await host.disable('p:serial');

  const enabling = host.enable('p:serial').then(() => order.push('enable-done'));
  const disabling = host.disable('p:serial').then(() => order.push('disable-done'));
  await Promise.all([enabling, disabling]);
  // 串行链保证 enable-done 先于 disable-done（后到者等待前者）
  assert.deepEqual(order, ['enable-done', 'disable-done']);
  assert.equal(host.list().find((p) => p.id === 'p:serial')!.enabled, false);
  void gateA;
});

test('disable 遇 stop 失败：状态落位已停用（不虚假 enabled=true）且错误如实上抛', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:stopfail',
    definePlugin: (ctx) => {
      ctx.service({ id: 'svc', start: () => {}, stop: () => { throw new Error('stop 崩溃'); } });
    },
  });
  await rejectsCode(host.disable('p:stopfail'), 'plugin_service_stop_failed');
  // 关键：不维持 enabled=true 但注册已清空的虚假状态
  const summary = host.list().find((p) => p.id === 'p:stopfail')!;
  assert.equal(summary.enabled, false);
  assert.deepEqual(summary.actions, []);
  // 再次 disable 幂等成功（已停用直接返回）
  await host.disable('p:stopfail');
});

// ---------------------------------------------------------------------------
// 回归：plugin.changed 事件与失败不伪报
// ---------------------------------------------------------------------------

test('register/enable/disable/unregister 成功后发 plugin.changed 事件；失败不发', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const changed = () => events.filter((e) => e === 'event:plugin.changed').length;
  await host.register({ id: 'p:ev', definePlugin: () => {} });
  assert.equal(changed(), 1);
  await host.disable('p:ev');
  assert.equal(changed(), 2);
  await host.enable('p:ev');
  assert.equal(changed(), 3);
  await host.unregister('p:ev');
  assert.equal(changed(), 4);

  // 失败路径不伪报成功：locked 拒绝、在途任务拒绝都不发事件
  const h2 = makeHost();
  await h2.register({ id: 'p:locked', locked: true, definePlugin: () => {} });
  const before = events.length;
  await rejectsCode(h2.disable('p:locked'), 'plugin_locked');
  await rejectsCode(h2.unregister('p:locked'), 'plugin_locked');
  assert.equal(events.length, before); // 失败未新增事件
});

// ---------------------------------------------------------------------------
// 回归：JSON-safe 边界（ui spec / doc / action output）
// ---------------------------------------------------------------------------

test('ui spec 边界拒 Map/Date/BigInt/循环/undefined：structuredClone 会放行但 JSON 必丢数据', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const bad: Array<[string, unknown]> = [
    ['Map', { id: 'x', json: { m: new Map([[1, 2]]) } }],
    ['Set', { id: 'x', json: { s: new Set([1]) } }],
    ['Date', { id: 'x', json: { d: new Date(0) } }],
    ['BigInt', { id: 'x', json: { b: 10n } }],
    ['undefined', { id: 'x', json: { u: undefined } }],
    ['NaN', { id: 'x', json: { n: NaN } }],
    ['fn', { id: 'x', cb: () => 1 }],
    ['cycle', (() => { const o: Record<string, unknown> = { id: 'x' }; o.self = o; return o; })()],
  ];
  for (const [label, spec] of bad) {
    await assert.rejects(
      host.register({ id: `p:ui-json-${label}`, definePlugin: (ctx) => void ctx.ui.screen(spec as never) }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError, `${label} 应拒`);
        assert.equal(err.code, 'invalid_ui_spec', `${label} 应 invalid_ui_spec`);
        return true;
      },
    );
  }
  // 合法 spec（有限数字数组 + null + 纯对象）接受
  await host.register({
    id: 'p:ui-ok',
    definePlugin: (ctx) => {
      ctx.ui.screen({ id: 'fine', label: 'Fine', json: { nums: [1, 2.5], nil: null, s: 'x' } });
    },
  });
  const ui = host.listUi();
  assert.equal(ui.length, 1);
  // 产物本身可无损 JSON 序列化
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(ui)));
});

test('doc 初始值/set/update 边界拒非 JSON 值；合法纯对象/有限数字数组/null 接受', { timeout: 60_000 }, async () => {
  const host = makeHost();
  // 初始值含 Map：注册失败回滚（invalid_json_value 是 HelmError，原样上抛）
  await assert.rejects(
    host.register({
      id: 'p:doc-bad-init',
      definePlugin: (ctx) => {
        ctx.doc('m', { m: new Map() } as never);
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof HelmError);
      assert.equal(err.code, 'invalid_json_value');
      return true;
    },
  );
  assert.equal(host.list().length, 0);

  let doc: PluginDocHandle<{ n: number; items: string[] }> | undefined;
  await host.register({
    id: 'p:doc',
    definePlugin: (ctx) => {
      doc = ctx.doc('k', { n: 0, items: [] });
    },
  });
  doc!.set({ n: 1, items: ['a'] }); // 合法 set 不抛
  assert.equal(docs.get('p:doc:k', { n: -1, items: [] }).n, 1);
  throwsCode(() => doc!.set({ n: NaN, items: [] } as never), 'invalid_json_value');
  throwsCode(() => doc!.set({ n: 1, items: ['a'], d: new Date() } as never), 'invalid_json_value');
  // undefined 字段被拒而非静默丢弃
  throwsCode(() => doc!.set({ n: 1, items: [], extra: undefined } as never), 'invalid_json_value');
  // update 传入非法产物同样拒
  throwsCode(
    () =>
      doc!.update(() => ({ n: 1, items: [10n as unknown as string] })),
    'invalid_json_value',
  );
  // store 未被污染
  const cur = docs.get('p:doc:k', { n: -1, items: [] });
  assert.equal(cur.n, 1);
  assert.deepEqual(cur.items, ['a']);
  // get 返回 JSON-safe clone
  const got = doc!.get();
  assert.deepEqual(got, { n: 1, items: ['a'] });
  got.items.push('MUT');
  assert.deepEqual(docs.get('p:doc:k', { n: -1, items: [] }).items, ['a']);
});

test('action 输出含 Map/undefined/循环等非 JSON 值时边界显式报错，不静默丢数据', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:out',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'map-out',
        description: 'x',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => ({ m: new Map([[1, 2]]) }) as never,
      });
      ctx.action({
        id: 'undef-out',
        description: 'x',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        handler: () => ({ a: 1, b: undefined }),
      });
    },
  });
  await rejectsCode(host.invokeAction('p:out', 'map-out', {}), 'invalid_json_value');
  await rejectsCode(host.invokeAction('p:out', 'undef-out', {}), 'invalid_json_value');
});

// ---------------------------------------------------------------------------
// 回归：$async Schema 与注册期预编译
// ---------------------------------------------------------------------------

test('action 声明 $async Schema 在注册边界即拒（invalid_plugin_schema）并整体回滚', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await rejectsCode(
    host.register({
      id: 'p:async-schema',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'a',
          description: 'x',
          inputSchema: { type: 'object', $async: true },
          outputSchema: { type: 'object' },
          handler: () => ({}),
        });
      },
    }),
    'invalid_plugin_schema',
  );
  assert.equal(host.list().length, 0);

  // 非法 Schema（无法编译）同样在注册边界回滚，不等首次调用
  await rejectsCode(
    host.register({
      id: 'p:bad-schema2',
      definePlugin: (ctx) => {
        ctx.action({
          id: 'a',
          description: 'x',
          inputSchema: { type: 'quux' } as never,
          outputSchema: { type: 'object' },
          handler: () => ({}),
        });
      },
    }),
    'invalid_plugin_schema',
  );
  assert.equal(host.list().length, 0);
});

test('$async Schema 若绕过注册（validatePluginInput 直接调用）也不会把 Promise 当 true 放行非法输入', { timeout: 60_000 }, async () => {
  // AJV $async 校验函数返回 Promise：同步 boolean 判断会误当通过。
  // compile 边界已拒，这里验证直接调用也不故行：非法输入仍拒绝。
  const schema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], $async: true } as never;
  throwsCode(() => validatePluginInput('p', 'a', schema, { n: 'not-a-number' }), 'invalid_plugin_schema');
});

// ---------------------------------------------------------------------------
// 回归：provider-safe 工具名
// ---------------------------------------------------------------------------

test('exposeAsTool 派生工具名 provider-safe：模拟 provider 请求工具名 regex 全部通过', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'builtin:test',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'do.thing',
        description: '含点动作',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        exposeAsTool: true,
        handler: () => ({ ok: true }),
      });
      ctx.tool({
        name: 'plain_tool',
        description: 'x',
        inputSchema: { type: 'object' },
        execute: () => 'ok',
      });
    },
  });
  const tools = host.listTools();
  // OpenAI 函数名约束：^[a-zA-Z0-9_-]{1,64}$（真实 provider 会拒绝其余形态）
  const providerToolNameRegex = /^[a-zA-Z0-9_-]{1,64}$/;
  for (const t of tools) {
    assert.match(t.name, providerToolNameRegex, `工具名 ${t.name} 未通过 provider regex`);
  }
  const derived = tools.find((t) => t.sourceKind === 'action')!;
  assert.equal(derived.qualifiedId, 'builtin:test.do.thing');
  // 别名稳定（跨 host 实例同名同 id 同 hash）
  assert.equal(derived.name, actionToolAlias('builtin:test', 'do.thing'));
  // manifest 仍用原 ID：run_action / HTTP / CLI 不受别名影响
  assert.equal(host.listActions().find((a) => a.id === 'do.thing')!.pluginId, 'builtin:test');
  // executeTool 别名映射回原动作并经 schema 校验
  assert.deepEqual(await host.executeTool(derived.name, {}, { conversationId: 1 }), { ok: true });
  // 全限定名仍可解析
  assert.deepEqual(await host.executeTool('builtin:test.do.thing', {}, { conversationId: 1 }), { ok: true });
});

test('ctx.tool 名 provider-safe 校验：点/超长拒绝；不同长 id 的别名不碰撞', { timeout: 60_000 }, async () => {
  const host = makeHost();
  // 点与超长能过通用 id 校验但不过 provider-safe 校验
  for (const [i, name] of ['has.dot', 'a'.repeat(65)].entries()) {
    await rejectsCode(
      host.register({
        id: `p:tn-${i}`,
        definePlugin: (ctx) =>
          void ctx.tool({ name, description: 'x', inputSchema: { type: 'object' }, execute: () => 'ok' }),
      }),
      'invalid_tool_spec',
    );
  }
  // 冒号/空格/空名在通用 id 校验即拒（invalid_identifier），同样回滚
  for (const [i, name] of ['has:colon', 'has space', ''].entries()) {
    await rejectsCode(
      host.register({
        id: `p:tn2-${i}`,
        definePlugin: (ctx) =>
          void ctx.tool({ name, description: 'x', inputSchema: { type: 'object' }, execute: () => 'ok' }),
      }),
      'invalid_identifier',
    );
  }
  // 合法名字正常注册（64 上限边界）
  await host.register({
    id: 'p:tn-ok',
    definePlugin: (ctx) => {
      ctx.tool({ name: 'a'.repeat(64), description: 'x', inputSchema: { type: 'object' }, execute: () => 'ok' });
      ctx.tool({ name: 'ab-01_XY', description: 'x', inputSchema: { type: 'object' }, execute: () => 'ok' });
    },
  });
  assert.equal(host.listTools().length, 2);

  // 别名不碰撞：两插件同动作 id、同插件不同动作，清洗后前缀相同也不冲突
  const h2 = makeHost();
  await h2.register({
    id: 'p:one',
    definePlugin: (ctx) => {
      ctx.action({ id: 'run', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, exposeAsTool: true, handler: () => ({}) });
      ctx.action({ id: 'run.x', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, exposeAsTool: true, handler: () => ({}) });
    },
  });
  await h2.register({
    id: 'p:on-e',
    definePlugin: (ctx) => {
      ctx.action({ id: 'run', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, exposeAsTool: true, handler: () => ({}) });
    },
  });
  const names = h2.listTools().map((t) => t.name);
  assert.equal(new Set(names).size, names.length); // 三个别名互不相同
});

// ---------------------------------------------------------------------------
// 回归：hook 载荷校验收紧（model 空串 / 数字字段整数化 / trigger.id）
// ---------------------------------------------------------------------------

test('model 允许空串：无模型配置的 root 会话也能过 before_turn 校验', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let ran = false;
  await host.register({
    id: 'p:bt',
    definePlugin: (ctx) => {
      ctx.hook.onBeforeTurn(() => {
        ran = true;
      });
    },
  });
  const conv = makeConversation(1);
  conv.model = ''; // 未配置模型的会话
  // 不抛 invalid_hook_result 且钩子正常执行
  const r = await host.runHook('before_turn', { conversation: conv, inputs: [], tools: [], sections: [], messages: [] });
  assert.equal(r.action, 'transform');
  assert.equal(ran, true);
});

test('hook 数字字段收紧：非整数/负 id/负 seq 拒绝，合法空 text 默认数据通过', { timeout: 60_000 }, async () => {
  const host = makeHost();
  // 驱动插件：载荷校验只对实际参与管道执行
  await host.register({
    id: 'p:drive',
    definePlugin: (ctx) => {
      ctx.hook.onBeforeTurn(() => undefined);
      ctx.hook.onInput(() => undefined);
      ctx.hook.onTrigger(() => undefined);
    },
  });
  const expectInvalid = async (operation: Promise<unknown>) => {
    await assert.rejects(operation, (err: unknown) => {
      assert.ok(err instanceof HelmError);
      assert.equal(err.code, 'invalid_hook_result');
      return true;
    });
  };
  // conversation.id 必须正整数；seq 类字段非负整数
  await expectInvalid(
    host.runHook('before_turn', { conversation: { ...makeConversation(1), id: 1.5 }, inputs: [], tools: [], sections: [], messages: [] }),
  );
  await expectInvalid(
    host.runHook('before_turn', { conversation: { ...makeConversation(1), id: 0 }, inputs: [], tools: [], sections: [], messages: [] }),
  );
  await expectInvalid(
    host.runHook('before_turn', { conversation: { ...makeConversation(1), stateChangeSeq: -1 }, inputs: [], tools: [], sections: [], messages: [] }),
  );
  await expectInvalid(
    host.runHook('input', { conversationId: 1, input: { id: 'i', text: 'hi', origin: 'human', createdAt: -1 } }),
  );
  await expectInvalid(
    host.runHook('input', { conversationId: 1.5, input: { id: 'i', text: 'hi', origin: 'human', createdAt: 1 } }),
  );
  // trigger.id 缺失/空拒绝
  await expectInvalid(host.runHook('trigger', { ...makeEnvelope(), id: '' }));

  // 合法空 text（默认数据）不拒绝：仅类型校验不强制非空；createdAt=0 合法
  const ok = await host.runHook('input', { conversationId: 1, input: { id: 'i', text: '', origin: 'human', createdAt: 0 } });
  assert.equal(ok.action, 'transform');
  const okEnv = await host.runHook('trigger', makeEnvelope());
  assert.equal(okEnv.action, 'transform');
});
