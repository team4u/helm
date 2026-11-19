import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { createHelmx } from '../../hub/src/app.js'
import { startHub } from '../../kernel/src/http/index.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { runCli } from '../../cli/src/index.js'
import { makeFauxProvider } from './helpers/plugin-test-env.js'

// 真实 app / HTTP / CLI / PluginHost；唯一受控边界是本地 Magpie HTTP 服务。
async function gatewayFixture() {
  let failCatalog = false
  const token = 'fixture-magpie-integration-key'
  const requests: string[] = []
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://fixture').pathname
    requests.push(path)
    if (req.headers.authorization !== `Bearer ${token}` && req.headers['x-api-key'] !== token) {
      res.writeHead(401).end(JSON.stringify({ error: 'fixture authentication required' }))
      return
    }
    res.setHeader('content-type', 'application/json')
    if (path === '/v1/models') {
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
    if (req.method === 'POST') {
      res.setHeader('content-type', 'text/event-stream')
      const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      if (path === '/v1/chat/completions') {
        res.write(`data: ${JSON.stringify({ id: 'fixture-chat', choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture chat reply' }, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ id: 'fixture-chat', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      if (path === '/v1/responses') {
        const item = { id: 'fixture-message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture responses reply', annotations: [] }] }
        send('response.created', { response: { id: 'fixture-response', status: 'in_progress', output: [] } })
        send('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
        send('response.content_part.added', { output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
        send('response.output_text.delta', { output_index: 0, content_index: 0, delta: 'fixture responses reply' })
        send('response.output_item.done', { output_index: 0, item })
        send('response.completed', { response: { id: 'fixture-response', status: 'completed', output: [item], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } })
        res.end()
        return
      }
      if (path === '/v1/messages') {
        send('message_start', { message: { id: 'fixture-anthropic', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } })
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'fixture anthropic reply' } })
        send('content_block_stop', { index: 0 })
        send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } })
        send('message_stop', {})
        res.end()
        return
      }
    }
    if (path === '/v1/magpie/quotas') { res.end(JSON.stringify({ data: [] })); return }
    if (path === '/v1/magpie/trace') { res.end(JSON.stringify({ routes: [] })); return }
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

test('Magpie 默认启用：启动即注册 provider、actions 与 settings.panel / commandPalette UI，且与 KernelRuntimeOptions.providers 共存', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helmx-magpie-default-'))
  const faux = makeFauxProvider()
  const app = await createHelmx({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    providers: [faux.provider],
  })
  try {
    const plugin = app.kernel.plugins.list().find((item) => item.id === 'builtin:magpie')
    assert.ok(plugin)
    assert.equal(plugin.enabled, true)

    const providers = app.kernel.listModelProviders()
    const magpie = providers.find((provider) => provider.id === 'magpie')
    assert.ok(magpie)
    assert.equal(magpie.pluginId, 'builtin:magpie')
    assert.equal(magpie.dynamic, true)
    assert.ok(providers.some((provider) => provider.id === 'faux'))

    const actions = app.kernel.plugins
      .listActions()
      .filter((action) => action.pluginId === plugin.id)
      .map((action) => action.id)
      .sort()
    assert.deepEqual(actions, ['group', 'groups', 'quota', 'refresh', 'status'])

    const ui = app.kernel.plugins.listUi().filter((item) => item.pluginId === plugin.id)
    assert.ok(ui.some((item) => item.surface === 'settings.panel'))
    assert.ok(ui.some((item) => item.surface === 'commandPalette'))
    assert.equal(app.kernel.plugins.getConfigSchema(plugin.id).apiKey?.secret, true)
  } finally {
    await app.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('Magpie 经真实组合层默认启用→配置切换→刷新/HTTP/CLI→缓存重启→停用→重启用；密钥不出站', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helmx-magpie-app-'))
  const gateway = await gatewayFixture()
  const gateway2 = await gatewayFixture()
  let app: Awaited<ReturnType<typeof createHelmx>> | undefined
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  let releaseCredential: (() => void) | undefined
  try {
    app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir, cwd: dataDir })
    assert.equal(app.kernel.plugins.list().find((plugin) => plugin.id === 'builtin:magpie')?.enabled, true)
    await app.kernel.plugins.setConfig('builtin:magpie', { gatewayUrl: gateway.root, apiKey: gateway.token })
    await app.kernel.plugins.invokeAction('builtin:magpie', 'refresh', {})
    const summary = app.kernel.listModelProviders().find((provider) => provider.id === 'magpie')
    assert.ok(summary)
    assert.equal(summary.pluginId, 'builtin:magpie')
    assert.equal(summary.dynamic, true)
    assert.equal(summary.modelCount, 3)
    assert.deepEqual((await app.kernel.listModels()).models.filter((model) => model.provider === 'magpie').map((model) => model.modelId).sort(), [
      'anthropic/claude-sonnet-4-6', 'fixture/responses', 'group/fixture-smart',
    ])
    assert.ok((await app.kernel.listModels()).models.filter((model) => model.provider === 'magpie').every((model) => model.available))
    assert.ok(app.kernel.plugins.listUi().some((item) => item.pluginId === 'builtin:magpie' && item.surface === 'settings.panel'))
    assert.ok(!app.kernel.plugins.listUi().some((item) => item.pluginId === 'builtin:magpie' && item.surface === 'composer.pill'), 'magpie 不再向 composer 注册占位胶囊')

    // 使用真实 Harness 与 SDK 发起三种原生协议请求，响应只来自受控本地网关。
    for (const [model, text, path] of [
      ['group/fixture-smart', 'fixture chat reply', '/v1/chat/completions'],
      ['fixture/responses', 'fixture responses reply', '/v1/responses'],
      ['anthropic/claude-sonnet-4-6', 'fixture anthropic reply', '/v1/messages'],
    ] as const) {
      await app.kernel.updateConversation(1, { model: `magpie/${model}` })
      await app.kernel.submitInput(1, '受控协议验收')
      await app.kernel.waitForIdle(1)
      const detail = await app.kernel.getConversationDetail(1, { limit: 100 })
      const answer = [...detail.entries].reverse().find((entry) => entry.kind === 'pi.assistant')
      assert.ok(JSON.stringify(answer).includes(text), `原生请求 ${path} 应完成回答：${JSON.stringify(answer)}`)
      assert.ok(gateway.requests.includes(path), `应请求精确协议路径 ${path}`)
    }

    hub = await startHub({ kernel: app.kernel, port: 0 })
    const credential = app.kernel.auth.createProcessToken()
    releaseCredential = credential.dispose
    const env = { HELMX_HUB_URL: hub.url, HELMX_DATA_DIR: join(dataDir, 'cli'), HELMX_TOKEN: credential.token, HELMX_CONVERSATION_ID: '1' }
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
    // Windows 无 POSIX mode（NTFS 走 ACL），跳过 0600 模式位断言。
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(dataDir, 'credentials.json'))).mode & 0o777, 0o600)
    }
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
    app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir, cwd: dataDir })
    assert.equal(app.kernel.plugins.list().find((plugin) => plugin.id === 'builtin:magpie')?.enabled, true)
    assert.equal(app.kernel.listModelProviders().find((provider) => provider.id === 'magpie')?.modelCount, 3, '重启离线恢复目录')
    // 等待本周期目录刷新终态，再检查停用、停用期配置切换不连网关、以及重启用恢复路径。
    await app.kernel.refreshModels({ providers: ['magpie'] })
    // 会话 #1 曾使用 magpie/* 模型（conversation_model 占用）：知情后 force 停用。
    await app.kernel.plugins.disable('builtin:magpie', { force: true })
    assert.ok(!app.kernel.listModelProviders().some((provider) => provider.id === 'magpie'))
    assert.ok(!(await app.kernel.listModels()).models.some((model) => model.provider === 'magpie'))
    assert.ok(!app.kernel.plugins.listUi().some((item) => item.pluginId === 'builtin:magpie'))
    assert.ok(!app.kernel.plugins.listActions().some((action) => action.pluginId === 'builtin:magpie'))

    // 停用状态下切换配置不得连接新网关
    await app.kernel.plugins.setConfig('builtin:magpie', { gatewayUrl: gateway2.root, apiKey: gateway2.token })
    assert.equal(gateway2.requests.length, 0, '配置停用插件不应连接网关')

    // 重启用：恢复 provider、动作与 UI，并从新网关刷新目录
    await app.kernel.plugins.enable('builtin:magpie')
    await app.kernel.plugins.invokeAction('builtin:magpie', 'refresh', {})
    const reenabled = app.kernel.listModelProviders().find((provider) => provider.id === 'magpie')
    assert.ok(reenabled)
    assert.equal(reenabled.modelCount, 3)
    assert.ok(gateway2.requests.includes('/v1/models'))
    assert.ok(app.kernel.plugins.listUi().some((item) => item.pluginId === 'builtin:magpie' && item.surface === 'settings.panel'))
    assert.ok(app.kernel.plugins.listActions().some((action) => action.pluginId === 'builtin:magpie' && action.id === 'refresh'))
  } finally {
    await hub?.close()
    releaseCredential?.()
    await app?.close()
    await gateway2.close()
    await gateway.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
