/**
 * Contract tests for `helmx nodes upgrade`: mock HTTP server simulating Hub
 * (same pattern as cli-nodes-env.test.ts), verifying GET/POST routes, query encoding,
 * request bodies, flag mutual exclusions, --json output, --current (HELMX_NODE_ID),
 * and honest human output (unconfirmed results never print success).
 * Every test specifies explicit timeout: 60_000.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  makeCliEnv,
  parseCliError,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

const CHECK_RESULT = {
  currentVersion: '0.1.0',
  latestVersion: '0.2.0',
  updateAvailable: true,
  blocked: { version: '0.1.5', reason: 'canary rollback', at: '2026-01-01T00:00:00.000Z' },
}

const UPGRADE_OK = { ok: true, previousVersion: '0.1.0', targetVersion: '0.2.0', upgraded: true, pid: 4321 }

// ---------------------------------------------------------------------------
// nodes upgrade --check
// ---------------------------------------------------------------------------

test('nodes upgrade --check: GET /upgrade/check (no query); --registry encoded into query string', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-node-upgrade-')
  const hub = await startMockHub(
    {
      'GET /api/nodes/gpu-box/upgrade/check': () => ({ body: CHECK_RESULT }),
      'GET /api/nodes/gpu-box/upgrade/check?registryUrl=https%3A%2F%2Fregistry.npmjs.org': () => ({ body: CHECK_RESULT }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const json = await runCliCaptured(['nodes', 'upgrade', 'gpu-box', '--check', '--json'], env)
  assert.equal(json.code, 0, json.err)
  assert.deepEqual(JSON.parse(json.out), CHECK_RESULT)
  assert.equal(hub.hits.at(-1)?.method, 'GET')
  assert.equal(hub.hits.at(-1)?.path, '/api/nodes/gpu-box/upgrade/check')

  const human = await runCliCaptured(['nodes', 'upgrade', 'gpu-box', '--check'], env)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /0\.1\.0/)
  assert.match(human.out, /0\.2\.0/)
  assert.match(human.out, /Update available/)
  assert.match(human.out, /0\.1\.5/, 'displays quarantined version')

  const withRegistry = await runCliCaptured(
    ['nodes', 'upgrade', 'gpu-box', '--check', '--registry', 'https://registry.npmjs.org'],
    env,
  )
  assert.equal(withRegistry.code, 0, withRegistry.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/nodes/gpu-box/upgrade/check?registryUrl=https%3A%2F%2Fregistry.npmjs.org')
})

// ---------------------------------------------------------------------------
// nodes upgrade (execute)
// ---------------------------------------------------------------------------

test('nodes upgrade: POST /upgrade empty body (upgrades to latest); --version/--registry/--force go in body', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-node-upgrade-')
  const hub = await startMockHub(
    {
      'POST /api/nodes/gpu-box/upgrade': () => ({ body: UPGRADE_OK }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const json = await runCliCaptured(['nodes', 'upgrade', 'gpu-box', '--json'], env)
  assert.equal(json.code, 0, json.err)
  assert.deepEqual(JSON.parse(json.out), UPGRADE_OK)
  assert.equal(hub.hits.at(-1)?.method, 'POST')
  assert.equal(hub.hits.at(-1)?.path, '/api/nodes/gpu-box/upgrade')

  await runCliCaptured(
    ['nodes', 'upgrade', 'gpu-box', '--version', 'v0.2.0', '--registry', 'https://registry.npmjs.org', '--force'],
    env,
  )
  const hit = hub.hits.at(-1)!
  assert.equal(hit.path, '/api/nodes/gpu-box/upgrade')
  assert.deepEqual(hit.body, {
    targetVersion: 'v0.2.0',
    registryUrl: 'https://registry.npmjs.org',
    force: true,
  })
})

test('nodes upgrade: nodeId path encoding (special characters safely escaped)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-node-upgrade-')
  const hub = await startMockHub(
    {
      'POST /api/nodes/gpu.box-1/upgrade': () => ({ body: UPGRADE_OK }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['nodes', 'upgrade', 'gpu.box-1'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/nodes/gpu.box-1/upgrade')
})

test('nodes upgrade human output: shows versions and pid on success; no-op message when up to date; exits 1 on failure without printing success', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-node-upgrade-')
  const noop = { ok: true, previousVersion: '0.2.0', targetVersion: '0.2.0', upgraded: false }
  const failed = { ok: false, previousVersion: '0.1.0', targetVersion: '0.2.0', upgraded: false }
  const hub = await startMockHub(
    {
      'POST /api/nodes/n-ok/upgrade': () => ({ body: UPGRADE_OK }),
      'POST /api/nodes/n-noop/upgrade': () => ({ body: noop }),
      'POST /api/nodes/n-fail/upgrade': () => ({ body: failed }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const ok = await runCliCaptured(['nodes', 'upgrade', 'n-ok'], env)
  assert.equal(ok.code, 0, ok.err)
  assert.match(ok.out, /upgraded:/)
  assert.match(ok.out, /0\.1\.0/)
  assert.match(ok.out, /0\.2\.0/)
  assert.match(ok.out, /4321/)

  const noOp = await runCliCaptured(['nodes', 'upgrade', 'n-noop'], env)
  assert.equal(noOp.code, 0, noOp.err)
  assert.match(noOp.out, /does not need an upgrade/)

  // HTTP 200 with ok:false must exit 1 with failure diagnostic on stderr, never code 0.
  const fail = await runCliCaptured(['nodes', 'upgrade', 'n-fail'], env)
  assert.equal(fail.code, 1)
  assert.match(fail.err, /did not complete/)
  assert.doesNotMatch(fail.out, /upgraded:|does not need an upgrade/, 'failed result must never show success wording')
})

test('nodes upgrade --json: HTTP 200 with ok:false also exits 1 with JSON error envelope on stderr', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-node-upgrade-')
  const failed = { ok: false, previousVersion: '0.1.0', targetVersion: '0.2.0', upgraded: false }
  const hub = await startMockHub(
    {
      'POST /api/nodes/gpu-box/upgrade': () => ({ body: failed }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['nodes', 'upgrade', 'gpu-box', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 1)
  const err = parseCliError(r)
  assert.equal(err.code, 'node_upgrade_failed')
  assert.match(err.message, /did not complete/)
  assert.equal(r.out.trim(), '', '--json must not print success payload to stdout on failure')
})

test('nodes upgrade: unconfirmed result (Hub 502 node_upgrade_unconfirmed) exits with error and prints no success', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-node-upgrade-')
  const hub = await startMockHub(
    {
      'POST /api/nodes/gpu-box/upgrade': () => ({
        status: 502,
        body: { error: { code: 'node_upgrade_unconfirmed', message: 'node gpu-box upgrade result unconfirmed' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['nodes', 'upgrade', 'gpu-box'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 1)
  assert.match(r.err, /unconfirmed/)
  assert.doesNotMatch(r.out, /upgraded:|does not need an upgrade/)
})

// ---------------------------------------------------------------------------
// flag mutual exclusions and --current
// ---------------------------------------------------------------------------

test('nodes upgrade: --check and --version/--force are mutually exclusive (rejected explicitly)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-node-upgrade-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const withVersion = await runCliCaptured(['nodes', 'upgrade', 'gpu-box', '--check', '--version', '1.0.0'], env)
  assert.equal(withVersion.code, 1)
  assert.match(withVersion.err, /mutually exclusive/)
  const withForce = await runCliCaptured(['nodes', 'upgrade', 'gpu-box', '--check', '--force'], env)
  assert.equal(withForce.code, 1)
  assert.match(withForce.err, /mutually exclusive/)
  assert.equal(hub.hits.length, 0, 'mutual exclusion rejected before sending HTTP request')
})

test('nodes upgrade --current: reads HELMX_NODE_ID; mutually exclusive with nodeId; errors explicitly when missing', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-node-upgrade-')
  const hub = await startMockHub(
    {
      'POST /api/nodes/env-node/upgrade': () => ({ body: UPGRADE_OK }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELMX_NODE_ID: 'env-node' })

  const viaCurrent = await runCliCaptured(['nodes', 'upgrade', '--current'], env)
  assert.equal(viaCurrent.code, 0, viaCurrent.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/nodes/env-node/upgrade')

  const both = await runCliCaptured(['nodes', 'upgrade', 'gpu-box', '--current'], env)
  assert.equal(both.code, 1)
  assert.match(both.err, /mutually exclusive/)

  const missing = await runCliCaptured(['nodes', 'upgrade', '--current'], makeCliEnv(hub.url, dir))
  assert.equal(missing.code, 1)
  assert.match(missing.err, /HELMX_NODE_ID/)
})

test('nodes upgrade: rejects unknown flag; errors on missing node target; rejects invalid --check response shape', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-node-upgrade-')
  const hub = await startMockHub(
    {
      'GET /api/nodes/gpu-box/upgrade/check': () => ({ body: { currentVersion: 'x' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const unknownFlag = await runCliCaptured(['nodes', 'upgrade', 'gpu-box', '--target'], env)
  assert.equal(unknownFlag.code, 1)
  assert.match(unknownFlag.err, /unknown option|--target/)

  const noTarget = await runCliCaptured(['nodes', 'upgrade'], env)
  assert.equal(noTarget.code, 1)
  assert.match(noTarget.err, /missing node target|nodeId/)

  const badShape = await runCliCaptured(['nodes', 'upgrade', 'gpu-box', '--check'], env)
  assert.equal(badShape.code, 1)
  assert.match(badShape.err, /invalid_response|field/)
})

test('nodes list: human table includes version column', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-node-upgrade-')
  const nodes = [
    { id: 'local', kind: 'local', online: true, version: '0.2.0', hostname: 'hub', platform: 'linux' },
    { id: 'gpu-box', kind: 'byom', online: true, version: '0.1.0', hostname: 'gpu', platform: 'linux' },
  ]
  const hub = await startMockHub({ 'GET /api/nodes': () => ({ body: nodes }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(['nodes', 'list'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /version/)
  assert.match(r.out, /0\.1\.0/)
  assert.match(r.out, /0\.2\.0/)
})
