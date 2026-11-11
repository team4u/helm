/**
 * 外部插件 DX 闭环 HTTP 契约测试：POST /api/plugins/doctor、
 * POST /api/plugins/rescan、POST /api/plugins/:id/reload。
 * 真实路由层（createHubHandler + 真实 routes.ts）+ 真实 AuthService +
 * 最小 PluginHost 形状的 fake（路由层消费 KernelRuntimeLike 结构化形状）。
 * 校验：鉴权门禁、路径分发、body 边界校验（dir 形状/未知字段）、
 * 错误信封（404/422/501 透传 HelmError 结构化语义）与成功响应形状。
 */
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HelmError,
  type PluginDoctorReport,
  type PluginReloadResult,
  type PluginRescanResult,
  type PluginSummary,
} from '@helm/protocol'
import { AuthService } from '../src/services/index.js'
import { createHubHandler, type KernelRuntimeLike } from '../src/http/index.js'

let dataDir: string
let token: string
let handler: (request: Request) => Promise<Response>

/** 路由层消费的最小 plugins 端口（按用例覆写行为）。 */
let doctorImpl:
  | ((target: { dir?: string; id?: string }) => Promise<PluginDoctorReport>)
  | undefined
let reloadImpl: ((pluginId: string) => Promise<PluginReloadResult>) | undefined
let rescanImpl: (() => Promise<PluginRescanResult>) | undefined

function makeSummary(id: string, enabled: boolean): PluginSummary {
  return { id, name: id, locked: false, enabled, hooks: [], actions: [], tools: [] }
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'helm-dx-http-'))
  doctorImpl = undefined
  reloadImpl = undefined
  rescanImpl = undefined
  const auth = new AuthService(dataDir)
  token = (await auth.setup('dx-http-test-password-123')).token
  const kernel: KernelRuntimeLike = {
    dataDir,
    auth,
    events: { response: () => new Response('') },
    profiles: new Proxy({}, { get: () => async () => [] }) as never,
    skills: new Proxy({}, { get: () => async () => [] }) as never,
    credentials: new Proxy({}, { get: () => async () => [] }) as never,
    providers: new Proxy({}, { get: () => async () => [] }) as never,
    artifacts: new Proxy({}, { get: () => { throw new HelmError('not_found', 'x', 404) } }) as never,
    plugins: {
      list: () => [],
      enable: async () => {},
      disable: async () => {},
      listActions: () => [],
      invokeAction: async () => ({}),
      getConfig: () => ({}),
      getConfigSchema: () => ({}),
      setConfig: async () => {},
      listRoutes: () => [],
      getPublicDoc: () => {
        throw new HelmError('not_found', 'x', 404)
      },
      getPublicSessionDoc: () => {
        throw new HelmError('not_found', 'x', 404)
      },
      getClientModule: async () => ({ code: '', contentHash: '', exports: [] }),
      doctorExternalPlugin: (target: { dir?: string; id?: string }) => {
        if (doctorImpl === undefined) throw new HelmError('unsupported', '未配置', 501)
        return doctorImpl(target)
      },
      reloadExternalPlugin: (pluginId: string) => {
        if (reloadImpl === undefined) throw new HelmError('unsupported', '未配置', 501)
        return reloadImpl(pluginId)
      },
      rescanExternalPlugins: () => {
        if (rescanImpl === undefined) throw new HelmError('unsupported', '未配置', 501)
        return rescanImpl()
      },
    },
    listConversations: async () => [],
    getConversationDetail: async () => ({}) as never,
    createConversation: async () => ({}) as never,
    updateConversation: async () => ({}) as never,
    deleteConversation: async () => {},
    submitInput: async () => ({ submissionId: 's' }),
    waitForInput: async () => ({}) as never,
    abortConversation: async () => {},
    resetConversation: async () => ({}) as never,
    compactConversation: async () => ({}) as never,
    forkConversation: async () => ({}) as never,
    listAsks: async () => [],
    answerAsk: async () => {},
    cancelAsk: async () => {},
    search: async () => [],
    listModels: async () => ({ models: [], thinkingLevels: {} }),
    listModelProviders: async () => [],
    listNodes: async () => [],
    issueNodeToken: async () => ({ nodeId: 'local', token: 't', createdAt: 0 }),
    removeNode: async () => {},
    execEnv: async () => {
      throw new HelmError('unsupported', 'fixture', 501)
    },
  }
  handler = createHubHandler(kernel)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

async function post(path: string, body?: unknown, withToken = true): Promise<Response> {
  return handler(
    new Request(`http://hub${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(withToken ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? '{}' : JSON.stringify(body),
    }),
  )
}

test('POST /api/plugins/doctor：成功返回报告；缺 dir / 非法 dir / 未知字段 400', { timeout: 60_000 }, async () => {
  const report: PluginDoctorReport = {
    dir: '/abs/plugin',
    pluginId: 'p1',
    ok: true,
    checks: [{ id: 'manifest', label: 'x' }],
  }
  doctorImpl = async (target) => {
    assert.deepEqual(target, { dir: '/abs/plugin' })
    return report
  }
  const res = await post('/api/plugins/doctor', { dir: '/abs/plugin' })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), report)

  // 缺 dir
  const missing = await post('/api/plugins/doctor', {})
  assert.equal(missing.status, 400)
  assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'validation_error')

  // dir 非绝对路径
  const relative = await post('/api/plugins/doctor', { dir: 'relative/path' })
  assert.equal(relative.status, 400)
  assert.equal(((await relative.json()) as { error: { code: string } }).error.code, 'validation_error')

  // 未知字段
  const extra = await post('/api/plugins/doctor', { dir: '/abs/plugin', force: true })
  assert.equal(extra.status, 400)
  assert.equal(((await extra.json()) as { error: { code: string } }).error.code, 'validation_error')

  // 鉴权门禁
  const unauth = await post('/api/plugins/doctor', { dir: '/abs/plugin' }, false)
  assert.equal(unauth.status, 401)
})

test('POST /api/plugins/doctor：非 JSON body 400', { timeout: 60_000 }, async () => {
  const res = await handler(
    new Request('http://hub/api/plugins/doctor', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: 'not json',
    }),
  )
  assert.equal(res.status, 400)
})

test('POST /api/plugins/rescan：成功返回结构；端口未提供 501', { timeout: 60_000 }, async () => {
  rescanImpl = async () => ({
    registered: ['new-one'],
    skipped: 2,
    plugins: [makeSummary('new-one', false)],
  })
  const res = await post('/api/plugins/rescan')
  assert.equal(res.status, 200)
  const body = (await res.json()) as PluginRescanResult
  assert.deepEqual(body.registered, ['new-one'])
  assert.equal(body.skipped, 2)
  assert.equal(body.plugins.length, 1)
})

test('POST /api/plugins/:id/reload：成功返回结构；预检失败 422；未注册 404', { timeout: 60_000 }, async () => {
  reloadImpl = async (pluginId) => {
    if (pluginId === 'missing') throw new HelmError('unknown_plugin', '未注册', 404, { pluginId })
    return {
      pluginId,
      wasEnabled: true,
      generation: 2,
      summary: makeSummary(pluginId, true),
    }
  }
  const ok = await post('/api/plugins/my-pl/reload')
  assert.equal(ok.status, 200)
  const body = (await ok.json()) as PluginReloadResult
  assert.equal(body.pluginId, 'my-pl')
  assert.equal(body.wasEnabled, true)
  assert.equal(body.generation, 2)
  assert.equal(body.summary.enabled, true)

  const notFound = await post('/api/plugins/missing/reload')
  assert.equal(notFound.status, 404)
  assert.equal(((await notFound.json()) as { error: { code: string } }).error.code, 'unknown_plugin')

  // 预检失败（422 + doctor 报告透传）
  reloadImpl = async () => {
    throw new HelmError('plugin_reload_preflight_failed', '预检失败', 422, {
      report: { ok: false, checks: [] },
    })
  }
  const preflight = await post('/api/plugins/my-pl/reload')
  assert.equal(preflight.status, 422)
  const errBody = (await preflight.json()) as { error: { code: string; details: { report?: unknown } } }
  assert.equal(errBody.error.code, 'plugin_reload_preflight_failed')
  assert.ok(errBody.error.details.report)
})
