/**
 * Display copy for the builtin:json-render client (pure copy table +
 * parameterized builders, no component exports — Fast Refresh friendly).
 *
 * Boundary discipline (what is localized here vs. what passes through):
 * - Only chrome produced by the plugin itself lives here: fallback labels,
 *   submit-state confirmations, degraded-spec callouts and action-result
 *   notifications, all resolved against the active host locale;
 * - Anything read out of the DSL spec (titles, labels, option text, table
 *   cells, empty-state text declared by the model) is model output and is
 *   rendered verbatim — never translated, never wrapped;
 * - Error details returned by the host (action failures, thrown messages)
 *   pass through unchanged inside a localized prefix, mirroring the other
 *   plugin clients.
 */
import type { HelmxLocale, LocalizedText } from '@helmx/plugin-client'
import { resolveLocalizedText } from '@helmx/plugin-client'

// ---------------------------------------------------------------------------
// Card chrome (index.tsx)
// ---------------------------------------------------------------------------

/** ViewBoundary label shown when the card subtree crashes. */
export const JSON_RENDER_VIEW_LABEL: LocalizedText = { en: 'JSON card', 'zh-CN': 'JSON 卡片' }

/** Title of the degraded-spec callout (invalid UI declaration). */
export const JSON_RENDER_INVALID_SPEC_TITLE: LocalizedText = {
  en: 'Invalid UI declaration',
  'zh-CN': '界面声明无效',
}

/** Fallback when a degraded node carries no readable reason. */
export const JSON_RENDER_UNKNOWN_REASON: LocalizedText = { en: 'unknown reason', 'zh-CN': '未知原因' }

/** Toast prefix when a declared action fails validation. */
export function jsonRenderInvalidActionNotify(message: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Invalid declarative action: ${message}`, 'zh-CN': `声明式动作无效：${message}` },
    locale,
  )
}

/** Toast after an action request is submitted to its plugin. */
export function jsonRenderActionSubmittedNotify(actionId: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Action request submitted: ${actionId}`, 'zh-CN': `动作请求已提交：${actionId}` },
    locale,
  )
}

/** Toast after a card command is sent to the current conversation. */
export function jsonRenderSentCommandNotify(text: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Card command sent: ${text}`, 'zh-CN': `已发送卡片指令：${text}` },
    locale,
  )
}

/** Toast after text is sent to another conversation. */
export function jsonRenderSentToNotify(conversationId: number, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Sent to conversation #${conversationId}`, 'zh-CN': `已发送到会话 #${conversationId}` },
    locale,
  )
}

/** Toast when an action request fails (host error detail passes through). */
export function jsonRenderActionFailedNotify(actionId: string, error: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Action ${actionId} failed: ${error}`, 'zh-CN': `动作 ${actionId} 执行失败：${error}` },
    locale,
  )
}

/** Toast when sending to a conversation fails (host error detail passes through). */
export function jsonRenderSendFailedNotify(conversationId: number, error: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    {
      en: `Failed to send to conversation #${conversationId}: ${error}`,
      'zh-CN': `发送到会话 #${conversationId} 失败：${error}`,
    },
    locale,
  )
}

/** Toast when opening a screen / artifact target fails (detail passes through). */
export function jsonRenderOpenFailedNotify(error: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Failed to open target: ${error}`, 'zh-CN': `打开目标失败：${error}` },
    locale,
  )
}

// ---------------------------------------------------------------------------
// Degraded-spec reasons (spec-normalize.ts; rendered in the degraded callout)
// ---------------------------------------------------------------------------

export function jsonRenderSpecNotObject(locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: 'Spec is empty or not an object; cannot render', 'zh-CN': 'Spec 为空或不是对象，无法渲染' },
    locale,
  )
}

export function jsonRenderElementReused(id: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    {
      en: `Element ${id} is referenced more than once (not allowed outside a DAG)`,
      'zh-CN': `元素 ${id} 被重复引用（DAG 之外不允许）`,
    },
    locale,
  )
}

export function jsonRenderElementCycle(id: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Element ${id} has a circular reference`, 'zh-CN': `元素 ${id} 存在循环引用` },
    locale,
  )
}

export function jsonRenderFlatRootMissing(rootId: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Flat spec root element '${rootId}' is missing or invalid`, 'zh-CN': `扁平 Spec 的根元素 '${rootId}' 缺失或非法` },
    locale,
  )
}

export function jsonRenderMissingComponentField(locale: HelmxLocale): string {
  return resolveLocalizedText(
    {
      en: 'Spec is missing the component/type field (neither the tree shorthand nor the flat form)',
      'zh-CN': 'Spec 缺少 component/type 字段（既非树状简写也非扁平形态）',
    },
    locale,
  )
}

export function jsonRenderRootNormalizeFailed(locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: 'Failed to normalize the spec root node', 'zh-CN': 'Spec 根节点归一化失败' },
    locale,
  )
}

// ---------------------------------------------------------------------------
// Declarative-action validation messages (spec-action.ts; surfaced via notify)
// ---------------------------------------------------------------------------

export function jsonRenderActionNotObject(locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: 'action is not an object', 'zh-CN': 'action 不是对象' },
    locale,
  )
}

export function jsonRenderActionMissingActionId(locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: 'helmx:action is missing actionId', 'zh-CN': 'helmx:action 缺少 actionId' },
    locale,
  )
}

export function jsonRenderOpenTargetEmpty(locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: 'helmx:open target evaluated to an empty value', 'zh-CN': 'helmx:open 求值后 target 为空' },
    locale,
  )
}

export function jsonRenderSendNoTargetNoDefault(locale: HelmxLocale): string {
  return resolveLocalizedText(
    {
      en: 'helmx:send has no target and the current view has no default conversation; specify conversation:<id> explicitly',
      'zh-CN': 'helmx:send 缺少 target 且当前视图无默认会话：请显式指定 conversation:<id>',
    },
    locale,
  )
}

export function jsonRenderSendTargetEvaluatedInvalid(value: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    {
      en: `helmx:send target is invalid after evaluation (${value}, usually a missing template path); expected conversation:<id> or a positive integer`,
      'zh-CN': `helmx:send target 求值后无效（${value}，通常为模板路径缺失）：应为 conversation:<id> 或正整数`,
    },
    locale,
  )
}

export function jsonRenderSendTargetInvalid(locale: HelmxLocale): string {
  return resolveLocalizedText(
    {
      en: 'helmx:send target is invalid; expected conversation:<id>, a positive integer, or an explicit current',
      'zh-CN': 'helmx:send target 无效：应为 conversation:<id>、正整数或显式 current',
    },
    locale,
  )
}

export function jsonRenderSendTextEmpty(locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: 'helmx:send text evaluated to an empty value', 'zh-CN': 'helmx:send 求值后 text 为空' },
    locale,
  )
}

export function jsonRenderSendWhenBusyInvalid(raw: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    {
      en: `helmx:send whenBusy is invalid: ${raw} (expected steer | followUp | reject)`,
      'zh-CN': `helmx:send whenBusy 无效：${raw}（应为 steer | followUp | reject）`,
    },
    locale,
  )
}

export function jsonRenderUnknownActionType(type: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Unknown action type: ${type}`, 'zh-CN': `未知的动作类型: ${type}` },
    locale,
  )
}

// ---------------------------------------------------------------------------
// Primitive chrome (spec-primitives.tsx) — fallback labels only; anything the
// model declared in the spec passes through verbatim
// ---------------------------------------------------------------------------

/** Header of the trailing row-actions column in Table. */
export const JSON_RENDER_TABLE_ACTIONS_HEADER: LocalizedText = { en: 'Actions', 'zh-CN': '操作' }

/** Empty-state text when Table has no rows and no spec-declared empty text. */
export const JSON_RENDER_TABLE_EMPTY: LocalizedText = { en: 'No data', 'zh-CN': '暂无数据' }

/** Fallback label for a row-action / ActionBar button without a declared label. */
export const JSON_RENDER_ACTION_LABEL_FALLBACK: LocalizedText = { en: 'Action', 'zh-CN': '操作' }

/** Fallback label for a Button without a declared label. */
export const JSON_RENDER_BUTTON_LABEL_FALLBACK: LocalizedText = { en: 'Button', 'zh-CN': '按钮' }

/** TextInput inline submit button states. */
export const JSON_RENDER_INPUT_SUBMIT: LocalizedText = { en: 'Submit', 'zh-CN': '提交' }
export const JSON_RENDER_INPUT_SUBMITTING: LocalizedText = { en: 'Submitting', 'zh-CN': '提交中' }
export const JSON_RENDER_INPUT_SUBMITTED: LocalizedText = { en: 'Submitted', 'zh-CN': '已提交' }

/** Marker appended to a TextInput label when its value is masked as a secret. */
export const JSON_RENDER_SECRET_TAG: LocalizedText = { en: ' (secret)', 'zh-CN': '（机密）' }

/** Inline hint under a CheckboxGroup while its change action is in flight. */
export const JSON_RENDER_SUBMITTING_HINT: LocalizedText = { en: 'Submitting…', 'zh-CN': '正在提交...' }

/** Slot primitive misuse notices. */
export const JSON_RENDER_SLOT_MISSING_NAME: LocalizedText = {
  en: 'Slot primitive is missing the name prop',
  'zh-CN': 'Slot 原语缺少 name 属性',
}
export const JSON_RENDER_SLOT_NO_HOST: LocalizedText = {
  en: 'Slot primitive is only available inside plugin views (chat code blocks have no plugin host)',
  'zh-CN': 'Slot 原语仅在插件视图内可用（聊天代码块无插件宿主）',
}

/** Fallback title of a Steps item without a declared title/label. */
export function jsonRenderStepFallbackTitle(index: number, locale: HelmxLocale): string {
  return resolveLocalizedText({ en: `Step ${index}`, 'zh-CN': `步骤 ${index}` }, locale)
}

/** Fallback title of a Tabs item without a declared label/title. */
export function jsonRenderTabFallbackTitle(index: number, locale: HelmxLocale): string {
  return resolveLocalizedText({ en: `Tab ${index}`, 'zh-CN': `标签页 ${index}` }, locale)
}

/** Notice for a spec node whose component name has no registered primitive. */
export function jsonRenderUnknownComponent(component: string, locale: HelmxLocale): string {
  return resolveLocalizedText(
    { en: `Unregistered component: ${component}`, 'zh-CN': `未注册的组件: ${component}` },
    locale,
  )
}
