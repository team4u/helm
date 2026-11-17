/**
 * Raw HTTP escape hatch: api <method> <path> [--input <json>] [--field key=value].
 * - method is case-insensitive (normalized to uppercase); only GET/POST/PUT/PATCH/DELETE are allowed.
 * - path automatically adds a leading / if missing (api/nodes and /api/nodes are equivalent).
 * - --input <json> provides the full request body (any valid JSON: object/array/scalar — no shape restriction);
 *   --field is repeatable for per-key assignment (scalar parsing), and merges only when the body is an object (otherwise rejected).
 * - GET requests pass query parameters in the path and send no request body.
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
      description: 'Raw HTTP request escape hatch (api <method> <path>; e.g. api GET /api/nodes)',
      flags: [
        { name: 'input', type: 'json', help: 'full request body JSON (can be combined with --field on objects; --field overrides matching keys)' },
        { name: 'field', type: 'string', repeated: true, help: 'single request body field as key=value (repeatable; parsed as JSON bool/number, otherwise string)' },
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
          throw new CliError('GET requests do not accept a request body; pass query parameters in the path instead', 'invalid_flag_value')
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
            // Mixing --field with --input: only a JSON object base can merge (arrays/scalars have no keys to override, so reject explicitly)
            if (input === null || typeof input !== 'object' || Array.isArray(input)) {
              throw new CliError('--field cannot be combined with a non-object JSON --input', 'invalid_flag_value')
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
