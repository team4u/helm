/**
 * Declarative action directive resolution (pure logic).
 *
 * Three standard directives (mirroring the real-world spellings inside the
 * kernel's built-in plugins):
 * - helmx:action: { type: 'helmx:action', actionId, input?, pluginId? }
 * - helmx:open  : { type: 'helmx:open', target, split? }
 * - helmx:send  : { type: 'helmx:send', target?, text, whenBusy? }
 *   Falling back to the current conversation (defaultConversationId) is only
 *   allowed when the target field is entirely omitted (undefined/null) or
 *   explicitly written as 'current' / 'conversation:current'; when the
 *   declaration explicitly provides a target, an evaluated result of
 *   undefined/null/empty/invalid is always an explicit invalid (a
 *   whole-template expression with a missing path evaluates to undefined —
 *   silently falling back would send the message to the wrong conversation),
 *   never a default fallback.
 *
 * Evaluation rules: input / target / text are template values evaluated via
 * evaluateSpecValue in the current scope (including $row / $value / $data),
 * preserving raw JS types (numbers stay numbers).
 *
 * Invalid-kind messages are display copy surfaced to the user via host
 * notifications, so they resolve against the host locale (execution errors
 * from the host pass through unchanged).
 */
import type { HelmxLocale } from '@helmx/plugin-client'
import { DEFAULT_HELMX_LOCALE } from '@helmx/plugin-client'
import { evaluateSpecValue, type EvalScope } from './evaluator.js'
import {
  jsonRenderActionMissingActionId,
  jsonRenderActionNotObject,
  jsonRenderOpenTargetEmpty,
  jsonRenderSendNoTargetNoDefault,
  jsonRenderSendTargetEvaluatedInvalid,
  jsonRenderSendTargetInvalid,
  jsonRenderSendTextEmpty,
  jsonRenderSendWhenBusyInvalid,
  jsonRenderUnknownActionType,
} from './copy.ts'

interface ResolvedSpecAction {
  kind: 'action'
  actionId: string
  pluginId?: string
  input: Record<string, unknown>
}

interface ResolvedSpecOpen {
  kind: 'open'
  target: string
  split: boolean
}

interface ResolvedSpecSend {
  kind: 'send'
  conversationId: number
  text: string
  whenBusy?: 'steer' | 'followUp' | 'reject'
}

type ResolvedSpecDirective = ResolvedSpecAction | ResolvedSpecOpen | ResolvedSpecSend

/** Safe positive-integer conversation id check (with the 2^53 bound; rejects Infinity/fractions/0/negatives). */
function safeConversationId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * helmx:send target resolution:
 * - undefined (field omitted) or explicit 'current' / 'conversation:current' -> the default conversation;
 * - a positive integer / 'conversation:<id>' / a pure digit string -> the targeted id;
 * - null / empty / blank strings (typical products of failed template
 *   evaluation) and any other invalid value -> null (explicitly invalid,
 *   never silently routed).
 */
export function parseSendTarget(target: unknown, defaultConversationId?: number): number | null {
  const resolveDefault = (): number | null => safeConversationId(defaultConversationId)
  if (target === undefined) return resolveDefault()
  if (typeof target === 'number') return safeConversationId(target)
  if (typeof target !== 'string') return null
  const trimmed = target.trim()
  if (trimmed === '') return null
  if (trimmed === 'current' || trimmed === 'conversation:current') return resolveDefault()
  if (trimmed.startsWith('conversation:')) {
    return safeConversationId(Number(trimmed.slice('conversation:'.length).trim()))
  }
  if (/^\d+$/.test(trimmed)) return safeConversationId(Number(trimmed))
  return null
}

/**
 * Resolve one declarative action (unknown type / invalid payload returns a
 * kind: 'invalid' description). evaluateSpecValue recurses into input:
 * `{ workerConversationId: '{$row.conversationId}' }` keeps the number once
 * $row is injected; `{ enabled: '{$value}' }` keeps the boolean.
 */
export function resolveSpecAction(
  raw: unknown,
  scope: EvalScope,
  defaultConversationId?: number,
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): ResolvedSpecDirective | { kind: 'invalid'; message: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'invalid', message: jsonRenderActionNotObject(locale) }
  }
  const action = raw as Record<string, unknown>
  const type = action['type']

  if (type === 'helmx:action') {
    const actionId = action['actionId']
    if (typeof actionId !== 'string' || actionId.trim() === '') {
      return { kind: 'invalid', message: jsonRenderActionMissingActionId(locale) }
    }
    const inputRaw = evaluateSpecValue(action['input'] ?? {}, scope)
    const input =
      inputRaw !== null && typeof inputRaw === 'object' && !Array.isArray(inputRaw)
        ? (inputRaw as Record<string, unknown>)
        : {}
    const pluginIdRaw = action['pluginId']
    return {
      kind: 'action',
      actionId,
      ...(typeof pluginIdRaw === 'string' && pluginIdRaw !== '' ? { pluginId: pluginIdRaw } : {}),
      input,
    }
  }

  if (type === 'helmx:open') {
    const target = evaluateSpecValue<string>(action['target'], scope)
    if (typeof target !== 'string' || target.trim() === '') {
      return { kind: 'invalid', message: jsonRenderOpenTargetEmpty(locale) }
    }
    return { kind: 'open', target, split: action['split'] === true }
  }

  if (type === 'helmx:send') {
    // Raw-field check: when the declaration explicitly provides a target (not
    // undefined) that is not an explicit current, an evaluated result of
    // undefined/null/empty must be invalid — a whole-template expression with
    // a missing path evaluates to undefined, and treating that as "omitted"
    // would fall back to the default conversation and send the message to the
    // wrong conversation (a bug observed in the browser).
    const rawTarget = action['target']
    const explicitCurrent =
      typeof rawTarget === 'string' &&
      (rawTarget.trim() === 'current' || rawTarget.trim() === 'conversation:current')
    const evaluatedTarget = evaluateSpecValue(rawTarget, scope)
    // Only a fully omitted field (undefined) or an explicit current may fall
    // back to the default conversation; null, empty strings and failed
    // template evaluations all mean "the declaration explicitly provided a
    // target" and are invalid (a whole-template expression with a missing
    // path evaluates to undefined — silently falling back would send the
    // message to the wrong conversation).
    const targetOmitted = rawTarget === undefined || explicitCurrent
    const conversationId = targetOmitted
      ? parseSendTarget(explicitCurrent ? 'current' : undefined, defaultConversationId)
      : parseSendTarget(evaluatedTarget, undefined)
    if (conversationId === null) {
      const hasDefault = safeConversationId(defaultConversationId) !== null
      return {
        kind: 'invalid',
        message: targetOmitted
          ? jsonRenderSendNoTargetNoDefault(locale)
          : hasDefault
            ? jsonRenderSendTargetEvaluatedInvalid(JSON.stringify(evaluatedTarget) ?? String(evaluatedTarget), locale)
            : jsonRenderSendTargetInvalid(locale),
      }
    }
    const text = evaluateSpecValue<string>(action['text'], scope)
    if (typeof text !== 'string' || text.trim() === '') {
      return { kind: 'invalid', message: jsonRenderSendTextEmpty(locale) }
    }
    // whenBusy present but invalid -> explicit invalid (typos are not silently dropped)
    const whenBusyRaw = evaluateSpecValue(action['whenBusy'], scope)
    if (whenBusyRaw !== undefined && whenBusyRaw !== null && whenBusyRaw !== 'steer' && whenBusyRaw !== 'followUp' && whenBusyRaw !== 'reject') {
      return { kind: 'invalid', message: jsonRenderSendWhenBusyInvalid(String(whenBusyRaw), locale) }
    }
    return {
      kind: 'send',
      conversationId,
      text,
      ...(whenBusyRaw === 'steer' || whenBusyRaw === 'followUp' || whenBusyRaw === 'reject'
        ? { whenBusy: whenBusyRaw }
        : {}),
    }
  }

  return { kind: 'invalid', message: jsonRenderUnknownActionType(String(type), locale) }
}
