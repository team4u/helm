/**
 * 内核本机文件工具（read / write / edit）：按会话 (nodeId, cwd) 靶点执行，
 * local 与远端分支经 file-env.ts 的统一执行环境适配收敛为单一模板
 * （行为等价重构；路径与 bash 同权，不设 cwd 沙箱，权限边界交给操作系统）。
 *
 * read：仅支持普通文件（目录/特殊文件拒绝，单文件 128KiB 上限）；结构化
 * path 回显真实 target 绝对路径（local 为词法绝对路径、远端为 canonical）。
 *
 * write/edit：写文本与精确替换（oldText 唯一匹配校验；newText 按字面写入，
 * 不解释 String.replace 的 $& 系替换模式）；目标已存在时经 canonicalPath/
 * realpath 解析到真实路径再写（软链别名写到真实文件，与互斥队列 key 对齐），
 * 新文件按词法绝对路径写入；读-改-写窗口经 env/file-mutation-queue 与插件
 * API 共享同一目标节点 canonical 路径互斥队列。edit 成功的结构化输出在锁内、
 * 落盘前基于实读内容计算真实行级差异（runtime/tool-edit-diff.ts 唯一实现，
 * local/远端共享；符合 @helm/protocol EDIT_TOOL_RESULT_SCHEMA）。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { bool, obj, opt, str } from '@earendil-works/pi-schema'
import { EDIT_TOOL_RESULT_SCHEMA, isAbsoluteTargetPath, type EditToolResult } from '@helm/protocol'
import { computeEditDiff } from '../tool-edit-diff.js'
import { targetPlatformForNode } from '../target-platform.js'
import type { HelmToolDeps } from '../tool-deps.js'
import { resolveTargetPath } from './target-path.js'
import { resolveToolTarget } from './tool-target.js'
import {
  basenameForShape,
  dirnameForShape,
  readableEnvFor,
  resolveWritableTarget,
  writableEnvFor,
} from './file-env.js'

const readParameters = obj({
  path: str({ description: '文件路径（相对会话 cwd 或绝对路径，支持 ../ 跨目录）' }),
})

/**
 * read 工具：按会话 (nodeId, cwd) 靶点读取文本文件。cwd 仅作相对路径基准，
 * 绝对路径与 ../ 跨目录一律允许（与 bash 同权）；仅支持普通文件，保留
 * 128KiB 上限；远端经 env RPC（canonicalPath 先解析软链，使 lstat 语义的
 * fileInfo 看到真实目标）。
 */
export function createReadTool(deps: HelmToolDeps): ToolRegistration<typeof readParameters> {
  return defineTool({
    name: 'read',
    description:
      '读取文本文件内容；路径相对会话 cwd 解析，支持绝对路径与 ../ 跨目录访问（与 bash 同权）；仅支持普通文件，单文件上限 128KiB（超限请用 bash + read_artifact 分页）；会话绑定远端节点时在目标节点读取。',
    parameters: readParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '实际读取的绝对路径（远端为 canonical 解析后；非原始入参）' },
        nodeId: { type: 'string', description: '实际读取节点' },
        content: { type: 'string' },
      },
      required: ['path', 'nodeId', 'content'],
    } as never,
    async execute(args, api, context) {
      const raw = args.path
      const agent = await api.agent(BACKGROUND_CONTEXT)
      // 路径语义按会话 cwd 靶点形状（POSIX/Windows）解析，绝不用 Hub 宿主
      // node:path 默认规则解析远端路径（Linux Hub 上 resolve('C:\\x') 会得到
      // 错误结果）；api.agent 与工具共享同一 SDK Context（cancel 传播到远端）。
      const sessionId = agent.cwd ?? deps.defaultCwd
      const nodeId = deps.nodeIdOf?.(api.conversationId as number) ?? 'local'
      // 平台感知解析（与 bash 同一平台来源与原语）：远端平台未知时沿用按
      // 形状选规则的既有语义（不猜平台）；win32 目标上 POSIX 视图路径
      // 先确定性转换为规范 Windows 路径，无法映射的裸 POSIX 根显式拒绝。
      const platformInfo = targetPlatformForNode(deps.envFabric, nodeId)
      if (!isAbsoluteTargetPath(sessionId)) {
        return {
          output: [
            { type: 'text', text: `read_failed: 会话 cwd 非绝对路径（${sessionId}），拒绝读取` },
          ],
          isError: true,
        }
      }
      const resolvedR = resolveTargetPath(
        raw,
        sessionId,
        platformInfo.known ? platformInfo.platform : undefined,
      )
      if (!resolvedR.ok) {
        return { output: [{ type: 'text', text: `invalid_path: ${resolvedR.reason}` }], isError: true }
      }
      const lexicalAbs = resolvedR.abs
      try {
        // 统一执行环境：远端（守卫先行：EnvFabric 缺失/节点离线显式失败，
        // 绝不回退本机）与 local（进程内 fs + fd 读取）同一读取模板。
        const envR = readableEnvFor(deps, nodeId, sessionId)
        if ('error' in envR) {
          return { output: [{ type: 'text', text: envR.error }], isError: true }
        }
        const readR = await envR.env.readText(lexicalAbs, raw, context)
        if (!readR.ok) {
          return { output: [{ type: 'text', text: readR.errorText }], isError: true }
        }
        const content = deps.redact(readR.content)
        const spill = await deps.artifacts.spill(
          api.conversationId as number,
          `read-${api.callId}`,
          content,
        )
        const structured = { path: readR.displayPath, nodeId, content: spill.text } as JsonValue
        return {
          output: [{ type: 'text', text: spill.text }],
          structuredOutput: structured,
          // details 是 SDK 持久化到 toolResult 消息的 UI 通道（structuredOutput 不落库，
          // 仅供嵌套调用方）；文本通道已携带内容，不重复存 content，避免双写。
          details: { path: readR.displayPath, nodeId } as JsonValue,
        }
      } catch (error) {
        return {
          output: [{ type: 'text', text: `read_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
    },
  })
}

const writeParameters = obj({
  path: str({ description: '目标文件路径（相对会话 cwd 或绝对路径，支持 ../ 跨目录；允许创建新文件或子目录）' }),
  content: str({ description: '要写入的 UTF-8 文本内容（整体覆盖）' }),
  artifact: opt(
    bool({
      description:
        '是否同时登记为当前会话产物（Web 界面可见/可预览/可下载，并在输出中返回 [Artifact] id=<id>；在回复正文中可用 [文件名](artifact:<id>) 或 ![图片](artifact:<id>) 直接渲染）',
    }),
  ),
})

/** write/edit 共用错误文案（锁内唯一匹配校验，local/远端共享）。 */
const editTextNotFound = (abs: string): string => `edit_failed: oldText 在 ${abs} 中不存在（拒绝无操作编辑）`
const editTextNotUnique = (abs: string, count: number): string =>
  `edit_failed: oldText 在 ${abs} 中出现 ${count} 次（需唯一匹配；请扩大上下文使 oldText 唯一）`
const editOkText = (abs: string, nodeId: string): string => `edit_ok: ${abs}（节点 ${nodeId}，已替换 1 处）`

/** write 工具：按会话 (nodeId, cwd) 靶点写入文本文件（路径与 bash 同权，不设 cwd 沙箱）。 */
export function createWriteTool(deps: HelmToolDeps): ToolRegistration<typeof writeParameters> {
  return defineTool({
    name: 'write',
    description:
      '写入 UTF-8 文本文件（整体覆盖）。路径相对会话 cwd 解析，支持绝对路径与 ../ 跨目录访问（与 bash 同权）；允许创建新文件或子目录；会话绑定远端节点时在目标节点写入。默认文件仅写入磁盘（Web 界面不可见）；若需交付用户在 Web 预览或下载，传 artifact: true 同步登记为会话产物并获取产物 ID，在回复中用 [文件名](artifact:<id>) 或 ![标题](artifact:<id>) 直接渲染到聊天界面。',
    parameters: writeParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '实际写入的绝对路径（已存在文件为 canonical 解析后；非原始入参）' },
        nodeId: { type: 'string', description: '实际写入节点' },
        bytesWritten: { type: 'number' },
        artifactId: { type: 'string' },
      },
      required: ['path', 'nodeId', 'bytesWritten'],
    } as never,
    async execute(args, api, context) {
      const target0 = await resolveToolTarget(deps, api)
      if ('error' in target0) {
        return { output: [{ type: 'text', text: `write_failed: ${target0.error}` }], isError: true }
      }
      const { nodeId, base, platform } = target0
      try {
        const onWriteSuccess = async (targetAbs: string, bytes: number) => {
          if (args.artifact === true) {
            if (deps.artifacts.writeUploaded === undefined) {
              return {
                output: [
                  {
                    type: 'text' as const,
                    text: 'write_failed: 产物服务未配置 writeUploaded，无法登记会话产物',
                  },
                ],
                isError: true,
              }
            }
            const fileName = basenameForShape(targetAbs)
            const meta = await deps.artifacts.writeUploaded(api.conversationId as number, {
              name: fileName,
              bytes: Buffer.from(args.content, 'utf8'),
            })
            return {
              output: [
                {
                  type: 'text' as const,
                  text: `write_ok: ${targetAbs}（节点 ${nodeId}，${bytes} 字节）\n[Artifact] id=${meta.id} name=${meta.name}`,
                },
              ],
              structuredOutput: {
                path: targetAbs,
                nodeId,
                bytesWritten: bytes,
                artifactId: meta.id,
              } as JsonValue,
              details: { path: targetAbs, nodeId, bytesWritten: bytes, artifactId: meta.id } as JsonValue,
            }
          }
          return {
            output: [
              { type: 'text' as const, text: `write_ok: ${targetAbs}（节点 ${nodeId}，${bytes} 字节）` },
            ],
            structuredOutput: { path: targetAbs, nodeId, bytesWritten: bytes } as JsonValue,
            details: { path: targetAbs, nodeId, bytesWritten: bytes } as JsonValue,
          }
        }

        // 统一执行环境：远端（守卫先行：EnvFabric 缺失/节点离线显式失败，
        // 绝不回退本机）与 local 同一写入模板。
        const envR = writableEnvFor(deps, nodeId, base, '写入')
        if ('error' in envR) {
          return { output: [{ type: 'text', text: envR.error }], isError: true }
        }
        const target = await resolveWritableTarget(envR.env.canonicalProbe, args.path, base, platform, context)
        if (!target.ok) {
          return { output: [{ type: 'text', text: target.message }], isError: true }
        }
        const bytes = Buffer.byteLength(args.content, 'utf8')
        // 互斥队列：同文件读-改-写窗口与插件/其他工具排队（见 env/file-mutation-queue.ts）。
        // 新文件的父目录可能不存在：先确保目录（recursive）；dirname 按目标
        // 形状规则（win32 反斜杠分隔符）。
        return await envR.env.withMutationQueue(target.abs, async () => {
          await envR.env.ensureDir(dirnameForShape(target.abs), context)
          await envR.env.writeFile(target.abs, args.content, context)
          return await onWriteSuccess(target.abs, bytes)
        }, context)
      } catch (error) {
        return {
          output: [{ type: 'text', text: `write_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
    },
  })
}

const editParameters = obj({
  path: str({ description: '目标文件路径（相对会话 cwd 或绝对路径，支持 ../ 跨目录）' }),
  oldText: str({ description: '要被替换的精确文本（必须在文件中恰好出现一次）' }),
  newText: str({ description: '替换后的文本' }),
})

/** 非重叠出现次数统计（edit 唯一匹配校验用）。 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * edit 工具：精确文本替换。oldText 必须在目标文件中唯一精确匹配（不存在
 * 或出现多次均显式报错，绝不模糊替换或静默跳过）；newText 按字面替换写入
 * （不解释 $& 系替换模式，与「精确替换」契约及差异展示一致）；替换后写回
 * 原文件；路径解析与 write 同契约（与 bash 同权，不设 cwd 沙箱）。成功结构
 * 化输出为 @helm/protocol EditToolResult，并同步镜像到 details（SDK 持久化
 * 到 toolResult 消息的 UI 通道，Web 差异展示读它；structuredOutput 不落库，
 * 仅供嵌套调用方）：差异在 canonical 互斥锁内、写盘前
 * 基于实读内容计算（computeEditDiff 抛错则 edit_failed 且文件未被修改），
 * 仅在写入成功后返回。
 */
export function createEditTool(deps: HelmToolDeps): ToolRegistration<typeof editParameters> {
  return defineTool({
    name: 'edit',
    description:
      '精确替换文件文本片段。oldText 必须在文件中恰好出现一次（不存在或多次出现均报错）；路径相对会话 cwd 解析，支持绝对路径与 ../ 跨目录访问（与 bash 同权）；会话绑定远端节点时在目标节点读取与写回。',
    parameters: editParameters,
    structuredOutputSchema: EDIT_TOOL_RESULT_SCHEMA as never,
    async execute(args, api, context) {
      const target0 = await resolveToolTarget(deps, api)
      if ('error' in target0) {
        return { output: [{ type: 'text', text: `edit_failed: ${target0.error}` }], isError: true }
      }
      const { nodeId, base, platform } = target0
      try {
        // 统一执行环境：远端（守卫先行：EnvFabric 缺失/节点离线显式失败，
        // 绝不回退本机）与 local 同一读-改-写模板。
        const envR = writableEnvFor(deps, nodeId, base, '编辑')
        if ('error' in envR) {
          return { output: [{ type: 'text', text: envR.error }], isError: true }
        }
        const target = await resolveWritableTarget(envR.env.canonicalProbe, args.path, base, platform, context)
        if (!target.ok) {
          return { output: [{ type: 'text', text: target.message }], isError: true }
        }
        // 互斥队列：读-改-写整体持锁（读旧内容与写回之间不被其他变更插入）。
        return await envR.env.withMutationQueue(target.abs, async () => {
          const content = await envR.env.readTextFile(target.abs, context)
          const count = countOccurrences(content, args.oldText)
          if (count === 0) {
            return {
              output: [{ type: 'text', text: editTextNotFound(target.abs) }],
              isError: true,
            }
          }
          if (count > 1) {
            return {
              output: [{ type: 'text', text: editTextNotUnique(target.abs, count) }],
              isError: true,
            }
          }
          const matchOffset = content.indexOf(args.oldText)
          // 字面替换（不解释 $& 系模式）：落盘内容与差异计算输入严格同源。
          const updated =
            content.slice(0, matchOffset) +
            args.newText +
            content.slice(matchOffset + args.oldText.length)
          // 差异在锁内、写盘前基于实读内容计算（纯函数；抛错则文件未被修改）。
          const diff = computeEditDiff(
            content,
            updated,
            matchOffset,
            args.oldText.length,
            deps.redact,
          )
          await envR.env.writeFile(target.abs, updated, context)
          const structured = {
            path: target.abs,
            nodeId,
            replaced: true,
            diff,
          } satisfies EditToolResult as unknown as JsonValue
          return {
            output: [{ type: 'text', text: editOkText(target.abs, nodeId) }],
            structuredOutput: structured,
            // Web 时间线的差异展示读持久化 details 通道（structuredOutput 不落库）；
            // 两通道同值，展示层只依赖 EDIT_TOOL_RESULT_SCHEMA 一份契约。
            details: structured,
          }
        }, context)
      } catch (error) {
        return {
          output: [{ type: 'text', text: `edit_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
    },
  })
}
