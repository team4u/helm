/**
 * ui-registry-contracts.test.ts: artifact.previewer / composer.completer 两个新 UI 契约
 * 的内核注册、边界校验与宿主生命周期测试。
 *
 * 覆盖：
 * - UiRegistry 直驱边界：previewer label/MIME 规范（精确或 type 通配子类型，拒全通配、glob、
 *   大写、参数、路径形态、重复项）/后缀（小写含点可多段，拒大写、无点、路径段、通配符）；
 *   completer 禁用轨（client/json/docs/sessionDocs）、trigger 白名单（'/' 拒绝）、
 *   source 互斥严校验（action 源禁 doc 字段、doc 源禁 action 字段、非法 kind）、
 *   itemsField 安全顶层键（拒 __proto__/constructor/prototype）、doc 名格式；
 * - assertUiDocsRegistered：completer doc/sessionDoc 源要求本插件公开文档；
 * - PluginHost 全链路：注册/enable/disable/snapshot 中两 surface 的贡献增删、
 *   方法数量消费者（PLUGIN_UI_METHOD_NAMES 19 个与 host ctx.ui 键一致）、
 *   本插件动作绑定存在且 idempotent（缺动作/非幂等/异步稍后注册均按契约裁决）、
 *   跨插件引用（目标启用时校验、目标未注册时不禁止合法稍后注册）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HelmError,
  PLUGIN_UI_METHOD_NAMES,
  type PluginDefinition,
  type PluginActionSpec,
} from '@helm/protocol';
import { UiRegistry } from '../src/plugins/ui-registry.js';
import { PluginHost, type PluginHostBackend } from '../src/plugins/index.js';

const isHelmError = (code: string) => (err: unknown): boolean => err instanceof HelmError && err.code === code;

// ---------------------------------------------------------------------------
// UiRegistry 边界：artifact.previewer
// ---------------------------------------------------------------------------

test('artifactPreviewer：合法 MIME/后缀声明与匹配列表公共校验', { timeout: 60_000 }, () => {
  const ui = new UiRegistry();

  // client 轨 + 精确 MIME + 多段后缀 + priority 均合法
  ui.registerUi(
    'p1',
    'artifact.previewer',
    {
      id: 'md',
      label: 'Markdown 预览',
      priority: 10,
      client: { module: './preview.tsx', export: 'Preview' },
      mimeTypes: ['text/markdown', 'text/*'],
      extensions: ['.md', '.tar.gz'],
    },
    'artifactPreviewer',
    '/tmp/client-root',
  );
  // 仅 json 轨（声明式降级）合法
  ui.registerUi(
    'p1',
    'artifact.previewer',
    { id: 'img', label: '图片', json: { component: 'Text', text: 'image' }, mimeTypes: ['image/*'] },
    'artifactPreviewer',
  );
  // 匹配字段全省略合法（仅按未指定字段不匹配，由前端裁决）
  ui.registerUi('p1', 'artifact.previewer', { id: 'any', label: '任意' }, 'artifactPreviewer');
  assert.equal(ui.listUi().length, 3);

  // label 必填非空
  assert.throws(
    () => ui.registerUi('p1', 'artifact.previewer', { id: 'bad-label', mimeTypes: ['text/plain'] }, 'artifactPreviewer'),
    isHelmError('invalid_ui_spec'),
  );

  // mimeTypes：非数组/空数组/非字符串/重复
  for (const mimeTypes of [[], ['text/plain', 'text/plain'], ['text/plain', 1], 'text/plain']) {
    assert.throws(
      () => ui.registerUi('p1', 'artifact.previewer', { id: 'bad-mime', label: 'x', mimeTypes }, 'artifactPreviewer'),
      isHelmError('invalid_ui_spec'),
    );
  }
  // extensions 同规则
  for (const extensions of [[], ['.md', '.md'], ['.md', 1], '.md']) {
    assert.throws(
      () => ui.registerUi('p1', 'artifact.previewer', { id: 'bad-ext', label: 'x', extensions }, 'artifactPreviewer'),
      isHelmError('invalid_ui_spec'),
    );
  }

  // MIME 规范：拒 */*、任意前缀 glob、中缀通配、参数、大写、空段
  for (const bad of ['*/*', 'text/*x', 'te*t/plain', '*/plain', 'text/plain;charset=utf-8', 'Text/Plain', '/plain', 'text/', 'text']) {
    assert.throws(
      () => ui.registerUi('p1', 'artifact.previewer', { id: 'bad-mime2', label: 'x', mimeTypes: [bad] }, 'artifactPreviewer'),
      isHelmError('invalid_ui_spec'),
      `MIME "${bad}" 应被拒绝`,
    );
  }
  // 后缀规范：拒大写、无前导点、路径段、通配符、空段
  for (const bad of ['.MD', 'md', '.md/x', '.m*', '.', '..', '.md.', '.*']) {
    assert.throws(
      () => ui.registerUi('p1', 'artifact.previewer', { id: 'bad-ext2', label: 'x', extensions: [bad] }, 'artifactPreviewer'),
      isHelmError('invalid_ui_spec'),
      `后缀 "${bad}" 应被拒绝`,
    );
  }
});

// ---------------------------------------------------------------------------
// UiRegistry 边界：composer.completer
// ---------------------------------------------------------------------------

/** 注册一个合法 completer 声明的最小助手。 */
function registerCompleter(ui: UiRegistry, pluginId: string, id: string, source: Record<string, unknown>): void {
  ui.registerUi(pluginId, 'composer.completer', { id, label: id, trigger: '@', source }, 'composerCompleter');
}

test('composerCompleter：禁用轨、trigger 白名单与 source 形状', { timeout: 60_000 }, () => {
  const ui = new UiRegistry();

  // 三种合法 action 源（含跨插件）
  registerCompleter(ui, 'p1', 'a1', { kind: 'action', actionId: 'complete' });
  registerCompleter(ui, 'p1', 'a2', { kind: 'action', actionId: 'complete', actionPluginId: 'other' });
  // doc/sessionDoc 源
  registerCompleter(ui, 'p1', 'd1', { kind: 'doc', name: 'items', itemsField: 'entries' });
  registerCompleter(ui, 'p1', 's1', { kind: 'sessionDoc', name: 'ctx', itemsField: 'list' });
  assert.equal(ui.listUi().length, 4);

  // label 必填非空
  assert.throws(
    () => ui.registerUi('p1', 'composer.completer', { id: 'bad-label', trigger: '@', source: { kind: 'action', actionId: 'x' } }, 'composerCompleter'),
    isHelmError('invalid_ui_spec'),
  );

  // 禁用轨：client/json/docs/sessionDocs 均拒绝（补全由宿主统一渲染）
  for (const field of ['client', 'json', 'docs', 'sessionDocs']) {
    const spec: Record<string, unknown> = {
      id: `bad-${field}`,
      label: 'x',
      trigger: '@',
      source: { kind: 'action', actionId: 'x' },
      [field]: field === 'client' ? { module: './x.tsx', export: 'X' } : field === 'json' ? { component: 'Text' } : ['doc'],
    };
    assert.throws(
      () => ui.registerUi('p1', 'composer.completer', spec, 'composerCompleter'),
      isHelmError('invalid_ui_spec'),
      `${field} 轨应被拒绝`,
    );
  }

  // trigger：'/' 保留给命令与技能；仅 @ # : 合法
  for (const bad of ['/', '$', 'at', '', undefined, null]) {
    const spec: Record<string, unknown> = { id: 'bad-trigger', label: 'x', source: { kind: 'action', actionId: 'x' } };
    if (bad !== undefined) spec.trigger = bad;
    assert.throws(
      () => ui.registerUi('p1', 'composer.completer', spec, 'composerCompleter'),
      isHelmError('invalid_ui_spec'),
      `trigger ${JSON.stringify(bad)} 应被拒绝`,
    );
  }
  for (const ok of ['@', '#', ':']) {
    ui.registerUi(
      'p1',
      'composer.completer',
      { id: `trigger-${ok}`, label: 'x', trigger: ok, source: { kind: 'action', actionId: 'x' } },
      'composerCompleter',
    );
  }

  // source 互斥严校验：action 源不得混入 doc 字段
  assert.throws(
    () => registerCompleter(ui, 'p1', 'mix1', { kind: 'action', actionId: 'x', name: 'items', itemsField: 'entries' }),
    isHelmError('invalid_ui_spec'),
  );
  // doc 源不得混入 action 字段
  assert.throws(
    () => registerCompleter(ui, 'p1', 'mix2', { kind: 'doc', name: 'items', itemsField: 'entries', actionId: 'x' }),
    isHelmError('invalid_ui_spec'),
  );
  assert.throws(
    () => registerCompleter(ui, 'p1', 'mix3', { kind: 'sessionDoc', name: 'items', itemsField: 'entries', actionPluginId: 'other' }),
    isHelmError('invalid_ui_spec'),
  );
  // 非法 kind / 缺 source
  assert.throws(
    () => registerCompleter(ui, 'p1', 'bad-kind', { kind: 'http', url: 'https://evil' }),
    isHelmError('invalid_ui_spec'),
  );
  assert.throws(
    () => ui.registerUi('p1', 'composer.completer', { id: 'no-source', label: 'x', trigger: '@' }, 'composerCompleter'),
    isHelmError('invalid_ui_spec'),
  );

  // actionId：空串/点号拒绝（跨插件走 actionPluginId）
  for (const bad of ['', 'x.y', 'a.b.c']) {
    assert.throws(
      () => registerCompleter(ui, 'p1', `bad-aid-${bad}`, { kind: 'action', actionId: bad }),
      isHelmError('invalid_ui_spec'),
    );
  }
  // actionPluginId 非空字符串
  assert.throws(
    () => registerCompleter(ui, 'p1', 'bad-apid', { kind: 'action', actionId: 'x', actionPluginId: '' }),
    isHelmError('invalid_ui_spec'),
  );

  // doc 名格式：非法字符/空串拒绝（与 docs/sessionDocs 列表同一命名约束）
  for (const bad of ['', 'a/b', 'a b']) {
    assert.throws(
      () => registerCompleter(ui, 'p1', `bad-name-${bad.length}`, { kind: 'doc', name: bad, itemsField: 'items' }),
      isHelmError('invalid_ui_spec'),
    );
  }
  // itemsField：原型污染键与非法字符拒绝（hasOwnProperty 是常规自有键名，不在拒结名单）
  for (const bad of ['__proto__', 'constructor', 'prototype', '', 'a/b', 'a.b']) {
    assert.throws(
      () => registerCompleter(ui, 'p1', `bad-field-${bad.length}`, { kind: 'doc', name: 'items', itemsField: bad }),
      isHelmError('invalid_ui_spec'),
      `itemsField "${bad}" 应被拒绝`,
    );
  }
});

test('composerCompleter：doc/sessionDoc 源经 assertUiDocsRegistered 要求公开文档', { timeout: 60_000 }, () => {
  const ui = new UiRegistry();
  registerCompleter(ui, 'p1', 'd1', { kind: 'doc', name: 'items', itemsField: 'entries' });
  registerCompleter(ui, 'p1', 's1', { kind: 'sessionDoc', name: 'ctx', itemsField: 'list' });

  // 均未公开：拒绝
  assert.throws(() => ui.assertUiDocsRegistered('p1', () => false, () => false), isHelmError('invalid_ui_spec'));
  // doc 源公开但 sessionDoc 源未公开：拒绝
  assert.throws(
    () => ui.assertUiDocsRegistered('p1', (n) => n === 'items', () => false),
    isHelmError('invalid_ui_spec'),
  );
  // 双公开：通过
  ui.assertUiDocsRegistered('p1', (n) => n === 'items', (n) => n === 'ctx');
});

// ---------------------------------------------------------------------------
// PluginHost 全链路
// ---------------------------------------------------------------------------

function createHostBackend(): PluginHostBackend {
  const unused = (): never => {
    throw new Error('本测试只验证 UI 注册，不应执行宿主业务操作');
  };
  return {
    dispatchTrigger: unused,
    submitInput: unused,
    createConversation: unused,
    listConversations: () => [],
    getConversation: unused,
    updateConversation: unused,
    abortConversation: unused,
    manageConversation: () => () => {},
    markConversationOwnership: unused,
    spawnAgent: unused,
    runGate: unused,
    prepareInterruptedConversations: unused,
    cleanupWorktree: unused,
    execEnv: unused,
    withFileMutationQueue: unused,
    prepareAction: unused,
    invokeAction: unused,
    listActions: () => [],
    createAsk: unused,
    cancelAsk: unused,
    registerAskSeqResolver: () => () => {},
    onEvent: () => () => {},
    emitEvent: () => {},
  };
}

interface HostFixture {
  host: PluginHost;
  dataDir: string;
  events: Array<{ type: string; pluginId: string; uiCount: number }>;
}

function createHost(): HostFixture {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ui-contracts-'));
  const events: HostFixture['events'] = [];
  // 会话分片内存存储（sessionDoc 声明要求持久层，拒绝内存降级是内核语义，测试补齐最小实现）
  const sessionData = new Map<string, string>();
  const sessionKey = (pluginId: string, name: string, conversationId: number): string =>
    `${pluginId}\u0000${name}\u0000${conversationId}`;
  const host = new PluginHost({
    dataDir,
    host: {
      ...createHostBackend(),
      emitEvent: (type: string, payload: unknown) => {
        if (type === 'plugin.changed') {
          const p = payload as { plugin: { id: string }; ui: unknown[] };
          events.push({ type, pluginId: p.plugin.id, uiCount: p.ui.length });
        }
      },
    },
    docs: {
      get: <T>(_key: string, initial: T): T => initial,
      set: () => {},
      flush: async () => {},
    },
    sessionDocs: {
      get: (pluginId, name, conversationId) => sessionData.get(sessionKey(pluginId, name, conversationId)),
      put: (pluginId, name, conversationId, valueJson) => {
        sessionData.set(sessionKey(pluginId, name, conversationId), valueJson);
      },
      delete: (pluginId, name, conversationId) => {
        sessionData.delete(sessionKey(pluginId, name, conversationId));
      },
      listConversationIds: () => [],
      flush: async () => {},
    },
    config: { get: () => ({}), set: () => {} },
  });
  return { host, dataDir, events };
}

const noopAction = (id: string, extra: Partial<PluginActionSpec<unknown, unknown>> = {}): PluginActionSpec<unknown, unknown> => ({
  id,
  description: id,
  inputSchema: { type: 'object', additionalProperties: false },
  outputSchema: { type: 'object', additionalProperties: false },
  handler: () => ({}),
  ...extra,
});

test('host：新契约注册/停用/snapshot 与方法数量消费者对齐', { timeout: 60_000 }, async () => {
  const { host, dataDir } = createHost();
  const plugin: PluginDefinition = {
    id: 'test:contracts',
    definePlugin(ctx) {
      ctx.doc('items', { entries: [] }, { public: true });
      ctx.sessionDoc('ctx-items', { list: [] }, { public: true });
      ctx.action(noopAction('complete', { idempotent: true }));
      ctx.ui.composerCompleter({
        id: 'at-mentions',
        label: '提及',
        trigger: '@',
        source: { kind: 'action', actionId: 'complete' },
      });
      ctx.ui.composerCompleter({
        id: 'hash-docs',
        label: '文档',
        trigger: '#',
        source: { kind: 'doc', name: 'items', itemsField: 'entries' },
      });
      ctx.ui.composerCompleter({
        id: 'colon-session',
        label: '上下文',
        trigger: ':',
        source: { kind: 'sessionDoc', name: 'ctx-items', itemsField: 'list' },
      });
      ctx.ui.artifactPreviewer({
        id: 'md',
        label: 'Markdown',
        mimeTypes: ['text/markdown', 'text/*'],
        extensions: ['.md', '.tar.gz'],
      });
    },
  };
  try {
    await host.register(plugin);
    const contributions = host.listUi();
    assert.equal(contributions.length, 4);
    assert.deepEqual(
      contributions.map((c) => c.surface).sort(),
      ['artifact.previewer', 'composer.completer', 'composer.completer', 'composer.completer'],
    );
    const previewer = contributions.find((c) => c.surface === 'artifact.previewer')!;
    assert.equal((previewer.spec as { label?: string }).label, 'Markdown');

    // disable 后贡献即时消失
    await host.disable('test:contracts');
    assert.equal(host.listUi().length, 0);

    // enable 后恢复（含跨启用周期重建）
    await host.enable('test:contracts');
    assert.equal(host.listUi().length, 4);

    // 方法数量消费者：protocol 唯一真源 17 个方法，host ctx.ui 提供同名注册入口
    assert.equal(PLUGIN_UI_METHOD_NAMES.length, 17);
    assert.ok(PLUGIN_UI_METHOD_NAMES.includes('composerCompleter' as const));
    assert.ok(PLUGIN_UI_METHOD_NAMES.includes('artifactPreviewer' as const));
  } finally {
    await host.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('host：completer 绑定本插件动作——缺动作/非幂等在定义期末拒绝', { timeout: 60_000 }, async () => {
  const { host, dataDir } = createHost();
  try {
    // 引用未声明动作：定义期末拒绝（注册失败，不留残影）
    const missing: PluginDefinition = {
      id: 'test:missing-action',
      definePlugin(ctx) {
        ctx.ui.composerCompleter({
          id: 'c1',
          label: 'c',
          trigger: '@',
          source: { kind: 'action', actionId: 'nope' },
        });
      },
    };
    await assert.rejects(() => host.register(missing), isHelmError('invalid_ui_spec'));
    assert.equal(host.listUi().length, 0);

    // 非幂等动作（无 idempotent: true）：拒绝
    const nonIdem: PluginDefinition = {
      id: 'test:non-idem',
      definePlugin(ctx) {
        ctx.action(noopAction('mutate'));
        ctx.ui.composerCompleter({
          id: 'c1',
          label: 'c',
          trigger: '@',
          source: { kind: 'action', actionId: 'mutate' },
        });
      },
    };
    await assert.rejects(() => host.register(nonIdem), isHelmError('invalid_ui_spec'));

    // 动作晚于 UI 声明（异步稍后注册）：定义期末校验通过
    const later: PluginDefinition = {
      id: 'test:later-action',
      definePlugin(ctx) {
        ctx.ui.composerCompleter({
          id: 'c1',
          label: 'c',
          trigger: '@',
          source: { kind: 'action', actionId: 'complete' },
        });
        ctx.action(noopAction('complete', { idempotent: true }));
      },
    };
    await host.register(later);
    assert.equal(host.listUi().length, 1);
  } finally {
    await host.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('host：completer 跨插件动作——目标启用时校验、未注册不禁止合法稍后注册', { timeout: 60_000 }, async () => {
  const { host, dataDir } = createHost();
  const consumer = (target?: string): PluginDefinition => ({
    id: 'test:consumer',
    definePlugin(ctx) {
      ctx.ui.composerCompleter({
        id: 'c1',
        label: 'c',
        trigger: '@',
        source: { kind: 'action', actionId: 'complete', ...(target ? { actionPluginId: target } : {}) },
      });
    },
  });
  const consumer2 = (target: string, pluginId: string): PluginDefinition => ({
    id: pluginId,
    definePlugin(ctx) {
      ctx.ui.composerCompleter({
        id: 'c1',
        label: 'c',
        trigger: '@',
        source: { kind: 'action', actionId: 'complete', actionPluginId: target },
      });
    },
  });
  const provider = (idempotent: boolean): PluginDefinition => ({
    id: 'test:provider',
    definePlugin(ctx) {
      ctx.action(noopAction('complete', { idempotent }));
    },
  });
  const provider2 = (): PluginDefinition => ({
    id: 'test:provider2',
    definePlugin(ctx) {
      ctx.action(noopAction('complete', { idempotent: true }));
    },
  });
  try {
    // 目标插件尚未注册：允许（合法的稍后注册场景），注册成功且贡献可见
    await host.register(consumer('test:provider'));
    assert.equal(host.listUi().length, 1);

    // 目标启用但动作非幂等：目标自身注册成功（内核不反向拒绝，避免误伤无 UI 的目标插件；
    // 非幂等事实经 listActions manifest 暴露，由前端在运行时凭 manifest 兑底校验）
    await host.register(provider(false));
    const manifest = host.listActions().find((a) => a.pluginId === 'test:provider' && a.id === 'complete')!;
    assert.notEqual(manifest.idempotent, true);

    // 新的跨插件绑定在启用提交点校验：目标已启用且非幂等 → 拒绝
    await host.register(consumer2('test:provider', 'test:consumer2'), { enabled: false });
    await assert.rejects(() => host.enable('test:consumer2'), isHelmError('invalid_ui_spec'));

    // 目标已启用且幂等 → 启用通过
    await host.register(provider2(), { enabled: false });
    await host.enable('test:provider2');
    await host.register(consumer2('test:provider2', 'test:consumer3'), { enabled: false });
    await host.enable('test:consumer3');
    assert.equal(host.listUi().filter((c) => c.pluginId === 'test:consumer3').length, 1);
  } finally {
    await host.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
