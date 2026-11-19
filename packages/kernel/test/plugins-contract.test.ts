/**
 * Core plugin contract tests: conversation scopes, public documents, host lifecycle ports, and relative routes.
 * runner: tsx --test; every test has explicit timeout: 60_000 to guard against deadlocks.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HelmxError, type ConversationSummary, type EnvExecResponse, type MaybePromise, type PluginDefinition } from '@helmx/protocol';
import { PluginHost } from '../src/plugins/index.js';
import { PluginHostBackendFixtureBase } from './helpers/plugin-host-backend.js';
import { createPluginBuildProvider } from '@helmx/plugin-build';
import {
  MemoryDocStore,
  assertRejectsCode,
  cleanupDir,
  makeConversationSummary,
  makeTempDir,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

function makeConversation(id: number, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return makeConversationSummary({ id, ...over });
}

/** Programmable conversation store: execution-phase scope validation reads live summaries via `host.getConversation`. */
class FakeBackend extends PluginHostBackendFixtureBase {
  conversations = new Map<number, ConversationSummary>();
  events: Array<{ type: string; payload: unknown }> = [];
  /** Conversation management lock records: `(conversationId, pluginId)` present while active. */
  managed = new Map<string, { conversationId: number; pluginId: string }>();
  askSeqResolvers = new Set<(askId: string) => MaybePromise<number | undefined>>();
  workflowListeners = new Set<(run: unknown) => void | Promise<void>>();

  constructor() {
    super();
    this.conversations.set(1, makeConversation(1, { profileId: 'assistant', tags: ['root'] }));
    this.conversations.set(2, makeConversation(2, { profileId: 'superagent', tags: ['router'] }));
    this.conversations.set(3, makeConversation(3, { profileId: 'watchdog', tags: ['watchdog'] }));
    this.conversations.set(5, makeConversation(5, { profileId: 'worker', tags: ['worker'] }));
  }

  dispatchTrigger(): Promise<void> {
    return Promise.resolve();
  }
  submitInput(): Promise<void> {
    return Promise.resolve();
  }
  createConversation(): Promise<ConversationSummary> {
    return Promise.resolve(makeConversation(99));
  }
  listConversations(): ConversationSummary[] {
    return [...this.conversations.values()];
  }
  getConversation(id: number): ConversationSummary {
    const found = this.conversations.get(id);
    if (found === undefined) throw new HelmxError('not_found', `conversation missing: ${id}`, 404);
    return found;
  }
  updateConversation(id: number): Promise<ConversationSummary> {
    return Promise.resolve(this.getConversation(id));
  }
  abortConversation(): Promise<void> {
    return Promise.resolve();
  }
  getConversationOwnership(): 'helmx' | 'bot' | 'human' {
    return 'human';
  }
  spawnAgent(): Promise<unknown> {
    return Promise.resolve({});
  }
  runGate(): Promise<{ ok: boolean; output: string }> {
    return Promise.resolve({ ok: true, output: '' });
  }
  invokeAction(pluginId: string, actionId: string): Promise<unknown> {
    void pluginId;
    void actionId;
    return Promise.resolve({});
  }
  prepareAction(): { idempotent: boolean } {
    return { idempotent: false };
  }
  execEnv(): Promise<EnvExecResponse> {
    return Promise.reject(new HelmxError('unsupported', 'this fixture does not execute node commands', 501));
  }
  withFileMutationQueue(): Promise<never> { throw new Error('this fixture does not support file mutation queue') }
  listActions(): [] {
    return [];
  }
  manageConversation(id: number, pluginId: string): () => void {
    const entry = { conversationId: id, pluginId };
    const key = `${id}:${pluginId}`;
    this.managed.set(key, entry);
    return () => {
      this.managed.delete(key);
    };
  }
  markConversationOwnership(id: number, owner: 'helmx' | 'bot' | 'human'): void {
    void id;
    void owner;
  }
  createAsk(): Promise<{ id: string; status: 'answered'; answers: Record<string, string> }> {
    return Promise.resolve({ id: 'ask-1', status: 'answered', answers: {} });
  }
  cancelAsk(): Promise<void> {
    return Promise.resolve();
  }
  registerAskSeqResolver(resolver: (askId: string) => MaybePromise<number | undefined>): () => void {
    this.askSeqResolvers.add(resolver);
    return () => {
      this.askSeqResolvers.delete(resolver);
    };
  }
  onEvent(_type: string, listener: (payload: unknown) => void | Promise<void>): () => void {
    this.workflowListeners.add(listener);
    return () => {
      this.workflowListeners.delete(listener);
    };
  }
  emitEvent(type: string, payload: unknown): void {
    this.events.push({ type, payload });
  }
}

let dataDir: string;
let backend: FakeBackend;
let docs: MemoryDocStore;

function makeHost(): PluginHost {
  return new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs });
}

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HelmxError, `expected HelmxError, got: ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

/** Builds a plugin declaring one tool and one action (optional scope; name includes id suffix to prevent cross-plugin collisions). */
function scopedPlugin(
  id: string,
  scope: { tool?: unknown; action?: unknown },
): PluginDefinition {
  const suffix = id.replaceAll(/[^A-Za-z0-9]/g, '_');
  return {
    id,
    definePlugin: (ctx) => {
      ctx.tool({
        name: `scoped_tool_${suffix}`,
        description: 'x',
        inputSchema: { type: 'object' },
        ...(scope.tool !== undefined ? { scope: scope.tool as never } : {}),
        execute: () => ({ ok: true }),
      });
      ctx.action({
        id: 'scoped_action',
        description: 'x',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        ...(scope.action !== undefined ? { scope: scope.action as never } : {}),
        handler: () => ({ ok: true }),
      });
    },
  };
}


/** Registered tool name for `scopedPlugin` (kept in sync with derivation rule). */
function scopedToolName(pluginId: string): string {
  return `scoped_tool_${pluginId.replaceAll(/[^A-Za-z0-9]/g, '_')}`;
}

beforeEach(async () => {
  dataDir = await makeTempDir('helmx-plugins-contract-');
  backend = new FakeBackend();
  docs = new MemoryDocStore();
});

afterEach(async () => {
  await cleanupDir(dataDir);
});

// ---------------------------------------------------------------------------
// 1. ConversationScope: registration boundary validation
// ---------------------------------------------------------------------------

test('scope registration boundary: non-plain objects, unknown fields, and invalid elements reject with invalid_plugin_scope and roll back', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const badScopes: unknown[] = [
    'not-object',
    42,
    null,
    new Map([['tags', ['a']]]),
    ['tags'],
    { conversationIds: '2,3' },
    { tags: [1, 'ok'] },
    { profileIds: [''] },
    { modelProviders: 'example' },
    { modelProviders: [''] },
    { modelProviders: [42] },
    { conversationIds: [0] },
    { conversationIds: [1.5] },
    { conversationIds: [-1] },
    { unknownField: ['x'] },
    { tags: 'worker' },
  ];
  for (const [i, scope] of badScopes.entries()) {
    await assertRejectsCode(
      () => host.register(scopedPlugin(`p:bad-${i}`, { tool: scope })),
      'invalid_plugin_scope',
      400,
    );
  }
  // Full rollback: zero registered plugins remain
  assert.equal(host.list().length, 0);
  // action scope also rejects at registration boundary
  await assertRejectsCode(
    () => host.register(scopedPlugin('p:bad-action', { action: { tags: [new Date()] } })),
    'invalid_plugin_scope',
  );

  // Valid scopes (positive integer IDs / non-empty strings / empty arrays tested separately) register cleanly
  const ok = makeHost();
  await ok.register(scopedPlugin('p:ok', { tool: { conversationIds: [1, 2], tags: ['worker'] } }));
  assert.equal(ok.list().length, 1);
});

test('modelProvider scope tracks live model switches and re-checks both tools and actions at execution', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const scope = { modelProviders: ['example'] };
  await host.register(scopedPlugin('p:model-provider', { tool: scope, action: scope }));
  const conversation = backend.getConversation(1);
  conversation.model = 'example/group/nested-model';
  assert.ok(host.listTools(conversation).some((tool) => tool.name === scopedToolName('p:model-provider')));
  await host.executeTool(scopedToolName('p:model-provider'), {}, { conversationId: 1 });
  conversation.model = 'another/model';
  assert.ok(!host.listTools(conversation).some((tool) => tool.name === scopedToolName('p:model-provider')));
  await assertRejectsCode(() => host.executeTool(scopedToolName('p:model-provider'), {}, { conversationId: 1 }), 'conversation_scope_violation', 403);
  await assertRejectsCode(() => host.invokeAction('p:model-provider', 'scoped_action', {}, { conversationId: 1 }), 'conversation_scope_violation', 403);
});

test('ui scope validates at registration boundary and enters manifest when valid', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:ui-scope',
        definePlugin: (ctx) => {
          ctx.ui.screen({ id: 's', label: 'x', scope: { bogus: [1] } as never });
        },
      }),
    'invalid_plugin_scope',
  );
  // Valid ui scope registers cleanly and appears in UI manifest
  await host.register({
    id: 'p:ui-scope-ok',
    definePlugin: (ctx) => {
      ctx.ui.screen({ id: 's', label: 'x', scope: { profileIds: ['superagent'] } });
    },
  });
  const ui = host.listUi();
  assert.equal(ui.length, 1);
  assert.deepEqual((ui[0]!.spec as { scope?: unknown }).scope, { profileIds: ['superagent'] });
});

test('timeline.renderer matchMeta only allows { renderer: non-empty string }', { timeout: 60_000 }, async () => {
  const host = makeHost();
  for (const [i, matchMeta] of [
    { renderer: '' },
    { renderer: 1 },
    { renderer: 'ok', extra: 1 },
    'nope',
    {},
  ].entries()) {
    await assertRejectsCode(
      () =>
        host.register({
          id: `p:mm-${i}`,
          definePlugin: (ctx) => {
            ctx.ui.timelineRenderer({ id: 'r', kinds: ['x'], matchMeta: matchMeta as never });
          },
        }),
      'invalid_ui_spec',
    );
  }
  await host.register({
    id: 'p:mm-ok',
    definePlugin: (ctx) => {
      ctx.ui.timelineRenderer({ id: 'r', kinds: ['worker.report'], matchMeta: { renderer: 'card' } });
    },
  });
  const spec = host.listUi()[0]!.spec as { matchMeta?: unknown };
  assert.deepEqual(spec.matchMeta, { renderer: 'card' });
});

// ---------------------------------------------------------------------------
// 2. listTools(conversation) scope filtering + executeTool / invokeAction double validation
// ---------------------------------------------------------------------------

test('listTools returns all tools when omitted or filters by scope (profileIds and tags) when conversation provided', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(
    scopedPlugin('p:superagent-tools', {
      // Role scoping uses profileIds explicitly
      tool: { profileIds: ['superagent', 'watchdog'] },
      action: { profileIds: ['superagent', 'watchdog'] },
    }),
  );
  await host.register({
    id: 'p:worker-tools',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'archive',
        description: 'archive worker',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        scope: { tags: ['worker'] },
        exposeAsTool: true,
        handler: () => ({ archived: true }),
      });
    },
  });
  await host.register(scopedPlugin('p:unscoped', {}));

  // No conversation passed: full list (both scoped and unscoped tools)
  const all = host.listTools();
  assert.equal(all.length, 3); // scoped_tool(superagent) + archive(worker) + scoped_tool(unscoped)

  // superagent conversation: matches two profileIds + unscoped tool
  const routerView = host.listTools(backend.conversations.get(2)!);
  const routerNames = routerView.map((t) => t.sourcePluginId).sort();
  assert.deepEqual(routerNames, ['p:superagent-tools', 'p:unscoped']);

  // worker conversation (tags match) + unscoped tool
  const workerView = host.listTools(backend.conversations.get(5)!);
  assert.deepEqual(
    workerView.map((t) => t.sourcePluginId).sort(),
    ['p:unscoped', 'p:worker-tools'],
  );

  // assistant conversation: only unscoped tool remains
  const assistantView = host.listTools(backend.conversations.get(1)!);
  assert.deepEqual(assistantView.map((t) => t.sourcePluginId), ['p:unscoped']);
});

test('explicit empty scope arrays match zero conversations rather than unconstrained; undefined fields stay unconstrained', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(scopedPlugin('p:none', { tool: { conversationIds: [] } }));
  await host.register(scopedPlugin('p:partial', { tool: { profileIds: ['superagent'], tags: [] } }));
  await host.register(scopedPlugin('p:open', { tool: { profileIds: undefined } }));

  const conv = backend.conversations.get(2)!;
  const names = host.listTools(conv).map((t) => t.sourcePluginId);
  // p:none fails empty conversationIds; p:partial matches profileIds yet fails empty tags AND clause;
  // p:open has no active constraints so it matches
  assert.deepEqual(names, ['p:open']);
});

test('executeTool re-validates scope (403 on mismatch, allowed on match/no conversation; unscoped unchanged)', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(
    scopedPlugin('p:guard', {
      tool: { profileIds: ['superagent'] },
      action: { profileIds: ['superagent'] },
    }),
  );

  // Conversation 1 (assistant) out of scope: direct calls outside visibility still reject 403
  await assertRejectsCode(() => host.executeTool(scopedToolName('p:guard'), {}, { conversationId: 1 }), 'conversation_scope_violation', 403);
  await assertRejectsCode(
    () => host.invokeAction('p:guard', 'scoped_action', {}, { conversationId: 1 }),
    'conversation_scope_violation',
    403,
  );
  // Conversation 2 (superagent) matches: allowed
  assert.deepEqual(await host.executeTool(scopedToolName('p:guard'), {}, { conversationId: 2 }), { ok: true });
  assert.deepEqual(await host.invokeAction('p:guard', 'scoped_action', {}, { conversationId: 2 }), { ok: true });

  // Call without conversationId (human HTTP/CLI outside conversation context): allowed (scope is conversation policy, not user auth)
  assert.deepEqual(await host.invokeAction('p:guard', 'scoped_action', {}), { ok: true });

  // Unscoped plugin: allowed everywhere regardless of conversation context
  await host.register(scopedPlugin('p:free', {}));
  assert.deepEqual(await host.executeTool(scopedToolName('p:free'), {}, { conversationId: 1 }), { ok: true });
});

test('scope reads live conversation summary via host.getConversation and throws not_found if missing', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(
    scopedPlugin('p:gone', { tool: { conversationIds: [999] }, action: { conversationIds: [999] } }),
  );
  await assertRejectsCode(() => host.executeTool(scopedToolName('p:gone'), {}, { conversationId: 999 }), 'not_found', 404);
  // Deleting conversation directly affects getConversation immediately
  backend.conversations.delete(1);
  await assertRejectsCode(
    () => host.invokeAction('p:gone', 'scoped_action', {}, { conversationId: 1 }),
    'not_found',
  );
});

test('exposeAsTool derived tool inherits scope and re-validates via invokeAction when executed', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:derived',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'patrol',
        description: 'patrol check',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        scope: { profileIds: ['watchdog'] },
        exposeAsTool: true,
        handler: () => ({ patrolled: true }),
      });
    },
  });
  const tools = host.listTools(backend.conversations.get(3)!); // visible in watchdog conversation
  assert.equal(tools.length, 1);
  const alias = tools[0]!.name;
  assert.deepEqual(await host.executeTool(alias, {}, { conversationId: 3 }), { patrolled: true });
  // Hidden and rejected in other conversations (double validation)
  assert.equal(host.listTools(backend.conversations.get(1)!).length, 0);
  await assertRejectsCode(() => host.executeTool(alias, {}, { conversationId: 1 }), 'conversation_scope_violation');
  // listActions manifest preserves scope (for run_action injection)
  const manifest = host.listActions().find((a) => a.id === 'patrol')!;
  assert.deepEqual(manifest.scope, { profileIds: ['watchdog'] });
});

// ---------------------------------------------------------------------------
// 3. Public documents: third `public` argument / getPublicDoc / plugin.doc.updated
// ---------------------------------------------------------------------------

test('ctx.doc public flag defaults to private; public writes emit JSON-safe plugin.doc.updated events', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let publicHandle!: { set: (v: { n: number }) => void; update: (fn: (c: { n: number }) => { n: number }) => void };
  let privateHandle!: { set: (v: { n: number }) => void };
  await host.register({
    id: 'p:docs',
    definePlugin: (ctx) => {
      publicHandle = ctx.doc('pub', { n: 0 }, { public: true });
      privateHandle = ctx.doc('priv', { n: 0 });
    },
  });

  const docEvents = () =>
    backend.events
      .filter((e) => e.type === 'plugin.doc.updated')
      .map((e) => (e.payload as { doc: { pluginId: string; name: string; value: { n: number } } }).doc);

  // Both set and update emit PublicPluginDoc payloads
  publicHandle.set({ n: 1 });
  publicHandle.update((c) => ({ n: c.n + 1 }));
  const emitted = docEvents();
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted.map((d) => d.value.n), [1, 2]);
  assert.equal(emitted[0]!.pluginId, 'p:docs');
  assert.equal(emitted[0]!.name, 'pub');

  // Private document writes emit zero events
  privateHandle.set({ n: 9 });
  assert.equal(docEvents().length, 2);
});

test('getPublicDoc reads public initial/written docs and returns unified 404 for private/missing/disabled/unregistered', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let publicHandle!: { set: (v: { n: number }) => void };
  await host.register({
    id: 'p:pub',
    definePlugin: (ctx) => {
      ctx.doc('fresh', { n: 7 }, { public: true }); // never written
      ctx.doc('written', { n: 0 }, { public: true });
      ctx.doc('secret', { n: 0 });
      publicHandle = ctx.doc('written', { n: 0 }, { public: true }) as never;
    },
  }).catch(() => {
    // Duplicate declaration of 'written' rejects with duplicate_doc; re-register cleanly below
  });

  // Confirm failed registration rolled back, then register clean plugin
  assert.equal(host.list().length, 0);
  await host.register({
    id: 'p:pub',
    definePlugin: (ctx) => {
      ctx.doc('fresh', { n: 7 }, { public: true }); // never written: readable via initial value
      ctx.doc('written', { n: 0 }, { public: true });
      ctx.doc('secret', { n: 0 });
    },
  });

  // Initial values are readable even before any write
  assert.deepEqual(host.getPublicDoc('p:pub', 'fresh'), { pluginId: 'p:pub', name: 'fresh', value: { n: 7 } });
  assert.deepEqual(host.getPublicDoc('p:pub', 'written'), { pluginId: 'p:pub', name: 'written', value: { n: 0 } });

  // Private / undeclared docs both return 404 (never leak existence of private docs)
  throwsCode(() => host.getPublicDoc('p:pub', 'secret'), 'plugin_doc_not_found');
  throwsCode(() => host.getPublicDoc('p:pub', 'missing'), 'plugin_doc_not_found');

  // Disabled / unregistered plugins return 404 uniformly
  await host.disable('p:pub');
  throwsCode(() => host.getPublicDoc('p:pub', 'fresh'), 'plugin_doc_not_found');
  throwsCode(() => host.getPublicDoc('p:none', 'any'), 'plugin_doc_not_found');

  // Non-JSON value in public doc rejects at set boundary without emitting event
  const h2 = makeHost();
  let handle2!: ReturnType<Parameters<NonNullable<PluginDefinition['definePlugin']>>[0]['doc']>;
  await h2.register({
    id: 'p:pub2',
    definePlugin: (ctx) => {
      handle2 = ctx.doc('bad', { n: 0 }, { public: true });
    },
  });
  throwsCode(() => handle2.set({ n: NaN }), 'invalid_json_value');
  assert.equal(
    backend.events.filter((e) => e.type === 'plugin.doc.updated').length,
    0,
  );
  void publicHandle;
});

test('doc opts only allows { public?: boolean } and rejects unknown fields', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:doc-opts',
        definePlugin: (ctx) => {
          ctx.doc('k', { n: 0 }, { public: true, extra: 1 } as never);
        },
      }),
    'invalid_doc_spec',
  );
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:doc-opts2',
        definePlugin: (ctx) => {
          ctx.doc('k', { n: 0 }, { public: 'yes' } as never);
        },
      }),
    'invalid_doc_spec',
  );
});

// ---------------------------------------------------------------------------
// 4. Host lifecycle ports: manageConversation / onEvent / registerAskSeqResolver
// ---------------------------------------------------------------------------

test('ctx.host.manageConversation automatically injects caller pluginId and returns idempotent release handle', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let release!: () => void;
  await host.register({
    id: 'p:manager',
    definePlugin: (ctx) => {
      release = ctx.host.manageConversation(2);
    },
  });
  // Backend receives (2, 'p:manager') while plugin passes only conversationId (identity injected by host)
  assert.ok(backend.managed.has('2:p:manager'));

  // Manual release is idempotent: repeated calls release once
  release();
  release();
  assert.ok(!backend.managed.has('2:p:manager'));

  // Disabling automatically releases remaining locks without manual cleanup
  await host.register({
    id: 'p:manager2',
    definePlugin: (ctx) => {
      void ctx.host.manageConversation(3);
    },
  });
  assert.ok(backend.managed.has('3:p:manager2'));
  await host.disable('p:manager2');
  assert.ok(!backend.managed.has('3:p:manager2'));
});

test('register/enable failure leaks zero host lifecycle assets (definePlugin throws rolls back)', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:leak',
        definePlugin: (ctx) => {
          void ctx.host.manageConversation(2);
          void ctx.host.onEvent('workflow.settled', () => {});
          void ctx.host.registerAskSeqResolver(() => undefined);
          throw new Error('definePlugin crash');
        },
      }),
    'plugin_registration_failed',
  );
  // All three lifecycle asset categories rolled back cleanly
  assert.equal(backend.managed.size, 0);
  assert.equal(backend.workflowListeners.size, 0);
  assert.equal(backend.askSeqResolvers.size, 0);

  // Enable failure rolls back identically (driven via service.start failure after register+disable)
  let failStart = false;
  await host.register({
    id: 'p:leak2',
    definePlugin: (ctx) => {
      void ctx.host.manageConversation(5);
      ctx.service({
        id: 'svc',
        start: () => {
          if (failStart) throw new Error('start failed');
        },
        stop: () => {},
      });
    },
  });
  await host.disable('p:leak2');
  failStart = true;
  await assertRejectsCode(() => host.enable('p:leak2'), 'plugin_service_start_failed');
  assert.equal(backend.managed.size, 0);
});

test('onEvent(workflow.settled): auto-unsubscribes on disable and counts in-flight callbacks as active tasks', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let settledRuns: string[] = [];
  await host.register({
    id: 'p:wf',
    definePlugin: (ctx) => {
      void ctx.host.onEvent('workflow.settled', async (raw) => {
        // Generic event bus: payload stays opaque to kernel (workflow.settled schema belongs to @helmx/plugins).
        const run = raw as { id: string };
        await new Promise((r) => setTimeout(r, 10));
        settledRuns.push(run.id);
      });
    },
  });
  assert.equal(backend.workflowListeners.size, 1);

  const makeRun = (id: string): { id: string } => ({
    id,
  });

  // Normal dispatch (backend holds listener set and triggers directly)
  for (const listener of backend.workflowListeners) await listener(makeRun('wf_a'));
  assert.deepEqual(settledRuns, ['wf_a']);

  // In-flight callback protects plugin from disable with plugin_has_live_tasks
  const firing = (async () => {
    for (const listener of backend.workflowListeners) await listener(makeRun('wf_b'));
  })();
  await new Promise((r) => setTimeout(r, 3));
  await assertRejectsCode(() => host.disable('p:wf'), 'plugin_has_live_tasks');
  await firing;
  assert.deepEqual(settledRuns, ['wf_a', 'wf_b']);

  // Disabling automatically removes listener
  await host.disable('p:wf');
  assert.equal(backend.workflowListeners.size, 0);
  settledRuns = [];
});

test('registerAskSeqResolver unsubscribes on disable; stale-epoch ctx rejects host lifecycle acquisitions', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let stolenHost: Parameters<NonNullable<PluginDefinition['definePlugin']>>[0]['host'] | undefined;
  await host.register({
    id: 'p:seq',
    definePlugin: (ctx) => {
      void ctx.host.registerAskSeqResolver(() => 11);
      stolenHost = ctx.host;
    },
  });
  assert.equal(backend.askSeqResolvers.size, 1);
  await host.disable('p:seq');
  assert.equal(backend.askSeqResolvers.size, 0);

  // Stale handle immediately expired on disable (409 plugin_context_expired)
  throwsCode(() => stolenHost!.manageConversation(1), 'plugin_context_expired');
  throwsCode(() => stolenHost!.onEvent('workflow.settled', () => {}), 'plugin_context_expired');
  throwsCode(() => stolenHost!.registerAskSeqResolver(() => undefined), 'plugin_context_expired');
});

test('ctx.host wrapper forwards updateConversation / markConversationOwnership / createAsk cleanly', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const marked: Array<{ id: number; owner: string }> = [];
  const origMark = backend.markConversationOwnership.bind(backend);
  backend.markConversationOwnership = (id: number, owner: 'helmx' | 'bot' | 'human') => {
    marked.push({ id, owner });
    origMark(id, owner);
  };
  await host.register({
    id: 'p:fwd',
    definePlugin: (ctx) => {
      void ctx.host.updateConversation(1, { title: 'renamed' });
      ctx.host.markConversationOwnership(5, 'bot');
      void ctx.host.createAsk({
        conversationId: 1,
        title: 'confirm',
        fields: [{ name: 'ok', label: 'OK', type: 'confirm' }],
      });
    },
  });
  assert.equal(host.list().length, 1);
  assert.deepEqual(marked, [{ id: 5, owner: 'bot' }]);
});

// ---------------------------------------------------------------------------
// 5. Relative route contracts (only relative paths permitted)
// ---------------------------------------------------------------------------

test('relative routing: host prepends plugin namespace and listRoutes returns full mounted path', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'builtin:triggers',
    definePlugin: (ctx) => {
      ctx.route({ method: 'POST', path: '/webhook/:id', public: true, handler: () => new Response('ok') });
    },
  });
  const routes = host.listRoutes();
  assert.equal(routes.length, 1);
  assert.equal(routes[0]!.path, '/api/plugins/builtin%3Atriggers/routes/webhook/:id');
  assert.equal(routes[0]!.public, true);

  // Full /api prefixes, dot-segment escapes, and encoded escapes reject uniformly
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:evil',
        definePlugin: (ctx) => {
          ctx.route({ method: 'GET', path: '/api/plugins/p%3Aevil/routes/x', handler: () => new Response('x') });
        },
      }),
    'invalid_route_path',
  );
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:evil2',
        definePlugin: (ctx) => {
          ctx.route({ method: 'GET', path: '/%2e%2e/other', handler: () => new Response('x') });
        },
      }),
    'invalid_route_path',
  );
  // Malformed percent encoding (%zz) rejects at registration boundary
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:evil3',
        definePlugin: (ctx) => {
          ctx.route({ method: 'GET', path: '/hook%zz', handler: () => new Response('x') });
        },
      }),
    'invalid_route_path',
  );
  assert.equal(host.listRoutes().length, 1);
});
