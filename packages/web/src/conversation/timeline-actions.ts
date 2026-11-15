/**
 * 时间线行级动作服务（分叉 / 排队撤回转编辑）：ConversationTimeline 统一
 * 实例化一次，行组件经回调 props 消费——渲染组件不各自直调会话 API。
 * - forkFromHere：从指定 entryId 分叉新会话，成功后默认分屏打开并通知；
 *   失败显式通知，不静默、不抛出；
 * - withdrawQueuedForEdit：撤回排队输入并转入编辑——withdrawn 回填原文本，
 *   already_placed / settled 以落库 entryId 原地编辑，其余状态警告提示。
 * 本模块只导出 hook 与纯类型（无组件），保持 .ts Fast Refresh 约定。
 */
import { useHelmStore } from '../lib/store-context.js'
import { useStableCallback } from '../lib/use-stable-callback.js'
import { conversationsApi } from '../lib/api.js'
import type { ConversationSummary } from '@helm/protocol'
import type { EditRequestTarget } from './timeline-model.js'

export interface TimelineEntryActions {
  /** 从指定 entryId 分叉新会话（成功后分屏打开新会话并通知；失败显式通知，不抛出）。 */
  forkFromHere: (entryId: string) => Promise<void>
  /** 撤回排队输入并转入编辑：按撤回结果选择原地编辑锚点或警告提示（不抛出）。 */
  withdrawQueuedForEdit: (subId: string, target: EditRequestTarget) => Promise<void>
}

export function useTimelineEntryActions(
  conversation: ConversationSummary,
  onRequestEdit: (target: EditRequestTarget) => void,
): TimelineEntryActions {
  const store = useHelmStore()

  const forkFromHere = useStableCallback(async (entryId: string): Promise<void> => {
    try {
      const forked = await conversationsApi.fork(conversation.id, entryId)
      store.openTarget({ kind: 'conversation', conversationId: forked.id }, { split: store.splitTarget === null })
      store.pushNotice({
        type: 'notification',
        level: 'info',
        title: '已创建分叉会话',
        body: `#${forked.id} ${forked.title}`,
        conversationId: forked.id,
      })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '分叉失败',
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    }
  })

  const withdrawQueuedForEdit = useStableCallback(async (subId: string, target: EditRequestTarget): Promise<void> => {
    try {
      const res = await conversationsApi.withdraw(conversation.id, subId)
      if (res.status === 'withdrawn') {
        onRequestEdit(target)
      } else if ((res.status === 'already_placed' || res.status === 'settled') && res.entryId !== undefined) {
        onRequestEdit({ text: target.text, entryId: res.entryId, ...(target.attachments !== undefined ? { attachments: target.attachments } : {}) })
      } else {
        store.pushNotice({
          type: 'notification',
          level: 'warning',
          title: '无法撤回排队消息',
          body: `提交已进入执行（status=${res.status}）`,
          conversationId: conversation.id,
        })
      }
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '撤回排队消息失败',
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    }
  })

  return { forkFromHere, withdrawQueuedForEdit }
}
