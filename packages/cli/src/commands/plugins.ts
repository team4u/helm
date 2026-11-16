/**
 * plugin domain:plugins list/enable/disable/config/doc/client and doctor/reload/rescan
 * (DX closed ring),install/update/remove(managed package manage) and actions list.config except
 * --input <json> outside support can duplicate --set key=value(value by JSON boolean/number semantics
 * parse, otherwise string).plugins init is local foot manually frame command (minimal/full through use plugin and
 * app full-stack micro app three Profile template,app artifact directly via helm apps validate preflight).
 */
import type {
  ActionManifest,
  PluginDoctorReport,
  PluginInstallResult,
  PluginReloadResult,
  PluginRemoveResult,
  PluginRescanResult,
  PluginSummary,
  PluginUpdateResult,
} from '@helm/protocol'
import { CliError } from '../errors.js'
import { parseFlags } from '../args.js'
import { printValue } from '../output.js'
import type { HubClient } from '../hub-client.js'
import {
  SCAFFOLD_CLIENT_APP_CSS,
  SCAFFOLD_CLIENT_APP_TSX,
  SCAFFOLD_CLIENT_INDEX_TSX,
  SCAFFOLD_INDEX_TS_APP,
  SCAFFOLD_INDEX_TS_FULL,
  SCAFFOLD_INDEX_TS_MINIMAL,
  SCAFFOLD_PLUGIN_JSON,
  SCAFFOLD_README,
  SCAFFOLD_TEMPLATES,
  SCAFFOLD_TSCONFIG,
  type ScaffoldTemplate,
} from './scaffold-templates.js'
import type { CommandContext, CommandSpec } from './shared.js'
import {
  assertNoExtraPositionals,
  coerceMetaFlag,
  parseKeyValues,
  parseNoFlags,
  printPlainText,
  printResult,
  repeatedValues,
  requirePositional,
  resolveConversationTarget,
} from './shared.js'

/**
 * conversation document subscribe (--watch): consume dedicated use SSE(GET /api/plugins/:id/docs/:name/events?conversationId=N).
 * - --json: each frame NDJSON output (snapshot frame and incremental frame all original);
 * - person class pattern:snapshot print when before value, incremental frame print one row change summary + new value;
 * - create connect 404(plugin deactivate/conversation delete/document non- public) explicit errors and stop (do not retry).
 */
async function watchSessionDoc(
  ctx: CommandContext,
  hub: HubClient,
  base: string,
  conversationId: number,
  pluginId: string,
  name: string,
): Promise<void> {
  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const label = `${pluginId}/${name}#conversation${conversationId}`
  try {
    await hub.streamSse(`${base}/events?conversationId=${conversationId}`, {
      signal: controller.signal,
      onFrame: ({ event, data }) => {
        let payload: unknown
        try {
          payload = JSON.parse(data)
        } catch {
          ctx.io.err(`helm: ignore non- JSON SSE frame (${data.slice(0, 120)})\n`)
          return
        }
        if (ctx.json) {
          ctx.io.out(`${JSON.stringify(payload ?? null)}\n`)
          return
        }
        if (event === 'snapshot') {
          const snap = payload as { doc?: { value?: unknown; deleted?: boolean } }
          ctx.io.out(`[${label}] snapshot\n`)
          printValue(ctx.io, snap.doc?.value ?? null, false)
          return
        }
        const frame = payload as { seq?: number; event?: { doc?: { value?: unknown; deleted?: boolean } } }
        const doc = frame.event?.doc
        ctx.io.out(`[${label}] update seq=${frame.seq ?? '?'}${doc?.deleted === true ? '(deleted)' : ''}\n`)
        printValue(ctx.io, doc?.value ?? null, false)
      },
    })
  } catch (err) {
    if (err instanceof CliError && err.code === 'aborted') return
    throw err
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

/**
 * break remove confirm (re- use CLI since has TTY/non- TTY stream convention, and login password same style):
 * --yes and --json non- interaction let through;TTY terminal stdin mention question one row (y/yes confirm);
 * non- TTY without --yes explicit reject - - never in without person value guard pipeline on pending etc. input.
 */
async function confirmRemove(ctx: CommandContext, assumedYes: boolean, pluginId: string): Promise<void> {
  if (ctx.json || assumedYes) return
  if (process.stdin.isTTY !== true) {
    throw new CliError(
      `remove ${pluginId} is break operation (clean up Hub host install directory, cannot restore): non- interaction environment must --yes confirm`,
      'confirmation_required',
    )
  }
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(`remove plugin ${pluginId} and its install directory (cannot restore). input yes confirm:`)
    const normalized = answer.trim().toLowerCase()
    if (normalized !== 'y' && normalized !== 'yes') {
      throw new CliError('cancelled: not confirm remove', 'not_confirmed')
    }
  } finally {
    rl.close()
  }
}

export function pluginsCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []
  cmds.push({
    path: ['plugins', 'list'],
    description: 'column out plugin (GET /api/plugins)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<PluginSummary[]>('/api/plugins'))
    },
  })

  cmds.push({
    path: ['plugins', 'enable'],
    description: 'enable plugin (POST /api/plugins/:id/enable)',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      const hub = await ctx.hub()
      printResult(ctx, await hub.post<unknown>(`/api/plugins/${encodeURIComponent(id)}/enable`))
    },
  })

  cmds.push({
    path: ['plugins', 'disable'],
    description: 'deactivate plugin (POST /api/plugins/:id/disable;--force ignore durable asset occupy alert)',
    flags: [
      { name: 'force', type: 'boolean', help: 'force deactivate (ignore durable config/asset occupy alert; in-flight run task still cannot skip)' },
    ],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'force', type: 'boolean' }], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      const force = parsed.flags.get('force') === true
      const hub = await ctx.hub()
      const path = `/api/plugins/${encodeURIComponent(id)}/disable`
      try {
        // without --force when keep without body invoke: server side encounter durable asset occupy return 409
        // plugin_in_use, by under way rich is occupy manifest + --force hint.
        printResult(
          ctx,
          force ? await hub.post<unknown>(path, { force: true }) : await hub.post<unknown>(path),
        )
      } catch (err) {
        if (!force && err instanceof CliError && err.code === 'plugin_in_use') {
          throw enrichPluginInUseError(err)
        }
        throw err
      }
    },
  })

  cmds.push({
    path: ['plugins', 'config'],
    description: 'view/update plugin config (GET return {values,schema};PUT send {values};--set key=value and --unset key can duplicate)',
    flags: [
      { name: 'input', type: 'json', help: 'whole values JSON object (and --set can shared store,--set override for should key)' },
      { name: 'set', type: 'string', repeated: true, help: 'single items assignment key=value, can duplicate; value by JSON boolean/number parse, otherwise string' },
      { name: 'unset', type: 'string', repeated: true, help: 'reset designate config key back default value (send null delete explicit override value, can duplicate)' },
    ],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'input', type: 'json' },
          { name: 'set', type: 'string', repeated: true },
          { name: 'unset', type: 'string', repeated: true },
        ],
        ctx.args,
      )
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      const hasInput = parsed.flags.has('input')
      const sets = repeatedValues(parsed.flags, 'set')
      const unsets = repeatedValues(parsed.flags, 'unset')
      for (const key of unsets) {
        if (key.length === 0 || key.includes('=')) {
          throw new CliError(`--unset must be config key name (non-empty, excludes =), got "${key}"`, 'invalid_flag_value')
        }
      }
      const hub = await ctx.hub()
      const path = `/api/plugins/${encodeURIComponent(id)}/config`
      if (!hasInput && sets.length === 0 && unsets.length === 0) {
        printResult(ctx, await hub.get<unknown>(path))
        return
      }
      const setValues = parseKeyValues(sets, 'set')
      for (const key of unsets) {
        if (key in setValues) {
          throw new CliError(`--set and --unset cannot also effect at the same field: ${key}`, 'conflicting_flags')
        }
      }
      const values: Record<string, unknown> = hasInput ? coerceMetaFlag(parsed.flags.get('input'), 'input') : {}
      Object.assign(values, setValues)
      for (const key of unsets) values[key] = null
      printResult(ctx, await hub.put<unknown>(path, { values }))
    },
  })

  cmds.push({
    path: ['plugins', 'doc'],
    description:
      'read plugin public document (GET /api/plugins/:id/docs/:name;--conversation/--current read conversation document;--watch subscribe conversation document dedicated use SSE)',
    flags: [
      { name: 'conversation', type: 'number', help: 'conversation document target conversation ID(and --current mutual exclusion)' },
      { name: 'current', type: 'boolean', help: 'use env HELM_CONVERSATION_ID(and --conversation mutual exclusion)' },
      { name: 'watch', type: 'boolean', help: 'subscribe conversation document dedicated use SSE(must --conversation/--current;Ctrl-C exit)' },
    ],
    positional: '<pluginId> <name>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'conversation', type: 'number' },
          { name: 'current', type: 'boolean' },
          { name: 'watch', type: 'boolean' },
        ],
        ctx.args,
      )
      const pluginId = parsed.positionals[0]
      const name = parsed.positionals[1]
      if (pluginId === undefined || name === undefined) {
        throw new CliError('missing location parameter:plugins doc <pluginId> <name>', 'missing_id')
      }
      assertNoExtraPositionals(parsed.positionals, 2)
      const hasConversation = parsed.flags.has('conversation')
      const hasCurrent = parsed.flags.get('current') === true
      if (hasConversation && hasCurrent) {
        throw new CliError('--conversation and --current mutual exclusion', 'conflicting_flags')
      }
      let conversationId: number | undefined
      if (hasConversation) {
        const value = parsed.flags.get('conversation')
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
          throw new CliError('--conversation must be a positive integer conversation ID', 'invalid_flag_value')
        }
        conversationId = value
      } else if (hasCurrent) {
        conversationId = resolveConversationTarget(parsed.flags, undefined, ctx.env)
      }
      const base = `/api/plugins/${encodeURIComponent(pluginId)}/docs/${encodeURIComponent(name)}`
      const hub = await ctx.hub()
      if (parsed.flags.get('watch') === true) {
        if (conversationId === undefined) {
          throw new CliError('--watch need to conversation target (--conversation <id> or --current)', 'missing_conversation_target')
        }
        await watchSessionDoc(ctx, hub, base, conversationId, pluginId, name)
        return
      }
      const path =
        conversationId === undefined ? base : `${base}?conversationId=${conversationId}`
      const doc = await hub.get<{
        pluginId: string
        name: string
        conversationId?: number
        value: unknown
        deleted?: boolean
      }>(path)
      if (ctx.json) {
        printResult(ctx, doc)
        return
      }
      // person class pattern: document name + value (JSON fidelity; text value direct out)
      if (typeof doc.value === 'string') {
        ctx.io.out(`${doc.name}\n`)
        printPlainText(ctx, doc.value)
        return
      }
      printValue(ctx.io, doc.value, false)
    },
  })

  cmds.push({
    path: ['plugins', 'client'],
    description: 'get plugin client.tsx compile artifact (GET /api/plugins/:id/client.mjs?module=...;--module default client.tsx)',
    flags: [
      { name: 'module', type: 'string', help: 'each other for plugin clientRoot module path (default client.tsx)' },
      { name: 'chunk', type: 'string', help: 'optional chunk filename (such as vendor.js)' },
      { name: 'output', type: 'string', help: 'write target file path (default stdout;--json when still write file and print meta information)' },
    ],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'module', type: 'string' },
          { name: 'chunk', type: 'string' },
          { name: 'output', type: 'string' },
        ],
        ctx.args,
      )
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      const moduleRef = (parsed.flags.get('module') as string | undefined) ?? 'client.tsx'
      const chunk = parsed.flags.get('chunk') as string | undefined
      if (parsed.flags.has('output') && typeof parsed.flags.get('output') !== 'string') {
        throw new CliError('--output need to file path', 'invalid_flag_value')
      }
      const outPath = parsed.flags.get('output') as string | undefined
      const hub = await ctx.hub()
      let path = `/api/plugins/${encodeURIComponent(id)}/client.mjs?module=${encodeURIComponent(moduleRef)}`
      if (chunk !== undefined) {
        path += `&chunk=${encodeURIComponent(chunk)}`
      }
      const response = await hub.raw(path)
      const code = await response.text()
      const contentHash = response.headers.get('x-helm-client-hash') ?? ''
      if (ctx.json) {
        printResult(ctx, {
          pluginId: id,
          module: moduleRef,
          ...(chunk !== undefined ? { chunk } : {}),
          contentHash,
          bytes: code.length,
        })
      }
      if (outPath !== undefined) {
        const { writeFile } = await import('node:fs/promises')
        await writeFile(outPath, code, 'utf8')
        if (!ctx.json) ctx.io.out(`already write ${outPath}(${code.length} byte,hash ${contentHash})\n`)
        return
      }
      if (!ctx.json) ctx.io.out(code)
    },
  })

  cmds.push({
    path: ['plugins', 'doctor'],
    description: 'external plugin source code static self inspect (POST /api/plugins/doctor; real load+real register+client compile)',
    flags: [
      { name: 'path', type: 'string', help: 'external plugin source directory absolute path (and --dir etc. price;--id/<id> mutual exclusion)' },
      { name: 'dir', type: 'string', help: '--path compatibility alias (etc. price)' },
      { name: 'id', type: 'string', help: 'registered external plugin id(server side parse its source directory; and path mutual exclusion)' },
    ],
    positional: '[<id> | <dir>]',
    async run(ctx: CommandContext) {
      const parsed = parseFlags(
        [
          { name: 'path', type: 'string' },
          { name: 'dir', type: 'string' },
          { name: 'id', type: 'string' },
        ],
        ctx.args,
      )
      const pathFlag = parsed.flags.get('path')
      const dirFlag = parsed.flags.get('dir')
      const idFlag = parsed.flags.get('id')
      const positional = parsed.positionals[0]
      // location parameter semantics push assert: absolute path -> directory target; otherwise -> plugin id.
      const positionalIsPath =
        positional !== undefined &&
        (positional.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(positional) || positional.startsWith('\\\\'))
      const pathDir =
        typeof pathFlag === 'string' && pathFlag.length > 0
          ? pathFlag
          : typeof dirFlag === 'string' && dirFlag.length > 0
            ? dirFlag
            : positionalIsPath
              ? positional
              : undefined
      const id =
        typeof idFlag === 'string' && idFlag.length > 0
          ? idFlag
          : !positionalIsPath && positional !== undefined
            ? positional
            : undefined
      if (pathDir === undefined && id === undefined) {
        throw new CliError('missing target:<id>,--path <dir> or --dir <dir>(choose one)', 'missing_id')
      }
      if (pathDir !== undefined && id !== undefined) {
        throw new CliError('id and path target mutual exclusion (choose one provide)', 'conflicting_flags')
      }
      const usedPositionals = positional !== undefined && (positionalIsPath ? pathDir === positional : id === positional) ? 1 : 0
      assertNoExtraPositionals(parsed.positionals, usedPositionals)
      const hub = await ctx.hub()
      const body = pathDir !== undefined ? { path: pathDir } : { id: id! }
      const report = await hub.post<PluginDoctorReport>('/api/plugins/doctor', body)
      if (ctx.json) {
        printResult(ctx, report)
      } else {
        ctx.io.out(
          `plugin self inspect:${report.dir}${report.pluginId ? `(id: ${report.pluginId})` : ''}${report.requestedId ? `(target id: ${report.requestedId})` : ''}\n`,
        )
        for (const check of report.checks) {
          if (check.error === undefined) {
            ctx.io.out(`  [ok] ${check.id} - ${check.label}\n`)
          } else {
            ctx.io.out(`  [!!] ${check.id} - ${check.label}\n        ${check.error.code}: ${check.error.message}\n`)
          }
        }
        ctx.io.out(report.ok ? 'conclusion: all check via\n' : 'conclusion: store in failed items (see on)\n')
      }
      // preflight failed: report already complete output (stdout), with non-zero exit code wrap-up supply script consume.
      if (!report.ok) {
        throw new CliError(
          `plugin self inspect store in failed items (${report.checks.filter((c) => c.error !== undefined).length} items)`,
          'doctor_failed',
        )
      }
    },
  })

  cmds.push({
    path: ['plugins', 'reload'],
    description: 'external plugin subject to control hot reload (POST /api/plugins/:id/reload; preflight failed old instance keep do not motion)',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      const hub = await ctx.hub()
      const result = await hub.post<PluginReloadResult>(
        `/api/plugins/${encodeURIComponent(id)}/reload`,
      )
      if (ctx.json) {
        printResult(ctx, result)
        return
      }
      ctx.io.out(
        `already reload ${result.pluginId}(proxy boundary ${result.generation}, enable state keep:${result.wasEnabled ? 'enabled' : 'deactivated'})\n`,
      )
      printResult(ctx, result.summary)
    },
  })

  cmds.push({
    path: ['plugins', 'rescan'],
    description: 'incremental heavy scan plugin directory (POST /api/plugins/rescan; only register new external plugin, by default deactivate)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      const result = await hub.post<PluginRescanResult>('/api/plugins/rescan')
      if (ctx.json) {
        printResult(ctx, result)
        return
      }
      if (result.registered.length === 0) {
        ctx.io.out('not found new plugin (registered plugin and pure data directory do not reload)\n')
      } else {
        ctx.io.out(`new register ${result.registered.length} plugin (by default deactivate):\n`)
        for (const id of result.registered) ctx.io.out(`  - ${id}\n`)
        ctx.io.out('enable:helm plugins enable <id>\n')
      }
      ctx.io.out(`(skip ${result.skipped} directory; when before shared ${result.plugins.length} plugin)\n`)
    },
  })

  cmds.push({
    path: ['plugins', 'init'],
    description:
      'local foot manually frame: in target directory generate external plugin skeleton (do not access Hub);--template app generate can via helm apps validate full-stack micro app',
    flags: [
      { name: 'dir', type: 'string', help: 'target parent directory (by default <dataDir>/plugins; directory must already exists or can create)' },
      { name: 'name', type: 'string', help: 'plugin directory name and by default id(character parent number and - _, by default sample-plugin)' },
      {
        name: 'template',
        type: 'string',
        help: 'skeleton template:minimal(only backend probe needle action)| full(contains doc/action/frontend panel)| app(full-stack micro app:doc/double action/screen main view + sidebar entry, artifact directly helm apps validate); by default full',
      },
      { name: 'force', type: 'boolean', help: 'target directory non-empty when continue (by default reject, guard against override)' },
    ],
    positional: '[name]',
    async run(ctx: CommandContext) {
      await runPluginsInit(ctx)
    },
  })

  cmds.push({
    path: ['plugins', 'install'],
    description:
      'from npm/git/local path install external plugin package and register (POST /api/plugins/install; by default deactivate,--enable install after i.e. enable).source by Hub parse, local path each other for Hub host; install enable i.e. in Hub inside execute can message plugin code, without sandbox',
    flags: [{ name: 'enable', type: 'boolean', help: 'install after immediately enable (default register is deactivate)' }],
    positional: '<source>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'enable', type: 'boolean' }], ctx.args)
      const source = requirePositional(parsed.positionals, 0, 'source')
      if (source.trim() === '') {
        throw new CliError(
          '<source> cannot be empty (npm:<spec> / git:<repo>@<ref> / HTTPS Git URL / local path, language method by Hub parse)',
          'invalid_flag_value',
        )
      }
      assertNoExtraPositionals(parsed.positionals, 1)
      const enable = parsed.flags.get('enable') === true
      const hub = await ctx.hub()
      const result = await hub.post<PluginInstallResult>('/api/plugins/install', {
        source,
        ...(enable ? { enable: true } : {}),
      })
      if (ctx.json) {
        printResult(ctx, result)
        return
      }
      ctx.io.out(
        `installed ${result.summary.id}${result.record.version === '' ? '' : ` ${result.record.version}`}(source ${result.record.source.raw})\n`,
      )
      ctx.io.out(`install directory (Hub host):${result.record.installPath}\n`)
      ctx.io.out(
        result.summary.enabled
          ? 'state: enabled\n'
          : `state: deactivated (enable:helm plugins enable ${result.summary.id})\n`,
      )
    },
  })

  cmds.push({
    path: ['plugins', 'update'],
    description: 'update installed external plugin package and reload (POST /api/plugins/:id/update; target must is managed install plugin)',
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      const hub = await ctx.hub()
      const result = await hub.post<PluginUpdateResult>(
        `/api/plugins/${encodeURIComponent(id)}/update`,
      )
      if (ctx.json) {
        printResult(ctx, result)
        return
      }
      const ver = (v: string): string => (v === '' ? 'unknown version' : v)
      if (result.changed) {
        ctx.io.out(`already update ${result.record.pluginId}:${ver(result.previousVersion)} -> ${ver(result.record.version)}\n`)
      } else {
        ctx.io.out(`${result.record.pluginId} source not change, without update (when before ${ver(result.record.version)})\n`)
      }
      ctx.io.out(
        `install directory (Hub host):${result.record.installPath}; state:${result.summary.enabled ? 'enabled' : 'deactivated'}\n`,
      )
    },
  })

  cmds.push({
    path: ['plugins', 'remove'],
    description:
      'remove managed install external plugin package (POST /api/plugins/:id/remove; deactivate and clean up Hub host on install directory and record, cannot restore). person class pattern by default confirm (TTY input yes), non- interaction environment use --yes',
    flags: [{ name: 'yes', type: 'boolean', help: 'skip confirm (non- interaction/script environment)' }],
    positional: '<id>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'yes', type: 'boolean' }], ctx.args)
      const id = requirePositional(parsed.positionals, 0, 'id')
      assertNoExtraPositionals(parsed.positionals, 1)
      await confirmRemove(ctx, parsed.flags.get('yes') === true, id)
      const hub = await ctx.hub()
      const result = await hub.post<PluginRemoveResult>(
        `/api/plugins/${encodeURIComponent(id)}/remove`,
      )
      if (ctx.json) {
        printResult(ctx, result)
        return
      }
      ctx.io.out(`already remove ${result.pluginId}(install record ${result.installId}; remove before${result.wasEnabled ? 'enable in' : 'deactivated'})\n`)
      ctx.io.out(`already clean up directory (Hub host):${result.installPath}\n`)
    },
  })

  cmds.push({
    path: ['actions', 'list'],
    description: 'column out plugin action manifest (GET /api/actions)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<ActionManifest[]>('/api/actions'))
    },
  })

  return cmds
}

// ---------------------------------------------------------------------------
// 409 plugin_in_use rich: keep code/details, message attach carries occupy manifest and --force hint
// ---------------------------------------------------------------------------

/** from error details in extract structure legal occupy list (usages: [{kind,id,label}]). */
function extractInUseUsages(details: unknown): Array<{ kind: string; id: string; label: string }> {
  if (details === null || typeof details !== 'object') return []
  const usages = (details as { usages?: unknown }).usages
  if (!Array.isArray(usages)) return []
  return usages.filter(
    (item): item is { kind: string; id: string; label: string } =>
      item !== null &&
      typeof item === 'object' &&
      typeof (item as { kind?: unknown }).kind === 'string' &&
      typeof (item as { id?: unknown }).id === 'string' &&
      typeof (item as { label?: unknown }).label === 'string',
  )
}

/** keep original CliError  code/details/exitCode, only rich person class can read message. */
function enrichPluginInUseError(err: CliError): CliError {
  const usages = extractInUseUsages(err.details)
  if (usages.length === 0) return err
  const lines = [err.message, 'occupy in durable asset:']
  for (const usage of usages) {
    lines.push(`  - [${usage.kind}] ${usage.id}:${usage.label}`)
  }
  lines.push('confirm after can use --force force deactivate (in-flight run task still cannot skip).')
  return new CliError(lines.join('\n'), err.code, err.exitCode, err.details)
}

// ---------------------------------------------------------------------------
// plugins init: local foot manually frame (do not access Hub; file after use doctor/reload closed ring verify)
// file content template see scaffold-templates.ts(pure data module)
// ---------------------------------------------------------------------------

/** plugin id/directory name: character parent number open head, allows - _(and protocol plugin id rule align, forbid builtin:). */
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** generate plugin skeleton file (store in preflight + non-empty directory reject + template choose + explicit produce out manifest). */
async function runPluginsInit(ctx: CommandContext): Promise<void> {
  const parsed = parseFlags(
    [
      { name: 'dir', type: 'string' },
      { name: 'name', type: 'string' },
      { name: 'template', type: 'string' },
      { name: 'force', type: 'boolean' },
    ],
    ctx.args,
  )
  const nameFlag = parsed.flags.get('name')
  const namePositional = parsed.positionals[0]
  const name = typeof nameFlag === 'string' && nameFlag.length > 0 ? nameFlag : namePositional
  if (typeof name !== 'string' || name.length === 0) {
    throw new CliError('missing <name>(--name or location parameter)', 'missing_id')
  }
  if (!PLUGIN_NAME_PATTERN.test(name) || name.startsWith('builtin:')) {
    throw new CliError(
      `plugin name illegal:${name}(must match ${PLUGIN_NAME_PATTERN}, and forbidden builtin: prefix)`,
      'invalid_flag_value',
    )
  }
  const templateRaw = parsed.flags.get('template')
  if (templateRaw !== undefined && !SCAFFOLD_TEMPLATES.includes(templateRaw as ScaffoldTemplate)) {
    throw new CliError(`--template must be ${SCAFFOLD_TEMPLATES.join(' | ')}`, 'invalid_flag_value')
  }
  const template = (templateRaw ?? 'full') as ScaffoldTemplate
  const usedPositionals = name === namePositional ? 1 : 0
  assertNoExtraPositionals(parsed.positionals, usedPositionals)
  const parentDir =
    typeof parsed.flags.get('dir') === 'string' && (parsed.flags.get('dir') as string).length > 0
      ? (parsed.flags.get('dir') as string)
      : `${ctx.dataDir}/plugins`
  const target = `${parentDir.replace(/\/+$/, '')}/${name}`
  const force = parsed.flags.get('force') === true

  const fsp = await import('node:fs/promises')
  const path = await import('node:path')
  // parent directory: missing when create (and plugins directory convention consistent); store in but non- directory explicit errors.
  try {
    const st = await fsp.stat(parentDir)
    if (!st.isDirectory()) {
      throw new CliError(`--dir is not directory:${parentDir}`, 'invalid_flag_value')
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (err instanceof CliError) throw err
      throw new CliError(
        `check --dir failed (${parentDir}):${err instanceof Error ? err.message : String(err)}`,
        'read_failed',
      )
    }
    await fsp.mkdir(parentDir, { recursive: true })
  }
  // target directory: already exists and non-empty when by default reject (--force continue); already exists is empty when re- use.
  let targetExisted = false
  try {
    const st = await fsp.stat(target)
    if (!st.isDirectory()) {
      throw new CliError(`target path already exists and is not directory:${target}`, 'conflict')
    }
    targetExisted = true
    const existing = await fsp.readdir(target)
    if (existing.length > 0 && !force) {
      throw new CliError(
        `target directory non-empty:${target}(use --force continue; existing file will not by delete, but same name file by override)`,
        'conflict',
      )
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (err instanceof CliError) throw err
      throw new CliError(
        `check target directory failed (${target}):${err instanceof Error ? err.message : String(err)}`,
        'read_failed',
      )
    }
  }
  // target directory missing when create (minimal template without client subdirectory, directory must explicit create).
  await fsp.mkdir(target, { recursive: true })
  const files: string[] = ['plugin.json', 'index.ts', 'tsconfig.json']
  await fsp.writeFile(path.join(target, 'plugin.json'), SCAFFOLD_PLUGIN_JSON(name, template), 'utf8')
  await fsp.writeFile(
    path.join(target, 'index.ts'),
    template === 'minimal'
      ? SCAFFOLD_INDEX_TS_MINIMAL(name)
      : template === 'app'
        ? SCAFFOLD_INDEX_TS_APP(name, `${name} should use`)
        : SCAFFOLD_INDEX_TS_FULL(name),
    'utf8',
  )
  await fsp.writeFile(path.join(target, 'tsconfig.json'), SCAFFOLD_TSCONFIG, 'utf8')
  if (template === 'full') {
    await fsp.mkdir(path.join(target, 'client'), { recursive: true })
    await fsp.writeFile(path.join(target, 'client', 'index.tsx'), SCAFFOLD_CLIENT_INDEX_TSX, 'utf8')
    files.push('client/index.tsx')
  }
  if (template === 'app') {
    await fsp.mkdir(path.join(target, 'client'), { recursive: true })
    await fsp.writeFile(path.join(target, 'client', 'index.tsx'), SCAFFOLD_CLIENT_APP_TSX, 'utf8')
    await fsp.writeFile(path.join(target, 'client', 'styles.css'), SCAFFOLD_CLIENT_APP_CSS, 'utf8')
    files.push('client/index.tsx', 'client/styles.css')
  }
  await fsp.writeFile(path.join(target, 'README.md'), SCAFFOLD_README(template), 'utf8')
  files.push('README.md')

  const summary = {
    pluginId: name,
    dir: target,
    template,
    files,
    targetExisted,
    nextSteps:
      template === 'app'
        ? [`helm plugins doctor ${target}`, `helm apps validate ${target}`, `helm apps publish ${target}`]
        : [`helm plugins doctor ${target}`, 'helm plugins rescan', `helm plugins enable ${name}`],
  }
  if (ctx.json) {
    printResult(ctx, summary)
    return
  }
  ctx.io.out(
    `already generate${template === 'app' ? 'full-stack micro app' : 'plugin'}skeleton (template ${template}):${target}${targetExisted ? '(directory already exists, file already write/override)' : ''}\n`,
  )
  for (const file of summary.files) ctx.io.out(`  - ${file}\n`)
  ctx.io.out('after continue step:\n')
  for (const step of summary.nextSteps) ctx.io.out(`  ${step}\n`)
}
