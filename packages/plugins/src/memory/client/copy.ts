/**
 * Display copy for the builtin:memory profile section (pure copy table, no
 * component exports — Fast Refresh friendly).
 *
 * Every human-visible string of the memory client resolves through these
 * LocalizedText entries against the active host locale; backend action
 * payloads and error messages pass through unchanged.
 */
import type { HelmxLocale, LocalizedText } from '@helmx/plugin-client'
import { resolveLocalizedText } from '@helmx/plugin-client'

/** Section heading shown in the profile detail drawer. */
export const MEMORY_SECTION_TITLE: LocalizedText = {
  en: 'Long-term memory (MEMORY.md)',
  'zh-CN': '长期记忆 (MEMORY.md)',
}

/** Hint for a profile that has not been created yet. */
export const MEMORY_NEW_PROFILE_HINT: LocalizedText = {
  en: 'After saving and creating the profile, you can enable or disable its long-term memory here and edit MEMORY.md.',
  'zh-CN': '保存并创建角色后，可在此开启或关闭该角色的长期记忆并编辑 MEMORY.md。',
}

/** Accessible label for the enable/disable switch. */
export const MEMORY_SWITCH_LABEL: LocalizedText = {
  en: 'Enable long-term memory',
  'zh-CN': '启用长期记忆',
}

/** Busy / idle states before the first load completes. */
export const MEMORY_LOADING: LocalizedText = { en: 'Loading memory…', 'zh-CN': '加载记忆中…' }
export const MEMORY_NOT_LOADED: LocalizedText = { en: 'Memory state not loaded', 'zh-CN': '尚未加载记忆状态' }

/** Load failure notice; the enable state stays untouched, so say so. */
export const MEMORY_LOAD_FAILED: LocalizedText = {
  en: 'Cannot read the memory state; the enable state of this profile was left unchanged.',
  'zh-CN': '无法读取记忆状态，未更改此 Profile 的启用状态。',
}
export const MEMORY_RETRY: LocalizedText = { en: 'Retry', 'zh-CN': '重试' }

/** Explanation when long-term memory is disabled for the profile. */
export const MEMORY_DISABLED_HINT: LocalizedText = {
  en: 'Long-term memory is disabled for this profile: MEMORY.md is not injected into conversations and the update_memory tool is not provided. The switch takes effect immediately; saved memory content stays on disk.',
  'zh-CN': '已为此角色关闭长期记忆：对话中不会注入 MEMORY.md，也不会提供 update_memory 工具。开关即时生效，已保存的记忆内容保留在磁盘上。',
}

/** Editor size counters (`n / 65536 chars`, optionally with line count). */
export function memoryCharCount(chars: number, locale: HelmxLocale): string {
  return resolveLocalizedText({ en: `${chars} / 65536 chars`, 'zh-CN': `${chars} / 65536 字符` }, locale)
}
export function memoryLineCount(lines: number, locale: HelmxLocale): string {
  return resolveLocalizedText({ en: ` · ${lines} lines`, 'zh-CN': ` · ${lines} 行` }, locale)
}

/** Editor placeholder and accessible name. */
export const MEMORY_PLACEHOLDER: LocalizedText = {
  en: 'Full long-term memory of this profile (Markdown supported)…',
  'zh-CN': '该角色的长期记忆全文（支持 Markdown）…',
}
export const MEMORY_TEXTAREA_LABEL: LocalizedText = { en: 'Long-term memory', 'zh-CN': '长期记忆' }

/** Save button busy / idle states and the dirty marker. */
export const MEMORY_SAVING: LocalizedText = { en: 'Saving…', 'zh-CN': '保存中…' }
export const MEMORY_SAVE: LocalizedText = { en: 'Save memory', 'zh-CN': '保存记忆' }
export const MEMORY_DIRTY_HINT: LocalizedText = {
  en: 'Unsaved changes (memory content is saved independently; it is not rolled back with "Cancel profile editing")',
  'zh-CN': '有未保存的修改（记忆内容独立保存，不随「取消角色编辑」回滚）',
}
