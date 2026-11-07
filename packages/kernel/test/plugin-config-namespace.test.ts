import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHelm } from '../src/app.js'
import { createHubHandler } from '../src/http/hub.js'
import { CredentialService } from '../src/services/credentials.js'

// 动态凭据与 configSchema secret 共用 credentials.json，但只有声明的配置可出站。
test('插件配置 HTTP 在重启和停用时均隐藏动态凭据，并保留已声明配置的脱敏', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-config-namespace-'))
  const pluginId = 'test:dynamic-credentials'
  const dynamicSecret = 'dynamic-hook-signing-key-7e4a'
  const configSecret = 'declared-config-key-94b2'
  const credentials = new CredentialService(dataDir)
  await credentials.setPluginSecret(pluginId, 'webhook:demo', dynamicSecret)
  await credentials.setPluginSecret(pluginId, 'apiKey', configSecret)
  let app: Awaited<ReturnType<typeof createHelm>> | undefined
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      app = await createHelm({ dataDir, cwd: dataDir, watchdogIntervalMs: 0 })
      await app.kernel.plugins.register({
        id: pluginId,
        definePlugin(ctx) {
          ctx.configSchema({
            apiKey: { type: 'string', secret: true },
            retries: { type: 'number', default: 3 },
          })
        },
      }, { enabled: false })
      const credential = app.kernel.auth.createProcessToken()
      try {
        const handler = createHubHandler(app.kernel, app.workflows)
        const response = await handler(new Request(`http://localhost/api/plugins/${encodeURIComponent(pluginId)}/config`, {
          headers: { authorization: `Bearer ${credential.token}` },
        }))
        assert.equal(response.status, 200)
        const body = await response.text()
        assert.ok(!body.includes(dynamicSecret), '停用插件的动态密钥不得经配置接口泄漏')
        assert.ok(!body.includes('webhook:demo'), '动态密钥不应成为公开配置字段')
        assert.ok(!body.includes(configSecret), '声明的 secret 必须掩码')
        const parsed = JSON.parse(body) as { values: Record<string, unknown> }
        assert.equal(parsed.values.apiKey, '******')
        assert.equal(Object.hasOwn(parsed.values, 'webhook:demo'), false)
      } finally {
        credential.dispose()
      }
      await app.close()
      app = undefined
    }
  } finally {
    await app?.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
