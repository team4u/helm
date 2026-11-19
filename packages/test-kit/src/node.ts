/**
 * Node.js test helpers (`@helmx/test-kit/node`).
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
export function useTempDir(t: CleanupRegistrar, prefix = 'helmx-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

/** Create an isolated temp dir asynchronously. */
export async function makeTempDir(prefix = 'helmx-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** Remove a directory recursively (ignores missing paths). */
export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

const HOST_MANAGED_HELMX_ENV_UPPER: ReadonlySet<string> = new Set(
  [
    'HELMX_ENV',
    'HELMX_HUB_URL',
    'HELMX_CONVERSATION_ID',
    'HELMX_CWD',
    'HELMX_DATA_DIR',
    'HELMX_NODE_ID',
    'HELMX_EXECUTION_SCOPE',
    'HELMX_TOKEN',
    'HELMX_NODE_INSTANCE_ID',
    'HELMX_NODE_CONTROL_ENDPOINT',
    'HELMX_NODE_PENDING_ACTIVATION',
    'HELMX_VERSION_OVERRIDE',
  ].map((name) => name.toUpperCase()),
)

/** Canonical uppercase list of host-managed Helmx env vars to strip. */
export const HOST_MANAGED_HELMX_ENV_NAMES: readonly string[] = [...HOST_MANAGED_HELMX_ENV_UPPER]

/**
 * Return a copy of the environment with host-managed `HELMX_*` variables stripped
 * (case-insensitively) and the test-specified `overrides` merged in. Does not mutate `process.env`.
 */
export function sanitizedHostEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (HOST_MANAGED_HELMX_ENV_UPPER.has(key.toUpperCase())) delete env[key]
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
