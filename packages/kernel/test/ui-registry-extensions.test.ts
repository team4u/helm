/**
 * ui-registry-extensions.test.ts: UiRegistry extend validate set to boundary test.
 *
 * override 5b4266b3 addUi validate move plant after new boundary (without going through PluginHost, directly drive registry):
 * - sessionDocs list shape and assertUiDocsRegistered third reference (session public validate, default behavior);
 * - micro action three track (actionId/client/json at least its one,placement/kinds/roles ownership);
 * - priority/order finite security integer;
 * - commandPalette slash format/keep term/plugin inside duplicate and profile.runtime kind duplicate;
 * - assertCrossPluginUnique across plugin final inspect (active+pending,pending in active in does not repeat iterate,
 *   only registry itself does not trigger,inactive probe do not occupy global name);
 * - clear/remove after name release.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HelmError } from '@helm/protocol';
import { UiRegistry } from '../src/plugins/ui-registry.js';
import { createPluginBuildProvider } from '@helm/plugin-build';

const isHelmError = (code: string) => (err: unknown): boolean => err instanceof HelmError && err.code === code;

/** test use clientRoot(client reference shape validate need to; directory no need to real store in - - shape validate first row). */
const CLIENT_ROOT = '/tmp/helm-test-client-root';

/** register a legal commandPalette declaration most small assist manually (by default away actionId track;slash not provide when does not carry the key). */
function registerCommand(ui: UiRegistry, pluginId: string, id: string, slash?: string): void {
  const spec: Record<string, unknown> = { id, title: id, actionId: 'noop' };
  if (slash !== undefined) spec.slash = slash;
  ui.registerUi(pluginId, 'commandPalette', spec, 'command');
}

/** register a legal profile.runtime declaration most small assist manually. */
function registerProfileRuntime(ui: UiRegistry, pluginId: string, kind: string): void {
  ui.registerUi(pluginId, 'profile.runtime', { id: `rt-${kind}`, kind, label: kind }, 'profileRuntime');
}

test('markdown.codeBlock:languages shape, duplicate reject and client required', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  const client = { module: 'index.tsx', export: 'C' };

  // legal declaration (many language + priority)
  ui.registerUi(
    'p1',
    'markdown.codeBlock',
    { id: 'cb1', languages: ['ui', 'json-render'], priority: 5, client },
    'markdownCodeBlock',
    CLIENT_ROOT,
  );

  // empty array / non- string / large write illegal form / duplicate all reject
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
  // missing client: reject (without declaration style track path)
  assert.throws(
    () => ui.registerUi('p1', 'markdown.codeBlock', { id: 'bad5', languages: ['a'] }, 'markdownCodeBlock'),
    isHelmError('invalid_ui_spec'),
  );

  // assertUiDocsRegistered now is without document reference validate hang point: any parameter under all no longer throw
  ui.assertUiDocsRegistered('p1', () => false, () => false);
});

test('ui.action:actionId/client at least its one and field ownership', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  const client = { module: 'index.tsx', export: 'C' };

  // legal:header + actionId + placement toolbar
  ui.registerUi(
    'p1',
    'conversation.header.action',
    { id: 'a1', target: 'conversation:header', label: 'L', actionId: 'x', placement: 'toolbar' },
    'action',
  );
  // legal:timeline:entry + kinds/roles
  ui.registerUi(
    'p1',
    'timeline.entry.action',
    { id: 'a2', target: 'timeline:entry', label: 'L', actionId: 'x', kinds: ['pi.user'], roles: ['user'] },
    'action',
  );
  // legal:client track (without actionId)
  ui.registerUi(
    'p1',
    'conversation.row.action',
    { id: 'a3', target: 'conversation:row', label: 'L', client },
    'action',
    CLIENT_ROOT,
  );

  // three track all empty: reject
  assert.throws(
    () => ui.registerUi('p1', 'conversation.header.action', { id: 'bad1', target: 'conversation:header', label: 'L' }, 'action'),
    isHelmError('invalid_ui_spec'),
  );
  // actionId contains point number: reject
  assert.throws(
    () => ui.registerUi('p1', 'conversation.header.action', { id: 'bad2', target: 'conversation:header', label: 'L', actionId: 'x.y' }, 'action'),
    isHelmError('invalid_ui_spec'),
  );
  // placement only header allows
  assert.throws(
    () => ui.registerUi('p1', 'conversation.row.action', { id: 'bad3', target: 'conversation:row', label: 'L', actionId: 'x', placement: 'toolbar' }, 'action'),
    isHelmError('invalid_ui_spec'),
  );
  // kinds/roles only timeline:entry allows
  assert.throws(
    () => ui.registerUi('p1', 'conversation.header.action', { id: 'bad4', target: 'conversation:header', label: 'L', actionId: 'x', kinds: ['a'] }, 'action'),
    isHelmError('invalid_ui_spec'),
  );
  // target field in register when remove (surface already carry semantics)
  const list = ui.listUi();
  const stored = list.find((u) => (u.spec as { id?: string }).id === 'a1');
  assert.equal('target' in (stored?.spec as Record<string, unknown>), false, 'target does not enter store spec');
});

test('priority/order must be finite security integer', { timeout: 60_000 }, () => {
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

test('commandPalette:slash format, keep term and plugin inside duplicate', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  registerCommand(ui, 'p1', 'cmd1', 'wf');
  registerCommand(ui, 'p1', 'cmd2'); // without slash legal

  // format illegal: before lead /, large write, illegal character, over long
  for (const bad of ['/wf', 'WF', 'a b', 'a#b', 'x'.repeat(66)]) {
    assert.throws(
      () => registerCommand(ui, 'p1', `cmd-bad`, bad),
      isHelmError('invalid_ui_spec'),
      `slash=${bad}`,
    );
  }
  // host keep term and skill: prefix
  for (const reserved of ['new', 'clear', 'compact', 'skill:run']) {
    assert.throws(
      () => registerCommand(ui, 'p1', `cmd-res`, reserved),
      isHelmError('invalid_ui_spec'),
      `slash=${reserved}`,
    );
  }
  // plugin inside duplicate slash:409 duplicate_command_slash,details carry slash
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
  // command must can trigger: without slash and without three track reject
  assert.throws(
    () => ui.registerUi('p1', 'commandPalette', { id: 'cmd-empty', title: 'E' }, 'command'),
    isHelmError('invalid_ui_spec'),
  );
  // client track command legal;slash must has can execute action, cannot only show choose yet cannot execute.
  ui.registerUi('p1', 'commandPalette', { id: 'cmd-client', title: 'C', client: { module: 'index.tsx', export: 'X' } }, 'command', CLIENT_ROOT);
  assert.throws(
    () => ui.registerUi('p1', 'commandPalette', { id: 'slash-client-only', title: 'C', slash: 'client-only' }, 'command'),
    isHelmError('invalid_ui_spec'),
  );
  for (const actionId of ['', 5, 'bad.id']) {
    assert.throws(
      () => ui.registerUi('p1', 'commandPalette', { id: 'bad-action', title: 'A', actionId }, 'command'),
      isHelmError('invalid_ui_spec'),
    );
  }
  assert.throws(() => ui.registerUi('p1', 'screen', null, 'screen'), isHelmError('invalid_ui_spec'));
});

test('profile.runtime:kind/label/agentSuggestions shape and plugin inside duplicate kind', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  registerProfileRuntime(ui, 'p1', 'worker');
  registerProfileRuntime(ui, 'p1', 'watcher'); // same plugin different kind legal

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
  // plugin inside duplicate kind:409 duplicate_profile_runtime_kind,details carry kind
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

test('assertCrossPluginUnique:active+pending final inspect and self exclude', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  registerCommand(ui, 'a', 'cmd', 'wf');
  registerProfileRuntime(ui, 'a', 'worker');
  registerCommand(ui, 'b', 'cmd', 'wf'); // and a conflict
  registerProfileRuntime(ui, 'b', 'worker'); // and a conflict
  registerCommand(ui, 'c', 'cmd', 'other');
  registerProfileRuntime(ui, 'c', 'watcher');

  // pure registry do not cache active: without conflict naming empty between under via
  ui.assertCrossPluginUnique('c', ['a', 'c']);
  // pending=b and active a conflict:slash conflict (first hit)
  assert.throws(
    () => ui.assertCrossPluginUnique('b', ['a', 'c']),
    isHelmError('duplicate_command_slash'),
  );
  // remove b command conflict after,kind conflict hit
  ui.removePlugin('b');
  registerProfileRuntime(ui, 'b', 'worker');
  assert.throws(
    () => ui.assertCrossPluginUnique('b', ['a', 'c']),
    isHelmError('duplicate_profile_runtime_kind'),
  );

  // pending also appear in active list in (such as host pass contains pending all collection) do not mistakenly report self conflict
  const ui2 = new UiRegistry(createPluginBuildProvider());
  registerCommand(ui2, 'a', 'cmd', 'wf');
  ui2.assertCrossPluginUnique('a', ['a']);

  // without any declaration pending: via
  const ui3 = new UiRegistry(createPluginBuildProvider());
  ui3.assertCrossPluginUnique('empty', ['a', 'b']);
});

test('inactive probe do not occupy global name: by default deactivate register does not participate final inspect', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  registerCommand(ui, 'probe', 'cmd', 'wf');
  registerProfileRuntime(ui, 'probe', 'worker');

  // probe(by default deactivate, not enter active set) does not occupy name:b can enable same name slash/kind
  ui.assertCrossPluginUnique('b', ['b']);
  registerCommand(ui, 'b', 'cmd', 'wf');
  registerProfileRuntime(ui, 'b', 'worker');

  // probe after rotate is enable (enter active) when, after to only then by final inspect reject
  assert.throws(
    () => ui.assertCrossPluginUnique('probe', ['b', 'probe']),
    isHelmError('duplicate_command_slash'),
  );

  // plugin inside duplicate kind/slash in registerUi boundary i.e. reject, no need to final inspect reference and
  assert.throws(
    () => ui.registerUi('b', 'commandPalette', { id: 'cmd2', title: 'C', slash: 'wf', actionId: 'x' }, 'command'),
    isHelmError('duplicate_command_slash'),
  );
});

test('clear/remove after name and declaration release', { timeout: 60_000 }, () => {
  const ui = new UiRegistry(createPluginBuildProvider());
  registerCommand(ui, 'a', 'cmd', 'wf');
  registerProfileRuntime(ui, 'a', 'worker');
  ui.registerUi('a', 'sidebar.item', { id: 's1', label: 'S', docs: ['d1'] }, 'sidebarItem');

  // clear empty declaration:docs validate no longer want seek, name can by other plugin occupy
  ui.clear('a');
  ui.assertUiDocsRegistered('a', () => false); // without declaration i.e. via
  assert.equal(ui.getUiByPlugin('a').length, 0);

  registerCommand(ui, 'b', 'cmd', 'wf');
  registerProfileRuntime(ui, 'b', 'worker');
  ui.assertCrossPluginUnique('b', ['b']);

  // removePlugin whole delete:listUi(active) no longer appear
  ui.removePlugin('b');
  assert.equal(ui.listUi(['b']).length, 0);
  ui.assertCrossPluginUnique('b', ['b']); // without declaration via
});
