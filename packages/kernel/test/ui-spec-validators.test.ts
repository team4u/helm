/**
 * ui-spec-validators：registerUi 拆出的各 surface 纯校验器最小单测。
 * 每个 surface 一组合法声明（不抛）+ 一组代表性非法声明（错误码断言）；
 * 错误码/消息与拆分前 registerUi 内联规则逐字一致（等价重构的回归锚）。
 *
 * runner: tsx --test；每项显式 timeout: 60_000。
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
      assert.ok(err.message.includes(messageIncludes), `消息应含 "${messageIncludes}"，实际：${err.message}`);
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// 早期块：UI 动作三 surface
// ---------------------------------------------------------------------------

test('conversation.header.action：合法声明通过；缺 actionId/client 拒绝；placement 非法拒绝；target 字段被剔除', { timeout: 60_000 }, () => {
  const ok: Record<string, unknown> = { id: 'a1', actionId: 'act', placement: 'toolbar', target: 'conversation:header' };
  validateUiSpecEarly('conversation.header.action', ok, 'a1', makeCtx('conversation.header.action'));
  assert.equal('target' in ok, false, '注册输入侧应剔除冗余 target 字段');

  expectThrow(
    () => validateUiSpecEarly('conversation.header.action', { id: 'a1' }, 'a1', makeCtx('conversation.header.action')),
    'invalid_ui_spec',
    '需至少提供 actionId 或 client 之一',
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
    "placement 仅允许 'toolbar' | 'menu'",
  );
});

test('conversation.row.action：不允许 placement；actionId 含点号拒绝', { timeout: 60_000 }, () => {
  validateUiSpecEarly('conversation.row.action', { id: 'r1', client: { module: 'a.tsx', export: 'X' } }, 'r1', makeCtx('conversation.row.action'));
  expectThrow(
    () =>
      validateUiSpecEarly('conversation.row.action', { id: 'r1', actionId: 'act', placement: 'menu' }, 'r1', makeCtx('conversation.row.action')),
    'invalid_ui_spec',
    '不允许 placement',
  );
  expectThrow(
    () => validateUiSpecEarly('conversation.row.action', { id: 'r1', actionId: 'a.b' }, 'r1', makeCtx('conversation.row.action')),
    'invalid_ui_spec',
    '不含点号的动作 id',
  );
});

test('timeline.entry.action：kinds/roles 合法通过；非法 roles 值拒绝；row surface 不允许 kinds', { timeout: 60_000 }, () => {
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
    "roles 仅允许 'user' | 'assistant'",
  );
  expectThrow(
    () => validateUiSpecEarly('conversation.row.action', { id: 'r1', actionId: 'act', kinds: ['bash'] }, 'r1', makeCtx('conversation.row.action')),
    'invalid_ui_spec',
    '不允许 kinds',
  );
});

// ---------------------------------------------------------------------------
// 早期块：commandPalette / profile.runtime / plugin.slot
// ---------------------------------------------------------------------------

test('commandPalette：slash+actionId 合法通过；保留词与插件内重复 slash 拒绝', { timeout: 60_000 }, () => {
  const ctx = makeCtx('commandPalette', [
    { pluginId: 'p1', surface: 'commandPalette', spec: { id: 'c0', slash: 'chart' } },
  ]);
  validateUiSpecEarly('commandPalette', { id: 'c1', slash: 'diagram', actionId: 'act' }, 'c1', ctx);
  expectThrow(
    () => validateUiSpecEarly('commandPalette', { id: 'c1', slash: 'new', actionId: 'act' }, 'c1', makeCtx('commandPalette')),
    'invalid_ui_spec',
    '与宿主保留命令冲突',
  );
  expectThrow(() => validateUiSpecEarly('commandPalette', { id: 'c1', slash: 'chart', actionId: 'act' }, 'c1', ctx), 'duplicate_command_slash');
  expectThrow(
    () => validateUiSpecEarly('commandPalette', { id: 'c1', slash: 'chart' }, 'c1', makeCtx('commandPalette')),
    'invalid_ui_spec',
    '声明 slash 时必须绑定 actionId',
  );
});

test('profile.runtime：kind/label 合法通过；kind 格式与插件内重复拒绝', { timeout: 60_000 }, () => {
  const ctx = makeCtx('profile.runtime', [
    { pluginId: 'p1', surface: 'profile.runtime', spec: { id: 'k0', kind: 'python' } },
  ]);
  validateUiSpecEarly('profile.runtime', { id: 'k1', kind: 'node', label: 'Node' }, 'k1', makeCtx('profile.runtime'));
  expectThrow(
    () => validateUiSpecEarly('profile.runtime', { id: 'k1', kind: '1bad kind', label: 'x' }, 'k1', makeCtx('profile.runtime')),
    'invalid_ui_spec',
    'kind 必须匹配',
  );
  expectThrow(
    () => validateUiSpecEarly('profile.runtime', { id: 'k1', kind: 'python', label: 'x' }, 'k1', ctx),
    'duplicate_profile_runtime_kind',
  );
});

test('plugin.slot：合法 target 通过；多余斜杠与非法段标识拒绝', { timeout: 60_000 }, () => {
  validateUiSpecEarly('plugin.slot', { id: 's1', target: 'owner/panel' }, 's1', makeCtx('plugin.slot'));
  expectThrow(
    () => validateUiSpecEarly('plugin.slot', { id: 's1', target: 'a/b/c' }, 's1', makeCtx('plugin.slot')),
    'invalid_ui_spec',
    "必须恰含一个 '/'",
  );
  expectThrow(
    () => validateUiSpecEarly('plugin.slot', { id: 's1', target: 'ow ner/panel' }, 's1', makeCtx('plugin.slot')),
    'invalid_ui_spec',
    '段标识非法',
  );
});

// ---------------------------------------------------------------------------
// 晚期块
// ---------------------------------------------------------------------------

test('timeline.renderer：matchMeta 合法通过；非法键拒绝', { timeout: 60_000 }, () => {
  validateUiSpecLate('timeline.renderer', { id: 't1', matchMeta: { renderer: 'bash' } }, 't1', makeCtx('timeline.renderer'));
  expectThrow(
    () => validateUiSpecLate('timeline.renderer', { id: 't1', matchMeta: { renderer: 'bash', extra: 1 } }, 't1', makeCtx('timeline.renderer')),
    'invalid_ui_spec',
    'matchMeta 仅允许 { renderer: 非空字符串 }',
  );
});

test('markdown.codeBlock：languages+client 合法通过；重复语言与缺 client 拒绝', { timeout: 60_000 }, () => {
  validateUiSpecLate(
    'markdown.codeBlock',
    { id: 'm1', languages: ['mermaid'], client: { module: 'a.tsx', export: 'X' } },
    'm1',
    makeCtx('markdown.codeBlock'),
  );
  expectThrow(
    () => validateUiSpecLate('markdown.codeBlock', { id: 'm1', languages: ['mermaid', 'mermaid'], client: { module: 'a.tsx', export: 'X' } }, 'm1', makeCtx('markdown.codeBlock')),
    'invalid_ui_spec',
    'languages 含重复项',
  );
  expectThrow(
    () => validateUiSpecLate('markdown.codeBlock', { id: 'm1', languages: ['mermaid'] }, 'm1', makeCtx('markdown.codeBlock')),
    'invalid_ui_spec',
    '必须声明 client 组件引用',
  );
});

test('tool.view：toolNames+replaceRow 合法通过；非布尔 replaceRow 拒绝', { timeout: 60_000 }, () => {
  validateUiSpecLate('tool.view', { id: 'v1', toolNames: ['bash'], replaceRow: true }, 'v1', makeCtx('tool.view'));
  expectThrow(
    () => validateUiSpecLate('tool.view', { id: 'v1', toolNames: ['bash'], replaceRow: 'yes' }, 'v1', makeCtx('tool.view')),
    'invalid_ui_spec',
    'replaceRow 必须是布尔值',
  );
});

test('artifact.previewer：MIME/后缀匹配声明合法通过；*/*、参数形态与重复项拒绝', { timeout: 60_000 }, () => {
  validateUiSpecLate(
    'artifact.previewer',
    { id: 'pr1', label: 'L', mimeTypes: ['text/markdown', 'image/*'], extensions: ['.md', '.tar.gz'] },
    'pr1',
    makeCtx('artifact.previewer'),
  );
  expectThrow(
    () => validateUiSpecLate('artifact.previewer', { id: 'pr1', label: 'L', mimeTypes: ['*/*'] }, 'pr1', makeCtx('artifact.previewer')),
    'invalid_ui_spec',
    '非法',
  );
  expectThrow(
    () => validateUiSpecLate('artifact.previewer', { id: 'pr1', label: 'L', extensions: ['.md', '.md'] }, 'pr1', makeCtx('artifact.previewer')),
    'invalid_ui_spec',
    '含重复项',
  );
});

test('composer.completer：action/doc 源合法通过；非法 trigger、client 轨与 __proto__ itemsField 拒绝', { timeout: 60_000 }, () => {
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
    "trigger 仅允许 '@' | '#' | ':'",
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
    '不允许声明 client',
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
    '安全顶层键',
  );
});

test('workbench.panel：badge 声明式形状合法通过；未知 badge 键拒绝', { timeout: 60_000 }, () => {
  validateUiSpecLate(
    'workbench.panel',
    { id: 'w1', badge: { doc: 'stats', countField: 'count', toneField: 'tone' } },
    'w1',
    makeCtx('workbench.panel'),
  );
  expectThrow(
    () => validateUiSpecLate('workbench.panel', { id: 'w1', badge: { doc: 'stats', unknown: 1 } }, 'w1', makeCtx('workbench.panel')),
    'invalid_ui_spec',
    'badge 仅允许',
  );
});
