/**
 * ui-spec-validators: minimal unit tests per UI surface extracted from registerUi.
 * Each surface covers one valid declaration (does not throw) + one representative set of invalid declarations (error code assertions);
 * error codes and messages stay character-for-character consistent with pre-extraction inline rules in registerUi (equivalence refactor regression anchor).
 *
 * runner: tsx --test; explicit timeout: 60_000 per test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HelmError, type PluginUiContribution } from '@helm/protocol';
import { validateUiSpecEarly, validateUiSpecLate, type UiSpecContext } from '../src/plugins/ui-spec-validators.js';

function makeCtx(surface: string, siblings: PluginUiContribution[] = []): UiSpecContext {
  return {
    pluginId: 'p1',
    fnName: 'fn',
    surface,
    clientRoot: undefined,
    hasBuildProvider: true,
    siblings,
  };
}

const isHelmError = (code: string) => (err: unknown): boolean => err instanceof HelmError && err.code === code;

function expectThrow(
  run: () => void,
  code: string,
  messageIncludes?: string,
): void {
  assert.throws(run, (err: unknown) => {
    if (!(err instanceof HelmError)) return false;
    assert.equal(err.code, code);
    if (messageIncludes !== undefined) {
      assert.ok(err.message.includes(messageIncludes), `message should include "${messageIncludes}", got: ${err.message}`);
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Early phase: three UI action surfaces
// ---------------------------------------------------------------------------

test('conversation.header.action: valid passes; missing actionId/client or invalid placement rejects; strips redundant target field', { timeout: 60_000 }, () => {
  const ok: Record<string, unknown> = { id: 'a1', actionId: 'act', placement: 'toolbar', target: 'conversation:header' };
  validateUiSpecEarly('conversation.header.action', ok, 'a1', makeCtx('conversation.header.action'));
  assert.equal('target' in ok, false, 'registered input should strip redundant target field');

  expectThrow(
    () => validateUiSpecEarly('conversation.header.action', { id: 'a1' }, 'a1', makeCtx('conversation.header.action')),
    'invalid_ui_spec',
    'must at least provide actionId or client of one',
  );
  expectThrow(
    () =>
      validateUiSpecEarly(
        'conversation.header.action',
        { id: 'a1', actionId: 'act', placement: 'sidebar' },
        'a1',
        makeCtx('conversation.header.action'),
      ),
    'invalid_ui_spec',
    "placement only allows 'toolbar' | 'menu'",
  );
});

test('conversation.row.action: disallows placement; rejects dotted actionId', { timeout: 60_000 }, () => {
  validateUiSpecEarly('conversation.row.action', { id: 'r1', client: { module: 'a.tsx', export: 'X' } }, 'r1', makeCtx('conversation.row.action'));
  expectThrow(
    () =>
      validateUiSpecEarly('conversation.row.action', { id: 'r1', actionId: 'act', placement: 'menu' }, 'r1', makeCtx('conversation.row.action')),
    'invalid_ui_spec',
    'disallows placement',
  );
  expectThrow(
    () => validateUiSpecEarly('conversation.row.action', { id: 'r1', actionId: 'a.b' }, 'r1', makeCtx('conversation.row.action')),
    'invalid_ui_spec',
    'excludes point number action id',
  );
});

test('timeline.entry.action: valid kinds/roles pass; invalid roles and kinds on row surface reject', { timeout: 60_000 }, () => {
  validateUiSpecEarly(
    'timeline.entry.action',
    { id: 'e1', actionId: 'act', kinds: ['bash'], roles: ['user'] },
    'e1',
    makeCtx('timeline.entry.action'),
  );
  expectThrow(
    () =>
      validateUiSpecEarly('timeline.entry.action', { id: 'e1', actionId: 'act', roles: ['system'] }, 'e1', makeCtx('timeline.entry.action')),
    'invalid_ui_spec',
    "roles only allows 'user' | 'assistant'",
  );
  expectThrow(
    () => validateUiSpecEarly('conversation.row.action', { id: 'r1', actionId: 'act', kinds: ['bash'] }, 'r1', makeCtx('conversation.row.action')),
    'invalid_ui_spec',
    'disallows kinds',
  );
});

// ---------------------------------------------------------------------------
// Early phase: commandPalette / profile.runtime / plugin.slot
// ---------------------------------------------------------------------------

test('commandPalette: slash+actionId passes; reserved words and intra-plugin duplicate slash reject', { timeout: 60_000 }, () => {
  const ctx = makeCtx('commandPalette', [
    { pluginId: 'p1', surface: 'commandPalette', spec: { id: 'c0', slash: 'chart' } },
  ]);
  validateUiSpecEarly('commandPalette', { id: 'c1', slash: 'diagram', actionId: 'act' }, 'c1', ctx);
  expectThrow(
    () => validateUiSpecEarly('commandPalette', { id: 'c1', slash: 'new', actionId: 'act' }, 'c1', makeCtx('commandPalette')),
    'invalid_ui_spec',
    'and host keep command conflict',
  );
  expectThrow(() => validateUiSpecEarly('commandPalette', { id: 'c1', slash: 'chart', actionId: 'act' }, 'c1', ctx), 'duplicate_command_slash');
  expectThrow(
    () => validateUiSpecEarly('commandPalette', { id: 'c1', slash: 'chart' }, 'c1', makeCtx('commandPalette')),
    'invalid_ui_spec',
    'declaration slash when must bind set actionId',
  );
});

test('profile.runtime: valid kind/label passes; invalid kind format and intra-plugin duplicate reject', { timeout: 60_000 }, () => {
  const ctx = makeCtx('profile.runtime', [
    { pluginId: 'p1', surface: 'profile.runtime', spec: { id: 'k0', kind: 'python' } },
  ]);
  validateUiSpecEarly('profile.runtime', { id: 'k1', kind: 'node', label: 'Node' }, 'k1', makeCtx('profile.runtime'));
  expectThrow(
    () => validateUiSpecEarly('profile.runtime', { id: 'k1', kind: '1bad kind', label: 'x' }, 'k1', makeCtx('profile.runtime')),
    'invalid_ui_spec',
    'kind must match',
  );
  expectThrow(
    () => validateUiSpecEarly('profile.runtime', { id: 'k1', kind: 'python', label: 'x' }, 'k1', ctx),
    'duplicate_profile_runtime_kind',
  );
});

test('plugin.slot: valid target passes; extra slashes and invalid segment identifiers reject', { timeout: 60_000 }, () => {
  validateUiSpecEarly('plugin.slot', { id: 's1', target: 'owner/panel' }, 's1', makeCtx('plugin.slot'));
  expectThrow(
    () => validateUiSpecEarly('plugin.slot', { id: 's1', target: 'a/b/c' }, 's1', makeCtx('plugin.slot')),
    'invalid_ui_spec',
    "must exactly contains a '/'",
  );
  expectThrow(
    () => validateUiSpecEarly('plugin.slot', { id: 's1', target: 'ow ner/panel' }, 's1', makeCtx('plugin.slot')),
    'invalid_ui_spec',
    'segment identifier illegal',
  );
});

// ---------------------------------------------------------------------------
// Late phase
// ---------------------------------------------------------------------------

test('timeline.renderer: valid matchMeta passes; extra keys reject', { timeout: 60_000 }, () => {
  validateUiSpecLate('timeline.renderer', { id: 't1', matchMeta: { renderer: 'bash' } }, 't1', makeCtx('timeline.renderer'));
  expectThrow(
    () => validateUiSpecLate('timeline.renderer', { id: 't1', matchMeta: { renderer: 'bash', extra: 1 } }, 't1', makeCtx('timeline.renderer')),
    'invalid_ui_spec',
    'matchMeta only allows { renderer: non-empty string }',
  );
});

test('markdown.codeBlock: valid languages+client passes; duplicate languages and missing client reject', { timeout: 60_000 }, () => {
  validateUiSpecLate(
    'markdown.codeBlock',
    { id: 'm1', languages: ['mermaid'], client: { module: 'a.tsx', export: 'X' } },
    'm1',
    makeCtx('markdown.codeBlock'),
  );
  expectThrow(
    () => validateUiSpecLate('markdown.codeBlock', { id: 'm1', languages: ['mermaid', 'mermaid'], client: { module: 'a.tsx', export: 'X' } }, 'm1', makeCtx('markdown.codeBlock')),
    'invalid_ui_spec',
    'languages contains duplicate items',
  );
  expectThrow(
    () => validateUiSpecLate('markdown.codeBlock', { id: 'm1', languages: ['mermaid'] }, 'm1', makeCtx('markdown.codeBlock')),
    'invalid_ui_spec',
    'must declaration client component reference',
  );
});

test('tool.view: valid toolNames+replaceRow passes; non-boolean replaceRow rejects', { timeout: 60_000 }, () => {
  validateUiSpecLate('tool.view', { id: 'v1', toolNames: ['bash'], replaceRow: true }, 'v1', makeCtx('tool.view'));
  expectThrow(
    () => validateUiSpecLate('tool.view', { id: 'v1', toolNames: ['bash'], replaceRow: 'yes' }, 'v1', makeCtx('tool.view')),
    'invalid_ui_spec',
    'replaceRow must be boolean value',
  );
});

test('artifact.previewer: valid MIME/extension patterns pass; */*, parameterized patterns, and duplicates reject', { timeout: 60_000 }, () => {
  validateUiSpecLate(
    'artifact.previewer',
    { id: 'pr1', label: 'L', mimeTypes: ['text/markdown', 'image/*'], extensions: ['.md', '.tar.gz'] },
    'pr1',
    makeCtx('artifact.previewer'),
  );
  expectThrow(
    () => validateUiSpecLate('artifact.previewer', { id: 'pr1', label: 'L', mimeTypes: ['*/*'] }, 'pr1', makeCtx('artifact.previewer')),
    'invalid_ui_spec',
    'illegal',
  );
  expectThrow(
    () => validateUiSpecLate('artifact.previewer', { id: 'pr1', label: 'L', extensions: ['.md', '.md'] }, 'pr1', makeCtx('artifact.previewer')),
    'invalid_ui_spec',
    'contains duplicate items',
  );
});

test('composer.completer: valid action/doc sources pass; invalid trigger, client track, and __proto__ itemsField reject', { timeout: 60_000 }, () => {
  validateUiSpecLate(
    'composer.completer',
    { id: 'cp1', label: 'L', trigger: '@', source: { kind: 'action', actionId: 'list' } },
    'cp1',
    makeCtx('composer.completer'),
  );
  validateUiSpecLate(
    'composer.completer',
    { id: 'cp2', label: 'L', trigger: '#', source: { kind: 'doc', name: 'items', itemsField: 'rows' } },
    'cp2',
    makeCtx('composer.completer'),
  );
  expectThrow(
    () => validateUiSpecLate('composer.completer', { id: 'cp1', label: 'L', trigger: '/' }, 'cp1', makeCtx('composer.completer')),
    'invalid_ui_spec',
    "trigger only allows '@' | '#' | ':'",
  );
  expectThrow(
    () =>
      validateUiSpecLate(
        'composer.completer',
        { id: 'cp1', label: 'L', trigger: '@', client: { module: 'a.tsx', export: 'X' }, source: { kind: 'action', actionId: 'x' } },
        'cp1',
        makeCtx('composer.completer'),
      ),
    'invalid_ui_spec',
    'disallows declaration client',
  );
  expectThrow(
    () =>
      validateUiSpecLate(
        'composer.completer',
        { id: 'cp1', label: 'L', trigger: '@', source: { kind: 'doc', name: 'items', itemsField: '__proto__' } },
        'cp1',
        makeCtx('composer.completer'),
      ),
    'invalid_ui_spec',
    'security top-level key',
  );
});

test('workbench.panel: valid badge shape passes; unknown badge keys reject', { timeout: 60_000 }, () => {
  validateUiSpecLate(
    'workbench.panel',
    { id: 'w1', badge: { doc: 'stats', countField: 'count', toneField: 'tone' } },
    'w1',
    makeCtx('workbench.panel'),
  );
  expectThrow(
    () => validateUiSpecLate('workbench.panel', { id: 'w1', badge: { doc: 'stats', unknown: 1 } }, 'w1', makeCtx('workbench.panel')),
    'invalid_ui_spec',
    'badge only allows',
  );
});
