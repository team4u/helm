/**
 * Conversation-scoped execution environment: when multiple conversations share `(nodeId, cwd)`,
 * each command computes its `env` freshly by `conversationId` instead of caching a previous
 * conversation's snapshot (preventing cross-conversation leakage of managed tokens / SecretStash secrets).
 *
 * Binding semantics (fail-closed):
 * - Keys returned by `composer` are **bound identities** (`HELM_CONVERSATION_ID`, `HELM_HUB_URL`,
 *   `HELM_TOKEN`, `HELM_SECRET_*`, etc.): per-call `options.env` cannot override keys of the same name
 *   (prevents forging scope), while all other keys are patched normally from per-call `env`;
 * - Without `conversationId` (`envFor` path): injects no secrets—no trusted scope means fail-closed,
 *   never borrowing another conversation's credentials;
 * - Remote transport stays shared (one connection pool per `nodeId` + output fan-out routed by `execId`),
 *   with each command's `env` composed in isolation at `exec` time.
 *
 * Local env composition (this file is the single source of truth; `tools.ts` has no second copy):
 * - Inherits host `process.env` (real PATH/HOME toolchain), stripping all managed `HELM_*` variables
 *   (including case variants) fail-closed;
 * - Prepends `cliBinDir` (helm CLI wrapper dir) to `PATH` using `path.delimiter`;
 * - Merges per-call `env` and composer-bound keys last; if composer omits `HELM_TOKEN`, every
 *   case variant from any source (host inheritance or per-call injection) is stripped.
 */

import type { ExecutionEnv, Result, ShellExecOptions, ShellExecResult } from '@earendil-works/pi-durable/env'
import type { ExecutionError } from '@earendil-works/pi-durable/env'
import type { Context } from '@earendil-works/chord/context'
import { prependEnvPath, setEnvEntry } from '@helm/env-io'
import type { EnvOptionsComposer } from './fabric.js'

/** Execution target: conversation + node + working directory (resolved Profile × node product). */
export interface EnvTarget {
  conversationId?: number
  nodeId: string
  cwd: string
}

export interface ScopedExecutionEnv extends ExecutionEnv {
  /** Target metadata (cwd is mutable per view; underlying instances remain isolated by target). */
  readonly target: { conversationId?: number; nodeId: string; cwd: string }
}

export interface ScopedExecutionEnvOptions {
  /** helm CLI wrapper directory (prepended to PATH for local exec). */
  cliBinDir?: () => string | undefined
}

/**
 * Managed variable names (stripped case-insensitively—Windows env semantics strip `helm_token`, `Helm_Token`,
 * etc. alike, and the final value is determined strictly by the composer as the single source of truth).
 * `HELM_EXECUTION_SCOPE` is the execution-context scope anchor (`helm-<first 24 hex of sha256>`, see
 * `executionScopeHash` in `tools.ts`): non-secret, only provides a stable resource naming hint for tools
 * that opt in (not an OS sandbox), and is managed alongside other bound identity variables.
 */
export const MANAGED_EXEC_ENV_VARS = [
  'HELM_ENV',
  'HELM_HUB_URL',
  'HELM_CONVERSATION_ID',
  'HELM_CWD',
  'HELM_DATA_DIR',
  'HELM_NODE_ID',
  'HELM_EXECUTION_SCOPE',
  'HELM_TOKEN',
] as const

const MANAGED_ENV_NAMES = new Set<string>(MANAGED_EXEC_ENV_VARS)

/** Shared env composition mechanism for scoped and direct local execution; caller only supplies managed policy output. */
export function composeExecutionEnv(
  nodeId: string,
  composed: Record<string, string>,
  perCall: Record<string, string> = {},
  options: {
    inheritEnv?: boolean
    cliBinDir?: string
    hostEnv?: Readonly<Record<string, string | undefined>>
    platform?: NodeJS.Platform
  } = {},
): Record<string, string> {
  const platform = options.platform ?? process.platform
  const hostEnv = options.hostEnv ?? process.env
  const env: Record<string, string> = {}
  if (nodeId === 'local' && options.inheritEnv !== false) {
    for (const [key, value] of Object.entries(hostEnv)) {
      if (value !== undefined && !MANAGED_ENV_NAMES.has(key.toUpperCase())) {
        setEnvEntry(env, key, value, platform)
      }
    }
  }
  const boundNames = new Set([...MANAGED_ENV_NAMES, ...Object.keys(composed).map((key) => key.toUpperCase())])
  for (const [key, value] of Object.entries(perCall)) {
    if (!boundNames.has(key.toUpperCase())) setEnvEntry(env, key, value, platform)
  }
  for (const [key, value] of Object.entries(composed)) {
    setEnvEntry(env, key, value, platform)
  }
  if (nodeId === 'local' && options.cliBinDir) {
    prependEnvPath(env, options.cliBinDir, platform)
  }
  return env
}

export function createScopedExecutionEnv(
  base: ExecutionEnv,
  target: EnvTarget,
  composer: EnvOptionsComposer | undefined,
  options: ScopedExecutionEnvOptions = {},
): ScopedExecutionEnv {
  const { cliBinDir } = options
  const exec = async (
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> => {
    const composed = composer === undefined ? {} : await composer({
      nodeId: target.nodeId,
      cwd: target.cwd,
      ...(target.conversationId === undefined ? {} : { conversationId: target.conversationId }),
    })
    const merged = composeExecutionEnv(target.nodeId, composed, options?.env, {
      inheritEnv: options?.inheritEnv,
      cliBinDir: cliBinDir?.(),
    })
    return base.exec(
      command,
      {
        ...(options === undefined ? {} : options),
        ...(target.nodeId === 'local' ? { inheritEnv: false } : {}),
        env: merged,
      },
      context,
    )
  }

  // Delegate all remaining operations; FS operations do not require identity env injection.
  const scoped: ScopedExecutionEnv = {
    target,
    get id() {
      return base.id
    },
    get cwd(): string {
      // Target view: default cwd for relative paths and exec is `target.cwd`.
      return target.cwd
    },
    set cwd(value: string) {
      // Only mutates this target's view: underlying instances are already isolated per target (never affects other conversations).
      target.cwd = value
      base.cwd = value
    },
    absolutePath: (p, ctx) => base.absolutePath(p, ctx),
    joinPath: (parts, ctx) => base.joinPath(parts, ctx),
    readTextFile: (p, ctx) => base.readTextFile(p, ctx),
    openTextLineReader: (p, ctx) => base.openTextLineReader(p, ctx),
    readTextLines: (p, o, ctx) => base.readTextLines(p, o, ctx),
    readBinaryFile: (p, ctx) => base.readBinaryFile(p, ctx),
    openBinaryReader: (p, o, ctx) => base.openBinaryReader(p, o, ctx),
    writeFile: (p, c, ctx) => base.writeFile(p, c, ctx),
    appendFile: (p, c, ctx) => base.appendFile(p, c, ctx),
    truncateFile: (p, s, ctx) => base.truncateFile(p, s, ctx),
    flushFile: (p, ctx) => base.flushFile(p, ctx),
    renameFile: (s, d, ctx) => base.renameFile(s, d, ctx),
    fileInfo: (p, ctx) => base.fileInfo(p, ctx),
    listDir: (p, ctx) => base.listDir(p, ctx),
    ...(base.listFiles === undefined ? {} : { listFiles: base.listFiles.bind(base) }),
    openDirReader: (p, ctx) => base.openDirReader(p, ctx),
    watch: (t, onChange, ctx) => base.watch(t, onChange, ctx),
    canonicalPath: (p, ctx) => base.canonicalPath(p, ctx),
    exists: (p, ctx) => base.exists(p, ctx),
    createDir: (p, o, ctx) => base.createDir(p, o, ctx),
    remove: (p, o, ctx) => base.remove(p, o, ctx),
    createTempDir: (p, ctx) => base.createTempDir(p, ctx),
    createTempFile: (o, ctx) => base.createTempFile(o, ctx),
    cleanup: (ctx) => base.cleanup(ctx),
    exec,
  } as ScopedExecutionEnv
  return scoped
}
