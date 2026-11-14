/**
 * triggers/delivery.ts：cron 与 webhook 共用的投递 helper。
 *
 * 目标解析（§4.4，与 superagent trigger hook 的路由互补）：
 * - envelope.targetConversationId 优先（与第二参 targetProfileId 互斥）；
 * - 仅 targetProfileId：取该 Profile 现有会话中最低 ID；无会话则校验 Profile
 *   存在后创建新会话（绝不发给错误角色；并发创建按 profileId 单飞合流）；
 * - 均无：保持缺省（不带 targetConversationId，由内核解析 assistant 入口，
 *   superagent trigger hook 可决定是否路由中枢）；
 * - text 传原始文本（runtime.dispatchTrigger 统一 defang 防逃逸包裹，
 *   连接器绝不双层包裹）；source 约定 cron:<id> / webhook:<id>；
 * - 宿主关闭中（ctx.host.isClosing）显式拒绝，防 close 期触发新回合。
 */
import { HelmError } from '@helm/protocol'
import type { ExternalTriggerEnvelope } from '@helm/protocol'
import type { ConversationLookup, ProfileLookup } from './contracts.js'

export type DispatchTriggerHelper = (
  event: ExternalTriggerEnvelope,
  targetProfileId?: string,
) => Promise<void>

export function createDeliveryDispatch(options: {
  host: {
    dispatchTrigger(event: ExternalTriggerEnvelope): Promise<void>
  } & ConversationLookup
  profiles: ProfileLookup
  /** 宿主关闭状态（ctx.host.isClosing getter）。 */
  isClosing(): boolean
}): DispatchTriggerHelper {
  const { host, profiles, isClosing } = options
  /** per-profile 会话创建单飞（见 resolveProfileConversation 注释）。 */
  const creationInflight = new Map<string, Promise<number>>()
  return async (event, targetProfileId) => {
    if (isClosing()) {
      throw new HelmError('runtime_closing', 'runtime 正在关闭，拒绝新的触发投递', 409, {
        source: event.source,
      })
    }
    let target = event.targetConversationId
    if (target !== undefined && targetProfileId !== undefined) {
      throw new HelmError(
        'validation_error',
        'targetConversationId 与 targetProfileId 不允许同时提供',
        400,
        {},
      )
    }
    if (target === undefined && targetProfileId !== undefined) {
      target = await resolveProfileConversation(host, profiles, targetProfileId, creationInflight)
    }
    if (target !== undefined) {
      assertConversationExists(host, target)
    }
    if (isClosing()) {
      throw new HelmError('runtime_closing', 'runtime 正在关闭，拒绝新的触发投递', 409, { source: event.source })
    }
    const final: ExternalTriggerEnvelope =
      target === undefined ? event : { ...event, targetConversationId: target }
    await host.dispatchTrigger(final)
  }
}

function assertConversationExists(host: ConversationLookup, id: number): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new HelmError('validation_error', `targetConversationId 非正整数（${String(id)}）`, 400, {})
  }
  try {
    host.getConversation(id)
  } catch (err) {
    if (err instanceof HelmError && err.code === 'not_found') {
      throw new HelmError(
        'not_found',
        `触发目标会话 #${id} 不存在（可能已被删除；请更新触发器目标）`,
        404,
        { targetConversationId: id },
      )
    }
    throw err
  }
}

/**
 * targetProfileId → 会话 ID：最低 ID 复用；无会话则校验存在后创建。
 * 创建段有 per-profileId 单飞（与内核缺省路径 resolveDefaultTriggerTarget 同
 * 等待遇）：并发触发（多 cron job 同点指向同一新 Profile / webhook 突发）
 * 只建一个会话，不产生后续投递永远取不到的孤儿会话。成功即清（不缓存
 * 可被删除的会话 ID）；失败同样清缓存，允许下一次触发重试。list 为空与
 * map 查询在同一同步段内，创建先行者必然可见（先入 store 后 resolve），
 * 后来者要么看到新会话、要么加入在途 Promise，不会双建。
 */
async function resolveProfileConversation(
  host: ConversationLookup,
  profiles: ProfileLookup,
  profileId: string,
  creationInflight: Map<string, Promise<number>>,
): Promise<number> {
  if (typeof profileId !== 'string' || /\s|[/\\]/.test(profileId) || profileId.length === 0 || profileId.length > 64) {
    throw new HelmError('validation_error', `targetProfileId 非法（收到：${String(profileId)}）`, 400, {})
  }
  const profile = await profiles.get(profileId)
  if (profile === undefined) {
    throw new HelmError(
      'validation_error',
      `targetProfileId 不存在：${profileId}（拒绝发给错误角色）`,
      400,
      { targetProfileId: profileId },
    )
  }
  const existing = host.listConversations({ profileId }).sort((a, b) => a.id - b.id)
  if (existing.length > 0) return existing[0]!.id
  const inflight = creationInflight.get(profileId)
  if (inflight !== undefined) return inflight
  const creation = host.createConversation({
    title: `触发器目标（${profileId}）`,
    profileId,
  }).then((created) => created.id)
  creationInflight.set(profileId, creation)
  try {
    return await creation
  } finally {
    if (creationInflight.get(profileId) === creation) creationInflight.delete(profileId)
  }
}
