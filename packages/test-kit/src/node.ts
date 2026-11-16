/**
 * Node.js test helpers (`@helm/test-kit/node`).
 * Provides temp dir auto-cleanup, host-managed env stripping, AssertionError-level error code
 * assertions, and polling utilities.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export { waitFor, waitFor as waitForCondition } from './index.js'
export type { WaitForOptions } from './index.js'

/** Test context that supports registering `after` cleanup callbacks (compatible with node:test `TestContext`). */
export interface CleanupRegistrar {
  after: (fn: () => void | Promise<void>) => void
}

/**
 * Create an isolated temp dir synchronously and clean it up recursively when the test context
 * finishes. Compared to manual try/finally, this avoids leaking temp dirs on error paths.
 */
export function useTempDir(t: CleanupRegistrar, prefix = 'helm-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

/** Create an isolated temp dir asynchronously. */
export async function makeTempDir(prefix = 'helm-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** Remove a directory recursively (ignores missing paths). */
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

/** Canonical uppercase list of host-managed Helm env vars to strip. */
export const HOST_MANAGED_HELM_ENV_NAMES: readonly string[] = [...HOST_MANAGED_HELM_ENV_UPPER]

/**
 * Return a copy of the environment with host-managed `HELM_*` variables stripped
 * (case-insensitively) and the test-specified `overrides` merged in. Does not mutate `process.env`.
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

/** Assert an async operation rejects with an error matching the given code (and optional HTTP status) via `node:assert/strict`. */
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
        `expected error code ${code}, got ${String(actual?.code)} (${String(actual?.message ?? error)})`,
      )
      if (status !== undefined) {
        assert.equal(actual?.status, status, `expected error status ${status}, got ${String(actual?.status)}`)
      }
      return true
    },
    `expected rejection with error code ${code}`,
  )
  return caught
}
