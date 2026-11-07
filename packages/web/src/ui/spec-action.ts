/**
 * 声明式动作指令求值（纯逻辑）。
 *
 * 三个标准指令（与内核内置插件的真实写法一一对应）：
 * - helm:action：{ type: 'helm:action', actionId, input?, pluginId? }
 * - helm:open  ：{ type: 'helm:open', target, split? }
 * - helm:send  ：{ type: 'helm:send', target: 'conversation:<id>', text }
 *
 * 求值规则：input / target / text 都是模板值，经 evaluateSpecValue 在当前
 * scope（含 $row / $value / $data）求值，保持原始 JS 类型（数字不转字符串）。
 */
import { evaluateSpecValue, type EvalScope } from './evaluator.js'

export type SpecAction =
  | { type: 'helm:action'; actionId: string; input?: Record<string, unknown>; pluginId?: string }
  | { type: 'helm:open'; target: string; split?: boolean }
  | { type: 'helm:send'; target: string; text: string }

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
}

export type ResolvedSpecDirective = ResolvedSpecAction | ResolvedSpecOpen | ResolvedSpecSend

/** helm:send 目标：'conversation:12' 或纯数字字符串。 */
export function parseSendTarget(target: unknown): number | null {
  if (typeof target !== 'string') return null
  const trimmed = target.trim()
  if (trimmed.startsWith('conversation:')) {
    const idNum = Number(trimmed.slice('conversation:'.length).trim())
    return Number.isInteger(idNum) && idNum > 0 ? idNum : null
  }
  const direct = Number(trimmed)
  return Number.isInteger(direct) && direct > 0 ? direct : null
}

/**
 * 求值一条声明式动作（未知 type / 非法载荷返回 kind: 'invalid' 描述）。
 * evaluateSpecValue 递归求 input：`{ workerConversationId: '{$row.conversationId}' }`
 * 在 $row 注入后保持 number；`{ enabled: '{$value}' }` 保持 boolean。
 */
export function resolveSpecAction(raw: unknown, scope: EvalScope): ResolvedSpecDirective | { kind: 'invalid'; message: string } {
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
    const conversationId = parseSendTarget(evaluateSpecValue(action['target'], scope))
    if (conversationId === null) {
      return { kind: 'invalid', message: 'helm:send 目标必须是 conversation:<id>' }
    }
    const text = evaluateSpecValue<string>(action['text'], scope)
    if (typeof text !== 'string' || text.trim() === '') {
      return { kind: 'invalid', message: 'helm:send 求值后 text 为空' }
    }
    return { kind: 'send', conversationId, text }
  }

  return { kind: 'invalid', message: `未知的动作类型: ${String(type)}` }
}
