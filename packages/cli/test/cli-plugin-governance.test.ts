/**
 * Plugin governance CLI tests: `plugins disable --force` (409 plugin_in_use enrichment)
 * and `plugins config --unset` (null reset and same-key --set/--unset conflict rejection).
 * Uses real runCli + mock Hub HTTP contract (real fetch boundary).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  makeCliEnv,
  makePluginSummary,
  parseCliError,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

/** 409 plugin_in_use error envelope (with details.usages resource list). */
const inUseResponse = (usages: Array<{ kind: string; id: string; label: string }>) => ({
  status: 409,
  body: {
    error: {
      code: 'plugin_in_use',
      message: 'plugin has associated config or persistent resources that will become inactive once disabled',
      details: { pluginId: 'builtin:triggers', usages },
    },
  },
})

test('plugins disable: without --force sends no request body', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-gov-')
  const hub = await startMockHub(
    {
      'POST /api/plugins/builtin%3Atriggers/disable': () => ({
        body: [makePluginSummary({ id: 'builtin:triggers', name: 'Triggers', enabled: false })],
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['plugins', 'disable', 'builtin:triggers', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  // Key regression guard: omitting --force sends no body field (preserves bodyless call semantics)
  assert.equal(hub.hits[0]!.method, 'POST')
  assert.equal((hub.hits[0]!.body as { force?: boolean } | undefined)?.force, undefined)
  assert.equal(JSON.parse(r.out)[0]?.id, 'builtin:triggers')
})

test('plugins disable --force: sends { force: true } in request body', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-gov-')
  let sawForce: unknown
  const hub = await startMockHub(
    {
      'POST /api/plugins/builtin%3Atriggers/disable': (body) => {
        sawForce = (body as { force?: boolean } | undefined)?.force
        return {
          body: [makePluginSummary({ id: 'builtin:triggers', name: 'Triggers', enabled: false })],
        }
      },
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['plugins', 'disable', 'builtin:triggers', '--force', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(hub.hits[0]!.body, { force: true })
  assert.equal(sawForce, true)
})

test('plugins disable: 409 plugin_in_use prints usage list and --force hint in human mode; --json keeps raw envelope', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-gov-')
  const usages = [
    { kind: 'cron_job', id: 'rule-1', label: 'Daily check (cron 0 9 * * *)' },
    { kind: 'profile_runtime', id: 'watchdog', label: 'Profile watchdog runtime depends on this plugin' },
  ]
  let forceSeen = false
  const hub = await startMockHub(
    {
      'POST /api/plugins/builtin%3Atriggers/disable': (body) => {
        forceSeen = (body as { force?: boolean } | undefined)?.force === true
        return inUseResponse(usages)
      },
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  // Human mode: error message includes occupied resources and --force hint, exits non-zero
  const r = await runCliCaptured(['plugins', 'disable', 'builtin:triggers'], env)
  assert.equal(r.code, 1)
  assert.equal(forceSeen, false)
  assert.ok(r.err.includes('plugin has associated'), r.err)
  assert.ok(r.err.includes('[cron_job] rule-1'), r.err)
  assert.ok(r.err.includes('[profile_runtime] watchdog'), r.err)
  assert.ok(r.err.includes('--force'), r.err)

  // --json: error envelope preserves original code and details (machine-consumable)
  const rj = await runCliCaptured(['plugins', 'disable', 'builtin:triggers', '--json'], env)
  assert.equal(rj.code, 1)
  const err = parseCliError<{ usages: unknown[] }>(rj)
  assert.equal(err.code, 'plugin_in_use')
  assert.equal(err.details?.usages.length, 2)
})

test('plugins config --unset: PUT sends { values: { [key]: null } } and combines with --set', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-gov-')
  let lastBody: unknown
  const hub = await startMockHub(
    {
      'PUT /api/plugins/builtin%3Aherdr/config': (body) => {
        lastBody = body
        return { body: { ok: true } }
      },
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const r = await runCliCaptured(['plugins', 'config', 'builtin:herdr', '--unset', 'socketPath', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(hub.hits[0]!.body, { values: { socketPath: null } })
  assert.deepEqual(lastBody, { values: { socketPath: null } })

  // Combine with --set: set takes effect, unset key becomes null
  const r2 = await runCliCaptured(
    [
      'plugins', 'config', 'builtin:herdr',
      '--set', 'retries=5',
      '--unset', 'socketPath',
      '--unset', 'verbose',
      '--json',
    ],
    env,
  )
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(hub.hits[1]!.body, { values: { retries: 5, socketPath: null, verbose: null } })
})

test('plugins config: same key in --set and --unset rejects with conflicting_flags', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-gov-')
  const hub = await startMockHub(
    {
      'PUT /api/plugins/builtin%3Aherdr/config': () => ({ body: { ok: true } }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(
    ['plugins', 'config', 'builtin:herdr', '--set', 'verbose=true', '--unset', 'verbose', '--json'],
    makeCliEnv(hub.url, dir),
  )
  assert.equal(r.code, 1)
  const err = parseCliError(r)
  assert.equal(err.code, 'conflicting_flags')
  assert.ok(err.message.includes('verbose'))
  // Must not send PUT request on conflict
  assert.equal(hub.hits.length, 0)
})

test('plugins config --unset: rejects empty key or key containing = (invalid_flag_value)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-gov-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const bad = await runCliCaptured(['plugins', 'config', 'p1', '--unset', 'a=b', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(bad.code, 1)
  assert.equal(parseCliError(bad).code, 'invalid_flag_value')
})

test('plugins list: passes through PluginSummary with status/error', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-gov-')
  const summary = [
    makePluginSummary({ id: 'builtin:profile', name: 'Profile Base', locked: true, status: 'active' }),
    makePluginSummary({
      id: 'external:broken',
      name: 'Broken Plugin',
      status: 'failed',
      error: { code: 'plugin_load_failed', message: 'missing default export', stage: 'load' },
    }),
  ]
  const hub = await startMockHub({ 'GET /api/plugins': () => ({ body: summary }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(['plugins', 'list', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(r.out), summary)
  // Human mode: table renders status and error info without failing
  const rh = await runCliCaptured(['plugins', 'list'], env)
  assert.equal(rh.code, 0, rh.err)
  assert.ok(rh.out.includes('failed'))
  assert.ok(rh.out.includes('plugin_load_failed'))
})

test('plugins list: human table resolves LocalizedText display copy; --json keeps raw maps', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-cli-gov-')
  const summary = [
    makePluginSummary({
      id: 'demo:board',
      name: { en: 'Dashboard Plugin', 'zh-CN': '看板插件' },
      description: { 'zh-CN': '仅中文描述' },
    }),
  ]
  const hub = await startMockHub({ 'GET /api/plugins': () => ({ body: summary }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  // --json: contract passthrough keeps the raw localized shape untouched
  const rj = await runCliCaptured(['plugins', 'list', '--json'], env)
  assert.equal(rj.code, 0, rj.err)
  assert.deepEqual(JSON.parse(rj.out), summary)

  // human table: display copy resolves with the default locale ('en'); a map
  // without an 'en' entry falls back to the first declared locale entry
  const rh = await runCliCaptured(['plugins', 'list'], env)
  assert.equal(rh.code, 0, rh.err)
  assert.ok(rh.out.includes('Dashboard Plugin'), rh.out)
  assert.ok(rh.out.includes('仅中文描述'), rh.out)
  assert.ok(!rh.out.includes('"zh-CN"'), `raw localized map must not leak into human table:\n${rh.out}`)
})
