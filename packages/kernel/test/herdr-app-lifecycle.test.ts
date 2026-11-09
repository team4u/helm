import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createHelm } from '../src/app.js'
import { startHub } from '../src/http/index.js'
import { runCli } from '../../cli/src/index.js'
import type { HerdrTarget, HerdrTransport } from '../src/builtin-plugins/herdr/contracts.js'

// 实际 app/PluginHost/配置落盘；传输 fixture 仅确认连接生命周期，不执行模型任务。
function connectionFixture() {
  const subscribed: HerdrTarget[] = []
  let released = 0
  const transport: HerdrTransport = {
    async subscribe(target) {
      subscribed.push(structuredClone(target))
      return () => { released++ }
    },
    async call(_target, method) {
      assert.equal(method, 'session.snapshot', `空会话不应调用 ${method}`)
      return { type: 'session_snapshot', snapshot: { agents: [], panes: [], tabs: [], workspaces: [] } }
    },
    async readOutput() { throw new Error('空会话不应读取交接文件') },
    async removeOutput() { throw new Error('空会话不应删除交接文件') },
    async runGate() { throw new Error('空会话不应执行 Gate') },
  }
  return { transport, subscribed, releases: () => released }
}

async function openApp(dataDir: string, transport?: HerdrTransport) {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  return createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, herdrTransport: transport })
}

test('createHelm 默认注册停用 Herdr，普通启动及原生回退不依赖终端服务', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-herdr-app-default-'))
  const app = await openApp(dir)
  try {
    const herdr = app.kernel.plugins.list().find((plugin) => plugin.id === 'builtin:herdr')
    assert.ok(herdr)
    assert.equal(herdr.enabled, false)
    assert.ok(!app.kernel.plugins.listUi().some((item) => item.pluginId === 'builtin:herdr'))
    assert.equal(app.kernel.getConversation(1).profileId, 'assistant')
    assert.ok(!app.kernel.plugins.listActions().some((action) => action.pluginId === 'builtin:herdr'))
    await assert.rejects(
      app.kernel.spawnAgent({ parentConversationId: 1, agentType: 'herdr:pi', prompt: '尚未启用' }),
      { code: 'unsupported_runtime' },
    )
    await assert.rejects(app.kernel.plugins.invokeAction('builtin:herdr', 'list', {}), { code: 'plugin_disabled' })
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createHelm 先配置后启用，重启沿用开关与连接配置，停用后重启不连接', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-herdr-app-persist-'))
  const fixture = connectionFixture()
  let app: Awaited<ReturnType<typeof createHelm>> | undefined
  try {
    app = await openApp(dir, fixture.transport)
    assert.equal(fixture.subscribed.length, 0, '默认停用时不得连接')
    const socketPath = join(dir, 'controlled-herdr.sock')
    await app.kernel.plugins.setConfig('builtin:herdr', { socketPath, startupTimeoutMs: 30_000 })
    assert.equal(fixture.subscribed.length, 0, '配置停用插件也不得连接')
    await app.kernel.plugins.enable('builtin:herdr')
    assert.equal(fixture.subscribed.length, 1)
    assert.equal(fixture.subscribed[0]?.socketPath, socketPath)
    assert.deepEqual(await app.kernel.plugins.invokeAction('builtin:herdr', 'list', {}), { panes: [] })
    assert.deepEqual(
      app.kernel.plugins.listActions().filter((action) => action.pluginId === 'builtin:herdr').map((action) => action.id).sort(),
      ['focus', 'list', 'read'],
    )
    const enabledConfig = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
    assert.equal(enabledConfig.pluginEnabled['builtin:herdr'], true)
    await app.close()
    app = undefined
    assert.equal(fixture.releases(), 1)

    app = await openApp(dir, fixture.transport)
    assert.equal(app.kernel.plugins.list().find((plugin) => plugin.id === 'builtin:herdr')?.enabled, true)
    const persisted = app.kernel.plugins.getConfig('builtin:herdr') as { socketPath?: string }
    assert.equal(persisted.socketPath, socketPath)
    assert.equal(fixture.subscribed.length, 2, '持久启用应在重启时连接一次')
    assert.equal(fixture.subscribed[1]?.socketPath, socketPath)
    await app.kernel.plugins.disable('builtin:herdr')
    assert.equal(fixture.releases(), 2)
    assert.ok(!app.kernel.plugins.listActions().some((action) => action.pluginId === 'builtin:herdr'))
    await app.close()
    app = undefined

    app = await openApp(dir, fixture.transport)
    assert.equal(app.kernel.plugins.list().find((plugin) => plugin.id === 'builtin:herdr')?.enabled, false)
    assert.equal(fixture.subscribed.length, 2, '持久停用后重启不得重新连接')
  } finally {
    await app?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Herdr 动作经真实 HTTP 自动映射 CLI，支持 --json 和 --current', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-herdr-cli-'))
  const fixture = connectionFixture()
  const app = await openApp(dir, fixture.transport)
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  const credential = app.kernel.auth.createProcessToken()
  try {
    hub = await startHub({ kernel: app.kernel, port: 0 })
    const env = {
      HELM_HUB_URL: hub.url,
      HELM_DATA_DIR: join(dir, 'cli'),
      HELM_TOKEN: credential.token,
      HELM_CONVERSATION_ID: '1',
    }
    async function cli(args: string[]) {
      let out = ''
      let err = ''
      const code = await runCli([...args, '--json'], {
        env,
        stdout: (text) => { out += text },
        stderr: (text) => { err += text },
      })
      assert.ok(!(out + err).includes(credential.token))
      return { code, out, err }
    }
    const socketPath = join(dir, 'controlled.sock')
    const configured = await cli(['plugins', 'config', 'builtin:herdr', '--input', JSON.stringify({ socketPath })])
    assert.equal(configured.code, 0, configured.err)
    assert.deepEqual(JSON.parse(configured.out), { ok: true })
    const configRead = await cli(['plugins', 'config', 'builtin:herdr'])
    assert.equal(configRead.code, 0, configRead.err)
    assert.equal(JSON.parse(configRead.out).values.socketPath, socketPath)
    assert.equal(fixture.subscribed.length, 0, 'CLI 配置也不能提前连接')

    const enabled = await cli(['plugins', 'enable', 'builtin:herdr'])
    assert.equal(enabled.code, 0, enabled.err)
    assert.equal(JSON.parse(enabled.out).find((plugin: { id: string }) => plugin.id === 'builtin:herdr').enabled, true)
    const listed = await cli(['herdr', 'list', '--current'])
    assert.equal(listed.code, 0, listed.err)
    assert.equal(listed.err, '')
    assert.deepEqual(JSON.parse(listed.out), { panes: [] })

    const missing = await cli(['herdr', 'read', '--pane-id', 'human-pane', '--current'])
    assert.notEqual(missing.code, 0)
    assert.equal(missing.out, '')
    assert.equal(JSON.parse(missing.err).error.code, 'not_found')
    assert.equal(fixture.subscribed.length, 1)
  } finally {
    credential.dispose()
    await hub?.close()
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
