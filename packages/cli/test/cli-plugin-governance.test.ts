/**
 * plugin governance CLI test:plugins disable --force(409 plugin_in_use rich hint),
 * plugins config --unset(send null reset and --set/--unset same key conflict reject).
 * real runCli + simulated Hub HTTP contract (real fetch boundary).
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

/** 409 plugin_in_use error message seal (contains details.usages occupy manifest). */
const inUseResponse = (usages: Array<{ kind: string; id: string; label: string }>) => ({
  status: 409,
  body: {
    error: {
      code: 'plugin_in_use',
      message: 'plugin store in related config or durable asset, deactivate after related feature can expires',
      details: { pluginId: 'builtin:triggers', usages },
    },
  },
})

test('plugins disable: without --force keep without body request', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-gov-')
  const hub = await startMockHub(
    {
      'POST /api/plugins/builtin%3Atriggers/disable': () => ({
        body: [makePluginSummary({ id: 'builtin:triggers', name: 'trigger', enabled: false })],
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['plugins', 'disable', 'builtin:triggers', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  // key regression point: not pass --force when request body excludes force(keep since has without body invoke semantics)
  assert.equal(hub.hits[0]!.method, 'POST')
  assert.equal((hub.hits[0]!.body as { force?: boolean } | undefined)?.force, undefined)
  assert.equal(JSON.parse(r.out)[0]?.id, 'builtin:triggers')
})

test('plugins disable --force: request carry { force: true }', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-gov-')
  let sawForce: unknown
  const hub = await startMockHub(
    {
      'POST /api/plugins/builtin%3Atriggers/disable': (body) => {
        sawForce = (body as { force?: boolean } | undefined)?.force
        return {
          body: [makePluginSummary({ id: 'builtin:triggers', name: 'trigger', enabled: false })],
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

test('plugins disable:409 plugin_in_use when person class pattern output occupy manifest and --force hint,--json keep message seal', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-gov-')
  const usages = [
    { kind: 'cron_job', id: 'rule-1', label: 'each day inspection (cron 0 9 * * *)' },
    { kind: 'profile_runtime', id: 'watchdog', label: 'role watchdog  runtime dependency this plugin' },
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
  // person class pattern: error message contains occupy summary and --force hint, exit code non-zero
  const r = await runCliCaptured(['plugins', 'disable', 'builtin:triggers'], env)
  assert.equal(r.code, 1)
  assert.equal(forceSeen, false)
  assert.ok(r.err.includes('plugin store in related'), r.err)
  assert.ok(r.err.includes('[cron_job] rule-1'), r.err)
  assert.ok(r.err.includes('[profile_runtime] watchdog'), r.err)
  assert.ok(r.err.includes('--force'), r.err)

  // --json: error message seal keep original code and details(supply machine consume)
  const rj = await runCliCaptured(['plugins', 'disable', 'builtin:triggers', '--json'], env)
  assert.equal(rj.code, 1)
  const err = parseCliError<{ usages: unknown[] }>(rj)
  assert.equal(err.code, 'plugin_in_use')
  assert.equal(err.details?.usages.length, 2)
})

test('plugins config --unset:PUT send { values: { [key]: null } }, can and --set combine', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-gov-')
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

  // and --set combine:set takes effect,unset key is null
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

test('plugins config:--set and --unset same key conflict report conflicting_flags', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-gov-')
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
  // conflict when must not out PUT request
  assert.equal(hub.hits.length, 0)
})

test('plugins config --unset: empty string and contains = key name reject (invalid_flag_value)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-gov-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const bad = await runCliCaptured(['plugins', 'config', 'p1', '--unset', 'a=b', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(bad.code, 1)
  assert.equal(parseCliError(bad).code, 'invalid_flag_value')
})

test('plugins list: pass-through contains status/error  PluginSummary', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-gov-')
  const summary = [
    makePluginSummary({ id: 'builtin:profile', name: 'role bottom seat', locked: true, status: 'active' }),
    makePluginSummary({
      id: 'external:broken',
      name: 'broken plugin',
      status: 'failed',
      error: { code: 'plugin_load_failed', message: 'entry export missing', stage: 'load' },
    }),
  ]
  const hub = await startMockHub({ 'GET /api/plugins': () => ({ body: summary }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(['plugins', 'list', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(r.out), summary)
  // person class pattern: table render new field do not errors and contains state and error information
  const rh = await runCliCaptured(['plugins', 'list'], env)
  assert.equal(rh.code, 0, rh.err)
  assert.ok(rh.out.includes('failed'))
  assert.ok(rh.out.includes('plugin_load_failed'))
})

test('plugins list: human table resolves LocalizedText display copy; --json keeps raw maps', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-gov-')
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
