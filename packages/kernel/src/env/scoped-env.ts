/**
 * conversation effect domain execute environment: the same (nodeId, cwd) under multiple conversation concurrency when, each command
 * env by conversationId live together into (fresh), never cache on a conversation snapshot
 * (otherwise managed token / SecretStash secret will across conversation leak leak).
 *
 * bind set semantics (fail-closed):
 * - composer return key is**bind set identity**(HELM_CONVERSATION_ID / HELM_HUB_URL /
 *   HELM_TOKEN / HELM_SECRET_* etc.): one by one invoke options.env same name key cannot override
 *   (guard against fabricate effect domain), the rest key by one by one invoke env normal patch fill;
 * - without conversationId(envFor two reference path): do not inject any secret - - no can message
 *   effect domain then do not inject (fail-closed), while non- borrow use other conversation;
 * - remote transfer sharing (same nodeId a connection pool + execId routing output fan out),
 *   each command env in exec when isolated together into.
 *
 * local together into (this file is unique right threat,tools.ts no longer has second set rule):
 * - inherit host process.env(real PATH/HOME tool chain), but managed HELM_* variable
 *   (contains large small write change body) by fail-closed strip except;
 * - cliBinDir(helm CLI wrap directory) with path.delimiter pre- inject PATH;
 * - one by one invoke env and composer bind set key finally together into;composer not provide HELM_TOKEN
 *   when everything source (host inherit/one by one invoke inject) same name change body one and strip except.
 */

import type { ExecutionEnv, Result, ShellExecOptions, ShellExecResult } from '@earendil-works/pi-durable/env'
import type { ExecutionError } from '@earendil-works/pi-durable/env'
import type { Context } from '@earendil-works/chord/context'
import { prependEnvPath, setEnvEntry } from '@helm/env-io'
import type { EnvOptionsComposer } from './fabric.js'

/** execute target: conversation + node + work directory (Profile×node combine after thing point). */
export interface EnvTarget {
  conversationId?: number
  nodeId: string
  cwd: string
}

export interface ScopedExecutionEnv extends ExecutionEnv {
  /** this target (cwd can change perspective; bottom seat instance follow target isolated). */
  readonly target: { conversationId?: number; nodeId: string; cwd: string }
}

export interface ScopedExecutionEnvOptions {
  /** helm CLI wrap directory (local exec pre- inject PATH). */
  cliBinDir?: () => string | undefined
}

/** managed variable name collection (large small write do not sensitive strip except;Windows env name semantics under helm_token / Helm_Token
 *  etc. same name change body one and strip except, managed value finally fixed override - - policy by composer provide right threat value).
 *  HELM_EXECUTION_SCOPE is execute context effect domain anchor (helm-<sha256 before 24 hex>,
 *  see tools.ts  executionScopeHash): non- secret, only supply tool explicit adopt stable asset
 *  naming hint (non- OS sandbox), and other bind set identity variable same etc. managed. */
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

/** Scoped environment and local machine directly execute shared use together into mechanism; caller only provide managed policy artifact. */
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

  // delegate the rest all operation;FS operation without identity env requirement.
  const scoped: ScopedExecutionEnv = {
    target,
    get id() {
      return base.id
    },
    get cwd(): string {
      // target perspective: relative path/exec by default cwd all with target.cwd is allow.
      return target.cwd
    },
    set cwd(value: string) {
      // only change this target perspective: bottom seat instance already by target isolated (does not affect other conversation).
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
