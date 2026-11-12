/**
 * 智能体待命页（Agent Standby）纯逻辑与草稿存储：
 * - 待命态是真草稿：不伪造 ConversationSummary、不预创建会话、不上传附件；
 * - 草稿只存内存（模块级 Map，按 `panel:profileId` 隔离，主/分屏互不串扰），
 *   组件卸载/切换目标后仍可找回（在途首发任务与重试都引用同一记录）；
 * - 首次发送编排（create -> patch thinkingLevel -> 上传附件 -> submitInput）
 *   以同步 sending 标记防双击/Enter 并发；create 成功后的任何失败都保留真实
 *   会话 ID 与已上传附件，重试复用，绝不重复创建或自动删除掩盖失败。
 * 本模块不导出组件；React 绑定仅 useSyncExternalStore 一个 hook。
 */
import { useSyncExternalStore } from 'react'
import type { ArtifactMetadata, ConversationInit, ConversationSummary } from '@helm/protocol'
import { envDraftError, type EnvDraft } from './composer-model.js'

/** 发送前本地暂存附件（不创建会话、不上传）。 */
export interface StandbyLocalFile {
  key: string
  file: File
  name: string
  size: number
  mimeType: string
}

/** 已上传附件（首发部分失败后重试复用，不重复上传）。 */
export interface StandbyUploadedAttachment {
  artifactId: string
  name: string
  size: number
  mimeType: string
}

/** 待命草稿完整状态（模块级存储的不可变记录，每次更新整体替换）。 */
export interface StandbyDraftState {
  text: string
  localFiles: StandbyLocalFile[]
  uploaded: StandbyUploadedAttachment[]
  /** 显式模型选择；undefined = 跟随 Profile/全局默认（服务器解析，不编造）。 */
  model: string | undefined
  /** 显式思考档位；undefined = 不 patch（创建后才能 patch）。 */
  thinkingLevel: string | undefined
  /** 环境是否被显式定制（URL 继承或用户编辑）；false 时 create 不携带 nodeId/cwd。 */
  envCustomized: boolean
  envNodeId: string | undefined
  envCwd: string | undefined
  /** 首发部分失败的续传锚点：已创建的真实会话 ID（重试跳过 create）。 */
  conversationId: number | undefined
  /** 同步防抖标记：首发任务开始时同步置 true，双击/连按 Enter 直接忽略。 */
  sending: boolean
  /** 最近一次首发失败的用户可读错误（重试前展示）。 */
  error: string | null
}

export const EMPTY_STANDBY_DRAFT: StandbyDraftState = {
  text: '',
  localFiles: [],
  uploaded: [],
  model: undefined,
  thinkingLevel: undefined,
  envCustomized: false,
  envNodeId: undefined,
  envCwd: undefined,
  conversationId: undefined,
  sending: false,
  error: null,
}

/** 附件大小上限与现有 Composer 一致（15 MiB）。 */
export const STANDBY_FILE_MAX_BYTES = 15 * 1024 * 1024

type DraftListener = () => void

const drafts = new Map<string, StandbyDraftState>()
const listeners = new Set<DraftListener>()
let localFileSeq = 0

function notifyListeners(): void {
  for (const listener of listeners) listener()
}

function subscribeDrafts(listener: DraftListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 草稿存储键：按面板（主/分屏）与 Profile 隔离。 */
export function standbyDraftKey(panel: 'primary' | 'split', profileId: string): string {
  return `${panel}:${profileId}`
}

export function getStandbyDraft(key: string): StandbyDraftState {
  return drafts.get(key) ?? EMPTY_STANDBY_DRAFT
}

/** 更新草稿（不存在则从空记录创建）。 */
export function updateStandbyDraft(key: string, patch: Partial<StandbyDraftState>): StandbyDraftState {
  const next: StandbyDraftState = { ...getStandbyDraft(key), ...patch }
  drafts.set(key, next)
  notifyListeners()
  return next
}

/** 仅在记录仍存在时更新（首发成功清空后，收尾 sending 复位不得复活空记录）。 */
export function patchStandbyDraftIfPresent(key: string, patch: Partial<StandbyDraftState>): void {
  if (!drafts.has(key)) return
  const current = drafts.get(key)!
  drafts.set(key, { ...current, ...patch })
  notifyListeners()
}

/** 首发全链路成功后清空草稿（正文只在内存，无需跨刷新恢复）。 */
export function clearStandbyDraft(key: string): void {
  if (!drafts.delete(key)) return
  notifyListeners()
}

/** 清空全部待命草稿（测试隔离用）。 */
export function resetStandbyDrafts(): void {
  drafts.clear()
  notifyListeners()
}

/** React 绑定：草稿记录引用稳定（每次更新整体替换），供 useSyncExternalStore 消费。 */
export function useStandbyDraft(key: string): StandbyDraftState {
  return useSyncExternalStore(subscribeDrafts, () => getStandbyDraft(key), () => EMPTY_STANDBY_DRAFT)
}

// ---------------------------------------------------------------------------
// 纯函数：环境草稿、附件与创建入参
// ---------------------------------------------------------------------------

/** 从 agent 目标继承的环境（删除导航/新话题继承；无则 undefined 交给服务器解析）。 */
export function inheritedEnvOf(target: { nodeId?: string; cwd?: string }): { nodeId?: string; cwd?: string } {
  return {
    ...(target.nodeId !== undefined && target.nodeId !== '' ? { nodeId: target.nodeId } : {}),
    ...(target.cwd !== undefined && target.cwd !== '' ? { cwd: target.cwd } : {}),
  }
}

/** 环境定制后的校验（复用会话环境条规则：目录必填且必须绝对路径）。未定制时恒通过。 */
export function standbyEnvError(draft: Pick<StandbyDraftState, 'envCustomized' | 'envNodeId' | 'envCwd'>): string | null {
  if (!draft.envCustomized) return null
  return envDraftError({ nodeId: draft.envNodeId || 'local', cwd: draft.envCwd ?? '' } satisfies EnvDraft)
}

/** 本地暂存附件录入（15 MiB 上限与 Composer 一致；返回被拒绝文件的错误文案）。 */
export function admitStandbyFiles(
  draft: Pick<StandbyDraftState, 'localFiles'>,
  files: ReadonlyArray<File>,
): { draft: Pick<StandbyDraftState, 'localFiles'>; accepted: File[]; rejected: Array<{ file: File; reason: string }> } {
  const next = [...draft.localFiles]
  const accepted: File[] = []
  const rejected: Array<{ file: File; reason: string }> = []
  for (const file of files) {
    if (file.size > STANDBY_FILE_MAX_BYTES) {
      rejected.push({ file, reason: '文件超过 15 MiB 上限' })
      continue
    }
    next.push({
      key: `standby-file-${++localFileSeq}`,
      file,
      name: file.name || 'attachment.bin',
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
    })
    accepted.push(file)
  }
  return { draft: { localFiles: next }, accepted, rejected }
}

/** 组装 create 入参：环境仅在显式定制时携带；模型仅在显式选择时携带（默认交服务器解析）。 */
export function buildStandbyCreateInit(
  profileId: string,
  draft: Pick<StandbyDraftState, 'envCustomized' | 'envNodeId' | 'envCwd' | 'model'>,
): ConversationInit {
  return {
    profileId,
    ...(draft.envCustomized
      ? { nodeId: draft.envNodeId || 'local', cwd: (draft.envCwd ?? '').trim() }
      : {}),
    ...(draft.model !== undefined && draft.model !== '' ? { model: draft.model } : {}),
  }
}

// ---------------------------------------------------------------------------
// 首发编排（依赖注入；UI 层传入真实 API 与导航回调）
// ---------------------------------------------------------------------------

export interface StandbySendDeps {
  create: (init: ConversationInit) => Promise<ConversationSummary>
  patchThinkingLevel: (conversationId: number, thinkingLevel: string) => Promise<unknown>
  upload: (conversationId: number, file: File) => Promise<ArtifactMetadata>
  submit: (conversationId: number, payload: { text: string; origin: 'human'; attachments?: string[] }) => Promise<unknown>
  notifyError: (title: string, err: unknown, conversationId?: number) => void
  /** 全链路成功且待命目标已不在当前视口时，用可点击通知引导用户回到新会话。 */
  notifySentInBackground: (conversationId: number) => void
  /** 全链路成功且待命目标仍在当前视口时，replace 导航到真实会话。 */
  navigateToConversation: (conversationId: number) => void
  isStillViewing: () => boolean
}

export type StandbySendResult = 'sent' | 'invalid' | 'busy' | 'failed'

/**
 * 执行首次发送。同步检查并占用 sending 标记（双击/Enter 并发第二次直接返回 busy），
 * 之后按 create -> patch -> upload -> submit 顺序推进；任何一步失败保留草稿、
 * 已创建会话 ID 与已上传附件并返回 failed，由用户显式重试（复用锚点）。
 */
export async function executeStandbySend(key: string, profileId: string, deps: StandbySendDeps): Promise<StandbySendResult> {
  const record = getStandbyDraft(key)
  const payload = record.text.trim()
  if (payload === '') return 'invalid'
  if (record.sending) return 'busy'
  const envError = standbyEnvError(record)
  if (envError !== null) {
    deps.notifyError('请先修正起始环境', envError)
    return 'invalid'
  }
  // 同步占用：后续双击/Enter 在任何 await 之前被拒绝。
  updateStandbyDraft(key, { sending: true, error: null })
  let conversationId = record.conversationId
  try {
    if (conversationId === undefined) {
      const created = await deps.create(buildStandbyCreateInit(profileId, record))
      conversationId = created.id
      // 立即持久化锚点：后续任一步失败，重试不再重复 create。
      updateStandbyDraft(key, { conversationId })
    }
    if (record.thinkingLevel !== undefined && record.thinkingLevel !== '') {
      await deps.patchThinkingLevel(conversationId, record.thinkingLevel)
    }
    for (const local of record.localFiles) {
      const meta = await deps.upload(conversationId, local.file)
      // 已上传即转正：失败重试时不再重复上传该文件。
      const current = getStandbyDraft(key)
      updateStandbyDraft(key, {
        localFiles: current.localFiles.filter((item) => item.key !== local.key),
        uploaded: [...current.uploaded, { artifactId: meta.id, name: meta.name, size: meta.size, mimeType: meta.mimeType }],
      })
    }
    const attachments = getStandbyDraft(key).uploaded.map((item) => item.artifactId)
    await deps.submit(conversationId, {
      text: payload,
      origin: 'human',
      ...(attachments.length > 0 ? { attachments } : {}),
    })
    clearStandbyDraft(key)
    if (deps.isStillViewing()) deps.navigateToConversation(conversationId)
    else deps.notifySentInBackground(conversationId)
    return 'sent'
  } catch (err) {
    patchStandbyDraftIfPresent(key, { error: err instanceof Error ? err.message : String(err) })
    deps.notifyError(conversationId !== undefined ? '发送失败，可重试（会话已创建）' : '创建会话失败，草稿已保留', err, conversationId)
    return 'failed'
  } finally {
    patchStandbyDraftIfPresent(key, { sending: false })
  }
}
