import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHelm } from '../src/app.js'
import { startHub } from '../src/http/index.js'
import { runCli } from '../../cli/src/index.js'

// 真实 app / HTTP / CLI / PluginHost；唯一受控边界是本地 Magpie HTTP 服务。
async function gatewayFixture() {
  let failCatalog = false
  const token = 'fixture-magpie-integration-key'
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end(JSON.stringify({ error: 'fixture authentication required' }))
      return
    }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/v1/models') {
      if (failCatalog) {
        res.writeHead(503).end(JSON.stringify({ error: 'fixture gateway unavailable' }))
        return
      }
      res.end(JSON.stringify({ data: [
        { id: 'fixture/responses', native_endpoints: ['/v1/responses'], context_length: 200000, max_output_tokens: 8192 },
        { id: 'anthropic/claude-sonnet-4-6', native_endpoints: ['/v1/messages'], reasoning: true },
        { id: 'group/fixture-smart', native_endpoints: ['/v1/chat/completions'] },
      ] }))
      return
    }
    if (req.url?.startsWith('/v1/magpie/quotas')) { res.end(JSON.stringify({ data: [] })); return }
    if (req.url === '/v1/magpie/trace') { res.end(JSON.stringify({ routes: [] })); return }
    res.writeHead(404).end(JSON.stringify({ error: 'fixture route absent' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    root: `http://127.0.0.1:${address.port}`, token, requests,
    fail: () => { failCatalog = true },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }
}

test('Magpie 默认停用：插件配置可发现，供应商、动作与 UI 不注册', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-magpie-default-'))
  const app = await createHelm({ dataDir, cwd: dataDir, watchdogIntervalMs: 0 })
  try {
    const plugin = app.kernel.plugins.list().find((item) => item.id === 'builtin:magpie')
    assert.ok(plugin)
    assert.equal(plugin.enabled, false)
    assert.ok(!app.kernel.listModelProviders().some((provider) => provider.id === 'magpie'))
    assert.ok(!app.kernel.plugins.listUi().some((item) => item.pluginId === plugin.id))
    assert.ok(!app.kernel.plugins.listActions().some((item) => item.pluginId === plugin.id))
    assert.equal(app.kernel.plugins.getConfigSchema(plugin.id).apiKey?.secret, true)
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('Magpie 经真实组合层注册、刷新、HTTP/CLI、缓存重启与停用；密钥不出站', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-magpie-app-'))
  const gateway = await gatewayFixture()
  let app: Awaited<ReturnType<typeof createHelm>> | undefined
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  let releaseCredential: (() => void) | undefined
  try {
    app = await createHelm({ dataDir, cwd: dataDir, watchdogIntervalMs: 0 })
    await app.kernel.plugins.setConfig('builtin:magpie', { gatewayUrl: gateway.root, apiKey: gateway.token })
    assert.equal(gateway.requests.length, 0, '配置停用插件不应连接网关')
    await app.kernel.plugins.enable('builtin:magpie')
    await app.kernel.plugins.invokeAction('builtin:magpie', 'refresh', {})
    const summary = app.kernel.listModelProviders().find((provider) => provider.id === 'magpie')
    assert.ok(summary)
    assert.equal(summary.pluginId, 'builtin:magpie')
    assert.equal(summary.dynamic, true)
    assert.equal(summary.modelCount, 3)
    assert.deepEqual((await app.kernel.listModels()).filter((model) => model.provider === 'magpie').map((model) => model.modelId).sort(), [
      'anthropic/claude-sonnet-4-6', 'fixture/responses', 'group/fixture-smart',
    ])
    assert.ok((await app.kernel.listModels()).filter((model) => model.provider === 'magpie').every((model) => model.available))
    assert.ok(app.kernel.plugins.listUi().some((item) => item.pluginId === 'builtin:magpie' && item.surface === 'settings.panel'))
    assert.ok(app.kernel.plugins.listUi().some((item) => item.pluginId === 'builtin:magpie' && item.surface === 'composer.pill'))

    hub = await startHub({ kernel: app.kernel, workflows: app.workflows, port: 0 })
    const credential = app.kernel.auth.createProcessToken()
    releaseCredential = credential.dispose
    const env = { HELM_HUB_URL: hub.url, HELM_DATA_DIR: join(dataDir, 'cli'), HELM_TOKEN: credential.token, HELM_CONVERSATION_ID: '1' }
    async function cli(args: string[]) {
      let out = '', err = ''
      const code = await runCli([...args, '--json'], { env, stdout: (text) => { out += text }, stderr: (text) => { err += text } })
      assert.equal(code, 0, err)
      assert.ok(!(out + err).includes(gateway.token), 'CLI 不得泄漏网关密钥')
      return JSON.parse(out)
    }
    const status = await cli(['magpie', 'status', '--current'])
    assert.equal(status.gatewayUrl, gateway.root)
    assert.equal(status.reachable, true)
    await cli(['models', 'refresh', '--provider', 'magpie'])
    const config = await cli(['plugins', 'config', 'builtin:magpie'])
    assert.equal(config.values.apiKey, '******')
    const catalog = await cli(['models', 'providers'])
    assert.equal(catalog.find((provider: { id: string }) => provider.id === 'magpie')?.pluginId, 'builtin:magpie')
    assert.equal((await stat(join(dataDir, 'credentials.json'))).mode & 0o777, 0o600)
    assert.ok(!(await readFile(join(dataDir, 'models-store.json'), 'utf8')).includes(gateway.token))

    // 凭据/静态供应商热重建不能遗失插件注册的动态供应商。
    await app.kernel.credentials.set('fixture-unused', 'fixture-other-key')
    await app.kernel.reloadModels()
    assert.equal(app.kernel.listModelProviders().find((provider) => provider.id === 'magpie')?.modelCount, 3)
    const events: string[] = []
    const off = app.kernel.events.subscribe((frame) => { events.push(frame.event.type) })
    gateway.fail()
    const failed = await app.kernel.refreshModels({ providers: ['magpie'] })
    off()
    assert.match(failed.errors.magpie ?? '', /fixture gateway unavailable|503/)
    assert.ok(events.includes('models.changed'), 'CLI/后台刷新必须通知 Web 更新目录')
    assert.equal(failed.providerCatalog.find((provider) => provider.id === 'magpie')?.modelCount, 3, '刷新失败保留上次已知目录')

    await hub.close(); hub = undefined
    releaseCredential(); releaseCredential = undefined
    await app.close(); app = undefined
    app = await createHelm({ dataDir, cwd: dataDir, watchdogIntervalMs: 0 })
    assert.equal(app.kernel.plugins.list().find((plugin) => plugin.id === 'builtin:magpie')?.enabled, true)
    assert.equal(app.kernel.listModelProviders().find((provider) => provider.id === 'magpie')?.modelCount, 3, '重启离线恢复目录')
    // 等待本周期目录刷新终态，再检查闲置插件的正常停用路径。
    await app.kernel.refreshModels({ providers: ['magpie'] })
    await app.kernel.plugins.disable('builtin:magpie')
    assert.ok(!app.kernel.listModelProviders().some((provider) => provider.id === 'magpie'))
    assert.ok(!(await app.kernel.listModels()).some((model) => model.provider === 'magpie'))
    assert.ok(!app.kernel.plugins.listUi().some((item) => item.pluginId === 'builtin:magpie'))
  } finally {
    await hub?.close()
    releaseCredential?.()
    await app?.close()
    await gateway.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
