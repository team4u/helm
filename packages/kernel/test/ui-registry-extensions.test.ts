/**
 * ui-registry-extensions.test.ts: UiRegistry 扩展校验的定向边界测试。
 *
 * 覆盖 5b4266b3 addUi 校验移植后的新边界（不经过 PluginHost，直接驱动 registry）：
 * - sessionDocs 列表形状与 assertUiDocsRegistered 第三参（session 公开校验、缺省行为）；
 * - 微动作三轨（actionId/client/json 至少其一、placement/kinds/roles 归属）；
 * - priority/order 有限安全整数；
 * - commandPalette slash 格式/保留词/插件内重复 与 profile.runtime kind 重复；
 * - assertCrossPluginUnique 跨插件终检（active+pending、pending 在 active 中不重复遍历、
 *   仅 registry 自身不触发、inactive probe 不占全局名字）；
 * - clear/remove 后名字释放。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HelmError } from '@helm/protocol';
import { UiRegistry } from '../src/plugins/ui-registry.js';

const isHelmError = (code: string) => (err: unknown): boolean => err instanceof HelmError && err.code === code;

/** 注册一个合法 commandPalette 声明的最小助手（默认走 actionId 轨；slash 未提供时不携带该键）。 */
function registerCommand(ui: UiRegistry, pluginId: string, id: string, slash?: string): void {
  const spec: Record<string, unknown> = { id, title: id, actionId: 'noop' };
  if (slash !== undefined) spec.slash = slash;
  ui.registerUi(pluginId, 'commandPalette', spec, 'command');
}

/** 注册一个合法 profile.runtime 声明的最小助手。 */
function registerProfileRuntime(ui: UiRegistry, pluginId: string, kind: string): void {
  ui.registerUi(pluginId, 'profile.runtime', { id: `rt-${kind}`, kind, label: kind }, 'profileRuntime');
}

test('sessionDocs：列表形状校验与 assertUiDocsRegistered 第三参', { timeout: 60_000 }, () => {
  const ui = new UiRegistry();

  // 合法 sessionDocs 列表可注册
  ui.registerUi(
    'p1',
    'workbench.panel',
    { id: 'panel1', title: 'Panel', sessionDocs: ['tasks'] },
    'workbenchPanel',
  );

  // 空数组 / 非字符串 / 重复名 / 非法字符 均拒绝
  assert.throws(
    () => ui.registerUi('p1', 'workbench.panel', { id: 'bad1', sessionDocs: [] }, 'workbenchPanel'),
    isHelmError('invalid_ui_spec'),
  );
  assert.throws(
    () => ui.registerUi('p1', 'workbench.panel', { id: 'bad2', sessionDocs: ['a', 1] }, 'workbenchPanel'),
    isHelmError('invalid_ui_spec'),
  );
  assert.throws(
    () => ui.registerUi('p1', 'workbench.panel', { id: 'bad3', sessionDocs: ['a', 'a'] }, 'workbenchPanel'),
    isHelmError('invalid_ui_spec'),
  );
  assert.throws(
    () => ui.registerUi('p1', 'workbench.panel', { id: 'bad4', sessionDocs: ['非法名'] }, 'workbenchPanel'),
    isHelmError('invalid_ui_spec'),
  );

  // sessionDocs 校验走第三参：未公开的会话文档拒绝
  assert.throws(
    () => ui.assertUiDocsRegistered('p1', () => false, () => false),
    isHelmError('invalid_ui_spec'),
  );
  // session 公开但 global 未公开：sessionDocs 不要求 global，通过
  ui.assertUiDocsRegistered('p1', () => false, (name) => name === 'tasks');

  // 缺省第三参：声明了 sessionDocs 即视为未公开，显式拒绝（防静默挂空）
  assert.throws(
    () => ui.assertUiDocsRegistered('p1', () => false),
    isHelmError('invalid_ui_spec'),
  );

  // docs（global）与 sessionDocs 双轨道独立校验
  const ui2 = new UiRegistry();
  ui2.registerUi(
    'p2',
    'sidebar.item',
    { id: 's1', label: 'S', docs: ['globalDoc'], sessionDocs: ['sessionDoc'] },
    'sidebarItem',
  );
  assert.throws(
    () => ui2.assertUiDocsRegistered('p2', () => false, () => true),
    isHelmError('invalid_ui_spec'),
  );
  ui2.assertUiDocsRegistered('p2', (n) => n === 'globalDoc', (n) => n === 'sessionDoc');
});

test('微动作三轨：actionId/client/json 至少其一与字段归属', { timeout: 60_000 }, () => {
  const ui = new UiRegistry();

  // 三者皆缺拒绝（三类 surface 同规则）
  for (const surface of ['conversation.header.action', 'conversation.row.action', 'timeline.entry.action']) {
    assert.throws(
      () => ui.registerUi('p1', surface, { id: 'none' }, 'fn'),
      isHelmError('invalid_ui_spec'),
    );
  }
  // actionId 轨：含点号拒绝（跨插件走 actionPluginId）
  assert.throws(
    () => ui.registerUi('p1', 'conversation.header.action', { id: 'a1', actionId: 'x.y' }, 'fn'),
    isHelmError('invalid_ui_spec'),
  );
  // actionPluginId 必须非空字符串
  assert.throws(
    () => ui.registerUi('p1', 'conversation.row.action', { id: 'a2', actionId: 'x', actionPluginId: '' }, 'fn'),
    isHelmError('invalid_ui_spec'),
  );
  // json 轨单独成立
  ui.registerUi('p1', 'timeline.entry.action', { id: 'a3', json: { type: 'static' } }, 'fn');
  // client 轨单独成立（提供 clientRoot）
  ui.registerUi(
    'p1',
    'conversation.header.action',
    { id: 'a4', client: { module: './x.tsx', export: 'X' } },
    'fn',
    '/tmp/client-root',
  );

  // placement 仅 conversation.header.action 允许，值域 toolbar|menu
  assert.throws(
    () => ui.registerUi('p1', 'conversation.row.action', { id: 'a5', actionId: 'x', placement: 'toolbar' }, 'fn'),
    isHelmError('invalid_ui_spec'),
  );
  assert.throws(
    () =>
      ui.registerUi('p1', 'conversation.header.action', { id: 'a6', actionId: 'x', placement: 'side' }, 'fn'),
    isHelmError('invalid_ui_spec'),
  );
  ui.registerUi('p1', 'conversation.header.action', { id: 'a7', actionId: 'x', placement: 'menu' }, 'fn');

  // kinds/roles 仅 timeline.entry.action 允许；roles 值域 user|assistant
  assert.throws(
    () => ui.registerUi('p1', 'conversation.row.action', { id: 'a8', actionId: 'x', kinds: ['k'] }, 'fn'),
    isHelmError('invalid_ui_spec'),
  );
  assert.throws(
    () => ui.registerUi('p1', 'conversation.row.action', { id: 'a9', actionId: 'x', roles: ['user'] }, 'fn'),
    isHelmError('invalid_ui_spec'),
  );
  assert.throws(
    () =>
      ui.registerUi('p1', 'timeline.entry.action', { id: 'a10', actionId: 'x', roles: ['other'] }, 'fn'),
    isHelmError('invalid_ui_spec'),
  );
  assert.throws(
    () => ui.registerUi('p1', 'timeline.entry.action', { id: 'a11', actionId: 'x', kinds: [] }, 'fn'),
    isHelmError('invalid_ui_spec'),
  );
  ui.registerUi('p1', 'timeline.entry.action', { id: 'a12', actionId: 'x', kinds: ['k'], roles: ['user'] }, 'fn');
});

test('priority/order 必须是有限安全整数', { timeout: 60_000 }, () => {
  const ui = new UiRegistry();
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

test('commandPalette：slash 格式、保留词与插件内重复', { timeout: 60_000 }, () => {
  const ui = new UiRegistry();
  registerCommand(ui, 'p1', 'cmd1', 'wf');
  registerCommand(ui, 'p1', 'cmd2'); // 无 slash 合法

  // 格式非法：前导 /、大写、非法字符、超长
  for (const bad of ['/wf', 'WF', 'a b', 'a#b', 'x'.repeat(66)]) {
    assert.throws(
      () => registerCommand(ui, 'p1', `cmd-bad`, bad),
      isHelmError('invalid_ui_spec'),
      `slash=${bad}`,
    );
  }
  // 宿主保留词与 skill: 前缀
  for (const reserved of ['new', 'clear', 'compact', 'skill:run']) {
    assert.throws(
      () => registerCommand(ui, 'p1', `cmd-res`, reserved),
      isHelmError('invalid_ui_spec'),
      `slash=${reserved}`,
    );
  }
  // 插件内重复 slash：409 duplicate_command_slash，details 携带 slash
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
  // 命令必须可触发：无 slash 且无三轨拒绝
  assert.throws(
    () => ui.registerUi('p1', 'commandPalette', { id: 'cmd-empty', title: 'E' }, 'command'),
    isHelmError('invalid_ui_spec'),
  );
  // json 轨命令合法，但 slash 必须有可执行动作，不能只显示候选却无法执行。
  ui.registerUi('p1', 'commandPalette', { id: 'cmd-json', title: 'J', json: { type: 'x' } }, 'command');
  assert.throws(
    () => ui.registerUi('p1', 'commandPalette', { id: 'slash-json', title: 'J', slash: 'json-only', json: {} }, 'command'),
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

test('profile.runtime：kind/label/agentSuggestions 形状与插件内重复 kind', { timeout: 60_000 }, () => {
  const ui = new UiRegistry();
  registerProfileRuntime(ui, 'p1', 'worker');
  registerProfileRuntime(ui, 'p1', 'watcher'); // 同插件不同 kind 合法

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
  // 插件内重复 kind：409 duplicate_profile_runtime_kind，details 携带 kind
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

test('assertCrossPluginUnique：active+pending 终检与自排除', { timeout: 60_000 }, () => {
  const ui = new UiRegistry();
  registerCommand(ui, 'a', 'cmd', 'wf');
  registerProfileRuntime(ui, 'a', 'worker');
  registerCommand(ui, 'b', 'cmd', 'wf'); // 与 a 冲突
  registerProfileRuntime(ui, 'b', 'worker'); // 与 a 冲突
  registerCommand(ui, 'c', 'cmd', 'other');
  registerProfileRuntime(ui, 'c', 'watcher');

  // 纯 registry 不缓存 active：无冲突命名空间下通过
  ui.assertCrossPluginUnique('c', ['a', 'c']);
  // pending=b 与 active a 冲突：slash 冲突（先命中）
  assert.throws(
    () => ui.assertCrossPluginUnique('b', ['a', 'c']),
    isHelmError('duplicate_command_slash'),
  );
  // 移除 b 的命令冲突后，kind 冲突命中
  ui.removePlugin('b');
  registerProfileRuntime(ui, 'b', 'worker');
  assert.throws(
    () => ui.assertCrossPluginUnique('b', ['a', 'c']),
    isHelmError('duplicate_profile_runtime_kind'),
  );

  // pending 同时出现在 active 列表中（如 host 传入含 pending 的全集）不误报自冲突
  const ui2 = new UiRegistry();
  registerCommand(ui2, 'a', 'cmd', 'wf');
  ui2.assertCrossPluginUnique('a', ['a']);

  // 无任何声明的 pending：通过
  const ui3 = new UiRegistry();
  ui3.assertCrossPluginUnique('empty', ['a', 'b']);
});

test('inactive probe 不占全局名字：默认停用注册不参与终检', { timeout: 60_000 }, () => {
  const ui = new UiRegistry();
  registerCommand(ui, 'probe', 'cmd', 'wf');
  registerProfileRuntime(ui, 'probe', 'worker');

  // probe（默认停用，未进入 active 集合）不占用名字：b 可启用同名 slash/kind
  ui.assertCrossPluginUnique('b', ['b']);
  registerCommand(ui, 'b', 'cmd', 'wf');
  registerProfileRuntime(ui, 'b', 'worker');

  // probe 之后转为启用（进入 active）时，后到者才被终检拒绝
  assert.throws(
    () => ui.assertCrossPluginUnique('probe', ['b', 'probe']),
    isHelmError('duplicate_command_slash'),
  );

  // 插件内重复 kind/slash 在 registerUi 边界即拒绝，无需终检参与
  assert.throws(
    () => ui.registerUi('b', 'commandPalette', { id: 'cmd2', title: 'C', slash: 'wf', actionId: 'x' }, 'command'),
    isHelmError('duplicate_command_slash'),
  );
});

test('clear/remove 后名字与声明释放', { timeout: 60_000 }, () => {
  const ui = new UiRegistry();
  registerCommand(ui, 'a', 'cmd', 'wf');
  registerProfileRuntime(ui, 'a', 'worker');
  ui.registerUi('a', 'sidebar.item', { id: 's1', label: 'S', docs: ['d1'] }, 'sidebarItem');

  // clear 清空声明：docs 校验不再要求，名字可被其他插件占用
  ui.clear('a');
  ui.assertUiDocsRegistered('a', () => false); // 无声明即通过
  assert.equal(ui.getUiByPlugin('a').length, 0);

  registerCommand(ui, 'b', 'cmd', 'wf');
  registerProfileRuntime(ui, 'b', 'worker');
  ui.assertCrossPluginUnique('b', ['b']);

  // removePlugin 整体删除：listUi(active) 不再出现
  ui.removePlugin('b');
  assert.equal(ui.listUi(['b']).length, 0);
  ui.assertCrossPluginUnique('b', ['b']); // 无声明通过
});
