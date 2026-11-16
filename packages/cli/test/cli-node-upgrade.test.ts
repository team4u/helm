/**
 * helm nodes upgrade command contract test: real HTTP server simulated Hub(cli-nodes-env
 * .test.ts same style pattern), verify GET/POST path, query string encode, request body,flag mutual exclusion,
 * --json output,--current(HELM_NODE_ID) parse and person class output honest (result not
 * confirm does not show succeeded). each items explicit timeout: 60_000.
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

test('nodes upgrade --check:GET /upgrade/check(without query string);--registry encode enter query string', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-node-upgrade-')
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
  assert.match(human.out, /has available update/)
  assert.match(human.out, /0\.1\.5/, 'by isolated version render')

  const withRegistry = await runCliCaptured(
    ['nodes', 'upgrade', 'gpu-box', '--check', '--registry', 'https://registry.npmjs.org'],
    env,
  )
  assert.equal(withRegistry.code, 0, withRegistry.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/nodes/gpu-box/upgrade/check?registryUrl=https%3A%2F%2Fregistry.npmjs.org')
})

// ---------------------------------------------------------------------------
// nodes upgrade(execute)
// ---------------------------------------------------------------------------

test('nodes upgrade:POST /upgrade empty body(upgrade to latest);--version/--registry/--force enter body', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-node-upgrade-')
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

test('nodes upgrade:nodeId path encode (special character security escaping)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-node-upgrade-')
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

test('nodes upgrade person class output: succeeded show new old version and pid; without operation show no need to upgrade; failed exit 1 does not show succeeded', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-node-upgrade-')
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
  assert.match(ok.out, /already upgrade/)
  assert.match(ok.out, /0\.1\.0/)
  assert.match(ok.out, /0\.2\.0/)
  assert.match(ok.out, /4321/)

  const noOp = await runCliCaptured(['nodes', 'upgrade', 'n-noop'], env)
  assert.equal(noOp.code, 0, noOp.err)
  assert.match(noOp.out, /no need to upgrade/)

  // HTTP 200 but ok:false: must exit 1 and stderr contains not complete diagnose, cannot code 0.
  const fail = await runCliCaptured(['nodes', 'upgrade', 'n-fail'], env)
  assert.equal(fail.code, 1)
  assert.match(fail.err, /not complete/)
  assert.doesNotMatch(fail.out, /already upgrade|no need to upgrade/, 'failed result never can show succeeded character')
})

test('nodes upgrade --json:HTTP 200 but ok:false same exit 1,stderr output error message seal', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-node-upgrade-')
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
  assert.match(err.message, /not complete/)
  assert.equal(r.out.trim(), '', 'on failure --json do not to stdout output succeeded result')
})

test('nodes upgrade: result not confirm (Hub 502 node_upgrade_unconfirmed) with error exit, does not show succeeded', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-node-upgrade-')
  const hub = await startMockHub(
    {
      'POST /api/nodes/gpu-box/upgrade': () => ({
        status: 502,
        body: { error: { code: 'node_upgrade_unconfirmed', message: 'node gpu-box upgrade result not confirm' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['nodes', 'upgrade', 'gpu-box'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 1)
  assert.match(r.err, /not confirm/)
  assert.doesNotMatch(r.out, /already upgrade|no need to upgrade/)
})

// ---------------------------------------------------------------------------
// flag mutual exclusion and --current
// ---------------------------------------------------------------------------

test('nodes upgrade:--check and --version/--force mutual exclusion (explicit reject)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-node-upgrade-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const withVersion = await runCliCaptured(['nodes', 'upgrade', 'gpu-box', '--check', '--version', '1.0.0'], env)
  assert.equal(withVersion.code, 1)
  assert.match(withVersion.err, /mutual exclusion/)
  const withForce = await runCliCaptured(['nodes', 'upgrade', 'gpu-box', '--check', '--force'], env)
  assert.equal(withForce.code, 1)
  assert.match(withForce.err, /mutual exclusion/)
  assert.equal(hub.hits.length, 0, 'mutual exclusion reject in request before')
})

test('nodes upgrade --current: read HELM_NODE_ID; and explicit nodeId mutual exclusion; missing when explicit errors', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-node-upgrade-')
  const hub = await startMockHub(
    {
      'POST /api/nodes/env-node/upgrade': () => ({ body: UPGRADE_OK }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELM_NODE_ID: 'env-node' })

  const viaCurrent = await runCliCaptured(['nodes', 'upgrade', '--current'], env)
  assert.equal(viaCurrent.code, 0, viaCurrent.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/nodes/env-node/upgrade')

  const both = await runCliCaptured(['nodes', 'upgrade', 'gpu-box', '--current'], env)
  assert.equal(both.code, 1)
  assert.match(both.err, /mutual exclusion/)

  const missing = await runCliCaptured(['nodes', 'upgrade', '--current'], makeCliEnv(hub.url, dir))
  assert.equal(missing.code, 1)
  assert.match(missing.err, /HELM_NODE_ID/)
})

test('nodes upgrade: unknown flag reject; missing node target errors;--check response illegal shape errors', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-node-upgrade-')
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

test('nodes list: person class pattern contains version column', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-node-upgrade-')
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
