/**
 * Pure-model tests for the profile available-skills configuration:
 * skills tri-state normalization / section row model / allowlist toggle guards
 * (directly tests profile-editor-skills-model and profile-editor-model)
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SkillSummary } from '@helmx/protocol'
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
