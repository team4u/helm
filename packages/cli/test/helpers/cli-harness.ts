/**
 * Shared CLI test fixtures and execution helpers (`packages/cli/test/helpers/cli-harness.ts`).
 * Reuses Mock Hub, auto-cleaned temp directories, and DTO factories from `@helm/test-kit`
 * to avoid duplicating `startHub / makeEnv / run / tempDir` boilerplate across CLI test files.
 */

import { runCli } from '../../src/index.js'
import type { StdinSource } from '../../src/options.js'

export {
  deferred,
  jsonResponse,
  makeConversationSummary,
  makePluginSummary,
  makeProfile,
  sleep,
  waitFor,
} from '@helm/test-kit'
export type { Deferred, WaitForOptions } from '@helm/test-kit'

export {
  cleanupDir,
  makeTempDir,
  sanitizedHostEnv,
  useTempDir,
} from '@helm/test-kit/node'
export type { CleanupRegistrar } from '@helm/test-kit/node'

export {
  startMockHub,
  startMockHub as startCliMockHub,
} from '@helm/test-kit/http'
export type {
  MockHttpHit,
  MockHubHandle,
  MockRouteHandler,
  MockRouteResult,
  StartMockHubOptions,
} from '@helm/test-kit/http'

/** Snapshot of stdout, stderr, and exit code returned by `runCliCaptured`. */
export interface CliCapturedResult {
  out: string
  err: string
  code: number
}

/** Optional injections for `runCliCaptured` (stdin / cwd / fetch / onStdout). */
export interface RunCliCapturedOptions {
  stdin?: StdinSource
  cwd?: string
  fetch?: typeof fetch
  onStdout?: (text: string) => void
}

/**
 * Build isolated CLI test environment variables (injecting test `HELM_HUB_URL`, `HELM_DATA_DIR`, and `HELM_TOKEN` by default).
 * Any key explicitly set to `undefined` in `extra` is deleted from the returned env object.
 */
export function makeCliEnv(
  hubUrl: string,
  dataDir: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HELM_HUB_URL: hubUrl,
    HELM_DATA_DIR: dataDir,
    HELM_TOKEN: 't-test',
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

/**
 * Execute `runCli` with captured output, returning `{ out, err, code }` without touching process stdio.
 */
export async function runCliCaptured(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  options: RunCliCapturedOptions = {},
): Promise<CliCapturedResult> {
  let out = ''
  let err = ''
  const code = await runCli(argv, {
    env,
    stdout: (text) => {
      out += text
      options.onStdout?.(text)
    },
    stderr: (text) => {
      err += text
    },
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  })
  return { out, err, code }
}

/**
 * Parse the `error` object emitted on stderr by CLI `--json` mode.
 */
export function parseCliError<TDetails = Record<string, unknown>>(result: {
  err: string
}): { code: string; message: string; details?: TDetails } {
  const parsed = JSON.parse(result.err) as {
    error: { code: string; message: string; details?: TDetails }
  }
  return parsed.error
}
