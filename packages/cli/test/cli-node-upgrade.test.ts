/**
 * helm nodes upgrade 命令契约测试：真实 HTTP server 模拟 Hub（cli-nodes-env
 * .test.ts 同款模式），验证 GET/POST 路径、查询串编码、请求体、flag 互斥、
 * --json 输出、--current（HELM_NODE_ID）解析与人类输出的诚实性（结果未
 * 确认不显示成功）。每项显式 timeout: 60_000。
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

test('nodes upgrade --check：GET /upgrade/check（无查询串）；--registry 编码进查询串', { timeout: 60_000 }, async (t) => {
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
  assert.match(human.out, /有可用更新/)
  assert.match(human.out, /0\.1\.5/, '被隔离版本展示')

  const withRegistry = await runCliCaptured(
    ['nodes', 'upgrade', 'gpu-box', '--check', '--registry', 'https://registry.npmjs.org'],
    env,
  )
  assert.equal(withRegistry.code, 0, withRegistry.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/nodes/gpu-box/upgrade/check?registryUrl=https%3A%2F%2Fregistry.npmjs.org')
})

// ---------------------------------------------------------------------------
// nodes upgrade（执行）
// ---------------------------------------------------------------------------

test('nodes upgrade：POST /upgrade 空 body（升级到 latest）；--version/--registry/--force 进 body', { timeout: 60_000 }, async (t) => {
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

test('nodes upgrade：nodeId 路径编码（特殊字符安全转义）', { timeout: 60_000 }, async (t) => {
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

test('nodes upgrade 人类输出：成功显示新旧版本与 pid；无操作显示无需升级；失败退出 1 不显示成功', { timeout: 60_000 }, async (t) => {
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
  assert.match(ok.out, /已升级/)
  assert.match(ok.out, /0\.1\.0/)
  assert.match(ok.out, /0\.2\.0/)
  assert.match(ok.out, /4321/)

  const noOp = await runCliCaptured(['nodes', 'upgrade', 'n-noop'], env)
  assert.equal(noOp.code, 0, noOp.err)
  assert.match(noOp.out, /无需升级/)

  // HTTP 200 但 ok:false：必须退出 1 且 stderr 含「未完成」诊断，不能 code 0。
  const fail = await runCliCaptured(['nodes', 'upgrade', 'n-fail'], env)
  assert.equal(fail.code, 1)
  assert.match(fail.err, /未完成/)
  assert.doesNotMatch(fail.out, /已升级|无需升级/, '失败结果绝不能显示成功字样')
})

test('nodes upgrade --json：HTTP 200 但 ok:false 同样退出 1，stderr 输出错误信封', { timeout: 60_000 }, async (t) => {
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
  assert.match(err.message, /未完成/)
  assert.equal(r.out.trim(), '', '失败时 --json 不向 stdout 输出成功结果')
})

test('nodes upgrade：结果未确认（Hub 502 node_upgrade_unconfirmed）以错误退出，不显示成功', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-node-upgrade-')
  const hub = await startMockHub(
    {
      'POST /api/nodes/gpu-box/upgrade': () => ({
        status: 502,
        body: { error: { code: 'node_upgrade_unconfirmed', message: '节点 gpu-box 升级结果未确认' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['nodes', 'upgrade', 'gpu-box'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 1)
  assert.match(r.err, /未确认/)
  assert.doesNotMatch(r.out, /已升级|无需升级/)
})

// ---------------------------------------------------------------------------
// flag 互斥与 --current
// ---------------------------------------------------------------------------

test('nodes upgrade：--check 与 --version/--force 互斥（显式拒绝）', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-node-upgrade-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const withVersion = await runCliCaptured(['nodes', 'upgrade', 'gpu-box', '--check', '--version', '1.0.0'], env)
  assert.equal(withVersion.code, 1)
  assert.match(withVersion.err, /互斥/)
  const withForce = await runCliCaptured(['nodes', 'upgrade', 'gpu-box', '--check', '--force'], env)
  assert.equal(withForce.code, 1)
  assert.match(withForce.err, /互斥/)
  assert.equal(hub.hits.length, 0, '互斥拒绝在发请求前')
})

test('nodes upgrade --current：读 HELM_NODE_ID；与显式 nodeId 互斥；缺失时显式报错', { timeout: 60_000 }, async (t) => {
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
  assert.match(both.err, /互斥/)

  const missing = await runCliCaptured(['nodes', 'upgrade', '--current'], makeCliEnv(hub.url, dir))
  assert.equal(missing.code, 1)
  assert.match(missing.err, /HELM_NODE_ID/)
})

test('nodes upgrade：未知 flag 拒绝；缺少节点目标报错；--check 响应非法形状报错', { timeout: 60_000 }, async (t) => {
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
  assert.match(unknownFlag.err, /未知选项|--target/)

  const noTarget = await runCliCaptured(['nodes', 'upgrade'], env)
  assert.equal(noTarget.code, 1)
  assert.match(noTarget.err, /缺少节点目标|nodeId/)

  const badShape = await runCliCaptured(['nodes', 'upgrade', 'gpu-box', '--check'], env)
  assert.equal(badShape.code, 1)
  assert.match(badShape.err, /invalid_response|字段/)
})

test('nodes list：人类模式含 version 列', { timeout: 60_000 }, async (t) => {
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
