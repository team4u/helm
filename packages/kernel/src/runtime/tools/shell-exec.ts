/**
 * Shell execution engine (`runShell` / `runGate` / `bash` tool).
 *
 * - Delegates shell execution to SDK `NodeExecutionEnv.exec` (`@earendil-works/pi-durable/env/node`):
 *   never spawns on pre-aborted `Context`; kills entire process groups on abort/timeout and reliably awaits
 *   process exit (cleans up all listeners/timers, zero orphan leaks); incremental per-stream UTF-8 decoding
 *   via `StreamDecoder` so multi-byte characters split across chunks stay intact; aggregates `onOutput` in
 *   arrival order (never stdout-before-stderr).
 * - Cross-node execution (`EnvFabric`): runs on `(nodeId, cwd, conversationId)`; `nodeId !== 'local'` goes
 *   through `deps.envFabric` (offline throws `node_offline`, disconnect returns `unknown`; local falls back to
 *   short-lived direct env creation only when EnvFabric isn't injected, whereas remote explicitly fails
 *   `env_fabric_missing` via `guards.ts` — never reading/writing Hub's local disk).
 * - Target-platform-aware cwd/path normalization (sole implementation `runtime/target-platform.ts`, reusing
 *   `@helm/protocol` `normalizeTargetPath`/`targetPlatformOf` without duplicating rules in entry points):
 *   SDK `NodeExecutionEnv`/remote exec receive pre-normalized paths (converges `bash` / `runGate` /
 *   `POST /api/env/exec` and `WorktreeAllocator.execGit` via `runShell`).
 * - Fallback redaction for inherited host `HELM_TOKEN`: `runShell` can be invoked without the caller
 *   registering it in `deps.redact`, so any host token is captured and explicitly redacted across returned text.
 * - Fails explicitly with `output_limit_exceeded` when output exceeds `maxOutputBytes` (never silently truncates).
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
/** Maximum `timeoutMs`: bounded proportionally to default to prevent unbounded waits. */
export const MAX_TIMEOUT_MS = 600_000
/** `bash` output aggregation cap (UTF-8 bytes): exceeding fails explicitly rather than truncating silently. */
export const MAX_OUTPUT_BYTES = 1024 * 1024
/** Streaming mode (`onOutputChunk`) aggregation budget: per-chunk streaming reaches the client directly, while Hub
 * keeps only terminal diagnostics; overflows fail explicitly with `output_limit_exceeded` (avoiding 64 MiB duplication leaks). */
export const STREAM_AGGREGATE_LIMIT_BYTES = 256 * 1024

export interface ShellRunResult {
  ok: boolean
  exitCode: number | null
  output: string
  timedOut: boolean
  signal: string | null
  /** Actual execution node (resolved from explicit arg/conversation binding; echoed in bash structured output, outside protocol response). */
  nodeId?: string
  /** Actual starting working directory (post-`normalizePathForTarget`, with win32 paths converted). */
  cwd?: string
}

/** Validate `timeoutMs`: positive finite integer <= cap; fails loudly without silent coercion. */
function assertTimeoutMs(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `invalid_timeout: timeoutMs must be an integer in (0, ${MAX_TIMEOUT_MS}], received ${timeoutMs}`,
    )
  }
}

/** Attach an external `AbortSignal` to SDK `Context` (pre-aborted contexts refuse spawning immediately). */
function contextWithSignal(signal: AbortSignal | undefined): Context {
  return signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT)
}

/**
 * Real shell execution (shared by `runGate` and `bash` tool). Delegates to SDK `NodeExecutionEnv`:
 * process-group spawning, timeout/abort group termination, per-stream incremental UTF-8 decoding, arrival-order
 * aggregation. Never fabricates success; exceeds limits -> `output_limit_exceeded`.
 */
export async function runShell(
  deps: HelmToolDeps,
  command: string,
  options: {
    cwd?: string
    conversationId?: number
    /** Target compute node (falls back to conversation binding, then `'local'`). */
    nodeId?: string
    timeoutMs?: number
    signal?: AbortSignal
    maxOutputBytes?: number
    /**
     * Per-chunk streaming callback (`stdout`/`stderr` in arrival order; aggregation budget still applies):
     * used by `POST /api/env/exec` NDJSON streaming without altering aggregate redaction semantics.
     */
    onOutputChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void
    /**
     * Caller-injected environment (e.g. Herdr plugin `Profile.runtime.env` + managed env): overrides matching
     * keys from `process.env`, while managed variables (`HELM_*` and managed tokens) remain pinned.
     */
    env?: Record<string, string>
  } = {},
): Promise<ShellRunResult> {
  const requestedCwd = options.cwd ?? deps.defaultCwd
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  assertTimeoutMs(timeoutMs)
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  // Node resolution: explicit `nodeId` > conversation binding (`nodeIdOf`) > `'local'`.
  const explicitNodeId = options.nodeId ?? (options.conversationId !== undefined ? deps.nodeIdOf?.(options.conversationId) : undefined)
  const nodeId = explicitNodeId ?? 'local'
  // Fallback redaction for inherited host `HELM_TOKEN`: `runShell` is a public API whose callers (e.g. tests)
  // might not register `HELM_TOKEN` in `deps.redact`, so capture and redact it explicitly here as well.
  const hostToken = process.env['HELM_TOKEN']
  const redactAll = (text: string): string => {
    const base = deps.redact(text)
    return hostToken !== undefined && hostToken !== '' ? base.split(hostToken).join('[REDACTED]') : base
  }
  // Target-platform-aware cwd normalization (sole entry `normalizePathForTarget` reusing `@helm/protocol`):
  // `local` uses Hub platform, remote uses only registered platform in `EnvFabric` (passes through verbatim
  // when unknown without guessing or falling back locally); converts WSL/Git Bash POSIX views to canonical Windows
  // paths on `win32` targets, rejecting unmappable bare POSIX roots explicitly with `invalid_path`.
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
  // Echo execution facts (`nodeId` + normalized starting `cwd`) into bash structured output; internal only,
  // excluded from the HTTP `EnvExecResponse` protocol payload.
  const withTarget = (r: ShellRunResult): ShellRunResult => ({ ...r, nodeId, cwd })
  // Remote nodes run via `EnvFabric` `RemoteExecutionEnv` (never fall back locally);
  // missing `envFabric` and offline nodes fail explicitly with distinct errors.
  if (nodeId !== 'local') {
    const guardOutput = remoteShellGuardText(deps.envFabric, nodeId)
    if (guardOutput !== undefined) {
      return withTarget({ ok: false, exitCode: null, output: guardOutput, timedOut: false, signal: null })
    }
  }
  // Remote nodes require `EnvFabric`; local production also prefers `fabric` `ScopedExecutionEnv` (single source of
  // truth for env assembly), falling back to ephemeral local execution only in tests without `envFabric`.
  let shell: ExecutionEnv
  let shellEnv: Record<string, string> | undefined = options.env
  let shellInheritEnv: boolean | undefined
  if (deps.envFabric !== undefined) {
    shell = deps.envFabric.envForTarget({
      nodeId,
      cwd,
      ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    })
    // Per-call env injection (e.g. `Profile.runtime.env`): managed keys remain pinned by `ScopedExecutionEnv`'s
    // composer (see `scoped-env.ts`). Uses default `inheritEnv` semantics: locally `Scoped` constructs the full
    // env (host PATH/HOME minus `HELM_*`, plus managed overrides) with explicit `inheritEnv: false` so SDK doesn't
    // re-inject stripped host `HELM_*`; remotely default `inheritEnv` lets the node daemon merge its native
    // PATH/HOME while stripping node host `HELM_TOKEN` and applying managed overrides last (never clobbering remote toolchains).
  } else if (nodeId === 'local') {
    shell = createLocalExecutionEnv({ cwd })
    // Fabric-less local fallback (tests): applies the same managed policy (`process.env` + pinned overrides +
    // `cliBinDir` on PATH) with explicit `inheritEnv: false` so SDK won't re-inherit stripped host `HELM_TOKEN`.
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
  // Arrival-order aggregation (stdout/stderr interleaved by arrival order, never stdout-then-stderr).
  // Redact across complete concatenated output so secrets split across chunks still match completely.
  // Streaming mode (`onOutputChunk`) uses a smaller aggregation budget and fails explicitly with `output_limit_exceeded`
  // on overflow (streaming clients already received all chunks; terminal output is purely diagnostic).
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
        // Streaming chunk delivery runs unaffected by hub-side terminal diagnostic aggregation overflow.
        if (options.onOutputChunk !== undefined) {
          try {
            options.onOutputChunk({ stream: info.stream, text })
          } catch {
            // Streaming callback errors do not halt aggregation.
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
    // Remote disconnect: command already started and outcome is unknown (`error.code === 'unknown'`); never retry.
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
        ? ' (streaming mode: all chunks were already pushed; only terminal diagnostic aggregation exceeded the cap)'
        : ''
    return withTarget({
      ok: false,
      exitCode: null,
      output: redactAll(
        `output_limit_exceeded: output exceeded ${limit}-byte aggregation cap and aggregation was aborted.${streamNote} ` +
          'Redirect output to a file and read it paginated with read_artifact/read, or narrow the command output.',
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
 * Gate verification command runner (shared by standalone subagents and Workflow adapters; guaranteed single execution).
 * `env` keeps local Gate consistent with real Herdr task environments (plugins pass `Profile.runtime.env` +
 * managed env via `spawnEnv`, sharing the same CI/tool PATH); managed variables stay pinned.
 * Optional `timeoutMs` (default `120_000`) bounds each gate run; `runShell` kills the entire process group
 * (`SIGTERM` -> `SIGKILL`) on timeout and surfaces `{ timedOut: true, exitCode: null }`.
 * Failures never report success; outputs are redacted.
 */
export async function runGate(
  deps: HelmToolDeps,
  command: string,
  options: {
    cwd?: string
    conversationId?: number
    nodeId?: string
    /** Per-run gate timeout in ms (default `120_000`; integer in `(0, 600_000]` validated by `runShell`). */
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
  command: str({ description: 'Shell command to execute' }),
  timeoutMs: opt(
    int({
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
      description: `Optional timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})`,
    }),
  ),
})

/** `bash` tool (SDK `defineTool`; oversized outputs spill to artifacts via services). */
export function createBashTool(deps: HelmToolDeps): ToolRegistration<typeof bashParameters> {
  return defineTool({
    name: 'bash',
    description:
      'Execute a shell command on the conversation\'s bound node (local runs on Hub; remote runs on the target node). ' +
      'Working directory is the conversation cwd; default timeout 120s; outputs over 32 KiB spill automatically to an artifact with a preview (use read_artifact to read completely); outputs over 1 MiB fail explicitly.',
    parameters: bashParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        exitCode: { type: ['number', 'null'] },
        output: { type: 'string' },
        timedOut: { type: 'boolean' },
        nodeId: { type: 'string', description: 'Actual execution node (resolved from conversation binding)' },
        cwd: { type: 'string', description: 'Actual starting working directory (normalized per target platform; not raw input)' },
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
        // Argument errors such as `invalid_timeout` fail explicitly without silent defaulting (rethrows if already aborted).
        throwIfToolAborted(context.abortSignal)
        return {
          output: [{ type: 'text', text: deps.redact(String(error)) }],
          isError: true,
        }
      }
      // Do not write meaningless spill artifact files during shutdown/cancellation windows.
      throwIfToolAborted(context.abortSignal)
      const spill = await deps.artifacts.spill(
        api.conversationId as number,
        api.callId,
        result.output,
      )
      // Structured echo of real execution facts (`nodeId` + normalized starting `cwd`); raw stdout stays verbatim
      // so callers never have to guess paths from exit text.
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
      // `details` is persisted to the UI channel (`structuredOutput` is unpersisted): omit `output` since text channel
      // already holds `spill.text`, avoiding persisting oversized outputs twice.
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
