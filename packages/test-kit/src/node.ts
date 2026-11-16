/**
 * Node.js 测试辅助（`@helm/test-kit/node`）。
 * 提供临时目录自动清理、受管环境变量剥除、AssertionError 级别错误码断言与轮询工具。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export { waitFor, waitFor as waitForCondition } from './index.js'
export type { WaitForOptions } from './index.js'

/** 支持注册 `after` 清理回调的测试上下文（兼容 node:test `TestContext`）。 */
export interface CleanupRegistrar {
  after: (fn: () => void | Promise<void>) => void
}

/**
 * 同步创建独立临时目录并在测试上下文结束时自动递归清理。
 * 相比手动 try/finally，可避免异常路径遗留临时目录。
 */
export function useTempDir(t: CleanupRegistrar, prefix = 'helm-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

/** 异步创建独立临时目录。 */
export async function makeTempDir(prefix = 'helm-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** 异步递归清理目录（忽略不存在）。 */
export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

const HOST_MANAGED_HELM_ENV_UPPER: ReadonlySet<string> = new Set(
  [
    'HELM_ENV',
    'HELM_HUB_URL',
    'HELM_CONVERSATION_ID',
    'HELM_CWD',
    'HELM_DATA_DIR',
    'HELM_NODE_ID',
    'HELM_EXECUTION_SCOPE',
    'HELM_TOKEN',
    'HELM_NODE_INSTANCE_ID',
    'HELM_NODE_CONTROL_ENDPOINT',
    'HELM_NODE_PENDING_ACTIVATION',
    'HELM_VERSION_OVERRIDE',
  ].map((name) => name.toUpperCase()),
)

/** 需剥除的宿主受管 Helm 环境变量标准大写清单。 */
export const HOST_MANAGED_HELM_ENV_NAMES: readonly string[] = [...HOST_MANAGED_HELM_ENV_UPPER]

/**
 * 返回剥除宿主受管 `HELM_*` 变量（大小写不敏感）后的环境变量副本，
 * 并合入测试显式指定的 `overrides`。不修改 `process.env`。
 */
export function sanitizedHostEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (HOST_MANAGED_HELM_ENV_UPPER.has(key.toUpperCase())) delete env[key]
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key]
      else env[key] = value
    }
  }
  return env
}

/** 使用 `node:assert/strict` 断言异步操作抛出匹配错误码（及可选 HTTP 状态码）的错误。 */
export async function assertRejectsCode(
  fn: () => Promise<unknown>,
  code: string,
  status?: number,
): Promise<unknown> {
  let caught: unknown
  await assert.rejects(
    fn,
    (error: unknown) => {
      caught = error
      const actual =
        error !== null && typeof error === 'object'
          ? (error as { code?: unknown; status?: unknown; message?: unknown })
          : undefined
      assert.equal(
        actual?.code,
        code,
        `预期错误码 ${code}，实际为 ${String(actual?.code)}（${String(actual?.message ?? error)}）`,
      )
      if (status !== undefined) {
        assert.equal(actual?.status, status, `预期错误状态码 ${status}，实际为 ${String(actual?.status)}`)
      }
      return true
    },
    `预期抛出错误码 ${code}`,
  )
  return caught
}
