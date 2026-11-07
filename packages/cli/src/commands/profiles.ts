/**
 * Profile 域：profiles list/get/create/update/delete。
 *
 * PUT /api/profiles/:id 为整体替换契约（profiles.save 全量覆盖 profile.json）：
 * - update 语义化 flag 路径必须先 GET 完整 Profile 合并后 PUT——只改 --name 也不丢
 *   nodeId/cwd/model 等绑定字段（否则后续会话误跑 local）；
 * - GET 响应带回的 system/memory 全文不回传（仅显式 --system/--memory[-file] 才写）；
 * - --input 单独使用 = 显式全量替换（不 GET）；与语义化 flag 组合时作为合并层，字段不丢。
 * - create 无既有配置可合并，语义化 flag / --input 直接构造新对象。
 */
import type { Profile } from '@helm/protocol'
import { CliError } from '../errors.js'
import { flagValue, parseFlags, type FlagSpec } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import type { HubClient } from '../hub-client.js'
import {
  assertNoExtraPositionals,
  coerceMetaFlag,
  parseNoFlags,
  printResult,
  readTextFileFlag,
  requirePositional,
} from './shared.js'

/** 语义化 flag -> Profile 字段（--system[-file]/--memory[-file] 在应用期单独处理）。 */
const PROFILE_FIELD_FLAGS: ReadonlyArray<{ flag: string; key: string }> = [
  { flag: 'name', key: 'name' },
  { flag: 'model', key: 'model' },
  { flag: 'node', key: 'nodeId' },
  { flag: 'cwd', key: 'cwd' },
]

const DOC_FLAGS = ['system', 'system-file', 'memory', 'memory-file'] as const

const semanticFlags: FlagSpec[] = [
  { name: 'input', type: 'json', help: 'Profile JSON（update 单独使用=全量替换；与语义化 flag 组合则作为合并层）' },
  ...PROFILE_FIELD_FLAGS.map(({ flag }) => ({ name: flag, type: 'string' }) as FlagSpec),
  { name: 'system', type: 'string', help: 'SYSTEM.md 全文' },
  { name: 'system-file', type: 'string', help: 'SYSTEM.md 从本地文件读取' },
  { name: 'memory', type: 'string', help: 'MEMORY.md 全文' },
  { name: 'memory-file', type: 'string', help: 'MEMORY.md 从本地文件读取' },
]

const PARSE_FLAGS_SPEC = semanticFlags.map((f) => ({ ...f }))

/** 是否给出任一语义化 flag（不含 --input）。 */
function hasSemanticFlags(flags: Map<string, unknown>): boolean {
  return (
    PROFILE_FIELD_FLAGS.some(({ flag }) => flags.has(flag)) ||
    DOC_FLAGS.some((flag) => flags.has(flag))
  )
}

/** 将语义化 flag 应用到 body（显式给出才写键；-file 与内联同给时内联优先）。 */
async function applySemanticFlags(flags: Map<string, unknown>, body: Record<string, unknown>): Promise<void> {
  for (const { flag, key } of PROFILE_FIELD_FLAGS) {
    const v = flagValue<string>(flags, flag)
    if (v !== undefined) body[key] = v
  }
  const systemInline = flagValue<string>(flags, 'system')
  if (systemInline !== undefined) body.system = systemInline
  else {
    const systemFile = flagValue<string>(flags, 'system-file')
    if (systemFile !== undefined) body.system = await readTextFileFlag(systemFile, 'system-file')
  }
  const memoryInline = flagValue<string>(flags, 'memory')
  if (memoryInline !== undefined) body.memory = memoryInline
  else {
    const memoryFile = flagValue<string>(flags, 'memory-file')
    if (memoryFile !== undefined) body.memory = await readTextFileFlag(memoryFile, 'memory-file')
  }
}

/**
 * update 合并基底：GET 完整 Profile 并剥离 system/memory 全文
 * （PUT 回传会导致整文件重写；仅显式 --system/--memory[-file] 才写）。
 * Profile 不存在时 GET 错误信封如实上抛（整体替换契约下无法盲改）。
 */
async function fetchProfileBase(hub: HubClient, id: string): Promise<Record<string, unknown>> {
  const current = await hub.get<Profile>(`/api/profiles/${encodeURIComponent(id)}`)
  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    throw new CliError(`Hub 响应非 Profile 形状（GET /api/profiles/${id}）`, 'invalid_response')
  }
  const base: Record<string, unknown> = { ...current }
  delete base['system']
  delete base['memory']
  return base
}

export function profilesCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['profiles', 'list'],
    description: '列出 Profile（GET /api/profiles）',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<Profile[]>('/api/profiles'))
    },
  })

  cmds.push({
    path: ['profiles', 'get'],
    description: '查看 Profile（GET /api/profiles/:id）',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<Profile>(`/api/profiles/${encodeURIComponent(id)}`))
    },
  })

  cmds.push({
    path: ['profiles', 'create'],
    description: '创建 Profile（POST /api/profiles；语义化 flag 或 --input）',
    flags: semanticFlags,
    positional: '[id]',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(PARSE_FLAGS_SPEC, ctx.args)
      const id = parsed.positionals[0]
      assertNoExtraPositionals(parsed.positionals, 1)
      const hasInput = parsed.flags.has('input')
      if (!hasInput && !hasSemanticFlags(parsed.flags)) {
        throw new CliError(
          '未提供任何字段：--input <json> 或语义化 flag（--name/--model/--node/--cwd/--system[-file]/--memory[-file]）（profiles create）',
          'missing_update_fields',
        )
      }
      const body: Record<string, unknown> = hasInput ? coerceMetaFlag(parsed.flags.get('input'), 'input') : {}
      await applySemanticFlags(parsed.flags, body)
      if (id !== undefined) {
        if (typeof body['id'] === 'string' && body['id'] !== id) {
          throw new CliError(`位置参数 id "${id}" 与 --input 中 id "${String(body['id'])}" 不一致`, 'invalid_flag_value')
        }
        body['id'] = id
      }
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<Profile>('/api/profiles', body))
    },
  })

  cmds.push({
    path: ['profiles', 'update'],
    description: '更新 Profile（PUT /api/profiles/:id 整体替换；语义化 flag 自动 GET 合并防丢字段，--input 单独使用为全量替换）',
    flags: semanticFlags,
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(PARSE_FLAGS_SPEC, ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      const hasInput = parsed.flags.has('input')
      const semantic = hasSemanticFlags(parsed.flags)
      if (!hasInput && !semantic) {
        throw new CliError(
          '未提供任何字段：--input <json> 或语义化 flag（--name/--model/--node/--cwd/--system[-file]/--memory[-file]）（profiles update）',
          'missing_update_fields',
        )
      }
      const hub = await ctx.hub()
      let body: Record<string, unknown>
      if (semantic) {
        // 整体替换契约：先 GET 完整合并——未触及字段（nodeId/cwd/model/tags/runtime…）全部保留
        body = await fetchProfileBase(hub, id)
        if (hasInput) Object.assign(body, coerceMetaFlag(parsed.flags.get('input'), 'input'))
        await applySemanticFlags(parsed.flags, body)
      } else {
        // --input 单独使用：显式全量替换（调用方自证完整）
        body = coerceMetaFlag(parsed.flags.get('input'), 'input')
      }
      body['id'] = id
      printResult(ctx, await hub.put<Profile>(`/api/profiles/${encodeURIComponent(id)}`, body))
    },
  })

  cmds.push({
    path: ['profiles', 'delete'],
    description: '删除 Profile（DELETE /api/profiles/:id）',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      const hub = await ctx.hub()
      printResult(ctx, await hub.delete<unknown>(`/api/profiles/${encodeURIComponent(id)}`))
    },
  })

  return cmds
}
