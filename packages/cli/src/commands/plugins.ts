/**
 * Plugin commands: plugins list/enable/disable/config/doc/client, doctor/reload/rescan
 * (DX loop), install/update/remove (managed package management), and actions list.
 * In addition to --input <json>, config supports repeatable --set key=value (values parsed
 * as JSON boolean/number when valid, otherwise string). plugins init scaffolds local
 * plugins using minimal/full/app templates (app artifacts pass helm apps validate directly).
 */
import {
  HelmError,
  PREBUILT_CLIENT_DIR_NAME,
  type ActionManifest,
  type BuildPluginClientBundleDirOptions,
  type BuildPluginClientBundleDirResult,
  type PluginClientNpmRoot,
  type PluginDoctorReport,
  type PluginInstallResult,
  type PluginReloadResult,
  type PluginRemoveResult,
  type PluginRescanResult,
  type PluginSummary,
  type PluginUpdateResult,
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
 * Session document subscription (--watch): consumes dedicated SSE (GET /api/plugins/:id/docs/:name/events?conversationId=N).
 * - --json: emits NDJSON per frame (both snapshot and incremental frames verbatim);
 * - human mode: snapshot prints current value; incremental frames print a change summary line + new value;
 * - 404 on connect (plugin disabled / conversation deleted / document not public) fails explicitly and stops without retrying.
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
  const label = `${pluginId}/${name}#conversation-${conversationId}`
  try {
    await hub.streamSse(`${base}/events?conversationId=${conversationId}`, {
      signal: controller.signal,
      onFrame: ({ event, data }) => {
        let payload: unknown
        try {
          payload = JSON.parse(data)
        } catch {
          ctx.io.err(`helm: ignoring non-JSON SSE frame (${data.slice(0, 120)})\n`)
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
        ctx.io.out(`[${label}] update seq=${frame.seq ?? '?'}${doc?.deleted === true ? ' (deleted)' : ''}\n`)
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
 * Destructive removal confirmation (reuses CLI TTY/non-TTY convention, matching login password prompt):
 * --yes and --json proceed non-interactively; TTY prompts one line on stdin (y/yes confirms);
 * non-TTY without --yes rejects explicitly — never hangs waiting for input on unattended pipes.
 */
async function confirmRemove(ctx: CommandContext, assumedYes: boolean, pluginId: string): Promise<void> {
  if (ctx.json || assumedYes) return
  if (process.stdin.isTTY !== true) {
    throw new CliError(
      `removing ${pluginId} is destructive (deletes Hub host install directory irreversibly): pass --yes in non-interactive environments`,
      'confirmation_required',
    )
  }
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(`Remove plugin ${pluginId} and its install directory (irreversible)? Type yes to confirm: `)
    const normalized = answer.trim().toLowerCase()
    if (normalized !== 'y' && normalized !== 'yes') {
      throw new CliError('cancelled: removal not confirmed', 'not_confirmed')
    }
  } finally {
    rl.close()
  }
}

export function pluginsCommands(): CommandSpec[] {
  const cmds: CommandSpec[] = []
  cmds.push({
    path: ['plugins', 'list'],
    description: 'List plugins (GET /api/plugins)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<PluginSummary[]>('/api/plugins'))
    },
  })

  cmds.push({
    path: ['plugins', 'enable'],
    description: 'Enable a plugin (POST /api/plugins/:id/enable)',
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
    description: 'Disable a plugin (POST /api/plugins/:id/disable; --force ignores persistent resource-in-use warnings)',
    flags: [
      { name: 'force', type: 'boolean', help: 'force disable (ignore persistent config/resource warnings; live in-flight tasks still cannot be bypassed)' },
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
        // Without --force, send no body: if persistent resources are in use, the server returns 409
        // plugin_in_use, which we enrich below with usage details and a --force hint.
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
    description: 'View or update plugin config (GET returns {values,schema}; PUT sends {values}; --set key=value and --unset key are repeatable)',
    flags: [
      { name: 'input', type: 'json', help: 'full values JSON object (can be combined with --set; --set overrides matching keys)' },
      { name: 'set', type: 'string', repeated: true, help: 'set a single key=value (repeatable; values parsed as JSON bool/number when valid, otherwise string)' },
      { name: 'unset', type: 'string', repeated: true, help: 'reset a config key to its default (sends null to remove explicit override; repeatable)' },
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
          throw new CliError(`--unset must be a config key name (non-empty, without =), got "${key}"`, 'invalid_flag_value')
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
          throw new CliError(`--set and --unset cannot target the same key: ${key}`, 'conflicting_flags')
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
      'Read a public plugin document (GET /api/plugins/:id/docs/:name; --conversation/--current reads a session doc; --watch subscribes to session doc SSE)',
    flags: [
      { name: 'conversation', type: 'number', help: 'target conversation ID for session document (mutually exclusive with --current)' },
      { name: 'current', type: 'boolean', help: 'use HELM_CONVERSATION_ID from environment (mutually exclusive with --conversation)' },
      { name: 'watch', type: 'boolean', help: 'subscribe to dedicated SSE for a session document (requires --conversation/--current; Ctrl-C to exit)' },
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
        throw new CliError('missing positional arguments: plugins doc <pluginId> <name>', 'missing_id')
      }
      assertNoExtraPositionals(parsed.positionals, 2)
      const hasConversation = parsed.flags.has('conversation')
      const hasCurrent = parsed.flags.get('current') === true
      if (hasConversation && hasCurrent) {
        throw new CliError('--conversation and --current are mutually exclusive', 'conflicting_flags')
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
          throw new CliError('--watch requires a target conversation (--conversation <id> or --current)', 'missing_conversation_target')
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
      // Human mode: document name + value (preserve JSON fidelity; print string values verbatim)
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
    description: 'Fetch compiled plugin client.tsx bundle (GET /api/plugins/:id/client.mjs?module=...; --module defaults to client.tsx)',
    flags: [
      { name: 'module', type: 'string', help: 'module path relative to plugin clientRoot (defaults to client.tsx)' },
      { name: 'chunk', type: 'string', help: 'optional chunk filename (e.g. vendor.js)' },
      { name: 'output', type: 'string', help: 'write output to file path (defaults to stdout; still writes file and prints metadata with --json)' },
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
        throw new CliError('--output requires a file path', 'invalid_flag_value')
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
        if (!ctx.json) ctx.io.out(`wrote ${outPath} (${code.length} bytes, hash ${contentHash})\n`)
        return
      }
      if (!ctx.json) ctx.io.out(code)
    },
  })

  cmds.push({
    path: ['plugins', 'doctor'],
    description: 'Run static self-check on external plugin source (POST /api/plugins/doctor; loads, registers, and compiles client)',
    flags: [
      { name: 'path', type: 'string', help: 'absolute path to external plugin source directory (equivalent to --dir; mutually exclusive with --id/<id>)' },
      { name: 'dir', type: 'string', help: 'compatibility alias for --path' },
      { name: 'id', type: 'string', help: 'registered external plugin ID (server resolves its source directory; mutually exclusive with path)' },
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
      // Infer positional intent: absolute path -> directory target; otherwise -> plugin ID.
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
        throw new CliError('missing target: provide <id>, --path <dir>, or --dir <dir>', 'missing_id')
      }
      if (pathDir !== undefined && id !== undefined) {
        throw new CliError('id and directory path cannot both be provided', 'conflicting_flags')
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
          `Plugin doctor: ${report.dir}${report.pluginId ? ` (id: ${report.pluginId})` : ''}${report.requestedId ? ` (target id: ${report.requestedId})` : ''}\n`,
        )
        for (const check of report.checks) {
          if (check.error === undefined) {
            ctx.io.out(`  [ok] ${check.id} — ${check.label}\n`)
          } else {
            ctx.io.out(`  [!!] ${check.id} — ${check.label}\n        ${check.error.code}: ${check.error.message}\n`)
          }
        }
        ctx.io.out(report.ok ? 'Result: all checks passed\n' : 'Result: failed checks found (see above)\n')
      }
      // Preflight failed: report is already printed to stdout; exit non-zero for script callers.
      if (!report.ok) {
        throw new CliError(
          `plugin doctor found failures (${report.checks.filter((c) => c.error !== undefined).length} check(s))`,
          'doctor_failed',
        )
      }
    },
  })

  cmds.push({
    path: ['plugins', 'reload'],
    description: 'Hot-reload an external plugin with preflight checks (POST /api/plugins/:id/reload; keeps previous instance if preflight fails)',
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
        `Reloaded ${result.pluginId} (generation ${result.generation}, enabled state preserved: ${result.wasEnabled ? 'enabled' : 'disabled'})\n`,
      )
      printResult(ctx, result.summary)
    },
  })

  cmds.push({
    path: ['plugins', 'rescan'],
    description: 'Incrementally rescan the plugins directory (POST /api/plugins/rescan; registers new external plugins as disabled by default)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      const result = await hub.post<PluginRescanResult>('/api/plugins/rescan')
      if (ctx.json) {
        printResult(ctx, result)
        return
      }
      if (result.registered.length === 0) {
        ctx.io.out('No new plugins found (already registered plugins and data-only directories are unchanged)\n')
      } else {
        ctx.io.out(`Registered ${result.registered.length} new plugin(s) (disabled by default):\n`)
        for (const id of result.registered) ctx.io.out(`  - ${id}\n`)
        ctx.io.out('Enable with: helm plugins enable <id>\n')
      }
      ctx.io.out(`(skipped ${result.skipped} directory(ies); ${result.plugins.length} plugin(s) total)\n`)
    },
  })

  cmds.push({
    path: ['plugins', 'init'],
    description:
      'Local scaffold: generate an external plugin skeleton in the target directory without contacting Hub; --template app passes helm apps validate',
    flags: [
      { name: 'dir', type: 'string', help: 'target parent directory (defaults to <dataDir>/plugins; must exist or be creatable)' },
      { name: 'name', type: 'string', help: 'plugin directory name and default id (alphanumeric plus - _, defaults to sample-plugin)' },
      {
        name: 'template',
        type: 'string',
        help: 'skeleton template: minimal (backend ping action only) | full (doc/action/workbench panel) | app (full-stack micro-app: doc/actions/screen + sidebar item, passes helm apps validate); defaults to full',
      },
      { name: 'force', type: 'boolean', help: 'proceed even if target directory is non-empty (rejected by default to prevent overwriting)' },
    ],
    positional: '[name]',
    async run(ctx: CommandContext) {
      await runPluginsInit(ctx)
    },
  })

  cmds.push({
    path: ['plugins', 'build'],
    description:
      'Local build: precompile a plugin directory client modules into static dist-client/ artifacts without contacting Hub',
    flags: [
      { name: 'dir', type: 'string', help: 'plugin directory path (defaults to current working directory)' },
      { name: 'out', type: 'string', help: 'output prebuilt directory (defaults to manifest clientDist or <dir>/dist-client)' },
      {
        name: 'module',
        type: 'string',
        repeated: true,
        help: 'explicit relative .ts/.tsx entry module(s) inside clientRoot (repeatable; auto-scans clientRoot when omitted)',
      },
    ],
    positional: '[dir]',
    async run(ctx: CommandContext) {
      await runPluginsBuild(ctx)
    },
  })

  cmds.push({
    path: ['plugins', 'install'],
    description:
      'Install and register an external plugin package from npm/git/local path (POST /api/plugins/install; disabled by default unless --enable). source is resolved on the Hub host; enabled plugins run trusted code in-process with no sandbox',
    flags: [{ name: 'enable', type: 'boolean', help: 'enable immediately after install (registered as disabled by default)' }],
    positional: '<source>',
    async run(ctx: CommandContext) {
      const parsed = parseFlags([{ name: 'enable', type: 'boolean' }], ctx.args)
      const source = requirePositional(parsed.positionals, 0, 'source')
      if (source.trim() === '') {
        throw new CliError(
          '<source> cannot be empty (npm:<spec> / git:<repo>@<ref> / HTTPS Git URL / local path; parsed by Hub)',
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
        `Installed ${result.summary.id}${result.record.version === '' ? '' : ` ${result.record.version}`} (source: ${result.record.source.raw})\n`,
      )
      ctx.io.out(`Install directory (Hub host): ${result.record.installPath}\n`)
      ctx.io.out(
        result.summary.enabled
          ? 'Status: enabled\n'
          : `Status: disabled (enable with: helm plugins enable ${result.summary.id})\n`,
      )
    },
  })

  cmds.push({
    path: ['plugins', 'update'],
    description: 'Update an installed external plugin package and reload (POST /api/plugins/:id/update; target must be a managed installation)',
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
        ctx.io.out(`Updated ${result.record.pluginId}: ${ver(result.previousVersion)} -> ${ver(result.record.version)}\n`)
      } else {
        ctx.io.out(`${result.record.pluginId} source unchanged; no update (current ${ver(result.record.version)})\n`)
      }
      ctx.io.out(
        `Install directory (Hub host): ${result.record.installPath}; status: ${result.summary.enabled ? 'enabled' : 'disabled'}\n`,
      )
    },
  })

  cmds.push({
    path: ['plugins', 'remove'],
    description:
      'Remove a managed external plugin package (POST /api/plugins/:id/remove; disables plugin and deletes its Hub install directory and record irreversibly). Prompts for confirmation on TTY; pass --yes non-interactively',
    flags: [{ name: 'yes', type: 'boolean', help: 'skip confirmation prompt (for non-interactive/scripted usage)' }],
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
      ctx.io.out(`Removed ${result.pluginId} (install record ${result.installId}; was ${result.wasEnabled ? 'enabled' : 'disabled'})\n`)
      ctx.io.out(`Removed directory (Hub host): ${result.installPath}\n`)
    },
  })

  cmds.push({
    path: ['actions', 'list'],
    description: 'List registered plugin actions (GET /api/actions)',
    async run(ctx: CommandContext) {
      parseNoFlags(ctx)
      const hub = await ctx.hub()
      printResult(ctx, await hub.get<ActionManifest[]>('/api/actions'))
    },
  })

  return cmds
}

// ---------------------------------------------------------------------------
// 409 plugin_in_use enrichment: preserve code/details while appending occupied resources and --force hint
// ---------------------------------------------------------------------------

/** Extract valid usage entries (usages: [{kind,id,label}]) from error details. */
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

/** Preserve original CliError code/details/exitCode while enriching the human-readable message. */
function enrichPluginInUseError(err: CliError): CliError {
  const usages = extractInUseUsages(err.details)
  if (usages.length === 0) return err
  const lines = [err.message, 'Occupied persistent resources:']
  for (const usage of usages) {
    lines.push(`  - [${usage.kind}] ${usage.id}: ${usage.label}`)
  }
  lines.push('Pass --force to disable anyway (live in-flight tasks still cannot be bypassed).')
  return new CliError(lines.join('\n'), err.code, err.exitCode, err.details)
}

// ---------------------------------------------------------------------------
// plugins init: local scaffold (no Hub calls; verify generated files with doctor/reload)
// File templates live in scaffold-templates.ts (pure data module)
// ---------------------------------------------------------------------------

/** Plugin ID / directory name: starts with alphanumeric, allows - _ (aligned with protocol plugin ID rules; builtin: forbidden). */
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Generate plugin skeleton files (validates parent dir, rejects non-empty targets, selects template, reports outputs). */
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
    throw new CliError('missing <name> (--name or positional argument)', 'missing_id')
  }
  if (!PLUGIN_NAME_PATTERN.test(name) || name.startsWith('builtin:')) {
    throw new CliError(
      `invalid plugin name: ${name} (must match ${PLUGIN_NAME_PATTERN}, and builtin: prefix is forbidden)`,
      'invalid_flag_value',
    )
  }
  const templateRaw = parsed.flags.get('template')
  if (templateRaw !== undefined && !SCAFFOLD_TEMPLATES.includes(templateRaw as ScaffoldTemplate)) {
    throw new CliError(`--template must be one of ${SCAFFOLD_TEMPLATES.join(' | ')}`, 'invalid_flag_value')
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
  // Parent directory: create if missing (matches plugins directory convention); fail explicitly if it exists as a non-directory.
  try {
    const st = await fsp.stat(parentDir)
    if (!st.isDirectory()) {
      throw new CliError(`--dir is not a directory: ${parentDir}`, 'invalid_flag_value')
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (err instanceof CliError) throw err
      throw new CliError(
        `failed to inspect --dir (${parentDir}): ${err instanceof Error ? err.message : String(err)}`,
        'read_failed',
      )
    }
    await fsp.mkdir(parentDir, { recursive: true })
  }
  // Target directory: reject by default if existing and non-empty (--force proceeds); reuse if empty.
  let targetExisted = false
  try {
    const st = await fsp.stat(target)
    if (!st.isDirectory()) {
      throw new CliError(`target path already exists and is not a directory: ${target}`, 'conflict')
    }
    targetExisted = true
    const existing = await fsp.readdir(target)
    if (existing.length > 0 && !force) {
      throw new CliError(
        `target directory is non-empty: ${target} (pass --force to proceed; existing unrelated files are kept, matching filenames will be overwritten)`,
        'conflict',
      )
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (err instanceof CliError) throw err
      throw new CliError(
        `failed to inspect target directory (${target}): ${err instanceof Error ? err.message : String(err)}`,
        'read_failed',
      )
    }
  }
  // Create target directory if missing (minimal template has no client subdir, so root must be created explicitly).
  await fsp.mkdir(target, { recursive: true })
  const files: string[] = ['plugin.json', 'index.ts', 'tsconfig.json']
  await fsp.writeFile(path.join(target, 'plugin.json'), SCAFFOLD_PLUGIN_JSON(name, template), 'utf8')
  await fsp.writeFile(
    path.join(target, 'index.ts'),
    template === 'minimal'
      ? SCAFFOLD_INDEX_TS_MINIMAL(name)
      : template === 'app'
        ? SCAFFOLD_INDEX_TS_APP(name, `${name} App`)
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
    `Generated ${template === 'app' ? 'full-stack micro-app' : 'plugin'} skeleton (template ${template}): ${target}${targetExisted ? ' (directory existed; files written/overwritten)' : ''}\n`,
  )
  for (const file of summary.files) ctx.io.out(`  - ${file}\n`)
  ctx.io.out('Next steps:\n')
  for (const step of summary.nextSteps) ctx.io.out(`  ${step}\n`)
}

// ---------------------------------------------------------------------------
// plugins build: local prebuilt dist-client generator (no Hub calls)
// ---------------------------------------------------------------------------

async function readOptionalManifestObject(
  filePath: string,
  label: string,
): Promise<Record<string, unknown> | undefined> {
  const fsp = await import('node:fs/promises')
  let text: string
  try {
    text = await fsp.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new CliError(
      `failed to read ${label} (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
      'read_failed',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new CliError(
      `invalid JSON in ${label} (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
      'invalid_plugin_manifest',
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError(`${label} (${filePath}) must be a JSON object`, 'invalid_plugin_manifest')
  }
  return parsed as Record<string, unknown>
}

function isOutsidePluginBase(pathMod: typeof import('node:path'), base: string, target: string): boolean {
  const rel = pathMod.relative(base, target)
  return rel === '..' || rel.startsWith(`..${pathMod.sep}`) || pathMod.isAbsolute(rel)
}

async function resolveNearestRealpath(
  pathMod: typeof import('node:path'),
  fsp: typeof import('node:fs/promises'),
  target: string,
): Promise<{ kind: 'ok'; real: string } | { kind: 'dangling-symlink' }> {
  let cur = target
  for (;;) {
    try {
      return { kind: 'ok', real: await fsp.realpath(cur) }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
      // A dangling symlink fails realpath with ENOENT; surface it as a symlink escape rather than masking via parent.
      try {
        if ((await fsp.lstat(cur)).isSymbolicLink()) return { kind: 'dangling-symlink' }
      } catch {
        // Missing component: walk up to nearest existing ancestor.
      }
      const parent = pathMod.dirname(cur)
      if (parent === cur) throw err
      cur = parent
    }
  }
}

async function assertPathInsidePluginRoot(
  pluginDir: string,
  dirReal: string,
  rawSubpath: string,
  resolvedPath: string,
  field: string,
): Promise<void> {
  const path = await import('node:path')
  const fsp = await import('node:fs/promises')
  // Compare lexical containment against pluginDir (same base used by path.resolve) so 8.3 short paths
  // (e.g. Windows RUNNER~1) or symlinked parent dirs (/var -> /private/var) do not falsely mismatch dirReal.
  const lexicalEscapes = path.isAbsolute(rawSubpath)
    ? isOutsidePluginBase(path, pluginDir, resolvedPath) && isOutsidePluginBase(path, dirReal, resolvedPath)
    : isOutsidePluginBase(path, pluginDir, resolvedPath)
  if (lexicalEscapes) {
    throw new CliError(
      `plugin ${pluginDir} ${field} escapes plugin directory: ${rawSubpath}`,
      'invalid_plugin_definition',
    )
  }
  try {
    const resolved = await resolveNearestRealpath(path, fsp, resolvedPath)
    if (resolved.kind === 'dangling-symlink' || isOutsidePluginBase(path, dirReal, resolved.real)) {
      throw new CliError(
        `plugin ${pluginDir} ${field} symlink escapes plugin directory: ${rawSubpath}`,
        'invalid_plugin_definition',
      )
    }
  } catch (err) {
    if (err instanceof CliError) throw err
    throw new CliError(
      `failed to resolve ${field} (${resolvedPath}): ${err instanceof Error ? err.message : String(err)}`,
      'read_failed',
    )
  }
}

async function runPluginsBuild(ctx: CommandContext): Promise<void> {
  const parsed = parseFlags(
    [
      { name: 'dir', type: 'string' },
      { name: 'out', type: 'string' },
      { name: 'module', type: 'string', repeated: true },
    ],
    ctx.args,
  )
  const path = await import('node:path')
  const fsp = await import('node:fs/promises')

  const dirFlag = parsed.flags.get('dir')
  const positionalDir = parsed.positionals[0]
  if (typeof dirFlag === 'string' && dirFlag.length > 0 && positionalDir !== undefined) {
    throw new CliError('--dir and positional <dir> are mutually exclusive', 'conflicting_flags')
  }
  const usedPositionals = positionalDir !== undefined ? 1 : 0
  assertNoExtraPositionals(parsed.positionals, usedPositionals)

  const rawDir =
    typeof dirFlag === 'string' && dirFlag.length > 0
      ? dirFlag
      : positionalDir !== undefined
        ? positionalDir
        : ctx.cwd
  const pluginDir = path.resolve(ctx.cwd, rawDir)

  let dirStat
  try {
    dirStat = await fsp.stat(pluginDir)
  } catch (err) {
    throw new CliError(
      `plugin directory not accessible (${pluginDir}): ${err instanceof Error ? err.message : String(err)}`,
      'client_root_invalid',
    )
  }
  if (!dirStat.isDirectory()) {
    throw new CliError(`plugin target is not a directory: ${pluginDir}`, 'client_root_invalid')
  }
  const dirReal = await fsp.realpath(pluginDir)

  const pluginJson = await readOptionalManifestObject(path.join(pluginDir, 'plugin.json'), 'plugin.json')
  const packageJson = await readOptionalManifestObject(path.join(pluginDir, 'package.json'), 'package.json')
  const helmFieldRaw = packageJson?.['helm']
  if (
    helmFieldRaw !== undefined &&
    (helmFieldRaw === null || typeof helmFieldRaw !== 'object' || Array.isArray(helmFieldRaw))
  ) {
    throw new CliError(`package.json helm field in ${pluginDir} must be an object`, 'invalid_plugin_manifest')
  }
  const helmField = helmFieldRaw as Record<string, unknown> | undefined

  const rawId = pluginJson?.['id'] ?? helmField?.['id'] ?? packageJson?.['name']
  const pluginId = typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim() : path.basename(pluginDir)

  const manifestClientRoot =
    typeof pluginJson?.['clientRoot'] === 'string'
      ? pluginJson['clientRoot']
      : typeof helmField?.['clientRoot'] === 'string'
        ? helmField['clientRoot']
        : undefined
  let clientRoot: string
  if (manifestClientRoot !== undefined && manifestClientRoot.length > 0) {
    clientRoot = path.resolve(pluginDir, manifestClientRoot)
    await assertPathInsidePluginRoot(pluginDir, dirReal, manifestClientRoot, clientRoot, 'clientRoot')
  } else {
    const defaultClientDir = path.join(pluginDir, 'client')
    let hasClientDir = false
    try {
      hasClientDir = (await fsp.stat(defaultClientDir)).isDirectory()
    } catch {
      // ENOENT
    }
    clientRoot = hasClientDir ? defaultClientDir : pluginDir
  }

  const outFlag = parsed.flags.get('out')
  let outDir: string
  if (typeof outFlag === 'string' && outFlag.length > 0) {
    outDir = path.resolve(ctx.cwd, outFlag)
  } else {
    const manifestDist =
      typeof pluginJson?.['clientDist'] === 'string'
        ? pluginJson['clientDist']
        : typeof helmField?.['clientDist'] === 'string'
          ? helmField['clientDist']
          : undefined
    if (manifestDist !== undefined && manifestDist.length > 0) {
      outDir = path.resolve(pluginDir, manifestDist)
      await assertPathInsidePluginRoot(pluginDir, dirReal, manifestDist, outDir, 'clientDist')
    } else {
      outDir = path.join(pluginDir, PREBUILT_CLIENT_DIR_NAME)
    }
  }

  const specSet = new Set<string>()
  for (const list of [pluginJson?.['clientDependencies'], helmField?.['clientDependencies']]) {
    if (list === undefined) continue
    if (!Array.isArray(list) || list.some((x) => typeof x !== 'string' || x.trim().length === 0)) {
      throw new CliError(`clientDependencies in ${pluginDir} must be an array of non-empty strings`, 'invalid_plugin_manifest')
    }
    for (const spec of list as string[]) specSet.add(spec.trim())
  }
  const npmRoots: PluginClientNpmRoot[] =
    specSet.size > 0 ? [{ specifiers: [...specSet], packageRoot: pluginDir }] : []
  const explicitModules = repeatedValues(parsed.flags, 'module')

  // Dynamically load the workspace/runtime build package without creating a static @helm/cli -> @helm/plugin-build dependency edge.
  const pluginBuildPkg = ['@helm', 'plugin-build'].join('/')
  let buildMod: {
    buildPluginClientBundleDir?: (
      options: BuildPluginClientBundleDirOptions,
    ) => Promise<BuildPluginClientBundleDirResult>
  }
  try {
    buildMod = (await import(pluginBuildPkg)) as typeof buildMod
  } catch (err) {
    throw new CliError(
      `plugin client compiler unavailable (${pluginBuildPkg} failed to load: ${err instanceof Error ? err.message : String(err)})`,
      'plugin_build_unavailable',
    )
  }
  if (typeof buildMod.buildPluginClientBundleDir !== 'function') {
    throw new CliError(
      `plugin client compiler unavailable (${pluginBuildPkg} does not export buildPluginClientBundleDir)`,
      'plugin_build_unavailable',
    )
  }

  let result: BuildPluginClientBundleDirResult
  try {
    result = await buildMod.buildPluginClientBundleDir({
      pluginId,
      clientRoot,
      outDir,
      ...(explicitModules.length > 0 ? { modules: explicitModules } : {}),
      ...(npmRoots.length > 0 ? { npmRoots } : {}),
    })
  } catch (err) {
    if (err instanceof HelmError) {
      throw new CliError(err.message, err.code, 1, err.details)
    }
    throw err
  }

  if (ctx.json) {
    printResult(ctx, result)
    return
  }
  const moduleKeys = Object.keys(result.manifest.modules).sort()
  ctx.io.out(
    `Built ${moduleKeys.length} client module(s) for ${result.pluginId} -> ${result.outDir} (${(result.totalBytes / 1024).toFixed(1)} KiB)\n`,
  )
  for (const modRef of moduleKeys) {
    const entry = result.manifest.modules[modRef]!
    const chunkSuffix = entry.chunks && entry.chunks.length > 0 ? ` + ${entry.chunks.length} chunk(s)` : ''
    ctx.io.out(`  - ${modRef} -> ${entry.entryFile} (${entry.contentHash.slice(0, 12)}${chunkSuffix})\n`)
  }
}
