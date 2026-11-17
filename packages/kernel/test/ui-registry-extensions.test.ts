/**
 * ui-registry-extensions.test.ts: boundary tests for UiRegistry extension validation.
 *
 * Covers validation boundaries moved out of addUi (driving registry directly without PluginHost):
 * - sessionDocs list format and 3-arg assertUiDocsRegistered (session publicity check, default behavior);
 * - action tracks (at least one of actionId/client/json, field ownership for placement/kinds/roles);
 * - finite safe integers for priority/order;
 * - commandPalette slash format, reserved words, intra-plugin duplicates, and profile.runtime kind duplicates;
 * - assertCrossPluginUnique cross-plugin final checks (active+pending without double-scanning self,
 *   self-only registration does not trigger, inactive probes do not reserve global names);
 * - name release after clear/remove.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HelmError } from '@helm/protocol';
import { UiRegistry } from '../src/plugins/ui-registry.js';
import { createPluginBuildProvider } from '@helm/plugin-build';

const isHelmError = (code: string) => (err: unknown): boolean => err instanceof HelmError && err.code === code;

/** Test clientRoot (needed for client-reference schema validation; directory does not need to exist yet). */
const CLIENT_ROOT = '/tmp/helm-test-client-root';

/** Minimal helper to register a valid commandPalette spec (uses actionId track by default; omits slash if unset). */
function registerCommand(ui: UiRegistry, pluginId: string, id: string, slash?: string): void {
  const spec: Record<string, unknown> = { id, title: id, actionId: 'noop' };
  if (slash !== undefined) spec.slash = slash;
  ui.registerUi(pluginId, 'commandPalette', spec, 'command');
}

/** Minimal helper to register a valid profile.runtime spec. */
function registerProfileRuntime(ui: UiRegistry, pluginId: string, kind: string): void {
  ui.registerUi(pluginId, 'profile.runtime', { id: `rt-${kind}`, kind, label: kind }, 'profileRuntime');
}

test('markdown.codeBlock: validates languages shape, rejects duplicates, requires client', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  const client = { module: 'index.tsx', export: 'C' };

  // Valid declaration (multiple languages + priority)
  ui.registerUi(
    'p1',
    'markdown.codeBlock',
    { id: 'cb1', languages: ['ui', 'json-render'], priority: 5, client },
    'markdownCodeBlock',
    CLIENT_ROOT,
  );

  // Empty array / non-string / invalid uppercase / duplicates all reject
  assert.throws(
    () => ui.registerUi('p1', 'markdown.codeBlock', { id: 'bad1', languages: [], client }, 'markdownCodeBlock'),
    isHelmError('invalid_ui_spec'),
  );
  assert.throws(
    () => ui.registerUi('p1', 'markdown.codeBlock', { id: 'bad2', languages: ['a', 1], client }, 'markdownCodeBlock'),
    isHelmError('invalid_ui_spec'),
  );
  assert.throws(
    () => ui.registerUi('p1', 'markdown.codeBlock', { id: 'bad3', languages: ['UI'], client }, 'markdownCodeBlock'),
    isHelmError('invalid_ui_spec'),
  );
  assert.throws(
    () => ui.registerUi('p1', 'markdown.codeBlock', { id: 'bad4', languages: ['a', 'a'], client }, 'markdownCodeBlock'),
    isHelmError('invalid_ui_spec'),
  );
  // Missing client: rejects (no declarative fallback path)
  assert.throws(
    () => ui.registerUi('p1', 'markdown.codeBlock', { id: 'bad5', languages: ['a'] }, 'markdownCodeBlock'),
    isHelmError('invalid_ui_spec'),
  );

  // assertUiDocsRegistered is now a no-op hook without doc-ref checks: never throws for any args
  ui.assertUiDocsRegistered('p1', () => false, () => false);
});

test('ui.action: requires actionId or client and enforces field ownership', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  const client = { module: 'index.tsx', export: 'C' };

  // Valid: header + actionId + placement toolbar
  ui.registerUi(
    'p1',
    'conversation.header.action',
    { id: 'a1', target: 'conversation:header', label: 'L', actionId: 'x', placement: 'toolbar' },
    'action',
  );
  // Valid: timeline:entry + kinds/roles
  ui.registerUi(
    'p1',
    'timeline.entry.action',
    { id: 'a2', target: 'timeline:entry', label: 'L', actionId: 'x', kinds: ['pi.user'], roles: ['user'] },
    'action',
  );
  // Valid: client track (without actionId)
  ui.registerUi(
    'p1',
    'conversation.row.action',
    { id: 'a3', target: 'conversation:row', label: 'L', client },
    'action',
    CLIENT_ROOT,
  );

  // All execution tracks omitted: rejects
  assert.throws(
    () => ui.registerUi('p1', 'conversation.header.action', { id: 'bad1', target: 'conversation:header', label: 'L' }, 'action'),
    isHelmError('invalid_ui_spec'),
  );
  // actionId contains a dot: rejects
  assert.throws(
    () => ui.registerUi('p1', 'conversation.header.action', { id: 'bad2', target: 'conversation:header', label: 'L', actionId: 'x.y' }, 'action'),
    isHelmError('invalid_ui_spec'),
  );
  // placement allowed on header only
  assert.throws(
    () => ui.registerUi('p1', 'conversation.row.action', { id: 'bad3', target: 'conversation:row', label: 'L', actionId: 'x', placement: 'toolbar' }, 'action'),
    isHelmError('invalid_ui_spec'),
  );
  // kinds/roles allowed on timeline:entry only
  assert.throws(
    () => ui.registerUi('p1', 'conversation.header.action', { id: 'bad4', target: 'conversation:header', label: 'L', actionId: 'x', kinds: ['a'] }, 'action'),
    isHelmError('invalid_ui_spec'),
  );
  // target field stripped upon registration (surface carries that semantic)
  const list = ui.listUi();
  const stored = list.find((u) => (u.spec as { id?: string }).id === 'a1');
  assert.equal('target' in (stored?.spec as Record<string, unknown>), false, 'target is not stored inside spec');
});

test('priority/order must be finite safe integers', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  ui.registerUi('p1', 'sidebar.item', { id: 'ok1', label: 'A', priority: 10, order: -3 }, 'sidebarItem');
  ui.registerUi('p1', 'sidebar.item', { id: 'ok2', label: 'B', priority: 0 }, 'sidebarItem');

  for (const field of ['priority', 'order']) {
    for (const bad of [1.5, NaN, Infinity, -Infinity, '3', null]) {
      assert.throws(
        () => ui.registerUi('p1', 'sidebar.item', { id: `bad-${field}`, label: 'B', [field]: bad }, 'sidebarItem'),
        isHelmError('invalid_ui_spec'),
        `field=${field} value=${String(bad)}`,
      );
    }
  }
});

test('commandPalette: slash format, reserved words, and intra-plugin duplicates', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  registerCommand(ui, 'p1', 'cmd1', 'wf');
  registerCommand(ui, 'p1', 'cmd2'); // omitting slash is valid

  // Invalid format: leading /, uppercase, illegal chars, oversized
  for (const bad of ['/wf', 'WF', 'a b', 'a#b', 'x'.repeat(66)]) {
    assert.throws(
      () => registerCommand(ui, 'p1', `cmd-bad`, bad),
      isHelmError('invalid_ui_spec'),
      `slash=${bad}`,
    );
  }
  // Host reserved words and skill: prefix
  for (const reserved of ['new', 'clear', 'compact', 'skill:run']) {
    assert.throws(
      () => registerCommand(ui, 'p1', `cmd-res`, reserved),
      isHelmError('invalid_ui_spec'),
      `slash=${reserved}`,
    );
  }
  // Intra-plugin duplicate slash: 409 duplicate_command_slash with slash in details
  assert.throws(
    () => registerCommand(ui, 'p1', 'cmd-dup', 'wf'),
    (err: unknown) => {
      assert.ok(err instanceof HelmError);
      assert.equal(err.code, 'duplicate_command_slash');
      assert.equal(err.status, 409);
      assert.deepEqual((err.details as { pluginId: string; slash: string }).slash, 'wf');
      return true;
    },
  );
  // Commands must be triggerable: omitting slash and all execution tracks rejects
  assert.throws(
    () => ui.registerUi('p1', 'commandPalette', { id: 'cmd-empty', title: 'E' }, 'command'),
    isHelmError('invalid_ui_spec'),
  );
  // client-track command is valid; slash commands must supply actionId or insert (mutually exclusive)
  ui.registerUi('p1', 'commandPalette', { id: 'cmd-client', title: 'C', client: { module: 'index.tsx', export: 'X' } }, 'command', CLIENT_ROOT);
  ui.registerUi('p1', 'commandPalette', { id: 'cmd-insert', title: 'Swarm', slash: 'swarm', insert: '/swarm ' }, 'command');
  assert.throws(
    () => ui.registerUi('p1', 'commandPalette', { id: 'slash-client-only', title: 'C', slash: 'client-only' }, 'command'),
    isHelmError('invalid_ui_spec'),
  );
  assert.throws(
    () => ui.registerUi('p1', 'commandPalette', { id: 'slash-both', title: 'B', slash: 'both', actionId: 'act', insert: '/both ' }, 'command'),
    isHelmError('invalid_ui_spec'),
  );
  for (const badInsert of ['', '   ', 123]) {
    assert.throws(
      () => ui.registerUi('p1', 'commandPalette', { id: 'bad-insert', title: 'I', slash: 'ins', insert: badInsert }, 'command'),
      isHelmError('invalid_ui_spec'),
    );
  }
  for (const actionId of ['', 5, 'bad.id']) {
    assert.throws(
      () => ui.registerUi('p1', 'commandPalette', { id: 'bad-action', title: 'A', actionId }, 'command'),
      isHelmError('invalid_ui_spec'),
    );
  }
  assert.throws(() => ui.registerUi('p1', 'screen', null, 'screen'), isHelmError('invalid_ui_spec'));
});

test('profile.runtime: kind/label/agentSuggestions validation and intra-plugin duplicate kind', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  registerProfileRuntime(ui, 'p1', 'worker');
  registerProfileRuntime(ui, 'p1', 'watcher'); // distinct kinds within one plugin are valid

  for (const bad of ['', ' bad', 'a b', 'a#b', 'x'.repeat(66)]) {
    assert.throws(
      () => registerProfileRuntime(ui, 'p1', bad),
      isHelmError('invalid_ui_spec'),
      `kind=${JSON.stringify(bad)}`,
    );
  }
  assert.throws(
    () => ui.registerUi('p1', 'profile.runtime', { id: 'rt-nolabel', kind: 'x' }, 'profileRuntime'),
    isHelmError('invalid_ui_spec'),
  );
  assert.throws(
    () =>
      ui.registerUi('p1', 'profile.runtime', { id: 'rt-sug', kind: 'x', label: 'X', agentSuggestions: ['a', ''] }, 'profileRuntime'),
    isHelmError('invalid_ui_spec'),
  );
  // Intra-plugin duplicate kind: 409 duplicate_profile_runtime_kind with kind in details
  assert.throws(
    () => ui.registerUi('p1', 'profile.runtime', { id: 'rt-worker-again', kind: 'worker', label: 'W' }, 'profileRuntime'),
    (err: unknown) => {
      assert.ok(err instanceof HelmError);
      assert.equal(err.code, 'duplicate_profile_runtime_kind');
      assert.equal(err.status, 409);
      assert.equal((err.details as { kind: string }).kind, 'worker');
      return true;
    },
  );
});

test('assertCrossPluginUnique: checks across active+pending while excluding self', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  registerCommand(ui, 'a', 'cmd', 'wf');
  registerProfileRuntime(ui, 'a', 'worker');
  registerCommand(ui, 'b', 'cmd', 'wf'); // conflicts with a
  registerProfileRuntime(ui, 'b', 'worker'); // conflicts with a
  registerCommand(ui, 'c', 'cmd', 'other');
  registerProfileRuntime(ui, 'c', 'watcher');

  // Registry itself does not track active plugins: succeeds when namespaces are disjoint
  ui.assertCrossPluginUnique('c', ['a', 'c']);
  // pending=b conflicts with active a: slash collision hits first
  assert.throws(
    () => ui.assertCrossPluginUnique('b', ['a', 'c']),
    isHelmError('duplicate_command_slash'),
  );
  // Removing b's command collision reveals the kind collision
  ui.removePlugin('b');
  registerProfileRuntime(ui, 'b', 'worker');
  assert.throws(
    () => ui.assertCrossPluginUnique('b', ['a', 'c']),
    isHelmError('duplicate_profile_runtime_kind'),
  );

  // When pending also appears in the active list (e.g. host passes active ∪ pending), self must not collide with itself
  const ui2 = new UiRegistry(createPluginBuildProvider());
  registerCommand(ui2, 'a', 'cmd', 'wf');
  ui2.assertCrossPluginUnique('a', ['a']);

  // Pending plugin with zero declarations passes
  const ui3 = new UiRegistry(createPluginBuildProvider());
  ui3.assertCrossPluginUnique('empty', ['a', 'b']);
});

test('inactive probe reserves no global names: disabled-by-default registrations skip final check', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  registerCommand(ui, 'probe', 'cmd', 'wf');
  registerProfileRuntime(ui, 'probe', 'worker');

  // probe is disabled by default (not in active set), so b can claim the same slash/kind
  ui.assertCrossPluginUnique('b', ['b']);
  registerCommand(ui, 'b', 'cmd', 'wf');
  registerProfileRuntime(ui, 'b', 'worker');

  // Once probe is enabled (entering active set), the final uniqueness check rejects it
  assert.throws(
    () => ui.assertCrossPluginUnique('probe', ['b', 'probe']),
    isHelmError('duplicate_command_slash'),
  );

  // Intra-plugin duplicate kind/slash is still rejected immediately at registerUi before the final check
  assert.throws(
    () => ui.registerUi('b', 'commandPalette', { id: 'cmd2', title: 'C', slash: 'wf', actionId: 'x' }, 'command'),
    isHelmError('duplicate_command_slash'),
  );
});

test('clear/remove releases registered names and UI declarations', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  registerCommand(ui, 'a', 'cmd', 'wf');
  registerProfileRuntime(ui, 'a', 'worker');
  ui.registerUi('a', 'sidebar.item', { id: 's1', label: 'S', docs: ['d1'] }, 'sidebarItem');

  // clear drops all specs: doc checks are waived and other plugins may claim those names
  ui.clear('a');
  ui.assertUiDocsRegistered('a', () => false); // passes with zero specs
  assert.equal(ui.getUiByPlugin('a').length, 0);

  registerCommand(ui, 'b', 'cmd', 'wf');
  registerProfileRuntime(ui, 'b', 'worker');
  ui.assertCrossPluginUnique('b', ['b']);

  // removePlugin deletes entries completely: disappears from listUi(active)
  ui.removePlugin('b');
  assert.equal(ui.listUi(['b']).length, 0);
  ui.assertCrossPluginUnique('b', ['b']); // passes with zero specs
});
