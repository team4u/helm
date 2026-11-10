/**
 * Profile 可用技能配置纯模型测试：
 * skills 三态归一 / 区块行模型 / 白名单切换守卫（直测 profile-editor-skills-model 与 profile-editor-model）
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SkillSummary } from '@helm/protocol'
import {
  buildProfileSavePayload,
  createDraft,
  editProfileField,
  isDraftDirty,
} from '../src/modals/profile-editor-model.js'
import {
  buildSkillsSectionModel,
  skillsEditMode,
  skillsForEditMode,
  toggleSkillInAllowlist,
} from '../src/modals/profile-editor-skills-model.js'

// ---------------------------------------------------------------------------
// 纯模型：skills 三态归一（profile-editor-model）
// ---------------------------------------------------------------------------

test('normalizeProfileConfig：skills 三态全量保留，[] 与 undefined 差异不归一', { timeout: 60_000 }, () => {
  // undefined：不携带键（跟随全部）
  const all = buildProfileSavePayload(createDraft({ id: 'p', tags: [] }), { isNew: false })
  assert.equal('skills' in all, false)

  // []：显式禁用全部——空数组是用户显式选择，不得归一为 undefined
  const none = buildProfileSavePayload(createDraft({ id: 'p', tags: [], skills: [] }), { isNew: false })
  assert.deepEqual(none.skills, [])

  // 白名单：原样保留（含已失效条目，不暗中删除）
  const allow = buildProfileSavePayload(
    createDraft({ id: 'p', tags: [], skills: ['review', 'ghost-skill'] }),
    { isNew: false },
  )
  assert.deepEqual(allow.skills, ['review', 'ghost-skill'])

  // 未编辑（只改别的字段）也不丢
  const edited = editProfileField(createDraft({ id: 'p', tags: [], skills: [] }), { name: '改名' })
  assert.deepEqual(buildProfileSavePayload(edited, { isNew: false }).skills, [])

  // 白名单 + 改其它字段：全量保留（含失效条目）
  const editedAllow = editProfileField(
    createDraft({ id: 'p', tags: [], skills: ['review', 'ghost-skill'] }),
    { name: '改名' },
  )
  assert.deepEqual(buildProfileSavePayload(editedAllow, { isNew: false }).skills, ['review', 'ghost-skill'])
})

test('dirty 判定：skills 未变时不可误报 dirty（undefined 与 [] 基线各自比较）', { timeout: 60_000 }, () => {
  assert.equal(isDraftDirty(createDraft({ id: 'p', tags: [], skills: [] })), false)
  assert.equal(isDraftDirty(createDraft({ id: 'p', tags: [] })), false)
  const edited = editProfileField(createDraft({ id: 'p', tags: [] }), { skills: [] })
  assert.equal(isDraftDirty(edited), true, 'undefined -> [] 是显式修改')
})

// ---------------------------------------------------------------------------
// 纯模型：技能区块行模型（profile-editor-skills-model）
// ---------------------------------------------------------------------------

const skill = (id: string, overrides: Partial<SkillSummary> = {}): SkillSummary => ({
  id,
  name: `技能 ${id}`,
  references: [],
  ...overrides,
})

const CATALOG: SkillSummary[] = [
  skill('review'),
  skill('tally'),
  skill('herdr-tool', { managedByPlugin: 'builtin:herdr' }),
]

test('skillsEditMode / skillsForEditMode：三态往返', { timeout: 60_000 }, () => {
  assert.equal(skillsEditMode(undefined), 'all')
  assert.equal(skillsEditMode([]), 'none')
  assert.equal(skillsEditMode(['a']), 'allowlist')

  assert.equal(skillsForEditMode(['a'], 'all'), undefined)
  assert.deepEqual(skillsForEditMode(undefined, 'none'), [])
  assert.deepEqual(skillsForEditMode(undefined, 'allowlist'), [])
  assert.deepEqual(skillsForEditMode(['a', 'b'], 'allowlist'), ['a', 'b'])
})

test('toggleSkillInAllowlist：不可选技能（停用/缺失）勾选请求被拒绝', { timeout: 60_000 }, () => {
  const selectable = new Set(['review', 'tally'])
  assert.deepEqual(toggleSkillInAllowlist([], 'review', true, selectable), ['review'])
  assert.deepEqual(toggleSkillInAllowlist(['review'], 'review', false, selectable), [])
  // 停用托管技能与未知 id 不可勾选
  assert.deepEqual(toggleSkillInAllowlist([], 'herdr-tool', true, selectable), [])
  assert.deepEqual(toggleSkillInAllowlist([], 'ghost', true, selectable), [])
  // 重复添加幂等
  assert.deepEqual(toggleSkillInAllowlist(['review'], 'review', true, selectable), ['review'])
})

test('buildSkillsSectionModel：可见 / 不可用分区与保留语义', { timeout: 60_000 }, () => {
  const enabled = new Set(['builtin:profile'])
  // undefined 模式：全部可见技能列出、无失效行
  const all = buildSkillsSectionModel(undefined, CATALOG, enabled)
  assert.deepEqual(all.visible.map((r) => r.skill.id), ['review', 'tally'])
  assert.equal(all.unavailable.length, 0)

  // 白名单含停用托管技能 + 缺失 id：停用技能进 unavailable（可移除），缺失 id 兜底成行
  const rows = buildSkillsSectionModel(['review', 'herdr-tool', 'ghost-skill'], CATALOG, enabled)
  assert.deepEqual(rows.visible.filter((r) => r.checked).map((r) => r.skill.id), ['review'])
  const herdrRow = rows.unavailable.find((r) => r.skill.id === 'herdr-tool')
  assert.ok(herdrRow)
  assert.equal(herdrRow.pluginDisabled, true)
  assert.equal(herdrRow.selectable, false)
  const ghostRow = rows.unavailable.find((r) => r.skill.id === 'ghost-skill')
  assert.ok(ghostRow)
  assert.equal(ghostRow.missing, true)

  // 停用技能未被勾入白名单时不产生失效行（仅勾选过的才保留展示）
  const notChecked = buildSkillsSectionModel(['review'], CATALOG, enabled)
  assert.equal(notChecked.unavailable.length, 0)

  // 插件启用后停用技能回到可见区
  const enabledHerdr = buildSkillsSectionModel(['herdr-tool'], CATALOG, new Set(['builtin:profile', 'builtin:herdr']))
  assert.deepEqual(enabledHerdr.visible.map((r) => r.skill.id), ['review', 'tally', 'herdr-tool'])
  assert.equal(enabledHerdr.unavailable.length, 0)
})
