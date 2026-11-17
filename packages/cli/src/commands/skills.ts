/** Skills commands: skills list / read. */
import type { SkillSummary } from '@helm/protocol'
import { CliError } from '../errors.js'
import { flagValue, parseFlags } from '../args.js'
import type { CommandContext, CommandSpec } from './shared.js'
import { parseNoFlags, printPlainText, printResult, requirePositional } from './shared.js'

export function skillsCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []

  cmds.push({
    path: ['skills', 'list'],
    description: 'List available skills (GET /api/skills)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<SkillSummary[]>('/api/skills'))
    },
  })

  cmds.push({
    path: ['skills', 'read'],
    description: 'Read a skill document (GET /api/skills/:id[?path=]; defaults to SKILL.md)',
    flags: [{ name: 'path', type: 'string', help: "relative path to a file within the skill directory, e.g. 'references/xxx.md'" }],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'path', type: 'string' }], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      const p = flagValue<string>(parsed.flags, 'path')
      const query = p ? `?path=${encodeURIComponent(p)}` : ''
      const hub = await ctx.hub()
      const res = await hub.get<{ text: string }>(`/api/skills/${encodeURIComponent(id)}${query}`)
      if (typeof res?.text !== 'string') {
        throw new CliError('Hub returned an invalid skills read response (expected { text })', 'invalid_response')
      }
      if (ctx.json) printResult(ctx, res)
      else printPlainText(ctx, res.text)
    },
  })

  return cmds
}
