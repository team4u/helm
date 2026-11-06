/**
 * PluginHost / Hook 管道 / 动作总线 / 在途任务保护 测试。
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HelmError,
  type ConversationSummary,
  type ExternalTriggerEnvelope,
  type HelmHostApi,
  type PluginDefinition,
} from '@helm/protocol';
import { PluginHost, type PluginDocStore, type PluginConfigStore } from '../src/plugins/index.js';

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

test('优先级与同优先级注册顺序：高 priority 先跑，同 priority 按注册顺序', async () => {
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

test('transform.value 传下游：后续处理器看到改写后的载荷', async () => {
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

test('handled 短路：后续处理器不执行，默认行为被接管', async () => {
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

test('tool_call block 携带 reason 短路；block 缺 reason 显式报错', async () => {
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

test('钩子返回不支持的动作组合（turn_settled block）显式 invalid_hook_result', async () => {
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

test('钩子返回 undefined 等价 continue；transform 缺 value / 破坏必要字段 / 未知 action 均显式报错', async () => {
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

test('钩子执行抛异常：包装 hook_execution_failed 且不静默', async () => {
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

test('invokeAction：入参校验失败 400 validation_error，输出违约 500 invalid_plugin_output', async () => {
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

test('parseQualifiedActionId：pluginId 含 ":" 时按首个 "." 正确分割', () => {
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

test('listActions / listTools：manifest 字段准确，exposeAsTool 动作派生工具', async () => {
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
  assert.ok(names.includes('builtin:mixed.visible'));
  assert.ok(!names.includes('builtin:mixed.hidden_tool'));

  // executeTool 走派生动作：输入经同一 schema 校验
  const r = await host.executeTool('builtin:mixed.visible', {}, { conversationId: 1 });
  assert.deepEqual(r, {});
  await assert.rejects(
    host.executeTool('dedicated_tool', { q: 123 }, { conversationId: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof HelmError);
      assert.equal(err.code, 'validation_error');
      return true;
    },
  );
});

test('动作声明缺 inputSchema/outputSchema 在注册边界显式拒绝', async () => {
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

test('disable 遇在途 action / tool / 挂起 spawn 一律 409，结束后可停用', async () => {
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

test('挂起 agent_spawn 与自定义 task 也计入在途保护', async () => {
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

test('runHook 执行期间 disable 被拒绝（钩子在途计为任务）', async () => {
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

test('服务 start 失败：已启动者逆向 stop，注册整体回滚', async () => {
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

test('正常 disable：服务按注册逆序 stop', async () => {
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

test('locked 插件 disable/unregister 403 plugin_locked', async () => {
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

test('doc 命名空间隔离 pluginId:name；get 返回 clone 防未持久化突变', async () => {
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

test('未提供 ConfigStore 时 setConfig 显式 501，不假持久化；提供时可写', async () => {
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

test('路由限定插件前缀：越界 403，正常注册进 listRoutes', async () => {
  const host = makeHost();
  await host.register({
    id: 'triggers',
    definePlugin: (ctx) => {
      ctx.route({
        method: 'POST',
        path: '/api/plugins/triggers/hook',
        public: true,
        handler: () => new Response('ok'),
      });
    },
  });
  const routes = host.listRoutes();
  assert.equal(routes.length, 1);
  assert.equal(routes[0]!.path, '/api/plugins/triggers/hook');
  assert.equal(routes[0]!.public, true);

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
});

test('UI 七类十函数统一收集可序列化 spec；不可序列化 spec 拒绝', async () => {
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

test('dispose 逆序停用全部插件；dispose 后调用显式报错', async () => {
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

test('cli.command 语义化命令路径：合法声明透传 manifest，非法声明拒绝', async () => {
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

test('重复注册 / 未知插件 / 未启用插件动作调用均显式报错', async () => {
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
