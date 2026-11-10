import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PluginConfigFieldSchema, Profile } from '@helm/protocol'
import {
  buildPluginConfigPayload,
  configFieldInitialValue,
  secretConfigured,
} from '../src/modals/plugin-config-form-model.js'
import {
  argsTextToArgs,
  argsToText,
  buildProfileSavePayload,
  createDraft,
  editProfileField,
  editRuntime,
  isDraftDirty,
  normalizeRuntime,
  textToTags,
} from '../src/modals/profile-editor-model.js'

// ---------------------------------------------------------------------------
// 插件配置表单：secret 掩码不得覆盖真实密钥
// ---------------------------------------------------------------------------

const SECRET_SCHEMA: Record<string, PluginConfigFieldSchema> = {
  apiKey: { type: 'string', secret: true, required: true, label: 'API Key' },
  baseUrl: { type: 'string', default: 'https://api.example.com' },
  retries: { type: 'number', default: 3 },
  verbose: { type: 'boolean', default: false },
}

test('secret 字段初始值恒为空串：服务端掩码 ****** 绝不灌入表单', { timeout: 60_000 }, () => {
  // GET config 对已配置 secret 返回 '******'（见 kernel redactConfigValues）
  assert.equal(configFieldInitialValue(SECRET_SCHEMA.apiKey!, '******'), '')
  assert.equal(configFieldInitialValue(SECRET_SCHEMA.apiKey!, ''), '')
  assert.equal(configFieldInitialValue({ type: 'string', secret: true }, '真实密钥也不会回显'), '')
  assert.equal(configFieldInitialValue({ type: 'string', secret: true, default: 'secret-default' }, undefined), '')
})

test('非 secret 字段初始值回显服务端值或 schema default', { timeout: 60_000 }, () => {
  assert.equal(configFieldInitialValue(SECRET_SCHEMA.baseUrl!, 'https://override.example.com'), 'https://override.example.com')
  assert.equal(configFieldInitialValue(SECRET_SCHEMA.baseUrl!, undefined), 'https://api.example.com')
  assert.equal(configFieldInitialValue(SECRET_SCHEMA.retries!, 7), 7)
  assert.equal(configFieldInitialValue(SECRET_SCHEMA.retries!, undefined), 3)
  assert.equal(configFieldInitialValue(SECRET_SCHEMA.verbose!, true), true)
  assert.equal(configFieldInitialValue({ type: 'boolean' }, undefined), false)
  assert.equal(configFieldInitialValue({ type: 'number' }, undefined), 0)
  assert.equal(configFieldInitialValue({ type: 'string' }, undefined), '')
})

test('未改动 secret 的保存载荷省略该字段：六颗星与空串都不入载荷', { timeout: 60_000 }, () => {
  // 用户打开表单（secret 初始为空）后不改任何 secret 直接保存
  const values = {
    apiKey: '', // secret 未改动
    baseUrl: 'https://override.example.com',
    retries: 3,
    verbose: true,
  }
  const payload = buildPluginConfigPayload(SECRET_SCHEMA, values)
  assert.equal('apiKey' in payload, false, '未改动的 secret 必须省略，服务端保持已存密钥')
  assert.deepEqual(payload, { baseUrl: 'https://override.example.com', retries: 3, verbose: true })
})

test('已修改 secret 的保存载荷包含新值；仅输入空白的 secret 视为未改动', { timeout: 60_000 }, () => {
  const payload = buildPluginConfigPayload(SECRET_SCHEMA, {
    apiKey: 'sk-new-value',
    baseUrl: 'https://api.example.com',
    retries: 3,
    verbose: false,
  })
  assert.equal(payload.apiKey, 'sk-new-value')

  const blank = buildPluginConfigPayload(SECRET_SCHEMA, {
    apiKey: '   ',
    baseUrl: 'https://api.example.com',
    retries: 3,
    verbose: false,
  })
  assert.equal('apiKey' in blank, false, '空白输入视为未改动')
})

test('掩码本身绝不会被当成新密钥提交', { timeout: 60_000 }, () => {
  // 即使异常路径把掩码灌进了表单值，载荷构造也必须丢弃它
  const payload = buildPluginConfigPayload(SECRET_SCHEMA, {
    apiKey: '******',
    baseUrl: 'x',
    retries: 1,
    verbose: false,
  })
  assert.equal('apiKey' in payload, false)
})

test('secretConfigured 仅由服务端原始值判断占位提示', { timeout: 60_000 }, () => {
  assert.equal(secretConfigured('******'), true)
  assert.equal(secretConfigured(''), false)
  assert.equal(secretConfigured(undefined), false)
  assert.equal(secretConfigured(123), false)
})

// ---------------------------------------------------------------------------
// ProfileEditorModal：PUT 整体替换语义的完整基础配置 + system/memory 按需提交
//（真实链路：routes.ts PUT /profiles/:id → profiles.save → 整体重写 profile.json；
//  省 system/memory 表示不动 SYSTEM.md / MEMORY.md，见 profile-binding 组合测试）
// ---------------------------------------------------------------------------

function baseProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'coder',
    name: '代码工人',
    model: 'zhipu/glm-4.6',
    nodeId: 'gpu-node',
    cwd: '/srv/work',
    tags: ['worker'],
    runtime: { kind: 'herdr', agent: 'agy', nodeId: 'ops-box', workspace: '/srv/herdr' },
    system: '# SYSTEM\n基础提示词',
    memory: '# MEMORY\n旧记忆',
    ...overrides,
  }
}

test('仅改展示名：载荷仍携带完整基础配置，不丢节点/目录/运行时；system / memory 省略', { timeout: 60_000 }, () => {
  const draft = createDraft(baseProfile())
  const next = editProfileField(draft, { name: '重构工人' })
  const payload = buildProfileSavePayload(next, { isNew: false })
  assert.equal(payload.name, '重构工人')
  assert.equal(payload.model, 'zhipu/glm-4.6', 'PUT 整体替换：未改的 model 必须随载荷保留')
  assert.equal(payload.nodeId, 'gpu-node', '只改名不丢执行节点')
  assert.equal(payload.cwd, '/srv/work', '只改名不丢工作目录')
  assert.deepEqual(payload.tags, ['worker'])
  assert.deepEqual(payload.runtime, { kind: 'herdr', agent: 'agy', nodeId: 'ops-box', workspace: '/srv/herdr' }, '只改名不丢外部运行时')
  assert.equal('system' in payload, false, '未编辑 system 时必须省略')
  assert.equal('memory' in payload, false, '未编辑 memory 时必须省略（保护 Agent 追加的新记忆）')
})

test('未做任何修改：载荷为完整规范化基础配置，dirty 为 false', { timeout: 60_000 }, () => {
  const draft = createDraft(baseProfile())
  assert.equal(isDraftDirty(draft), false)
  const payload = buildProfileSavePayload(draft, { isNew: false })
  assert.deepEqual(payload, {
    id: 'coder',
    name: '代码工人',
    model: 'zhipu/glm-4.6',
    nodeId: 'gpu-node',
    cwd: '/srv/work',
    tags: ['worker'],
    runtime: { kind: 'herdr', agent: 'agy', nodeId: 'ops-box', workspace: '/srv/herdr' },
  })
})

test('基线无可选字段：载荷仍提交骨架（tags 空数组），不携带 undefined 键', { timeout: 60_000 }, () => {
  const draft = createDraft({ id: 'bare', tags: undefined })
  assert.equal(isDraftDirty(draft), false)
  const payload = buildProfileSavePayload(draft, { isNew: false })
  assert.deepEqual(payload, { id: 'bare', tags: [] })
  assert.equal('nodeId' in payload, false)
  assert.equal('cwd' in payload, false)
  assert.equal('runtime' in payload, false)
  assert.equal('system' in payload, false)
  assert.equal('memory' in payload, false)
})

test('显式编辑过 memory 才提交 memory 全文', { timeout: 60_000 }, () => {
  const draft = createDraft(baseProfile())
  const edited = {
    ...draft,
    profile: { ...draft.profile, memory: '# MEMORY\n新记忆' },
    editedFields: new Set<'system' | 'memory'>(['memory']),
  }
  const payload = buildProfileSavePayload(edited, { isNew: false })
  assert.equal(payload.memory, '# MEMORY\n新记忆')
  assert.equal('system' in payload, false)
})

test('新建 Profile：提交完整基础配置 + 当前 system / memory 全文', { timeout: 60_000 }, () => {
  const draft = createDraft({ ...baseProfile(), id: 'reviewer', system: '# 新提示词', memory: '' })
  const payload = buildProfileSavePayload(draft, { isNew: true })
  assert.equal(payload.id, 'reviewer')
  assert.equal(payload.name, '代码工人')
  assert.equal(payload.model, 'zhipu/glm-4.6')
  assert.equal(payload.nodeId, 'gpu-node')
  assert.equal(payload.cwd, '/srv/work')
  assert.deepEqual(payload.tags, ['worker'])
  assert.deepEqual(payload.runtime, { kind: 'herdr', agent: 'agy', nodeId: 'ops-box', workspace: '/srv/herdr' })
  assert.equal(payload.system, '# 新提示词')
  assert.equal(payload.memory, '')
})

// ---------------------------------------------------------------------------
// runtime.args：每行一个参数，带空格参数保真
// ---------------------------------------------------------------------------

test('argsTextToArgs 每行一个参数且保留参数内部空格', { timeout: 60_000 }, () => {
  assert.deepEqual(argsTextToArgs('--model\nglm-4.6'), ['--model', 'glm-4.6'])
  assert.deepEqual(argsTextToArgs('--title\n周报 草稿 v2'), ['--title', '周报 草稿 v2'])
  assert.deepEqual(argsTextToArgs('  --trim  \n\n  --keep inner  \n'), ['--trim', '--keep inner'])
  assert.deepEqual(argsTextToArgs(''), [])
})

test('argsToText 与 argsTextToArgs 往返保真（不按空格拆分）', { timeout: 60_000 }, () => {
  const args = ['--prompt', 'fix the bug now', '--title', '周报 草稿']
  assert.deepEqual(argsTextToArgs(argsToText(args)), args)
})

test('normalizeRuntime：空 nodeId/workspace/env/args 省略，参数仅 trim 边界', { timeout: 60_000 }, () => {
  const normalized = normalizeRuntime({
    kind: 'herdr',
    agent: 'agy',
    nodeId: '   ',
    workspace: '',
    args: ['  --keep inner  ', ''],
    env: { EMPTY_KEY: '' },
  })
  assert.deepEqual(normalized, { kind: 'herdr', agent: 'agy', args: ['--keep inner'], env: { EMPTY_KEY: '' } })
  assert.equal('nodeId' in normalized, false)
  assert.equal('workspace' in normalized, false)
})

test('normalizeRuntime：runtime 整体可被清空（关闭 Herdr 运行时）', { timeout: 60_000 }, () => {
  assert.equal(normalizeRuntime(undefined), undefined)
})

test('runtime 随载荷完整规范化提交；关闭（undefined）时才省略', { timeout: 60_000 }, () => {
  const draft = createDraft(baseProfile({ runtime: { kind: 'herdr', agent: 'agy', nodeId: '  ' } }))
  // 未修改的 runtime 也随完整载荷提交（规范化后空白 nodeId 省略）。
  const unchanged = buildProfileSavePayload(draft, { isNew: false })
  assert.deepEqual(unchanged.runtime, { kind: 'herdr', agent: 'agy' })

  const edited = editRuntime(draft, { kind: 'herdr', agent: 'agy', nodeId: '  ', args: ['--title', '周报 草稿'] })
  assert.equal(isDraftDirty(edited), true)
  const payload = buildProfileSavePayload(edited, { isNew: false })
  assert.deepEqual(payload.runtime, { kind: 'herdr', agent: 'agy', args: ['--title', '周报 草稿'] })
})

test('关闭外部运行时：载荷省略 runtime 键，整体替换即删除', { timeout: 60_000 }, () => {
  const draft = createDraft(baseProfile())
  const closed = editRuntime(draft, undefined)
  assert.equal(isDraftDirty(closed), true)
  const payload = buildProfileSavePayload(closed, { isNew: false })
  assert.equal('runtime' in payload, false)
  assert.equal(payload.nodeId, 'gpu-node', '关闭 runtime 不影响顶层执行节点')
})

// ---------------------------------------------------------------------------
// Profile 顶层 nodeId / cwd（普通会话执行默认节点与工作目录，与 runtime.nodeId 不同层级）
// ---------------------------------------------------------------------------

test('顶层 nodeId / cwd 修改进入载荷并置 dirty；清空归一为省略（删除覆盖，回退 local）', { timeout: 60_000 }, () => {
  const draft = createDraft(baseProfile())
  // 未修改：不 dirty。
  assert.equal(isDraftDirty(draft), false)

  // 修改：进入载荷并置 dirty。
  const edited = editProfileField(draft, { nodeId: 'gpu-node-2', cwd: '/srv/work2' })
  assert.equal(isDraftDirty(edited), true)
  const payload = buildProfileSavePayload(edited, { isNew: false })
  assert.equal(payload.nodeId, 'gpu-node-2')
  assert.equal(payload.cwd, '/srv/work2')
  assert.equal(payload.model, 'zhipu/glm-4.6')

  // 清空（空白归一为省略）：整体替换语义下删除覆盖，节点回退本机 local。
  const blank = editProfileField(draft, { nodeId: '  ', cwd: '' })
  assert.equal(isDraftDirty(blank), true)
  const blankPayload = buildProfileSavePayload(blank, { isNew: false })
  assert.equal('nodeId' in blankPayload, false, '清空 nodeId 即从 profile.json 删除该键')
  assert.equal('cwd' in blankPayload, false, '清空 cwd 即从 profile.json 删除该键')
  assert.equal(blankPayload.name, '代码工人', '清空节点不影响其他字段')
})

test('顶层 nodeId / cwd 与基线同值时不视为 dirty', { timeout: 60_000 }, () => {
  const base = baseProfile({ nodeId: 'gpu-node', cwd: '/srv/work' })
  const draft = createDraft(base)
  assert.equal(isDraftDirty(draft), false)
  const resubmitted = editProfileField(draft, { nodeId: 'gpu-node', cwd: '/srv/work' })
  assert.equal(isDraftDirty(resubmitted), false)
  const payload = buildProfileSavePayload(resubmitted, { isNew: false })
  assert.equal(payload.nodeId, 'gpu-node')
  assert.equal(payload.cwd, '/srv/work')
  assert.deepEqual(payload.runtime, { kind: 'herdr', agent: 'agy', nodeId: 'ops-box', workspace: '/srv/herdr' })
})

// ---------------------------------------------------------------------------
// tags：普通标签编辑，不涉及生命周期语义
// ---------------------------------------------------------------------------

test('textToTags 逗号分隔解析（coder 等角色提示就是普通 tag）', { timeout: 60_000 }, () => {
  assert.deepEqual(textToTags('worker, coder'), ['worker', 'coder'])
  assert.deepEqual(textToTags(' a , , b '), ['a', 'b'])
  assert.deepEqual(textToTags(''), [])
})

test('tags 修改随完整载荷提交；清空时提交空数组（整体替换语义可清空）', { timeout: 60_000 }, () => {
  const draft = createDraft(baseProfile())
  const edited = editProfileField(draft, { tags: ['worker', 'coder'] })
  const payload = buildProfileSavePayload(edited, { isNew: false })
  assert.deepEqual(payload.tags, ['worker', 'coder'])

  const cleared = editProfileField(draft, { tags: [] })
  const clearedPayload = buildProfileSavePayload(cleared, { isNew: false })
  assert.deepEqual(clearedPayload.tags, [], 'PUT 整体替换：空数组即从磁盘清空 tags')
  assert.equal(clearedPayload.name, '代码工人')
})

test('model 清空与修改：trim 后空串归一为省略（删除覆盖，回退默认模型）', { timeout: 60_000 }, () => {
  const draft = createDraft(baseProfile({ model: 'zhipu/glm-4.6' }))
  const cleared = buildProfileSavePayload(editProfileField(draft, { model: '  ' }), { isNew: false })
  assert.equal('model' in cleared, false)

  const changed = buildProfileSavePayload(editProfileField(draft, { model: 'zhipu/glm-5' }), { isNew: false })
  assert.equal(changed.model, 'zhipu/glm-5')
})

test('载荷永不携带 system / memory 以外的 Profile 大文本快照（防 Object.assign 泄漏）', { timeout: 60_000 }, () => {
  // draft.profile 携带加载时的大文本快照；未编辑时载荷绝不含这两个键。
  const payload = buildProfileSavePayload(createDraft(baseProfile()), { isNew: false })
  assert.equal('system' in payload, false)
  assert.equal('memory' in payload, false)
  // 编辑其他字段也不会把大文本带出。
  const edited = editProfileField(createDraft(baseProfile()), { name: '重构工人' })
  const editedPayload = buildProfileSavePayload(edited, { isNew: false })
  assert.equal('system' in editedPayload, false)
  assert.equal('memory' in editedPayload, false)
})

test('大文本字段一经编辑即 dirty（即使内容改回原文仍提交，保守不丢数据）', { timeout: 60_000 }, () => {
  const draft = createDraft(baseProfile())
  const edited: typeof draft = {
    ...draft,
    profile: { ...draft.profile, memory: draft.profile.memory },
    editedFields: new Set(['memory']),
  }
  assert.equal(isDraftDirty(edited), true)
})
