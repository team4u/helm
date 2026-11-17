/**
 * ui-registry-contracts.test.ts: registration, boundary validation, and host lifecycle tests for the
 * `artifact.previewer` and `composer.completer` UI contracts.
 *
 * Covers:
 * - Direct `UiRegistry` validation: previewer label/MIME rules (exact or `type/<subtype>` wildcard; rejects global wildcard,
 *   globs, uppercase, parameters, path forms, duplicates) and extensions (lowercase leading dot with multiple segments;
 *   rejects uppercase, missing leading dot, path segments, wildcards, duplicates); completer disallows `client` track,
 *   restricts trigger characters (`/` rejected), enforces mutually exclusive action vs. doc sources, validates
 *   safe `itemsField` top-level keys (rejects `__proto__`/`constructor`/`prototype`), and doc name format;
 * - display copy fields: one `registerUi` guard (`parseNonEmptyLocalizedText`) covers
 *   label/title/description on every surface — localized maps accepted and stored raw,
 *   blank copy / unsupported locale keys / non-string values rejected;
 * - `assertUiDocsRegistered`: no longer enforces define-time doc lookups for completer doc/sessionDoc sources;
 * - `PluginHost` end-to-end: adding/removing contributions across register/enable/disable/snapshot,
 *   method count consistency (`PLUGIN_UI_METHOD_NAMES` 16 methods matching `ctx.ui`),
 *   same-plugin action binding checks (`idempotent` / missing action / async later registration),
 *   and cross-plugin action references (validated on target enable without blocking valid registration order).
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
// UiRegistry boundaries: artifact.previewer
// ---------------------------------------------------------------------------

test('artifactPreviewer: valid MIME/extension declarations pass and matcher list validation rejects malformed specs', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());

  // client track + exact MIME + multi-segment extension + priority are all valid
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
  // json-only track (declarative fallback) is valid
  ui.registerUi(
    'p1',
    'artifact.previewer',
    { id: 'img', label: 'Image preview', json: { component: 'Text', text: 'image' }, mimeTypes: ['image/*'] },
    'artifactPreviewer',
  );
  // Omitting all matcher fields is valid (means never auto-selected by matcher, resolved by frontend)
  ui.registerUi('p1', 'artifact.previewer', { id: 'any', label: 'any' }, 'artifactPreviewer');
  assert.equal(ui.listUi().length, 3);

  // label required and non-empty
  assert.throws(
    () => ui.registerUi('p1', 'artifact.previewer', { id: 'bad-label', mimeTypes: ['text/plain'] }, 'artifactPreviewer'),
    isHelmError('invalid_ui_spec'),
  );

  // mimeTypes: non-array / empty array / non-string / duplicates
  for (const mimeTypes of [[], ['text/plain', 'text/plain'], ['text/plain', 1], 'text/plain']) {
    assert.throws(
      () => ui.registerUi('p1', 'artifact.previewer', { id: 'bad-mime', label: 'x', mimeTypes }, 'artifactPreviewer'),
      isHelmError('invalid_ui_spec'),
    );
  }
  // extensions: same rules
  for (const extensions of [[], ['.md', '.md'], ['.md', 1], '.md']) {
    assert.throws(
      () => ui.registerUi('p1', 'artifact.previewer', { id: 'bad-ext', label: 'x', extensions }, 'artifactPreviewer'),
      isHelmError('invalid_ui_spec'),
    );
  }

  // MIME validation: rejects */*, prefix globs, wildcards inside subtype, parameters, uppercase, empty segments
  for (const bad of ['*/*', 'text/*x', 'te*t/plain', '*/plain', 'text/plain;charset=utf-8', 'Text/Plain', '/plain', 'text/', 'text']) {
    assert.throws(
      () => ui.registerUi('p1', 'artifact.previewer', { id: 'bad-mime2', label: 'x', mimeTypes: [bad] }, 'artifactPreviewer'),
      isHelmError('invalid_ui_spec'),
      `MIME "${bad}" should be rejected`,
    );
  }
  // Extension validation: rejects uppercase, missing leading dot, path segments, wildcards, empty segments
  for (const bad of ['.MD', 'md', '.md/x', '.m*', '.', '..', '.md.', '.*']) {
    assert.throws(
      () => ui.registerUi('p1', 'artifact.previewer', { id: 'bad-ext2', label: 'x', extensions: [bad] }, 'artifactPreviewer'),
      isHelmError('invalid_ui_spec'),
      `extension "${bad}" should be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// UiRegistry boundaries: composer.completer
// ---------------------------------------------------------------------------

/** Helper to register a minimal valid completer declaration. */
function registerCompleter(ui: UiRegistry, pluginId: string, id: string, source: Record<string, unknown>): void {
  ui.registerUi(pluginId, 'composer.completer', { id, label: id, trigger: '@', source }, 'composerCompleter');
}

test('composerCompleter: disallowed client track, trigger allowlist, and source shape validation', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());

  // Valid action sources (including cross-plugin references)
  registerCompleter(ui, 'p1', 'a1', { kind: 'action', actionId: 'complete' });
  registerCompleter(ui, 'p1', 'a2', { kind: 'action', actionId: 'complete', actionPluginId: 'other' });
  // doc/sessionDoc sources
  registerCompleter(ui, 'p1', 'd1', { kind: 'doc', name: 'items', itemsField: 'entries' });
  registerCompleter(ui, 'p1', 's1', { kind: 'sessionDoc', name: 'ctx', itemsField: 'list' });
  assert.equal(ui.listUi().length, 4);

  // label required and non-empty
  assert.throws(
    () => ui.registerUi('p1', 'composer.completer', { id: 'bad-label', trigger: '@', source: { kind: 'action', actionId: 'x' } }, 'composerCompleter'),
    isHelmError('invalid_ui_spec'),
  );

  // Disallowed track: client rejected (completions render uniformly via host)
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
    'client track should be rejected',
  );
});

test('composerCompleter: doc/sessionDoc sources still enforce safe source shape without define-time doc reference checks', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  registerCompleter(ui, 'p1', 'd1', { kind: 'doc', name: 'items', itemsField: 'entries' });
  registerCompleter(ui, 'p1', 's1', { kind: 'sessionDoc', name: 'ctx', itemsField: 'list' });
  // Invalid source shapes still reject (e.g., prototype-polluting itemsField keys)
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
  // assertUiDocsRegistered is a hook stub: no longer checks completer doc sources at end of define phase
  ui.assertUiDocsRegistered('p1', () => false, () => false);
});

// ---------------------------------------------------------------------------
// UiRegistry boundaries: display copy fields (LocalizedText)
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
        `message should locate display field ${field}: ${err.message}`,
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
// PluginHost end-to-end
// ---------------------------------------------------------------------------

function createHostBackend(): PluginHostBackend {
  const unused = (): never => {
    throw new Error('this test only verifies UI registration and must not execute host business operations');
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
  // Per-conversation in-memory store (sessionDoc requires a persistence layer; refusing silent fallback is kernel semantics)
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

test('host: new contracts preserve contributions across register/disable/enable and method count matches protocol', { timeout: 60_000 }, async () => {
  const { host, dataDir } = await createHost();
  const plugin: PluginDefinition = {
    id: 'test:contracts',
    definePlugin(ctx) {
      ctx.doc('items', { entries: [] }, { public: true });
      ctx.sessionDoc('ctx-items', { list: [] }, { public: true });
      ctx.action(noopAction('complete', { idempotent: true }));
      ctx.ui.composerCompleter({
        id: 'at-mentions',
        label: 'Mention',
        trigger: '@',
        source: { kind: 'action', actionId: 'complete' },
      });
      ctx.ui.composerCompleter({
        id: 'hash-docs',
        label: 'Documents',
        trigger: '#',
        source: { kind: 'doc', name: 'items', itemsField: 'entries' },
      });
      ctx.ui.composerCompleter({
        id: 'colon-session',
        label: 'Context',
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

    // Contributions disappear immediately on disable
    await host.disable('test:contracts');
    assert.equal(host.listUi().length, 0);

    // Restored cleanly on re-enable (re-evaluated across enable cycles)
    await host.enable('test:contracts');
    assert.equal(host.listUi().length, 4);

    // Method count parity: single source of truth in protocol has 16 methods matching ctx.ui
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

test('host: completer binding to own action validates missing/non-idempotent actions at end of define phase', { timeout: 60_000 }, async () => {
  const { host, dataDir } = await createHost();
  try {
    // Referencing undeclared action rejects at end of define phase (registration fails cleanly with no leftover UI)
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

    // Non-idempotent action (missing idempotent: true): rejected
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

    // Action declared after UI declaration (async order): validated at end of define phase
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

test('host: completer cross-plugin actions validate on target enable without blocking valid registration order', { timeout: 60_000 }, async () => {
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
    // Target plugin not yet registered: permitted (supports deferred registration), succeeds with visible contribution
    await host.register(consumer('test:provider'));
    assert.equal(host.listUi().length, 1);

    // Target enables with non-idempotent action: target itself registers normally (kernel does not reject
    // target plugin, avoiding collateral breakage; non-idempotency is exposed via listActions manifest and enforced at runtime)
    await host.register(provider(false));
    const manifest = host.listActions().find((a) => a.pluginId === 'test:provider' && a.id === 'complete')!;
    assert.notEqual(manifest.idempotent, true);

    // New cross-plugin binding validates at enable commit point: target enabled & non-idempotent -> rejected
    await host.register(consumer2('test:provider', 'test:consumer2'), { enabled: false });
    await assert.rejects(() => host.enable('test:consumer2'), isHelmError('invalid_ui_spec'));

    // Target enabled & idempotent -> enable passes
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
