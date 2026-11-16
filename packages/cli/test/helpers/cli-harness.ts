/**
 * CLI test sharing fixture and run auxiliary (`packages/cli/test/helpers/cli-harness.ts`).
 * unify re- use `@helm/test-kit`  Mock Hub, temp directory automatically clean up and DTO work vendor,
 * eliminate each CLI test file in duplicate `startHub / makeEnv / run / tempDir` board code.
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

/** `runCliCaptured` return standard output, standard error and exit code snapshot. */
export interface CliCapturedResult {
  out: string
  err: string
  code: number
}

/** `runCliCaptured` optional inject items (stdin / cwd / fetch / onStdout). */
export interface RunCliCapturedOptions {
  stdin?: StdinSource
  cwd?: string
  fetch?: typeof fetch
  onStdout?: (text: string) => void
}

/**
 * construct isolated CLI test environment variable (by default inject test use `HELM_HUB_URL`,`HELM_DATA_DIR`,`HELM_TOKEN`).
 * if `extra` in explicit a certain key set is `undefined`, then from return object in delete the key.
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
 * catch style execute `runCli`, return `{ out, err, code }`, avoid test trigger touch global stdio.
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
 * parse CLI `--json` pattern under stderr output error message seal `error` object.
 */
export function parseCliError<TDetails = Record<string, unknown>>(result: {
  err: string
}): { code: string; message: string; details?: TDetails } {
  const parsed = JSON.parse(result.err) as {
    error: { code: string; message: string; details?: TDetails }
  }
  return parsed.error
}
