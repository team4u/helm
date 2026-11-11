/**
 * 新版插件核心契约测试：会话作用域、公共文档、宿主生命周期端口、相对路由。
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
  type EnvExecResponse,
  type MaybePromise,
  type PluginDefinition,
  type WorkflowRunSummary,
} from '@helm/protocol';
import { PluginHost, type PluginDocStore } from '../src/plugins/index.js';
import { PluginHostBackendFixtureBase } from './helpers/plugin-host-backend.js';

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

function makeConversation(id: number, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'test/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

/** 可编程会话面：scope 执行期校验经 host.getConversation 现取真实摘要。 */
class FakeBackend extends PluginHostBackendFixtureBase {
  conversations = new Map<number, ConversationSummary>();
  events: Array<{ type: string; payload: unknown }> = [];
  /** 会话管理保护记录：(conversationId, pluginId) → 仍生效即存在。 */
  managed = new Map<string, { conversationId: number; pluginId: string }>();
  askSeqResolvers = new Set<(askId: string) => MaybePromise<number | undefined>>();
  workflowListeners = new Set<(run: WorkflowRunSummary) => void | Promise<void>>();

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
    if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404);
    return found;
  }
  updateConversation(id: number): Promise<ConversationSummary> {
    return Promise.resolve(this.getConversation(id));
  }
  abortConversation(): Promise<void> {
    return Promise.resolve();
  }
  getConversationActivity(): { consecutiveErrors: number } {
    return { consecutiveErrors: 0 };
  }
  getConversationOwnership(): 'helm' | 'bot' | 'human' {
    return 'human';
  }
  spawnAgent(): Promise<unknown> {
    return Promise.resolve({});
  }
  runGate(): Promise<{ ok: boolean; output: string }> {
    return Promise.resolve({ ok: true, output: '' });
  }
  prepareInterruptedConversations(): Promise<void> {
    return Promise.resolve();
  }
  cleanupWorktree(): Promise<import('@helm/protocol').WorktreeCleanupResult> {
    return Promise.resolve({ removed: false, worktreeId: '', path: '', branch: '', nodeId: '', branchDeleted: false });
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
    return Promise.reject(new HelmError('unsupported', '本 fixture 不执行节点命令', 501));
  }
  withFileMutationQueue(): Promise<never> { throw new Error('本 fixture 不承载文件互斥队列') }
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
  markConversationOwnership(id: number, owner: 'helm' | 'bot' | 'human'): void {
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
    this.workflowListeners.add(listener as (run: WorkflowRunSummary) => void | Promise<void>);
    return () => {
      this.workflowListeners.delete(listener as (run: WorkflowRunSummary) => void | Promise<void>);
    };
  }
  emitEvent(type: string, payload: unknown): void {
    this.events.push({ type, payload });
  }
}

class MemoryDocStore implements PluginDocStore {
  store = new Map<string, unknown>();
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial;
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value));
  }
  async flush(): Promise<void> {}
}

let dataDir: string;
let backend: FakeBackend;
let docs: MemoryDocStore;

function makeHost(): PluginHost {
  return new PluginHost({ dataDir, host: backend, docs });
}

async function rejectsCode(promise: Promise<unknown>, code: string, status?: number): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof HelmError, `期望 HelmError，实际：${String(err)}`);
    assert.equal(err.code, code);
    if (status !== undefined) assert.equal(err.status, status);
    return true;
  });
}

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HelmError, `期望 HelmError，实际：${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

/** 构造一个声明工具与动作的插件（scope 可配；名字带 id 后缀避免跨插件重名）。 */
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


/** scopedPlugin 的工具注册名（与实现保持同一派生规则）。 */
function scopedToolName(pluginId: string): string {
  return `scoped_tool_${pluginId.replaceAll(/[^A-Za-z0-9]/g, '_')}`;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'helm-plugins-contract-'));
  backend = new FakeBackend();
  docs = new MemoryDocStore();
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. ConversationScope：注册边界校验
// ---------------------------------------------------------------------------

test('scope 注册边界：非纯对象/未知字段/非法元素一律 invalid_plugin_scope 并整体回滚', { timeout: 60_000 }, async () => {
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
    await rejectsCode(
      host.register(scopedPlugin(`p:bad-${i}`, { tool: scope })),
      'invalid_plugin_scope',
      400,
    );
  }
  // 全部回滚：无插件注册
  assert.equal(host.list().length, 0);
  // 动作 scope 同样在注册边界拒绝
  await rejectsCode(
    host.register(scopedPlugin('p:bad-action', { action: { tags: [new Date()] } })),
    'invalid_plugin_scope',
  );

  // 合法 scope（正整数 ID / 非空字符串 / 空数组语义另测）正常注册
  const ok = makeHost();
  await ok.register(scopedPlugin('p:ok', { tool: { conversationIds: [1, 2], tags: ['worker'] } }));
  assert.equal(ok.list().length, 1);
});

test('模型供应商 scope 随会话切换生效，执行边界复核工具与动作', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const scope = { modelProviders: ['example'] };
  await host.register(scopedPlugin('p:model-provider', { tool: scope, action: scope }));
  const conversation = backend.getConversation(1);
  conversation.model = 'example/group/nested-model';
  assert.ok(host.listTools(conversation).some((tool) => tool.name === scopedToolName('p:model-provider')));
  await host.executeTool(scopedToolName('p:model-provider'), {}, { conversationId: 1 });
  conversation.model = 'another/model';
  assert.ok(!host.listTools(conversation).some((tool) => tool.name === scopedToolName('p:model-provider')));
  await rejectsCode(host.executeTool(scopedToolName('p:model-provider'), {}, { conversationId: 1 }), 'conversation_scope_violation', 403);
  await rejectsCode(host.invokeAction('p:model-provider', 'scoped_action', {}, { conversationId: 1 }), 'conversation_scope_violation', 403);
});

test('ui scope 也在注册边界校验：非法 ui spec scope 拒绝', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await rejectsCode(
    host.register({
      id: 'p:ui-scope',
      definePlugin: (ctx) => {
        ctx.ui.screen({ id: 's', label: 'x', scope: { bogus: [1] } as never });
      },
    }),
    'invalid_plugin_scope',
  );
  // 合法 ui scope 注册成功且进清单
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

test('timeline.renderer matchMeta 仅允许 { renderer: 非空字符串 }', { timeout: 60_000 }, async () => {
  const host = makeHost();
  for (const [i, matchMeta] of [
    { renderer: '' },
    { renderer: 1 },
    { renderer: 'ok', extra: 1 },
    'nope',
    {},
  ].entries()) {
    await rejectsCode(
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
// 2. listTools(conversation) 按会话筛选 + executeTool / invokeAction 双重校验
// ---------------------------------------------------------------------------

test('listTools 无参全量（runtime 热注册）；有参按 scope 筛选（profileIds 为主示例，tags 通用）', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(
    scopedPlugin('p:superagent-tools', {
      // 新角色示例：中枢 scope 用 profileIds 表达
      tool: { profileIds: ['superagent', 'watchdog'] },
      action: { profileIds: ['superagent', 'watchdog'] },
    }),
  );
  await host.register({
    id: 'p:worker-tools',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'archive',
        description: '归档 worker',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        scope: { tags: ['worker'] },
        exposeAsTool: true,
        handler: () => ({ archived: true }),
      });
    },
  });
  await host.register(scopedPlugin('p:unscoped', {}));

  // 无参：全部工具（含无 scope 与命中 scope 的）
  const all = host.listTools();
  assert.equal(all.length, 3); // scoped_tool(superagent) + archive(worker) + scoped_tool(unscoped)

  // superagent 会话：可见 profileIds 命中的两个 + 无 scope 的一个
  const routerView = host.listTools(backend.conversations.get(2)!);
  const routerNames = routerView.map((t) => t.sourcePluginId).sort();
  assert.deepEqual(routerNames, ['p:superagent-tools', 'p:unscoped']);

  // worker 会话（tags 命中）+ 无 scope
  const workerView = host.listTools(backend.conversations.get(5)!);
  assert.deepEqual(
    workerView.map((t) => t.sourcePluginId).sort(),
    ['p:unscoped', 'p:worker-tools'],
  );

  // assistant 会话：只剩无 scope 的
  const assistantView = host.listTools(backend.conversations.get(1)!);
  assert.deepEqual(assistantView.map((t) => t.sourcePluginId), ['p:unscoped']);
});

test('显式空数组 scope 匹配不到任何会话（非「不限」）；缺省字段不限', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(scopedPlugin('p:none', { tool: { conversationIds: [] } }));
  await host.register(scopedPlugin('p:partial', { tool: { profileIds: ['superagent'], tags: [] } }));
  await host.register(scopedPlugin('p:open', { tool: { profileIds: undefined } }));

  const conv = backend.conversations.get(2)!;
  const names = host.listTools(conv).map((t) => t.sourcePluginId);
  // p:none 空 conversationIds 不命中；p:partial profileIds 命中但 tags 空数组 AND 不命中；
  // p:open 无实质约束命中
  assert.deepEqual(names, ['p:open']);
});

test('executeTool 双重校验：scope 未命中 403，命中放行；无 scope 保持旧行为', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(
    scopedPlugin('p:guard', {
      tool: { profileIds: ['superagent'] },
      action: { profileIds: ['superagent'] },
    }),
  );

  // 会话 1（assistant）不在 scope：可见性之外的直接执行也被拒
  await rejectsCode(host.executeTool(scopedToolName('p:guard'), {}, { conversationId: 1 }), 'conversation_scope_violation', 403);
  await rejectsCode(
    host.invokeAction('p:guard', 'scoped_action', {}, { conversationId: 1 }),
    'conversation_scope_violation',
    403,
  );
  // 会话 2（superagent）命中：放行
  assert.deepEqual(await host.executeTool(scopedToolName('p:guard'), {}, { conversationId: 2 }), { ok: true });
  assert.deepEqual(await host.invokeAction('p:guard', 'scoped_action', {}, { conversationId: 2 }), { ok: true });

  // 无 conversationId 的人工调用（HTTP/CLI 无会话上下文）：放行（scope 是会话策略非用户鉴权）
  assert.deepEqual(await host.invokeAction('p:guard', 'scoped_action', {}), { ok: true });

  // 无 scope 插件：任何会话与无会话上下文都放行（旧行为）
  await host.register(scopedPlugin('p:free', {}));
  assert.deepEqual(await host.executeTool(scopedToolName('p:free'), {}, { conversationId: 1 }), { ok: true });
});

test('scope 会话摘要经 host.getConversation 现取：会话不存在如实抛 not_found', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(
    scopedPlugin('p:gone', { tool: { conversationIds: [999] }, action: { conversationIds: [999] } }),
  );
  await rejectsCode(host.executeTool(scopedToolName('p:gone'), {}, { conversationId: 999 }), 'not_found', 404);
  // 私改 conversations 面板不影响：getConversation 现取真实数据
  backend.conversations.delete(1);
  await rejectsCode(
    host.invokeAction('p:gone', 'scoped_action', {}, { conversationId: 1 }),
    'not_found',
  );
});

test('exposeAsTool 动作派生工具继承 scope：executeTool 经 invokeAction 二次校验', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:derived',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'patrol',
        description: '巡检',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        scope: { profileIds: ['watchdog'] },
        exposeAsTool: true,
        handler: () => ({ patrolled: true }),
      });
    },
  });
  const tools = host.listTools(backend.conversations.get(3)!); // watchdog 会话可见
  assert.equal(tools.length, 1);
  const alias = tools[0]!.name;
  assert.deepEqual(await host.executeTool(alias, {}, { conversationId: 3 }), { patrolled: true });
  // 其他会话不可见且执行被拒（双重校验）
  assert.equal(host.listTools(backend.conversations.get(1)!).length, 0);
  await rejectsCode(host.executeTool(alias, {}, { conversationId: 1 }), 'conversation_scope_violation');
  // listActions manifest 携带 scope（run_action 清单注入用）
  const manifest = host.listActions().find((a) => a.id === 'patrol')!;
  assert.deepEqual(manifest.scope, { profileIds: ['watchdog'] });
});

// ---------------------------------------------------------------------------
// 3. 公共文档：public 第三参 / getPublicDoc / plugin.doc.updated
// ---------------------------------------------------------------------------

test('ctx.doc 第三参 public：私有默认；公共变更发 plugin.doc.updated（值 JSON-safe）', { timeout: 60_000 }, async () => {
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

  // set / update 都发事件，载荷是 PublicPluginDoc
  publicHandle.set({ n: 1 });
  publicHandle.update((c) => ({ n: c.n + 1 }));
  const emitted = docEvents();
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted.map((d) => d.value.n), [1, 2]);
  assert.equal(emitted[0]!.pluginId, 'p:docs');
  assert.equal(emitted[0]!.name, 'pub');

  // 私有 doc 写入不发事件
  privateHandle.set({ n: 9 });
  assert.equal(docEvents().length, 2);
});

test('getPublicDoc：public 可读（含未写过的初值）；private/missing/停用/未注册统一 404', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let publicHandle!: { set: (v: { n: number }) => void };
  await host.register({
    id: 'p:pub',
    definePlugin: (ctx) => {
      ctx.doc('fresh', { n: 7 }, { public: true }); // 从未 set
      ctx.doc('written', { n: 0 }, { public: true });
      ctx.doc('secret', { n: 0 });
      publicHandle = ctx.doc('written', { n: 0 }, { public: true }) as never;
    },
  }).catch(() => {
    // written 重复声明会 duplicate_doc —— 换个干净写法
  });

  // 上面故意注册失败（duplicate_doc），换干净插件验证
  assert.equal(host.list().length, 0);
  await host.register({
    id: 'p:pub',
    definePlugin: (ctx) => {
      ctx.doc('fresh', { n: 7 }, { public: true }); // 从未 set：初值可读
      ctx.doc('written', { n: 0 }, { public: true });
      ctx.doc('secret', { n: 0 });
    },
  });

  // 初值在未写过时即可读
  assert.deepEqual(host.getPublicDoc('p:pub', 'fresh'), { pluginId: 'p:pub', name: 'fresh', value: { n: 7 } });
  assert.deepEqual(host.getPublicDoc('p:pub', 'written'), { pluginId: 'p:pub', name: 'written', value: { n: 0 } });

  // 私有 / 未声明：统一 404（外部无从探测私有 doc 存在性）
  throwsCode(() => host.getPublicDoc('p:pub', 'secret'), 'plugin_doc_not_found');
  throwsCode(() => host.getPublicDoc('p:pub', 'missing'), 'plugin_doc_not_found');

  // 停用后统一 404；未注册插件 404
  await host.disable('p:pub');
  throwsCode(() => host.getPublicDoc('p:pub', 'fresh'), 'plugin_doc_not_found');
  throwsCode(() => host.getPublicDoc('p:none', 'any'), 'plugin_doc_not_found');

  // 公共 doc 非法值（非 JSON）：set 边界拒绝且不发事件
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

test('doc opts 只允许 { public?: boolean }：未知字段拒绝', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await rejectsCode(
    host.register({
      id: 'p:doc-opts',
      definePlugin: (ctx) => {
        ctx.doc('k', { n: 0 }, { public: true, extra: 1 } as never);
      },
    }),
    'invalid_doc_spec',
  );
  await rejectsCode(
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
// 4. 宿主生命周期端口：manageConversation / onWorkflowSettled / askSeq 解除
// ---------------------------------------------------------------------------

test('ctx.host.manageConversation 自动携带本插件 pluginId；释放句柄幂等', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let release!: () => void;
  await host.register({
    id: 'p:manager',
    definePlugin: (ctx) => {
      release = ctx.host.manageConversation(2);
    },
  });
  // 后端收到的是 (2, 'p:manager')——插件侧只有单参，身份由宿主包装注入
  assert.ok(backend.managed.has('2:p:manager'));

  // 手动释放幂等：多次调用只解除一次
  release();
  release();
  assert.ok(!backend.managed.has('2:p:manager'));

  // 停用自动释放：重新 manage 后 disable，不再需要插件手动释放
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

test('register/enable 失败不泄漏宿主生命周期资源（definePlugin 抛错即回滚释放）', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await rejectsCode(
    host.register({
      id: 'p:leak',
      definePlugin: (ctx) => {
        void ctx.host.manageConversation(2);
        void ctx.host.onEvent('workflow.settled', () => {});
        void ctx.host.registerAskSeqResolver(() => undefined);
        throw new Error('definePlugin 崩溃');
      },
    }),
    'plugin_registration_failed',
  );
  // 三类资源全部回滚释放
  assert.equal(backend.managed.size, 0);
  assert.equal(backend.workflowListeners.size, 0);
  assert.equal(backend.askSeqResolvers.size, 0);

  // enable 失败同样回滚：先注册成功再改坏 definePlugin 不可行（定义不可变），
  // 用 service start 失败驱动 enable 回滚路径
  let failStart = false;
  await host.register({
    id: 'p:leak2',
    definePlugin: (ctx) => {
      void ctx.host.manageConversation(5);
      ctx.service({
        id: 'svc',
        start: () => {
          if (failStart) throw new Error('start 失败');
        },
        stop: () => {},
      });
    },
  });
  await host.disable('p:leak2');
  failStart = true;
  await rejectsCode(host.enable('p:leak2'), 'plugin_service_start_failed');
  assert.equal(backend.managed.size, 0);
});

test('onEvent(workflow.settled) 监听：停用自动解除；回调计入在途任务保护；每 run 只触发一次', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let settledRuns: string[] = [];
  await host.register({
    id: 'p:wf',
    definePlugin: (ctx) => {
      void ctx.host.onEvent('workflow.settled', async (raw) => {
        const run = raw as WorkflowRunSummary;
        await new Promise((r) => setTimeout(r, 10));
        settledRuns.push(run.id);
      });
    },
  });
  assert.equal(backend.workflowListeners.size, 1);

  const makeRun = (id: string): WorkflowRunSummary => ({
    id,
    name: 'demo',
    conversationId: 1,
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
  });

  // 正常触发（监听是后端集合：直接调用即可）
  for (const listener of backend.workflowListeners) await listener(makeRun('wf_a'));
  assert.deepEqual(settledRuns, ['wf_a']);

  // 回调在途期间 disable 被拒（plugin_has_live_tasks）
  const firing = (async () => {
    for (const listener of backend.workflowListeners) await listener(makeRun('wf_b'));
  })();
  await new Promise((r) => setTimeout(r, 3));
  await rejectsCode(host.disable('p:wf'), 'plugin_has_live_tasks');
  await firing;
  assert.deepEqual(settledRuns, ['wf_a', 'wf_b']);

  // 停用自动解除监听
  await host.disable('p:wf');
  assert.equal(backend.workflowListeners.size, 0);
  settledRuns = [];
});

test('registerAskSeqResolver 停用自动解除；旧周期 ctx 的宿主资源获取被 epoch 守卫拒绝', { timeout: 60_000 }, async () => {
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

  // 旧周期句柄：获取宿主生命周期资源即刻失效（409 plugin_context_expired）
  throwsCode(() => stolenHost!.manageConversation(1), 'plugin_context_expired');
  throwsCode(() => stolenHost!.onEvent('workflow.settled', () => {}), 'plugin_context_expired');
  throwsCode(() => stolenHost!.registerAskSeqResolver(() => undefined), 'plugin_context_expired');
});

test('ctx.host 包装层转发新端口：updateConversation / markConversationOwnership / createAsk 三态', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const marked: Array<{ id: number; owner: string }> = [];
  const origMark = backend.markConversationOwnership.bind(backend);
  backend.markConversationOwnership = (id: number, owner: 'helm' | 'bot' | 'human') => {
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
        title: '确认',
        fields: [{ name: 'ok', label: 'OK', type: 'confirm' }],
      });
    },
  });
  assert.equal(host.list().length, 1);
  assert.deepEqual(marked, [{ id: 5, owner: 'bot' }]);
});

// ---------------------------------------------------------------------------
// 5. 相对路由契约（新：只收相对路径）
// ---------------------------------------------------------------------------

test('相对路由：宿主拼接命名空间，listRoutes 输出完整挂载路径', { timeout: 60_000 }, async () => {
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

  // 完整 /api 前缀、点段逃逸、编码逃逸一律拒绝
  await rejectsCode(
    host.register({
      id: 'p:evil',
      definePlugin: (ctx) => {
        ctx.route({ method: 'GET', path: '/api/plugins/p%3Aevil/routes/x', handler: () => new Response('x') });
      },
    }),
    'invalid_route_path',
  );
  await rejectsCode(
    host.register({
      id: 'p:evil2',
      definePlugin: (ctx) => {
        ctx.route({ method: 'GET', path: '/%2e%2e/other', handler: () => new Response('x') });
      },
    }),
    'invalid_route_path',
  );
  // 非法百分号编码（%zz）注册边界即拒
  await rejectsCode(
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
