import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { createModels } from '@earendil-works/pi-ai'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { KernelRuntime } from '../src/runtime/index.js'
import { CredentialService } from '../src/services/credentials.js'

test('外部注入模型集在目录与热重载中保持调用方所有权', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-external-providers-'))
  const models = createModels()
  models.setProvider(fauxProvider({ models: [{ id: 'fixture-external' }] }).provider)
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, models, autoResume: false })
    const initial = await kernel.listModels()
    await kernel.credentials.set('deepseek', 'fixture-unused')
    await kernel.reloadModels()
    assert.deepEqual(await kernel.listModels(), initial)
    assert.deepEqual(kernel.listModelProviders().map((provider) => provider.id), ['faux'])
  } finally {
    await kernel?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('全量供应商启动加载、增删密钥热更新与读取失败不静默降级', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-provider-registry-'))
  const previousEnv = process.env['DEEPSEEK_API_KEY']
  delete process.env['DEEPSEEK_API_KEY']
  const credentials = new CredentialService(dataDir)
  await credentials.set('deepseek', 'fixture-deepseek-startup')
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
    assert.equal(kernel.listModelProviders().length, builtinProviders().length)
    const entries = () => kernel!.listModels().then((catalog) => catalog.filter((entry) => entry.provider === 'deepseek'))
    const initial = await entries()
    assert.ok(initial.length > 0)
    assert.ok(initial.every((entry) => entry.available), '非 OpenAI/Anthropic 的凭据也必须在启动时加载')

    await credentials.delete('deepseek')
    await kernel.reloadModels()
    assert.ok((await entries()).every((entry) => !entry.available), '删除密钥不能继续复用旧缓存')

    await credentials.set('deepseek', 'fixture-deepseek-reloaded')
    await kernel.reloadModels()
    assert.ok((await entries()).every((entry) => entry.available), '新增内置供应商密钥无需 providers.json 条目')

    const path = join(dataDir, 'credentials.json')
    const validStore = await readFile(path, 'utf8')
    try {
      await writeFile(path, '{invalid-json')
      await assert.rejects(() => kernel!.reloadModels(), /JSON|解析|非法/)
      assert.ok((await entries()).every((entry) => entry.available), '读取失败不应发布半成品或把模型静默标记为不可用')
    } finally { await writeFile(path, validStore) }
  } finally {
    await kernel?.close()
    if (previousEnv === undefined) delete process.env['DEEPSEEK_API_KEY']
    else process.env['DEEPSEEK_API_KEY'] = previousEnv
    await rm(dataDir, { recursive: true, force: true })
  }
})
