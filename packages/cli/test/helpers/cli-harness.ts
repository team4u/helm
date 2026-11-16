/**
 * CLI 测试共享夹具与运行辅助（`packages/cli/test/helpers/cli-harness.ts`）。
 * 统一复用 `@helm/test-kit` 的 Mock Hub、临时目录自动清理与 DTO 工厂，
 * 消除各 CLI 测试文件中重复的 `startHub / makeEnv / run / tempDir` 样板代码。
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

/** `runCliCaptured` 返回的标准输出、标准错误与退出码快照。 */
export interface CliCapturedResult {
  out: string
  err: string
  code: number
}

/** `runCliCaptured` 可选注入项（stdin / cwd / fetch / onStdout）。 */
export interface RunCliCapturedOptions {
  stdin?: StdinSource
  cwd?: string
  fetch?: typeof fetch
  onStdout?: (text: string) => void
}

/**
 * 构造隔离的 CLI 测试环境变量（默认注入测试用 `HELM_HUB_URL`、`HELM_DATA_DIR`、`HELM_TOKEN`）。
 * 若 `extra` 中显式将某键设为 `undefined`，则从返回对象中删除该键。
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
 * 捕获式执行 `runCli`，返回 `{ out, err, code }`，避免测试触碰全局 stdio。
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
 * 解析 CLI `--json` 模式下 stderr 输出的错误信封 `error` 对象。
 */
export function parseCliError<TDetails = Record<string, unknown>>(result: {
  err: string
}): { code: string; message: string; details?: TDetails } {
  const parsed = JSON.parse(result.err) as {
    error: { code: string; message: string; details?: TDetails }
  }
  return parsed.error
}
