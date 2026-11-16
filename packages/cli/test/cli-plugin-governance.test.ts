/**
 * 插件治理 CLI 测试：plugins disable --force（409 plugin_in_use 富化提示）、
 * plugins config --unset（发送 null 重置与 --set/--unset 同 key 冲突拒绝）。
 * 真实 runCli + 模拟 Hub HTTP 契约（真实 fetch 边界）。
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

/** 409 plugin_in_use 错误信封（含 details.usages 占用清单）。 */
const inUseResponse = (usages: Array<{ kind: string; id: string; label: string }>) => ({
  status: 409,
  body: {
    error: {
      code: 'plugin_in_use',
      message: '插件存在关联的配置或持久资源，停用后相关功能将失效',
      details: { pluginId: 'builtin:triggers', usages },
    },
  },
})

test('plugins disable：无 --force 保持无 body 请求', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-gov-')
  const hub = await startMockHub(
    {
      'POST /api/plugins/builtin%3Atriggers/disable': () => ({
        body: [makePluginSummary({ id: 'builtin:triggers', name: '触发器', enabled: false })],
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['plugins', 'disable', 'builtin:triggers', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  // 关键回归点：未传 --force 时请求体不含 force（保持既有无 body 调用语义）
  assert.equal(hub.hits[0]!.method, 'POST')
  assert.equal((hub.hits[0]!.body as { force?: boolean } | undefined)?.force, undefined)
  assert.equal(JSON.parse(r.out)[0]?.id, 'builtin:triggers')
})

test('plugins disable --force：请求携带 { force: true }', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-gov-')
  let sawForce: unknown
  const hub = await startMockHub(
    {
      'POST /api/plugins/builtin%3Atriggers/disable': (body) => {
        sawForce = (body as { force?: boolean } | undefined)?.force
        return {
          body: [makePluginSummary({ id: 'builtin:triggers', name: '触发器', enabled: false })],
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

test('plugins disable：409 plugin_in_use 时人类模式输出占用清单与 --force 提示，--json 保留信封', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-gov-')
  const usages = [
    { kind: 'cron_job', id: 'rule-1', label: '每日巡检（cron 0 9 * * *）' },
    { kind: 'profile_runtime', id: 'watchdog', label: '角色 watchdog 的 runtime 依赖本插件' },
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
  // 人类模式：错误消息含占用摘要与 --force 提示，退出码非零
  const r = await runCliCaptured(['plugins', 'disable', 'builtin:triggers'], env)
  assert.equal(r.code, 1)
  assert.equal(forceSeen, false)
  assert.ok(r.err.includes('插件存在关联'), r.err)
  assert.ok(r.err.includes('[cron_job] rule-1'), r.err)
  assert.ok(r.err.includes('[profile_runtime] watchdog'), r.err)
  assert.ok(r.err.includes('--force'), r.err)

  // --json：错误信封保留原 code 与 details（供机器消费）
  const rj = await runCliCaptured(['plugins', 'disable', 'builtin:triggers', '--json'], env)
  assert.equal(rj.code, 1)
  const err = parseCliError<{ usages: unknown[] }>(rj)
  assert.equal(err.code, 'plugin_in_use')
  assert.equal(err.details?.usages.length, 2)
})

test('plugins config --unset：PUT 发送 { values: { [key]: null } }，可与 --set 组合', { timeout: 60_000 }, async (t) => {
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

  // 与 --set 组合：set 生效、unset 键为 null
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

test('plugins config：--set 与 --unset 同 key 冲突报 conflicting_flags', { timeout: 60_000 }, async (t) => {
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
  // 冲突时不得发出 PUT 请求
  assert.equal(hub.hits.length, 0)
})

test('plugins config --unset：空串与含 = 的键名拒绝（invalid_flag_value）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-gov-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const bad = await runCliCaptured(['plugins', 'config', 'p1', '--unset', 'a=b', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(bad.code, 1)
  assert.equal(parseCliError(bad).code, 'invalid_flag_value')
})

test('plugins list：透传含 status/error 的 PluginSummary', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-gov-')
  const summary = [
    makePluginSummary({ id: 'builtin:profile', name: '角色底座', locked: true, status: 'active' }),
    makePluginSummary({
      id: 'external:broken',
      name: '坏插件',
      status: 'failed',
      error: { code: 'plugin_load_failed', message: '入口导出缺失', stage: 'load' },
    }),
  ]
  const hub = await startMockHub({ 'GET /api/plugins': () => ({ body: summary }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const r = await runCliCaptured(['plugins', 'list', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(r.out), summary)
  // 人类模式：表格渲染新字段不报错且包含状态与错误信息
  const rh = await runCliCaptured(['plugins', 'list'], env)
  assert.equal(rh.code, 0, rh.err)
  assert.ok(rh.out.includes('failed'))
  assert.ok(rh.out.includes('plugin_load_failed'))
})
