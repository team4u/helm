/**
 * builtin:memory：完全自治的长期记忆插件（locked: false，默认启用）。
 *
 * 职责（与 builtin:profile 正交，内核/协议零记忆感知）：
 * - MemoryStore 自管 `<dataDir>/profiles/<id>/MEMORY.md`（文件锁 + 64k 上限
 *   唯一权威点，见 memory/store.ts）；磁盘全文是唯一权威，不进公共文档；
 * - 私有 ctx.doc('state') 持久化紧凑状态：disabledProfiles（单 Profile 开关）
 *   与 initializedProfiles（跨重启区分「从未初始化」与「已初始化后被删」）；
 * - before_turn：单 Profile 关闭时不读文件、不注入段落并剥离 update_memory
 *   工具；开启时按内容注入 memory.content / memory.guide / memory.assets-missing；
 * - update_memory 工具：execute 入口复核单 Profile 开关（关闭 403）；
 * - 三个 ctx.action（get / set / configure）自动映射 HTTP / CLI（helm memory
 *   get|set|configure）/ Agent Tool / Web invokeAction 五端。
 *
 * 诚实性纪律：
 * - 已初始化 Profile 的 MEMORY.md 被外部删除：显式 warning 通知 + 注入
 *   memory.assets-missing，绝不启动时无条件重建掩盖丢失；文件恢复/工具
 *   写入后自愈；
 * - 从未初始化的合法 Profile 首次需要记忆时惰性创建（不误报缺失）；
 * - 空白 MEMORY.md 是合法的 memory.guide 状态（无缺失告警）。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HelmError, PROFILE_DETAIL_SECTION_SLOT, type PluginDefinition } from '@helm/protocol'
import { FileNotFoundError } from '../services/atomic-file.js'
import { assertProfileId, type ProfileService } from '../services/index.js'
import { MEMORY_PLUGIN_ID, MAX_MEMORY_CHARS, MemoryStore } from './memory/store.js'

export { MEMORY_PLUGIN_ID, MAX_MEMORY_CHARS, MEMORY_DEFAULT, MemoryStore } from './memory/store.js'

/** 单 Profile 记忆开关与初始化标记的紧凑持久状态（私有 doc，不含全文）。 */
export interface MemoryPluginDoc {
  /** 已关闭长期记忆的 Profile ID 列表（不在列表中的 Profile 默认开启）。 */
  disabledProfiles: string[]
  /** 已初始化过 MEMORY.md 的 Profile ID 列表（跨重启区分从未初始化 vs 被删）。 */
  initializedProfiles: string[]
}

const DOC_NAME = 'state'

export function isProfileMemoryEnabled(
  doc: Pick<MemoryPluginDoc, 'disabledProfiles'> | undefined,
  profileId: string,
): boolean {
  return !(doc?.disabledProfiles ?? []).includes(profileId)
}

/** 截断说明（注入时附在截断内容之后，绝不静默截断）。 */
const MEMORY_TRUNCATION_NOTE = `\n[ helm 提示：MEMORY.md 超过 ${MAX_MEMORY_CHARS} 字符上限，以上为前 ${MAX_MEMORY_CHARS} 字符；请用 update_memory(mode='replace') 整理精简记忆 ]`

/** 记忆工具用法提示（动态注入，SYSTEM.md 不再硬编码）。 */
const MEMORY_USAGE_NOTE = '用 `update_memory` 保存稳定的用户偏好与约定。'

/** clientRoot 兼容 src / dist 运行路径（与 workflow/herdr 插件同机制）。 */
function resolveClientRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const local = join(here, 'memory', 'client')
  if (existsSync(local)) return local
  const pkgRoot = dirname(dirname(here))
  const srcFallback = join(pkgRoot, 'src', 'builtin-plugins', 'memory', 'client')
  if (existsSync(srcFallback)) return srcFallback
  throw new HelmError(
    'memory_plugin_client_missing',
    `内置插件 ${MEMORY_PLUGIN_ID} 找不到 client 组件目录（期望 ${local} 或 ${srcFallback}）`,
    500,
  )
}

interface MemoryPluginServices {
  profiles: ProfileService
}

/** 校验 Profile 存在（与 Profile 详情接口同一存在性判定）。 */
async function requireProfile(profiles: ProfileService, profileId: string): Promise<void> {
  assertProfileId(profileId)
  const found = await profiles.get(profileId)
  if (found === undefined) {
    throw new HelmError('profile_not_found', `Profile '${profileId}' 不存在`, 404, { profileId })
  }
}

export function createMemoryPlugin({ profiles }: MemoryPluginServices): PluginDefinition {
  return {
    id: MEMORY_PLUGIN_ID,
    name: '长期记忆',
    version: '0.1.0',
    locked: false,
    clientRoot: resolveClientRoot(),
    definePlugin(ctx) {
      const store = new MemoryStore(
        // ctx.dataDir 为 <dataDir>/plugins/builtin:memory；MEMORY.md 物理路径
        // <dataDir>/profiles/<id>/MEMORY.md（与 Profile 目录同根，不随插件移动）。
        resolve(ctx.dataDir, '../..'),
      )
      // 私有紧凑状态：disabledProfiles + initializedProfiles（磁盘全文是唯一权威）。
      const stateDoc = ctx.doc<MemoryPluginDoc>(DOC_NAME, {
        disabledProfiles: [],
        initializedProfiles: [],
      })

      const isEnabled = (profileId: string): boolean =>
        isProfileMemoryEnabled(stateDoc.get(), profileId)
      const isInitialized = (profileId: string): boolean =>
        stateDoc.get().initializedProfiles.includes(profileId)
      const markInitialized = (profileId: string): void => {
        stateDoc.update((current) =>
          current.initializedProfiles.includes(profileId)
            ? current
            : { ...current, initializedProfiles: [...current.initializedProfiles, profileId] },
        )
      }

      // ------------------------------------------------------------------
      // ctx.action：get / set / configure（自动映射 helm memory … CLI 与 HTTP）
      // ------------------------------------------------------------------

      ctx.action<{ profileId: string }, { profileId: string; enabled: boolean; content: string; initialized: boolean }>({
        id: 'get',
        description: '读取指定 Profile 的长期记忆内容与开关状态（helm memory get）',
        inputSchema: {
          type: 'object',
          properties: { profileId: { type: 'string', minLength: 1 } },
          required: ['profileId'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            profileId: { type: 'string' },
            enabled: { type: 'boolean' },
            content: { type: 'string' },
            initialized: { type: 'boolean' },
          },
          required: ['profileId', 'enabled', 'content', 'initialized'],
          additionalProperties: false,
        },
        idempotent: true,
        async handler(input) {
          await requireProfile(profiles, input.profileId)
          let content = ''
          try {
            content = await store.getMemory(input.profileId)
          } catch (err) {
            if (!(err instanceof FileNotFoundError)) throw err
            // 文件不存在：如实返回空串（前端显示真实状态，不伪造内容）。
          }
          return {
            profileId: input.profileId,
            enabled: isEnabled(input.profileId),
            content,
            initialized: isInitialized(input.profileId),
          }
        },
      })

      ctx.action<{ profileId: string; text: string; mode?: 'append' | 'replace' }, { profileId: string; updated: boolean; length: number }>({
        id: 'set',
        description: '显式写入指定 Profile 的 MEMORY.md 全文或追加（helm memory set）',
        inputSchema: {
          type: 'object',
          properties: {
            profileId: { type: 'string', minLength: 1 },
            text: { type: 'string' },
            mode: { type: 'string', enum: ['replace', 'append'] },
          },
          required: ['profileId', 'text'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            profileId: { type: 'string' },
            updated: { type: 'boolean' },
            length: { type: 'number' },
          },
          required: ['profileId', 'updated', 'length'],
          additionalProperties: false,
        },
        async handler(input) {
          await requireProfile(profiles, input.profileId)
          const mode = input.mode ?? 'replace'
          if (!isEnabled(input.profileId)) {
            throw new HelmError(
              'memory_disabled_for_profile',
              `Profile '${input.profileId}' 已关闭长期记忆，禁止写入 MEMORY.md`,
              403,
              { profileId: input.profileId },
            )
          }
          const written = await store.updateMemory(input.profileId, input.text, mode)
          markInitialized(input.profileId)
          return { profileId: input.profileId, updated: true, length: written.length }
        },
      })

      ctx.action<
        { profileId: string; enabled: boolean; text?: string },
        { profileId: string; enabled: boolean }
      >({
        id: 'configure',
        description: '配置指定 Profile 的长期记忆启停（可同时携带替换文本；helm memory configure）',
        inputSchema: {
          type: 'object',
          properties: {
            profileId: { type: 'string', minLength: 1 },
            enabled: { type: 'boolean' },
            text: { type: 'string' },
          },
          required: ['profileId', 'enabled'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            profileId: { type: 'string' },
            enabled: { type: 'boolean' },
          },
          required: ['profileId', 'enabled'],
          additionalProperties: false,
        },
        async handler(input) {
          await requireProfile(profiles, input.profileId)
          // 先写入文本（若提供），成功后才提交开关——失败时不留半配置。
          if (input.text !== undefined) {
            if (!isEnabled(input.profileId) && !input.enabled) {
              throw new HelmError(
                'memory_disabled_for_profile',
                `Profile '${input.profileId}' 已关闭长期记忆，禁止写入 MEMORY.md`,
                403,
                { profileId: input.profileId },
              )
            }
            await store.updateMemory(input.profileId, input.text, 'replace')
            markInitialized(input.profileId)
          }
          if (input.enabled && !isInitialized(input.profileId)) {
            // 开启且尚无初始化标记：惰性创建文件（已有文件时原样保留）。
            await store.ensureMemory(input.profileId)
            markInitialized(input.profileId)
          }
          stateDoc.update((current) => ({
            ...current,
            disabledProfiles: input.enabled
              ? current.disabledProfiles.filter((id) => id !== input.profileId)
              : current.disabledProfiles.includes(input.profileId)
                ? current.disabledProfiles
                : [...current.disabledProfiles, input.profileId],
          }))
          return { profileId: input.profileId, enabled: input.enabled }
        },
      })

      // ------------------------------------------------------------------
      // before_turn：单 Profile 开关 + 惰性初始化 + 缺失告警
      // ------------------------------------------------------------------

      const missingNotified = new Set<string>()

      ctx.hook.onBeforeTurn(async (turn) => {
        const profileId = turn.conversation.profileId
        if (!isEnabled(profileId)) {
          // 单 Profile 已关闭：不读文件、不注入，并剥离 update_memory 工具。
          if (turn.tools.some((t) => t.name === 'update_memory')) {
            return {
              action: 'transform',
              value: {
                ...turn,
                tools: turn.tools.filter((t) => t.name !== 'update_memory'),
              },
            }
          }
          return { action: 'continue' }
        }

        const sections = [...turn.sections]
        let rawMemory: string
        try {
          rawMemory = await store.getMemory(profileId)
          missingNotified.delete(profileId) // 恢复即停；下次再缺失可重新告警
          if (!isInitialized(profileId)) markInitialized(profileId)
        } catch (err) {
          if (!(err instanceof FileNotFoundError)) throw err
          if (!isInitialized(profileId)) {
            // 从未初始化的合法 Profile 首次需要记忆：惰性创建默认文件。
            rawMemory = await store.ensureMemory(profileId)
            markInitialized(profileId)
          } else {
            // 已初始化后被外部删除：显式告警（按 profileId 独立去重），不重建。
            if (!missingNotified.has(profileId)) {
              missingNotified.add(profileId)
              try {
                ctx.host.emitEvent('notification', {
                  type: 'notification',
                  level: 'warning',
                  title: `长期记忆文件缺失：${profileId}/MEMORY.md`,
                  body: `Profile '${profileId}' 的 MEMORY.md 曾存在但已被外部删除；本回合按无记忆处理，下次 update_memory 写入或恢复文件后自愈`,
                })
              } catch {
                // 通知失败不阻断回合（事件通道故障由宿主诊断）。
              }
            }
            sections.push({
              id: 'memory.assets-missing',
              text: [
                '<memory_assets_missing>',
                `[警告] 长期记忆资产缺失（${profileId}/MEMORY.md 曾存在但已被删除）。`,
                '请提醒用户检查 profiles 目录或通过 update_memory 重建；在此之前你没有长期记忆。',
                '</memory_assets_missing>',
              ].join('\n'),
            })
            rawMemory = ''
          }
        }

        // 空白内容是合法状态（memory.guide），无缺失告警。
        if (rawMemory.trim()) {
          // 存量超限（外部手改绕过写入防线）：注入时截断并显式说明。
          const memory =
            rawMemory.length > MAX_MEMORY_CHARS
              ? `${rawMemory.slice(0, MAX_MEMORY_CHARS)}${MEMORY_TRUNCATION_NOTE}`
              : rawMemory
          sections.push({
            id: 'memory.content',
            text: `<memory>\n${memory}\n</memory>\n${MEMORY_USAGE_NOTE}`,
          })
        } else {
          sections.push({ id: 'memory.guide', text: MEMORY_USAGE_NOTE })
        }
        return { action: 'transform', value: { ...turn, sections } }
      })

      // ------------------------------------------------------------------
      // update_memory 工具（执行期复核单 Profile 开关）
      // ------------------------------------------------------------------

      ctx.tool<{ text: string; mode: 'append' | 'replace' }>({
        name: 'update_memory',
        description: '更新当前会话 Profile 的 MEMORY.md。append 追加内容，replace 替换全文（超过 64000 字符需先 replace 精简）。',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' }, mode: { type: 'string', enum: ['append', 'replace'] } },
          required: ['text', 'mode'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const conversation = ctx.host.getConversation(context.conversationId)
          const profileId = conversation.profileId
          if (!isEnabled(profileId)) {
            throw new HelmError(
              'memory_disabled_for_profile',
              `Profile '${profileId}' 已关闭长期记忆，禁止调用 update_memory`,
              403,
              { profileId },
            )
          }
          // 大小防线唯一权威点在 MemoryStore.updateMemory 文件锁内（合并后
          // 检查）：跨会话同 Profile 并发 append 不可能叠加突破上限。
          const content = await store.updateMemory(profileId, input.text, input.mode)
          markInitialized(profileId)
          return { updated: true, profileId, length: content.length }
        },
      })

      // ------------------------------------------------------------------
      // Web 插槽：向 Profile 详情抽屉注入单 Profile 记忆开关与编辑器
      // ------------------------------------------------------------------

      ctx.ui.slot({
        id: 'profile-memory-section',
        target: PROFILE_DETAIL_SECTION_SLOT,
        order: 10,
        client: { module: 'index.tsx', export: 'ProfileMemorySection' },
      })
    },
  }
}
