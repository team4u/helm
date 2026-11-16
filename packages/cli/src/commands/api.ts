/**
 * original HTTP escape generate cabin:api <method> <path> [--input <json>] [--field key=value].
 * - method large small write do not sensitive (automatically rotate large write), only allows GET/POST/PUT/PATCH/DELETE.
 * - path automatically patch complete before lead /(api/nodes and /api/nodes etc. price).
 * - --input <json> is whole request body (any JSON: object/array/mark amount all can - - escape generate cabin do not set shape restrict);
 *   --field can duplicate, one by one key assignment (mark amount semantics), only when body is object when merge, otherwise reject mix use.
 * - GET use path inside query parameter, do not send request body.
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
      description: 'original HTTP request escape generate cabin (api <method> <path>; such as api GET /api/nodes)',
      flags: [
        { name: 'input', type: 'json', help: 'whole request body JSON object (and --field can shared store,--field override same key)' },
        { name: 'field', type: 'string', repeated: true, help: 'request body single items key=value, can duplicate; value by JSON boolean/number parse, otherwise string' },
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
          throw new CliError(`<method> must be ${HTTP_METHODS.join('|')}, got "${parsed.positionals[0]}"`, 'invalid_flag_value')
        }
        const rawPath = requirePositional(parsed.positionals, 1, 'path', 'missing_path')
        assertNoExtraPositionals(parsed.positionals, 2)
        const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
        const hasInput = parsed.flags.has('input')
        const fields = repeatedValues(parsed.flags, 'field')
        if (method === 'GET' && (hasInput || fields.length > 0)) {
          throw new CliError('GET do not accept request body; please query parameter put in path in', 'invalid_flag_value')
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
            // --field and --input mix use: only object base bottom can merge (array/mark amount without key can override, explicit reject)
            if (input === null || typeof input !== 'object' || Array.isArray(input)) {
              throw new CliError('--input is non- object JSON when cannot and --field mix use', 'invalid_flag_value')
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
