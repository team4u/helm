/**
 * shell execute engine (runShell / runGate / bash tool).
 *
 * - shell execute delegate SDK `NodeExecutionEnv.exec`(`@earendil-works/pi-durable/env/node`):
 *   pre- first aborted  Context never spawn;abort/timeout kill the whole process group and can rely wait for child process
 *   exit (listener/timer all clean up, do not leak process);stdout/stderr each `StreamDecoder` incremental
 *   decode, multibyte character across chunk do not tear;`onOutput` by reach order concatenate (non- first stdout after stderr).
 * - across node execute (EnvFabric): by (nodeId, cwd, conversationId) target in target node execute;
 *   nodeId !== 'local' when via deps.envFabric(offline explicit node_offline, disconnection explicit unknown;
 *   EnvFabric missing when only allows local short lifecycle direct create, remote explicit env_fabric_missing,
 *   see guards.ts), never static default fall back local mistakenly read write Hub local machine disk.
 * - target node platform aware cwd/path specification (unique implement runtime/target-platform.ts,
 *   re- use @helm/protocol normalizeTargetPath/targetPlatformOf original language, business entry
 *   must not each another write rule):SDK NodeExecutionEnv / Remote execute only receive already specification path
 *   (bash / runGate / POST /api/env/exec and WorktreeAllocator execGit all via
 *   runShell converge).
 * - runShell for host inherit HELM_TOKEN do fall back redaction: even if caller not host token register enter
 *   deps.redact, return everything aggregate text also for catch to host token do precise replace redaction.
 * - output exceeds maxOutputBytes explicit failed `output_limit_exceeded`(never truncate when succeeded).
 */
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'
import type { JsonValue } from '@earendil-works/chord/json'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { createLocalExecutionEnv } from '../../env/local-host-env.js'
import { int, obj, opt, str } from '@earendil-works/pi-schema'
import { redactJsonValue } from '../../redact.js'
import { invalidPathText, normalizePathForTarget, targetPlatformForNode } from '../target-platform.js'
import { throwIfToolAborted, type HelmToolDeps } from '../tool-deps.js'
import { remoteShellGuardText, shellEnvFabricMissingText } from './guards.js'
import { buildToolEnv } from './managed-env.js'

const DEFAULT_TIMEOUT_MS = 120_000
/** timeoutMs cap: and default value same amount level, guard against over large value change each other unbounded wait for. */
export const MAX_TIMEOUT_MS = 600_000
/** bash output aggregate cap (UTF-8 byte): exceeds explicit failed, never static default truncate when succeeded. */
export const MAX_OUTPUT_BYTES = 1024 * 1024
/** streaming pattern (onOutputChunk) aggregate pre- compute: one by one chunk push do not subject to affect (one by one chunk output is streaming
 *  client deliver thing),Hub side only terminal state diagnose aggregate; over limit same explicit
 *  output_limit_exceeded(old 64MiB all text duplicate is memory leak leak, see audit). */
export const STREAM_AGGREGATE_LIMIT_BYTES = 256 * 1024

export interface ShellRunResult {
  ok: boolean
  exitCode: number | null
  output: string
  timedOut: boolean
  signal: string | null
  /** actual execute node (explicit/conversation bind set parse result; supply bash structure output back visible, do not protocol response). */
  nodeId?: string
  /** actual start work directory (normalizePathForTarget specification after;win32 view already convert). */
  cwd?: string
}

/** timeoutMs validate: correct finite integer and ≤ cap; illegal explicit throws (not silently change by default). */
function assertTimeoutMs(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `invalid_timeout: timeoutMs must be (0, ${MAX_TIMEOUT_MS}] integer, receives ${timeoutMs}`,
    )
  }
}

/** external AbortSignal hang to SDK Context(pre- aborted when exec directly reject spawn). */
function contextWithSignal(signal: AbortSignal | undefined): Context {
  return signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
}

/**
 * real shell execute (runGate and bash tool shared use). delegate SDK NodeExecutionEnv:
 * process group spawn, timeout/abort kill group, one by one stream incremental UTF-8 decode, reach order aggregate.
 * forever do not fabricate succeeded; over limit explicit output_limit_exceeded.
 */
export async function runShell(
  deps: HelmToolDeps,
  command: string,
  options: {
    cwd?: string
    conversationId?: number
    /** target compute node (default via conversation bind set parse, again default 'local'). */
    nodeId?: string
    timeoutMs?: number
    signal?: AbortSignal
    maxOutputBytes?: number
    /**
     * one by one chunk streaming call back (stdout/stderr by reach order; aggregate cap still takes effect):
     * POST /api/env/exec  NDJSON streaming pattern use, does not affect aggregate redaction semantics.
     */
    onOutputChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
    /**
     * caller inject environment (such as herdr plugin Profile.runtime.env + manage environment):
     * override process.env same name items, but managed variable (HELM_* and managed token) still fixed override.
     */
    env?: Record<string, string>
  } = {},
): Promise<ShellRunResult> {
  const requestedCwd = options.cwd ?? deps.defaultCwd
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  assertTimeoutMs(timeoutMs)
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  // node parse: explicit nodeId > conversation bind set (nodeIdOf) > 'local'.
  const explicitNodeId = options.nodeId ?? (options.conversationId !== undefined ? deps.nodeIdOf?.(options.conversationId) : undefined)
  const nodeId = explicitNodeId ?? 'local'
  // host inherit HELM_TOKEN fall back redaction:runShell is public API, caller (such as test)
  // may not it register enter deps.redact- - self row catch and for everything return text precise replace
  //(and produce Runtime  addRedaction same effect; do not print secret itself).
  const hostToken = process.env['HELM_TOKEN']
  const redactAll = (text: string): string => {
    const base = deps.redact(text)
    return hostToken !== undefined && hostToken !== '' ? base.split(hostToken).join('[REDACTED]') : base
  }
  // target platform aware cwd specification (unique entry normalizePathForTarget, re- use
  // protocol original language):local use Hub host platform, remote only use EnvFabric register register
  // platform (unknown then original pass-through, do not guess, do not fallback local);win32 target on WSL /
  // Git Bash  POSIX view convert is specification Windows path, cannot mapping bare POSIX 
  // explicit invalid_path(keep original path).
  const platformInfo = targetPlatformForNode(deps.envFabric, nodeId)
  const cwdNorm = normalizePathForTarget(requestedCwd, platformInfo)
  if (!cwdNorm.ok) {
    return {
      ok: false,
      exitCode: null,
      output: redactAll(invalidPathText(cwdNorm)),
      timedOut: false,
      signal: null,
    }
  }
  const cwd = cwdNorm.path
  // execute fact back visible (bash structure output use): parse out real node and specification start directory;
  // only store in at internal ShellRunResult, does not enter HTTP EnvExecResponse protocol.
  const withTarget = (r: ShellRunResult): ShellRunResult => ({ ...r, nodeId, cwd })
  // remote node: via EnvFabric  RemoteExecutionEnv execute (never fall back local);
  // config missing (envFabric not inject) and node offline respectively explicit failed, never fallthrough local.
  if (nodeId !== 'local') {
    const guardOutput = remoteShellGuardText(deps.envFabric, nodeId)
    if (guardOutput !== undefined) {
      return withTarget({ ok: false, exitCode: null, output: guardOutput, timedOut: false, signal: null })
    }
  }
  // remote node: must via EnvFabric(without fabric when explicit failed, never fall back local);
  // local produce same takes precedence via fabric  ScopedExecutionEnv(unify env together into right threat;
  // test not inject fabric when local allows short lifecycle direct create - - only this fall back, do not involve remote).
  let shell: ExecutionEnv
  let shellEnv: Record<string, string> | undefined = options.env
  let shellInheritEnv: boolean | undefined
  if (deps.envFabric !== undefined) {
    shell = deps.envFabric.envForTarget({
      nodeId,
      cwd,
      ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    })
    // one by one invoke inject env(such as herdr plugin Profile.runtime.env): managed bind set key
    // still by ScopedExecutionEnv  composer fixed override (see scoped-env.ts);
    // inheritEnv keep default:local by Scoped together into complete env(copy host PATH/HOME
    // base bottom, strip except managed HELM_*, managed override) after for base explicit inheritEnv:false
    //(SDK must not already strip except host HELM_* re- carries back); remote default inheritEnv let
    // node daemon merge node host base bottom (node real PATH/HOME tool chain) and strip except node
    // host HELM_TOKEN, managed together into finally override; never together into by default PATH override node tool chain.
  } else if (nodeId === 'local') {
    shell = createLocalExecutionEnv({ cwd })
    // without fabric fall back (test use): still away since has managed together into policy (host base bottom + managed
    // fixed override + cliBinDir PATH pre-), self carries complete env and explicit inheritEnv:false
    // (SDK second inherit will already strip except host HELM_TOKEN re- carries back).
    shellEnv = buildToolEnv(deps, cwd, options.conversationId, options.env, nodeId)
    shellInheritEnv = false
  } else {
    return withTarget({
      ok: false,
      exitCode: null,
      output: shellEnvFabricMissingText(nodeId),
      timedOut: false,
      signal: null,
    })
  }
  // reach order aggregate (stdout/stderr mix arrange by real reach order, non- first stdout after stderr).
  // secret redaction in aggregate all text on do: across chunk tear secret in complete concatenate after must however complete match.
  // streaming pattern (onOutputChunk leap) aggregate pre- compute more small: over limit explicit failed
  // output_limit_exceeded(never truncate when succeeded) - - streaming client already receives all one by one chunk
  // output, terminal state output only act diagnose, over limit i.e. abandon aggregate and such as errors.
  const aggregateLimit = options.onOutputChunk !== undefined ? STREAM_AGGREGATE_LIMIT_BYTES : maxOutputBytes
  let combined = ''
  let outputBytes = 0
  let exceeded = false
  const result = await shell.exec(
    command,
    {
      cwd,
      ...(shellEnv === undefined ? {} : { env: shellEnv }),
      ...(shellInheritEnv === undefined ? {} : { inheritEnv: shellInheritEnv }),
      timeout: timeoutMs / 1000,
      onOutput: (text, _ctx, info) => {
        // streaming one by one chunk call back do not subject to aggregate over limit affect (one by one chunk output is streaming client deliver thing;
        // over limit only abandon Hub side terminal state diagnose aggregate, never interrupt push).
        if (options.onOutputChunk !== undefined) {
          try {
            options.onOutputChunk({ stream: info.stream, text })
          } catch {
            // streaming call back fault does not affect aggregate.
          }
        }
        if (exceeded) return
        outputBytes += Buffer.byteLength(text, 'utf8')
        if (outputBytes > aggregateLimit) {
          exceeded = true
          combined = ''
          return
        }
        combined += text
      },
    },
    contextWithSignal(options.signal),
  )
  if (!result.ok) {
    // remote disconnection: command already start, result unknown - -error.code is unknown, never retry.
    if (result.error.code === 'unknown') {
      return withTarget({
        ok: false,
        exitCode: null,
        output: redactAll(combined + (combined === '' ? '' : '\n') + `[shell unknown: ${result.error.message}]`),
        timedOut: false,
        signal: null,
      })
    }
  }
  if (exceeded) {
    const limit = options.onOutputChunk !== undefined ? aggregateLimit : maxOutputBytes
    const streamNote =
      options.onOutputChunk !== undefined
        ? '(streaming pattern: one by one chunk output already all push, this where only terminal state diagnose aggregate over limit)'
        : ''
    return withTarget({
      ok: false,
      exitCode: null,
      output: redactAll(
        `output_limit_exceeded: output exceeds ${limit} byte aggregate cap, already abandon aggregate.${streamNote}` +
          'please heavy set to to file after use read page read, or narrow command output.',
      ),
      timedOut: false,
      signal: null,
    })
  }
  if (!result.ok) {
    const error = result.error
    const timedOut = error.code === 'timeout'
    const aborted = error.code === 'aborted'
    const label = aborted ? 'aborted' : timedOut ? `timeout after ${timeoutMs}ms` : error.code
    return withTarget({
      ok: false,
      exitCode: null,
      output: redactAll(
        combined + (combined === '' ? '' : '\n') + `[shell ${label}: ${error.message}]`,
      ),
      timedOut,
      signal: null,
    })
  }
  return withTarget({
    ok: result.value.exitCode === 0,
    exitCode: result.value.exitCode,
    output: redactAll(combined),
    timedOut: false,
    signal: null,
  })
}

/**
 * gate gate command execute (independent subagent and Workflow adapter shared use, guarantee only execute once).
 * env make local machine Gate and actual Herdr task environment consistent (plugin pass Profile.runtime.env and
 * manage environment group into spawnEnv, the same CI/tool PATH); managed variable still fixed override.
 * timeoutMs optional (default 120_000): single time gate timeout; timeout by runShell terminate the whole
 * process group (SIGTERM -> SIGKILL) and such as through out underlying result (timedOut=true,exitCode=null).
 * failed forever do not return succeeded; output redaction.
 */
export async function runGate(
  deps: HelmToolDeps,
  command: string,
  options: {
    cwd?: string
    conversationId?: number
    nodeId?: string
    /** single time gate timeout milli second count (default 120_000;(0, 600_000] integer by runShell validate). */
    timeoutMs?: number
    signal?: AbortSignal
    env?: Record<string, string>
  } = {},
): Promise<{ ok: boolean; output: string; exitCode: number | null; timedOut: boolean }> {
  const result = await runShell(deps, command, {
    ...options,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
  return { ok: result.ok, output: result.output, exitCode: result.exitCode, timedOut: result.timedOut }
}

const bashParameters = obj({
  command: str({ description: 'want execute shell command' }),
  timeoutMs: opt(
    int({
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
      description: `optional timeout milli second count (by default ${DEFAULT_TIMEOUT_MS}, cap ${MAX_TIMEOUT_MS})`,
    }),
  ),
})

/** bash tool (SDK defineTool; output over threshold via services spill). */
export function createBashTool(deps: HelmToolDeps): ToolRegistration<typeof bashParameters> {
  return defineTool({
    name: 'bash',
    description:
      'in conversation bind set node shell in execute command (local is Hub local machine; remote node in target node execute). work directory is conversation cwd; timeout by default 120 second; output over 32KiB automatically spill is artifact and return preview (use read_artifact read all text); output over 1MiB explicit failed.',
    parameters: bashParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        exitCode: { type: ['number', 'null'] },
        output: { type: 'string' },
        timedOut: { type: 'boolean' },
        nodeId: { type: 'string', description: 'actual execute node (conversation bind set parse result)' },
        cwd: { type: 'string', description: 'actual start work directory (target platform specification after, non- original reference)' },
      },
      required: ['ok', 'output'],
    },
    async execute(args, api, context) {
      const agent = await api.agent(context)
      const cwd = agent.cwd ?? deps.defaultCwd
      let result: ShellRunResult
      try {
        result = await runShell(deps, args.command, {
          cwd,
          conversationId: api.conversationId as number,
          timeoutMs: args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: context.abortSignal,
        })
      } catch (error) {
        // invalid_timeout etc. parameter level error: explicit failed, never static default change by default (already abort then on throw).
        throwIfToolAborted(context.abortSignal)
        return {
          output: [{ type: 'text', text: deps.redact(String(error)) }],
          isError: true,
        }
      }
      // closure stop/cancel window forbidden in disk write without intent meaning spill artifact file.
      throwIfToolAborted(context.abortSignal)
      const spill = await deps.artifacts.spill(
        api.conversationId as number,
        api.callId,
        result.output,
      )
      // structure back visible actual execute fact (nodeId + specification start cwd); text stdout original
      // do not motion, never from external succeeded text guess file location.
      const structured = redactJsonValue(
        {
          ok: result.ok,
          exitCode: result.exitCode,
          output: spill.text,
          timedOut: result.timedOut,
          ...(result.nodeId !== undefined ? { nodeId: result.nodeId } : {}),
          ...(result.cwd !== undefined ? { cwd: result.cwd } : {}),
        },
        (t) => deps.redact(t),
      )
      // details is persist UI channel (structuredOutput do not written to the database); no longer carry output- -
      // text channel already has the same content, avoid each bash result double write spill pre- compute inside all text.
      const { output: _uiDropped, ...uiFacts } = structured as Record<string, JsonValue>
      return {
        output: [{ type: 'text', text: spill.text }],
        isError: !result.ok,
        structuredOutput: structured as JsonValue,
        details: uiFacts as JsonValue,
      }
    },
  })
}
