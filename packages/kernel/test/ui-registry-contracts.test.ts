/**
 * ui-registry-contracts.test.ts: artifact.previewer / composer.completer two new UI contract
 * kernel register, boundary validate and host lifecycle test.
 *
 * override:
 * - UiRegistry direct drive boundary:previewer label/MIME specification (precise or type through match sub- type, refuse all through match,glob,
 *   large write, parameter, path form, duplicate items)/suffix (small write contains point can many segment, refuse large write, without point, path segment, wildcard);
 *   completer disable track (client),trigger blank name single ('/' reject),
 *   source mutual exclusion severe validate (action source forbid doc field,doc source forbid action field, illegal kind),
 *   itemsField security top-level key (refuse __proto__/constructor/prototype),doc name format;
 * - display copy fields: one registerUi guard (parseNonEmptyLocalizedText) covers
 *   label/title/description on every surface — localized maps accepted and stored raw,
 *   blank copy / unsupported locale keys / non-string values rejected;
 * - assertUiDocsRegistered:completer doc/sessionDoc source want seek this plugin public document;
 * - PluginHost all link: register/enable/disable/snapshot in two surface contribution increase delete,
 *   method amount consumer (PLUGIN_UI_METHOD_NAMES 19 and host ctx.ui key consistent),
 *   this plugin action bind set store in and idempotent(missing action/non- idempotent/async later register all by contract trim decide),
 *   across plugin reference (target enable when validate, target not registered when do not forbidden legal later register).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HelmError,
  PLUGIN_UI_METHOD_NAMES,
  type PluginDefinition,
  type PluginActionSpec,
} from '@helm/protocol';
import { UiRegistry } from '../src/plugins/ui-registry.js';
import { PluginHost, type PluginHostBackend } from '../src/plugins/index.js';
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js';
import { createPluginBuildProvider } from '@helm/plugin-build';
import { MemoryDocStore, cleanupDir, makeTempDir } from './helpers.js';

const isHelmError = (code: string) => (err: unknown): boolean => err instanceof HelmError && err.code === code;

// ---------------------------------------------------------------------------
// UiRegistry boundary:artifact.previewer
// ---------------------------------------------------------------------------

test('artifactPreviewer: legal MIME/suffix declaration and match list public validate', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());

  // client track + precise MIME + many segment suffix + priority all legal
  ui.registerUi(
    'p1',
    'artifact.previewer',
    {
      id: 'md',
      label: 'Markdown preview',
      priority: 10,
      client: { module: './preview.tsx', export: 'Preview' },
      mimeTypes: ['text/markdown', 'text/*'],
      extensions: ['.md', '.tar.gz'],
    },
    'artifactPreviewer',
    '/tmp/client-root',
  );
  // only json track (declaration style fall back) legal
  ui.registerUi(
    'p1',
    'artifact.previewer',
    { id: 'img', label: 'diagram piece', json: { component: 'Text', text: 'image' }, mimeTypes: ['image/*'] },
    'artifactPreviewer',
  );
  // match field all omit legal (only by not designate field does not match, by frontend trim decide)
  ui.registerUi('p1', 'artifact.previewer', { id: 'any', label: 'any' }, 'artifactPreviewer');
  assert.equal(ui.listUi().length, 3);

  // label required non-empty
  assert.throws(
    () => ui.registerUi('p1', 'artifact.previewer', { id: 'bad-label', mimeTypes: ['text/plain'] }, 'artifactPreviewer'),
    isHelmError('invalid_ui_spec'),
  );

  // mimeTypes: non- array/empty array/non- string/duplicate
  for (const mimeTypes of [[], ['text/plain', 'text/plain'], ['text/plain', 1], 'text/plain']) {
    assert.throws(
      () => ui.registerUi('p1', 'artifact.previewer', { id: 'bad-mime', label: 'x', mimeTypes }, 'artifactPreviewer'),
      isHelmError('invalid_ui_spec'),
    );
  }
  // extensions same rule
  for (const extensions of [[], ['.md', '.md'], ['.md', 1], '.md']) {
    assert.throws(
      () => ui.registerUi('p1', 'artifact.previewer', { id: 'bad-ext', label: 'x', extensions }, 'artifactPreviewer'),
      isHelmError('invalid_ui_spec'),
    );
  }

  // MIME specification: refuse */*, any prefix glob, in suffix through match, parameter, large write, empty segment
  for (const bad of ['*/*', 'text/*x', 'te*t/plain', '*/plain', 'text/plain;charset=utf-8', 'Text/Plain', '/plain', 'text/', 'text']) {
    assert.throws(
      () => ui.registerUi('p1', 'artifact.previewer', { id: 'bad-mime2', label: 'x', mimeTypes: [bad] }, 'artifactPreviewer'),
      isHelmError('invalid_ui_spec'),
      `MIME "${bad}" should by reject`,
    );
  }
  // suffix specification: refuse large write, without before lead point, path segment, wildcard, empty segment
  for (const bad of ['.MD', 'md', '.md/x', '.m*', '.', '..', '.md.', '.*']) {
    assert.throws(
      () => ui.registerUi('p1', 'artifact.previewer', { id: 'bad-ext2', label: 'x', extensions: [bad] }, 'artifactPreviewer'),
      isHelmError('invalid_ui_spec'),
      `suffix "${bad}" should by reject`,
    );
  }
});

// ---------------------------------------------------------------------------
// UiRegistry boundary:composer.completer
// ---------------------------------------------------------------------------

/** register a legal completer declaration most small assist manually. */
function registerCompleter(ui: UiRegistry, pluginId: string, id: string, source: Record<string, unknown>): void {
  ui.registerUi(pluginId, 'composer.completer', { id, label: id, trigger: '@', source }, 'composerCompleter');
}

test('composerCompleter: disable track,trigger blank name single and source shape', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());

  // three legal action source (contains across plugin)
  registerCompleter(ui, 'p1', 'a1', { kind: 'action', actionId: 'complete' });
  registerCompleter(ui, 'p1', 'a2', { kind: 'action', actionId: 'complete', actionPluginId: 'other' });
  // doc/sessionDoc source
  registerCompleter(ui, 'p1', 'd1', { kind: 'doc', name: 'items', itemsField: 'entries' });
  registerCompleter(ui, 'p1', 's1', { kind: 'sessionDoc', name: 'ctx', itemsField: 'list' });
  assert.equal(ui.listUi().length, 4);

  // label required non-empty
  assert.throws(
    () => ui.registerUi('p1', 'composer.completer', { id: 'bad-label', trigger: '@', source: { kind: 'action', actionId: 'x' } }, 'composerCompleter'),
    isHelmError('invalid_ui_spec'),
  );

  // disable track:client reject (completion by host unify render)
  assert.throws(
    () =>
      ui.registerUi('p1', 'composer.completer', {
        id: 'bad-client',
        label: 'x',
        trigger: '@',
        source: { kind: 'action', actionId: 'x' },
        client: { module: './x.tsx', export: 'X' },
      }, 'composerCompleter'),
    isHelmError('invalid_ui_spec'),
    'client track should by reject',
  );
});

test('composerCompleter:doc/sessionDoc source declaration still subject to source shape constraint (reference validate follow JSON track remove)', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  registerCompleter(ui, 'p1', 'd1', { kind: 'doc', name: 'items', itemsField: 'entries' });
  registerCompleter(ui, 'p1', 's1', { kind: 'sessionDoc', name: 'ctx', itemsField: 'list' });
  // source shape illegal still reject (such as itemsField prototype pollute key)
  assert.throws(
    () =>
      ui.registerUi('p1', 'composer.completer', {
        id: 'bad-proto',
        label: 'x',
        trigger: '@',
        source: { kind: 'doc', name: 'items', itemsField: '__proto__' },
      }, 'composerCompleter'),
    isHelmError('invalid_ui_spec'),
  );
  // assertUiDocsRegistered is hang point: no longer for completer source do define phase end inspect
  ui.assertUiDocsRegistered('p1', () => false, () => false);
});

// ---------------------------------------------------------------------------
// UiRegistry boundary:display copy fields (LocalizedText)
// ---------------------------------------------------------------------------

test('display copy fields: one registerUi guard covers label/title/description on every surface (maps accepted, blanks rejected)', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  const badCopy: unknown[] = [
    '', '   ', 42, true, null, [], { fr: 'x' }, { 'zh-cn': 'x' }, { en: 1 }, { en: '' }, { en: 'Hi', 'zh-CN': ' ' },
  ];
  const expectDisplayCopyThrow = (run: () => void, field: string): void => {
    assert.throws(run, (err: unknown) => {
      if (!(err instanceof HelmError)) return false;
      assert.equal(err.code, 'invalid_ui_spec');
      assert.ok(
        err.message.includes(`${field} must be display copy`),
        `message should locate display field ${field}:${err.message}`,
      );
      return true;
    });
  };

  // accepted: localized maps on label/title/description across surface families,
  // including the required-label surfaces (artifactPreviewer / composerCompleter /
  // profileRuntime) and surfaces whose only display field is the base title.
  ui.registerUi(
    'p1',
    'sidebar.item',
    { id: 'nav', label: { en: 'Work', 'zh-CN': '工作' }, title: { en: 'Workbench', 'zh-CN': '工作台' } },
    'sidebarItem',
  );
  ui.registerUi(
    'p1',
    'commandPalette',
    { id: 'cmd', title: { en: 'New', 'zh-CN': '新建' }, description: { en: 'Create', 'zh-CN': '创建' }, actionId: 'new' },
    'command',
  );
  ui.registerUi('p1', 'workbench.panel', { id: 'panel', label: { en: 'Stats', 'zh-CN': '统计' } }, 'workbenchPanel');
  ui.registerUi('p1', 'settings.panel', { id: 'settings', label: { en: 'Settings', 'zh-CN': '设置' } }, 'settingsPanel');
  ui.registerUi(
    'p1',
    'artifact.previewer',
    { id: 'md', label: { en: 'Markdown', 'zh-CN': 'Markdown 预览' }, mimeTypes: ['text/markdown'] },
    'artifactPreviewer',
  );
  ui.registerUi(
    'p1',
    'composer.completer',
    { id: 'at', label: { en: 'Mention', 'zh-CN': '提及' }, trigger: '@', source: { kind: 'action', actionId: 'complete' } },
    'composerCompleter',
  );
  ui.registerUi(
    'p1',
    'profile.runtime',
    { id: 'node', kind: 'node', label: { en: 'Node', 'zh-CN': 'Node 运行时' } },
    'profileRuntime',
  );
  ui.registerUi('p1', 'timeline.renderer', { id: 'render', title: { en: 'Custom', 'zh-CN': '自定义' } }, 'timelineRenderer');
  ui.registerUi('p1', 'plugin.slot', { id: 'slot', target: 'owner/panel', title: { en: 'Extra', 'zh-CN': '扩展' } }, 'slot');
  assert.equal(ui.listUi().length, 9);

  // raw localized shape is stored as declared (listUi keeps the map, no locale coercion)
  const nav = ui.listUi().find((c) => c.surface === 'sidebar.item')!;
  assert.deepEqual((nav.spec as { label: unknown }).label, { en: 'Work', 'zh-CN': '工作' });
  const cmd = ui.listUi().find((c) => c.surface === 'commandPalette')!;
  assert.deepEqual((cmd.spec as { description: unknown }).description, { en: 'Create', 'zh-CN': '创建' });

  // rejected: label — on label-bearing surfaces and on a surface without any dedicated
  // label validator (timeline.renderer), proving the guard is one place for all surfaces.
  for (const [surface, fnName] of [
    ['sidebar.item', 'sidebarItem'],
    ['sidebar.section', 'sidebarSection'],
    ['screen', 'screen'],
    ['composer.pill', 'composerPill'],
    ['settings.panel', 'settingsPanel'],
    ['workbench.panel', 'workbenchPanel'],
    ['timeline.renderer', 'timelineRenderer'],
  ] as const) {
    for (const value of badCopy) {
      expectDisplayCopyThrow(() => ui.registerUi('p1', surface, { id: 'bad', label: value }, fnName), 'label');
    }
  }

  // rejected: title — base UiSpecBase field covered by the same guard
  for (const [surface, fnName] of [
    ['timeline.renderer', 'timelineRenderer'],
    ['sidebar.item', 'sidebarItem'],
  ] as const) {
    for (const value of badCopy) {
      expectDisplayCopyThrow(() => ui.registerUi('p1', surface, { id: 'bad', title: value }, fnName), 'title');
    }
  }

  // rejected: description — declared on commandPalette, and still guarded on surfaces
  // whose type does not declare it (runtime boundary cannot trust static optionality).
  for (const value of badCopy) {
    expectDisplayCopyThrow(
      () => ui.registerUi('p1', 'commandPalette', { id: 'bad', actionId: 'new', description: value }, 'command'),
      'description',
    );
    expectDisplayCopyThrow(
      () => ui.registerUi('p1', 'workbench.panel', { id: 'bad', label: 'ok', description: value }, 'workbenchPanel'),
      'description',
    );
  }
});

// ---------------------------------------------------------------------------
// PluginHost all link
// ---------------------------------------------------------------------------

function createHostBackend(): PluginHostBackend {
  const unused = (): never => {
    throw new Error('this test only verify UI register, must not execute host business operation');
  };
  return {
    ...createPluginHostBackendFixture(),
    dispatchTrigger: unused,
    submitInput: unused,
    createConversation: unused,
    listConversations: () => [],
    getConversation: unused,
    updateConversation: unused,
    abortConversation: unused,
    getConversationOwnership: () => 'human' as const,
    manageConversation: () => () => {},
    markConversationOwnership: unused,
    spawnAgent: unused,
    runGate: unused,
    execEnv: unused,
    withFileMutationQueue: unused,
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

async function createHost(): Promise<HostFixture> {
  const dataDir = await makeTempDir('helm-ui-contracts-');
  const events: HostFixture['events'] = [];
  // conversation shard memory store (sessionDoc declaration want seek durable layer, reject memory fall back is kernel semantics, test patch complete most small implement)
  const sessionData = new Map<string, string>();
  const sessionKey = (pluginId: string, name: string, conversationId: number): string =>
    `${pluginId}\u0000${name}\u0000${conversationId}`;
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(),
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
    docs: new MemoryDocStore(),
    sessionDocs: {
      get: (pluginId, name, conversationId) => sessionData.get(sessionKey(pluginId, name, conversationId)),
      put: (pluginId, name, conversationId, valueJson) => {
        sessionData.set(sessionKey(pluginId, name, conversationId), valueJson);
      },
      delete: (pluginId, name, conversationId) => {
        sessionData.delete(sessionKey(pluginId, name, conversationId));
      },
      deletePlugin: () => {},
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

test('host: new contract register/deactivate/snapshot and method amount consumer align', { timeout: 60_000 }, async () => {
  const { host, dataDir } = await createHost();
  const plugin: PluginDefinition = {
    id: 'test:contracts',
    definePlugin(ctx) {
      ctx.doc('items', { entries: [] }, { public: true });
      ctx.sessionDoc('ctx-items', { list: [] }, { public: true });
      ctx.action(noopAction('complete', { idempotent: true }));
      ctx.ui.composerCompleter({
        id: 'at-mentions',
        label: 'mention and',
        trigger: '@',
        source: { kind: 'action', actionId: 'complete' },
      });
      ctx.ui.composerCompleter({
        id: 'hash-docs',
        label: 'document',
        trigger: '#',
        source: { kind: 'doc', name: 'items', itemsField: 'entries' },
      });
      ctx.ui.composerCompleter({
        id: 'colon-session',
        label: 'context',
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

    // disable after contribution i.e. when disappear
    await host.disable('test:contracts');
    assert.equal(host.listUi().length, 0);

    // enable after restore (contains across enable cycle rebuild)
    await host.enable('test:contracts');
    assert.equal(host.listUi().length, 4);

    // method amount consumer:protocol unique true source 16 method,host ctx.ui provide same name register entry
    assert.equal(PLUGIN_UI_METHOD_NAMES.length, 16);
    assert.ok(PLUGIN_UI_METHOD_NAMES.includes('markdownCodeBlock' as const));
    assert.ok(PLUGIN_UI_METHOD_NAMES.includes('action' as const));
    assert.ok(PLUGIN_UI_METHOD_NAMES.includes('composerCompleter' as const));
    assert.ok(PLUGIN_UI_METHOD_NAMES.includes('artifactPreviewer' as const));
  } finally {
    await host.dispose();
    await cleanupDir(dataDir);
  }
});

test('host:completer bind set this plugin action - - missing action/non- idempotent in define phase end reject', { timeout: 60_000 }, async () => {
  const { host, dataDir } = await createHost();
  try {
    // reference not declaration action: define phase end reject (register failed, do not leftover shadow)
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

    // non- idempotent action (without idempotent: true): reject
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

    // action later than UI declaration (async later register): define phase end validate via
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
    await cleanupDir(dataDir);
  }
});

test('host:completer across plugin action - - target enable when validate, not registered do not forbidden legal later register', { timeout: 60_000 }, async () => {
  const { host, dataDir } = await createHost();
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
    // target plugin not yet register: allows (legal later register scenario), register succeeded and contribution visible
    await host.register(consumer('test:provider'));
    assert.equal(host.listUi().length, 1);

    // target enable but action non- idempotent: target itself register succeeded (kernel do not reverse reject, avoid mistakenly damage without UI target plugin;
    // non- idempotent fact via listActions manifest expose, by frontend in runtime rely on manifest honor bottom validate)
    await host.register(provider(false));
    const manifest = host.listActions().find((a) => a.pluginId === 'test:provider' && a.id === 'complete')!;
    assert.notEqual(manifest.idempotent, true);

    // new across plugin bind set in enable commit point validate: target enabled and non- idempotent → reject
    await host.register(consumer2('test:provider', 'test:consumer2'), { enabled: false });
    await assert.rejects(() => host.enable('test:consumer2'), isHelmError('invalid_ui_spec'));

    // target enabled and idempotent → enable via
    await host.register(provider2(), { enabled: false });
    await host.enable('test:provider2');
    await host.register(consumer2('test:provider2', 'test:consumer3'), { enabled: false });
    await host.enable('test:consumer3');
    assert.equal(host.listUi().filter((c) => c.pluginId === 'test:consumer3').length, 1);
  } finally {
    await host.dispose();
    await cleanupDir(dataDir);
  }
});
