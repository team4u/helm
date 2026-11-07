/**
 * 原始 HTTP 逃生舱：api <method> <path> [--input <json>] [--field key=value]。
 * - method 大小写不敏感（自动转大写），仅允许 GET/POST/PUT/PATCH/DELETE。
 * - path 自动补齐前导 /（api/nodes 与 /api/nodes 等价）。
 * - --input <json> 为整体请求体（任意 JSON：对象/数组/标量均可——逃生舱不设形状限制）；
 *   --field 可重复、逐键赋值（标量语义），仅当 body 为对象时合并，否则拒绝混用。
 * - GET 使用 path 内的查询参数，不发送请求体。
 */
import { CliError } from '../errors.js'
import { parseFlags } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import {
  assertNoExtraPositionals,
  parseKeyValues,
  printResult,
  repeatedValues,
  requirePositional,
} from './shared.js'

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

export function apiCommands(): CommandSpec[] {
  return [
    {
      path: ['api'],
      description: '原始 HTTP 请求逃生舱（api <method> <path>；如 api GET /api/nodes）',
      flags: [
        { name: 'input', type: 'json', help: '整体请求体 JSON 对象（与 --field 可共存，--field 覆盖同键）' },
        { name: 'field', type: 'string', repeated: true, help: '请求体单项 key=value，可重复；值按 JSON boolean/number 解析，否则 string' },
      ],
      positional: '<method> <path>',
      async run(ctx: CommandContext) {
        const parsed = parseFlags(
          [
            { name: 'input', type: 'json' },
            { name: 'field', type: 'string', repeated: true },
          ],
          ctx.args,
        )
        const method = requirePositional(parsed.positionals, 0, 'method', 'missing_method').toUpperCase()
        if (!(HTTP_METHODS as readonly string[]).includes(method)) {
          throw new CliError(`<method> 需为 ${HTTP_METHODS.join('|')}，实得 "${parsed.positionals[0]}"`, 'invalid_flag_value')
        }
        const rawPath = requirePositional(parsed.positionals, 1, 'path', 'missing_path')
        assertNoExtraPositionals(parsed.positionals, 2)
        const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
        const hasInput = parsed.flags.has('input')
        const fields = repeatedValues(parsed.flags, 'field')
        if (method === 'GET' && (hasInput || fields.length > 0)) {
          throw new CliError('GET 不接受请求体；请把查询参数放在路径中', 'invalid_flag_value')
        }
        const hub = await ctx.hub()
        if (!hasInput && fields.length === 0) {
          printResult(ctx, await hub.request<unknown>(method, path))
          return
        }
        const fieldsObj = parseKeyValues(fields, 'field')
        let body: unknown
        if (hasInput) {
          const input = parsed.flags.get('input')
          if (fields.length > 0) {
            // --field 与 --input 混用：仅对象基底可合并（数组/标量无键可覆盖，显式拒绝）
            if (input === null || typeof input !== 'object' || Array.isArray(input)) {
              throw new CliError('--input 为非对象 JSON 时不可与 --field 混用', 'invalid_flag_value')
            }
            body = { ...(input as Record<string, unknown>), ...fieldsObj }
          } else {
            body = input
          }
        } else {
          body = fieldsObj
        }
        printResult(ctx, await hub.request<unknown>(method, path, { body }))
      },
    },
  ]
}
