/**
 * Pure-model tests for the profile available-skills configuration:
 * skills tri-state normalization / section row model / allowlist toggle guards
 * (directly tests profile-editor-skills-model and profile-editor-model),
 * plus SSR coverage for the drawer allowlist list rendering description
 * summaries (summarizeSingleLine collapse + truncation).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Profile, SkillSummary } from '@helmx/protocol'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
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
import { summarizeSingleLine } from '../src/lib/format.js'
import { ProfileDetailDrawer } from '../src/profiles/ProfileDetailDrawer.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'
import { readHostStyles } from './helpers/host-styles.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React
const SKILLS_CSS = readHostStyles()

// ---------------------------------------------------------------------------
// Pure model: skills tri-state normalization (profile-editor-model)
// ---------------------------------------------------------------------------

test('normalizeProfileConfig: the skills tri-state is preserved in full; [] and undefined never normalize into each other', { timeout: 60_000 }, () => {
  // undefined: the key is absent (follow all)
  const all = buildProfileSavePayload(createDraft({ id: 'p', tags: [] }), { isNew: false })
  assert.equal('skills' in all, false)

  // []: explicitly disable all — an empty array is an explicit user choice and must not normalize to undefined
  const none = buildProfileSavePayload(createDraft({ id: 'p', tags: [], skills: [] }), { isNew: false })
  assert.deepEqual(none.skills, [])

  // Allowlist: kept verbatim (stale entries included, never silently deleted)
  const allow = buildProfileSavePayload(
    createDraft({ id: 'p', tags: [], skills: ['review', 'ghost-skill'] }),
    { isNew: false },
  )
  assert.deepEqual(allow.skills, ['review', 'ghost-skill'])

  // Not edited (only other fields changed): nothing is lost either
  const edited = editProfileField(createDraft({ id: 'p', tags: [], skills: [] }), { name: '改名' })
  assert.deepEqual(buildProfileSavePayload(edited, { isNew: false }).skills, [])

  // Allowlist + other field edits: preserved in full (stale entries included)
  const editedAllow = editProfileField(
    createDraft({ id: 'p', tags: [], skills: ['review', 'ghost-skill'] }),
    { name: '改名' },
  )
  assert.deepEqual(buildProfileSavePayload(editedAllow, { isNew: false }).skills, ['review', 'ghost-skill'])
})

test('dirty detection: unchanged skills must not misreport dirty (undefined and [] compared against their own baselines)', { timeout: 60_000 }, () => {
  assert.equal(isDraftDirty(createDraft({ id: 'p', tags: [], skills: [] })), false)
  assert.equal(isDraftDirty(createDraft({ id: 'p', tags: [] })), false)
  const edited = editProfileField(createDraft({ id: 'p', tags: [] }), { skills: [] })
  assert.equal(isDraftDirty(edited), true, 'undefined -> [] is an explicit change')
})

// ---------------------------------------------------------------------------
// Pure model: skills section row model (profile-editor-skills-model)
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

test('skillsEditMode / skillsForEditMode: tri-state round trips', { timeout: 60_000 }, () => {
  assert.equal(skillsEditMode(undefined), 'all')
  assert.equal(skillsEditMode([]), 'none')
  assert.equal(skillsEditMode(['a']), 'allowlist')

  assert.equal(skillsForEditMode(['a'], 'all'), undefined)
  assert.deepEqual(skillsForEditMode(undefined, 'none'), [])
  assert.deepEqual(skillsForEditMode(undefined, 'allowlist'), [])
  assert.deepEqual(skillsForEditMode(['a', 'b'], 'allowlist'), ['a', 'b'])
})

test('toggleSkillInAllowlist: checking unselectable skills (disabled/missing) is rejected', { timeout: 60_000 }, () => {
  const selectable = new Set(['review', 'tally'])
  assert.deepEqual(toggleSkillInAllowlist([], 'review', true, selectable), ['review'])
  assert.deepEqual(toggleSkillInAllowlist(['review'], 'review', false, selectable), [])
  // Disabled managed skills and unknown ids cannot be checked
  assert.deepEqual(toggleSkillInAllowlist([], 'herdr-tool', true, selectable), [])
  assert.deepEqual(toggleSkillInAllowlist([], 'ghost', true, selectable), [])
  // Duplicate additions are idempotent
  assert.deepEqual(toggleSkillInAllowlist(['review'], 'review', true, selectable), ['review'])
})

test('buildSkillsSectionModel: visible / unavailable partitions and retention semantics', { timeout: 60_000 }, () => {
  const enabled = new Set(['builtin:profile'])
  // undefined mode: all visible skills listed, no stale rows
  const all = buildSkillsSectionModel(undefined, CATALOG, enabled)
  assert.deepEqual(all.visible.map((r) => r.skill.id), ['review', 'tally'])
  assert.equal(all.unavailable.length, 0)

  // Allowlist with a disabled managed skill + a missing id: the disabled skill goes to unavailable (removable); the missing id becomes a fallback row
  const rows = buildSkillsSectionModel(['review', 'herdr-tool', 'ghost-skill'], CATALOG, enabled)
  assert.deepEqual(rows.visible.filter((r) => r.checked).map((r) => r.skill.id), ['review'])
  const herdrRow = rows.unavailable.find((r) => r.skill.id === 'herdr-tool')
  assert.ok(herdrRow)
  assert.equal(herdrRow.pluginDisabled, true)
  assert.equal(herdrRow.selectable, false)
  const ghostRow = rows.unavailable.find((r) => r.skill.id === 'ghost-skill')
  assert.ok(ghostRow)
  assert.equal(ghostRow.missing, true)

  // A disabled skill not checked into the allowlist produces no stale row (only checked entries stay visible)
  const notChecked = buildSkillsSectionModel(['review'], CATALOG, enabled)
  assert.equal(notChecked.unavailable.length, 0)

  // Once the plugin is enabled the disabled skill returns to the visible partition
  const enabledHerdr = buildSkillsSectionModel(['herdr-tool'], CATALOG, new Set(['builtin:profile', 'builtin:herdr']))
  assert.deepEqual(enabledHerdr.visible.map((r) => r.skill.id), ['review', 'tally', 'herdr-tool'])
  assert.equal(enabledHerdr.unavailable.length, 0)
})

// ---------------------------------------------------------------------------
// Skill description summaries (summarizeSingleLine + drawer SSR)
// ---------------------------------------------------------------------------

test('summarizeSingleLine: 空白折叠为单行、边界与截断省略号', { timeout: 60_000 }, () => {
  assert.equal(summarizeSingleLine(undefined), '')
  assert.equal(summarizeSingleLine('   \n\t  '), '')
  assert.equal(summarizeSingleLine('审查当前改动。'), '审查当前改动。')
  // 换行与连续空白折叠为单个空格（SKILL.md 块标量描述跨行）
  assert.equal(summarizeSingleLine('第一行\n  第二行\t\t第三行'), '第一行 第二行 第三行')
  // 恰好等于上限：原样返回；超限：截断到 maxChars-1 并补省略号
  const exact = 'a'.repeat(120)
  assert.equal(summarizeSingleLine(exact), exact)
  assert.equal(summarizeSingleLine(`${exact}x`), `${'a'.repeat(119)}…`)
  // 截断在代理对（emoji）边界上不切割半个字符
  const emoji = '😀'.repeat(130)
  const cut = summarizeSingleLine(emoji)
  assert.ok(Array.from(cut).every((ch) => ch === '😀' || ch === '…'))
  assert.equal(Array.from(cut).length, 120)
})

test('ProfileDetailDrawer: 技能白名单列表渲染名称行与描述摘要（无描述技能不渲染摘要行）', { timeout: 60_000 }, () => {
  const longDesc = `开头 ${'很'.repeat(200)} 结尾`
  const profile: Profile = { id: 'helper', name: '助手', tags: [], skills: [] }
  const skills: SkillSummary[] = [
    { id: 'review', name: '代码审查', description: '审查当前改动。\n第二步核对一致性。', references: [] },
    { id: 'tally', name: '记账', references: [] },
    { id: 'long', name: '长描述', description: longDesc, references: [] },
  ]
  const store = makeTestStore({ profiles: [profile], models: [], skills })
  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, { profile, isNew: false, open: true, inline: true, onClose: () => {} }),
    ),
  )
  // 名称行始终渲染；描述摘要换行折叠为空格后出现
  assert.match(html, /代码审查/)
  assert.match(html, /审查当前改动。 第二步核对一致性。/)
  // 无描述技能：只有名称行，不产生空的摘要节点（按 tally 名称行计数校验）
  assert.match(html, /记账/)
  const tallyDescNodes = html.split(/<span class="profile-skill-desc"/).length - 1
  assert.equal(tallyDescNodes, 2, '仅带描述的两个技能渲染摘要节点')
  // 超长描述按 summarizeSingleLine 截断（与展示层同源计算）
  const expected = summarizeSingleLine(longDesc)
  assert.ok(expected.endsWith('…'))
  assert.ok(html.includes(`>${expected}</span>`), '摘要节点内容与 summarizeSingleLine 一致')
  // title 悬浮保留完整原文（含被截断的结尾）
  assert.ok(html.includes(`title="${longDesc}"`), 'title 保留完整描述供悬浮查看')
  // CSS 原语存在
  assert.match(SKILLS_CSS, /\.profile-skill-desc/)
})
