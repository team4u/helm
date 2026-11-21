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
import { MAX_MEMORY_CHARS } from './models.js'

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

/** Editor size counters (`n / 4000 chars`, optionally with line count). */
export function memoryCharCount(chars: number, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `${chars} / ${MAX_MEMORY_CHARS} chars`, 'zh-CN': `${chars} / ${MAX_MEMORY_CHARS} 字符` },
    locale,
  )
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

// ---------------------------------------------------------------------------
// Dream (daily auto-consolidation) copy and formatters (pure module, Fast Refresh friendly)
// ---------------------------------------------------------------------------

/** Heading of the dream sub-block. */
export const MEMORY_DREAM_TITLE: LocalizedText = {
  en: 'Daily auto-organize (Dream)',
  'zh-CN': '每日自动整理（Dream）',
}

/** Two-digit local hour label. */
export function memoryDreamHour(hour: number, locale: HelmxLocale): string {
  return resolveLocalizedText({ en: `daily ${String(hour).padStart(2, '0')}:00`, 'zh-CN': `每天 ${String(hour).padStart(2, '0')}:00` }, locale)
}

/** Schedule line: "<daily hh:00> · <timezone>" or the paused hint. */
export function memoryDreamSchedule(
  config: { enabled: boolean; hour: number; timezone: string },
  locale: HelmxLocale,
): string {
  if (!config.enabled) return resolveLocalizedText({ en: 'paused', 'zh-CN': '已暂停' }, locale)
  return `${memoryDreamHour(config.hour, locale)} · ${config.timezone}`
}

/** Candidate count pill. */
export function memoryDreamCandidates(count: number, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `${count} pending candidate${count === 1 ? '' : 's'}`, 'zh-CN': `${count} 条待整理候选` },
    locale,
  )
}

/** Shared clock formatter for dream meta rows (host locale, same practice as the web app's absolute timestamps). */
function formatDreamTime(ms: number, locale: HelmxLocale): string {
  return Number.isFinite(ms) ? new Date(ms).toLocaleString(locale) : String(ms)
}

/** Last-run summary line (absent when never ran). */
export function memoryDreamLastRun(
  record: { lastRunAt?: number; ran: boolean; applied?: boolean; conflict?: boolean; reason?: string; error?: string },
  locale: HelmxLocale,
): string {
  const prefix = resolveLocalizedText({ en: 'last run', 'zh-CN': '上次整理' }, locale)
  const when = record.lastRunAt !== undefined ? formatDreamTime(record.lastRunAt, locale) : undefined
  const head = when === undefined ? prefix : `${prefix} ${when}`
  if (!record.ran) {
    const reason =
      record.reason === 'no_candidates'
        ? undefined
        : record.reason === 'no_conversation_for_model'
          ? resolveLocalizedText({ en: 'no conversation to resolve the model', 'zh-CN': '无会话可解析模型' }, locale)
          : record.reason === 'memory_missing'
            ? resolveLocalizedText({ en: 'MEMORY.md missing', 'zh-CN': 'MEMORY.md 缺失' }, locale)
            : record.reason
    return reason === undefined ? `${head}: ${resolveLocalizedText({ en: 'skipped (no candidates)', 'zh-CN': '跳过（无候选）' }, locale)}`
      : `${head}: ${resolveLocalizedText({ en: 'skipped', 'zh-CN': '跳过' }, locale)} (${reason})`
  }
  if (record.conflict) {
    return `${head}: ${resolveLocalizedText({ en: 'abandoned (memory edited during the dream)', 'zh-CN': '放弃写回（整理期间记忆被修改）' }, locale)}`
  }
  if (record.applied) {
    return `${head}: ${resolveLocalizedText({ en: 'applied', 'zh-CN': '已应用' }, locale)}`
  }
  return `${head}: ${resolveLocalizedText({ en: 'failed', 'zh-CN': '失败' }, locale)}`
}

/** Next scheduled run line (only while the schedule is enabled and the backend reports one). */
export function memoryDreamNextRun(nextRunAt: number, locale: HelmxLocale): string {
  const label = resolveLocalizedText({ en: 'next run', 'zh-CN': '下次运行' }, locale)
  return `${label} ${formatDreamTime(nextRunAt, locale)}`
}

/** Short diagnostic of the most recent failed run (backend bounds it to 300 chars; display caps to one tidy line). */
export function memoryDreamLastError(error: string, locale: HelmxLocale): string {
  const label = resolveLocalizedText({ en: 'last error', 'zh-CN': '上次诊断' }, locale)
  const cap = 160
  const text = error.length > cap ? `${error.slice(0, cap)}…` : error
  return `${label}: ${text}`
}

/** Manual run result line. */
export function memoryDreamRunResult(
  result: { ran: boolean; applied?: boolean; conflict?: boolean; reason?: string; consumed?: number },
  locale: HelmxLocale,
): string {
  if (!result.ran) {
    if (result.reason === 'no_candidates') {
      return resolveLocalizedText({ en: 'No candidates to organize yet.', 'zh-CN': '暂无可整理的候选。' }, locale)
    }
    if (result.reason === 'no_conversation_for_model') {
      return resolveLocalizedText(
        { en: 'No conversation of this profile exists to resolve the model; dream skipped.', 'zh-CN': '该角色暂无会话可解析生效模型，已跳过整理。' },
        locale,
      )
    }
    if (result.reason === 'memory_missing') {
      return resolveLocalizedText({ en: 'MEMORY.md does not exist; dream skipped.', 'zh-CN': 'MEMORY.md 不存在，已跳过整理。' }, locale)
    }
    return resolveLocalizedText({ en: `Skipped (${result.reason ?? 'unknown'}).`, 'zh-CN': `已跳过（${result.reason ?? '未知'}）。` }, locale)
  }
  if (result.conflict) {
    return resolveLocalizedText(
      { en: 'Memory was edited while the dream ran; write-back abandoned, candidates kept.', 'zh-CN': '整理期间记忆被修改，已放弃写回，候选保留。' },
      locale,
    )
  }
  if (result.applied) {
    const n = result.consumed ?? 0
    return resolveLocalizedText(
      { en: `Dream applied (${n} candidate${n === 1 ? '' : 's'} merged).`, 'zh-CN': `整理完成（合并 ${n} 条候选）。` },
      locale,
    )
  }
  return resolveLocalizedText({ en: 'Dream ran but nothing was applied.', 'zh-CN': '整理已运行但未应用改动。' }, locale)
}

export const MEMORY_DREAM_RUN: LocalizedText = { en: 'Organize now', 'zh-CN': '立即整理' }
export const MEMORY_DREAM_RUNNING: LocalizedText = { en: 'Organizing…', 'zh-CN': '整理中…' }
export const MEMORY_DREAM_DRAFT_KEPT: LocalizedText = {
  en: 'Unsaved edits in the editor were kept (based on the pre-dream text); saving them will replace the organized memory.',
  'zh-CN': '已保留编辑区未保存的修改（基于整理前文本）；保存将覆盖整理后的记忆。',
}
export const MEMORY_DREAM_REFRESH_FAILED: LocalizedText = {
  en: 'The organized memory was applied, but the editor failed to reload it; the editor still shows the previous version.',
  'zh-CN': '整理后的记忆已写入，但编辑区正文刷新失败，编辑器仍显示旧版本。',
}
export const MEMORY_DREAM_PAUSE: LocalizedText = { en: 'Pause auto', 'zh-CN': '暂停自动' }
export const MEMORY_DREAM_RESUME: LocalizedText = { en: 'Resume auto', 'zh-CN': '恢复自动' }
export const MEMORY_DREAM_GLOBAL_HINT: LocalizedText = {
  en: 'The schedule is global for all profiles; pausing stops the daily consolidation only (collection keeps running, manual "Organize now" still works).',
  'zh-CN': '调度为全角色共用；暂停仅停止每日自动整理（候选照常收集，可随时手动「立即整理」）。',
}
export const MEMORY_DREAM_LOAD_FAILED: LocalizedText = {
  en: 'Dream status unavailable; manual organizing still works.',
  'zh-CN': '整理状态暂不可用；手动「立即整理」不受影响。',
}
export const MEMORY_DREAM_STATUS_LOADING: LocalizedText = {
  en: 'Loading dream status…',
  'zh-CN': '整理状态加载中…',
}
export const MEMORY_DREAM_MALFORMED: LocalizedText = {
  en: 'Dream status response is malformed.',
  'zh-CN': '整理状态响应格式不正确。',
}
