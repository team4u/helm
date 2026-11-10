/**
 * 声明式动作指令求值（纯逻辑）。
 *
 * 三个标准指令（与内核内置插件的真实写法一一对应）：
 * - helm:action：{ type: 'helm:action', actionId, input?, pluginId? }
 * - helm:open  ：{ type: 'helm:open', target, split? }
 * - helm:send  ：{ type: 'helm:send', target?, text, whenBusy? }
 *   仅当 target 字段完全省略（undefined/null）或显式写 'current' /
 *   'conversation:current' 时才回退到当前会话（defaultConversationId）；
 *   声明里明确提供了 target 时，求值结果 undefined/null/空串/非法值一律
 *   显式 invalid（整串模板表达式路径缺失会求值出 undefined，静默回退会把
 *   消息发错会话），绝不带 default 回退。
 *
 * 求值规则：input / target / text 都是模板值，经 evaluateSpecValue 在当前
 * scope（含 $row / $value / $data）求值，保持原始 JS 类型（数字不转字符串）。
 */
import { evaluateSpecValue, type EvalScope } from './evaluator.js'

export type SpecAction =
  | { type: 'helm:action'; actionId: string; input?: Record<string, unknown>; pluginId?: string }
  | { type: 'helm:open'; target: string; split?: boolean }
  | { type: 'helm:send'; target?: string; text: string; whenBusy?: 'steer' | 'followUp' | 'reject' }

export interface ResolvedSpecAction {
  kind: 'action'
  actionId: string
  pluginId?: string
  input: Record<string, unknown>
}

export interface ResolvedSpecOpen {
  kind: 'open'
  target: string
  split: boolean
}

export interface ResolvedSpecSend {
  kind: 'send'
  conversationId: number
  text: string
  whenBusy?: 'steer' | 'followUp' | 'reject'
}

export type ResolvedSpecDirective = ResolvedSpecAction | ResolvedSpecOpen | ResolvedSpecSend

/** 安全正整数会话 ID 判定（含 2^53 上界，拒绝 Infinity/小数/0/负数）。 */
function safeConversationId(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * helm:send 目标解析：
 * - undefined（字段缺省）或显式 'current' / 'conversation:current' → 默认会话；
 * - number 正整数 / 'conversation:<id>' / 纯数字字符串 → 定向 ID；
 * - null / 空串 / 空白串（常见于模板求值失败）与其它非法值 → null（显式 invalid，绝不静默路由）。
 */
export function parseSendTarget(target: unknown, defaultConversationId?: number): number | null {
  const useDefault = (): number | null => safeConversationId(defaultConversationId)
  if (target === undefined) return useDefault()
  if (typeof target === 'number') return safeConversationId(target)
  if (typeof target !== 'string') return null
  const trimmed = target.trim()
  if (trimmed === '') return null
  if (trimmed === 'current' || trimmed === 'conversation:current') return useDefault()
  if (trimmed.startsWith('conversation:')) {
    return safeConversationId(Number(trimmed.slice('conversation:'.length).trim()))
  }
  if (/^\d+$/.test(trimmed)) return safeConversationId(Number(trimmed))
  return null
}

/**
 * 求值一条声明式动作（未知 type / 非法载荷返回 kind: 'invalid' 描述）。
 * evaluateSpecValue 递归求 input：`{ workerConversationId: '{$row.conversationId}' }`
 * 在 $row 注入后保持 number；`{ enabled: '{$value}' }` 保持 boolean。
 */
export function resolveSpecAction(
  raw: unknown,
  scope: EvalScope,
  defaultConversationId?: number,
): ResolvedSpecDirective | { kind: 'invalid'; message: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'invalid', message: 'action 不是对象' }
  }
  const action = raw as Record<string, unknown>
  const type = action['type']

  if (type === 'helm:action') {
    const actionId = action['actionId']
    if (typeof actionId !== 'string' || actionId.trim() === '') {
      return { kind: 'invalid', message: 'helm:action 缺少 actionId' }
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

  if (type === 'helm:open') {
    const target = evaluateSpecValue<string>(action['target'], scope)
    if (typeof target !== 'string' || target.trim() === '') {
      return { kind: 'invalid', message: 'helm:open 求值后 target 为空' }
    }
    return { kind: 'open', target, split: action['split'] === true }
  }

  if (type === 'helm:send') {
    // 原始字段检查：声明里明确提供了 target（非 undefined）且不是显式 current 时，
    // 求值结果 undefined/null/空都必须 invalid——整串模板表达式路径缺失会求值出
    // undefined，把它当「省略」回退默认会话会把消息发错会话（浏览器实测 bug）。
    const rawTarget = action['target']
    const explicitCurrent =
      typeof rawTarget === 'string' &&
      (rawTarget.trim() === 'current' || rawTarget.trim() === 'conversation:current')
    const evaluatedTarget = evaluateSpecValue(rawTarget, scope)
    // 仅字段完全缺省（undefined）或显式 current 才允许回退默认会话；
    // null、空串、求值失败的模板都是「声明里明确提供了 target」，一律 invalid
    //（整串模板表达式路径缺失会求值出 undefined，静默回退会把消息发错会话）。
    const targetOmitted = rawTarget === undefined || explicitCurrent
    const conversationId = targetOmitted
      ? parseSendTarget(explicitCurrent ? 'current' : undefined, defaultConversationId)
      : parseSendTarget(evaluatedTarget, undefined)
    if (conversationId === null) {
      const hasDefault = safeConversationId(defaultConversationId) !== null
      return {
        kind: 'invalid',
        message: targetOmitted
          ? 'helm:send 缺少 target 且当前视图无默认会话：请显式指定 conversation:<id>'
          : hasDefault
            ? `helm:send target 求值后无效（${JSON.stringify(evaluatedTarget) ?? String(evaluatedTarget)}，通常为模板路径缺失）：应为 conversation:<id> 或正整数`
            : 'helm:send target 无效：应为 conversation:<id>、正整数或显式 current',
      }
    }
    const text = evaluateSpecValue<string>(action['text'], scope)
    if (typeof text !== 'string' || text.trim() === '') {
      return { kind: 'invalid', message: 'helm:send 求值后 text 为空' }
    }
    // whenBusy 有值但不合法 → 显式 invalid（不静默丢弃拼写错误）
    const whenBusyRaw = evaluateSpecValue(action['whenBusy'], scope)
    if (whenBusyRaw !== undefined && whenBusyRaw !== null && whenBusyRaw !== 'steer' && whenBusyRaw !== 'followUp' && whenBusyRaw !== 'reject') {
      return { kind: 'invalid', message: `helm:send whenBusy 无效：${String(whenBusyRaw)}（应为 steer | followUp | reject）` }
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

  return { kind: 'invalid', message: `未知的动作类型: ${String(type)}` }
}
