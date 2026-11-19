/**
 * Herdr 跨机附件诚实门禁与 [Attached Files] 注入测试：
 * - 远端机器未配置可达 HELMX_HUB_URL 且携带附件：remote_hub_unreachable_for_artifacts 且零建窗；
 * - 远端 Profile 显式配置可达 HELMX_HUB_URL 或节点通道提供可达 hubUrl：门禁通过并注入回连；
 * - 本机窗格携带附件：注入本机 path 与拉取命令；getArtifact 未注入时退化裸 ID（不伪造）。
 */
import test, { after, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { HelmxError } from '@helmx/protocol'
import {
  HerdrFakeBackend,
  openHerdrUnitEnv,
  scriptHerdrSuccess,
  spawnHerdrDirect,
  type HerdrUnitEnv,
} from './helpers/herdr-unit-fixture.js'

describe('herdr 跨机附件诚实门禁与提示词注入', () => {
  let plainEnv: HerdrUnitEnv
  let artifactEnv: HerdrUnitEnv
  const artifactLookups: Array<{ id: string; conversationId: number }> = []

  before(async () => {
    plainEnv = await openHerdrUnitEnv({ hubUrls: {} })
    const backend = new HerdrFakeBackend()
    backend.getArtifactImpl = async (id, conversationId) => {
      artifactLookups.push({ id, conversationId })
      return {
        id,
        name: 'spec.md',
        mimeType: 'text/markdown',
        size: 42,
        absPath: `/data/artifacts/1/${id}-spec.md`,
      }
    }
    artifactEnv = await openHerdrUnitEnv({
      backend,
      hubUrls: {
        'build-01': 'http://10.0.0.7:3202',
        'build-02': 'http://127.0.0.1:3202',
        'build-bad': 'file:///not-a-hub',
        'build-03': 'http://10.0.0.7:3202',
      },
    })
  })

  after(async () => {
    await Promise.all([plainEnv?.close(), artifactEnv?.close()])
  })

  test('远端未配置可达 HELMX_HUB_URL（前缀 / Profile / resume）均显式拒绝且零建窗', { timeout: 60_000 }, async () => {
    plainEnv.transport.calls.length = 0
    await assert.rejects(
      spawnHerdrDirect(plainEnv, {
        agentType: 'herdr:agy@remote-node',
        attachments: ['art-id-1', 'art-id-2'],
      }),
      (err: unknown) => {
        assert.ok(err instanceof HelmxError)
        assert.equal(err.code, 'remote_hub_unreachable_for_artifacts')
        assert.equal(err.status, 400)
        assert.ok(err.message.includes('remote-node'))
        assert.ok(err.message.includes('HELMX_HUB_URL'))
        const details = err.details as { nodeId: string; attachments: string[] }
        assert.equal(details.nodeId, 'remote-node')
        assert.deepEqual(details.attachments, ['art-id-1', 'art-id-2'])
        return true
      },
    )
    plainEnv.profiles.set('far-broken', {
      id: 'far-broken',
      runtime: { kind: 'herdr', agent: 'agy', nodeId: 'remote-node' },
    })
    await assert.rejects(
      spawnHerdrDirect(plainEnv, { agentType: 'far-broken', attachments: ['a1'] }),
      (err: unknown) => err instanceof HelmxError && err.code === 'remote_hub_unreachable_for_artifacts',
    )
    for (const method of ['tab.create', 'worktree.create', 'agent.start', 'agent.prompt']) {
      assert.equal(plainEnv.transport.calls.filter((c) => c.method === method).length, 0)
    }

    // resume 远端窗格在撤销可达 HELMX_HUB_URL 后携带附件同样拒绝。
    plainEnv.profiles.set('far-resume', {
      id: 'far-resume',
      runtime: { kind: 'herdr', agent: 'agy', nodeId: 'remote-node', env: { HELMX_HUB_URL: 'http://10.0.0.5:3202' } },
    })
    scriptHerdrSuccess(plainEnv, 'first-ok')
    await spawnHerdrDirect(plainEnv, { agentType: 'far-resume' })
    const paneId = [...plainEnv.transport.panes.keys()].at(-1)!
    plainEnv.profiles.set('far-resume', {
      id: 'far-resume',
      runtime: { kind: 'herdr', agent: 'agy', nodeId: 'remote-node' },
    })
    await assert.rejects(
      spawnHerdrDirect(plainEnv, { agentType: 'far-resume', resume: paneId, attachments: ['resume-art'] }),
      (err: unknown) => err instanceof HelmxError && err.code === 'remote_hub_unreachable_for_artifacts',
    )
  })

  test('getArtifact 未注入退化用裸 ID（不伪造元数据）；无附件时不注入 [Attached Files]', { timeout: 60_000 }, async () => {
    scriptHerdrSuccess(plainEnv, 'bare-ok')
    assert.equal(await spawnHerdrDirect(plainEnv, { agentType: 'herdr:agy', attachments: ['bare-id-7'] }), 'bare-ok')
    const barePrompt = plainEnv.transport.calls.findLast((c) => c.method === 'agent.prompt')!.params['text'] as string
    assert.ok(barePrompt.includes('[Attached Files]'))
    assert.ok(barePrompt.includes('id=bare-id-7'))
    assert.ok(!barePrompt.includes('spec.md'))

    scriptHerdrSuccess(plainEnv, 'plain-ok')
    assert.equal(await spawnHerdrDirect(plainEnv, { agentType: 'herdr:agy' }), 'plain-ok')
    const plainPrompt = plainEnv.transport.calls.findLast((c) => c.method === 'agent.prompt')!.params['text'] as string
    assert.ok(!plainPrompt.includes('[Attached Files]'))
  })

  test('远端可达 HELMX_HUB_URL 与本机窗格：注入拉取指引、本机 path 与正确段落顺序', { timeout: 60_000 }, async () => {
    artifactLookups.length = 0
    artifactEnv.profiles.set('far', {
      id: 'far',
      runtime: { kind: 'herdr', agent: 'agy', nodeId: 'remote-node', env: { HELMX_HUB_URL: 'http://10.0.0.5:3202' } },
    })
    scriptHerdrSuccess(artifactEnv, 'remote-ok')
    assert.equal(await spawnHerdrDirect(artifactEnv, { agentType: 'far', attachments: ['art-id-1'] }), 'remote-ok')
    assert.deepEqual(artifactLookups, [{ id: 'art-id-1', conversationId: 1 }])
    const remotePrompt = artifactEnv.transport.calls.findLast((c) => c.method === 'agent.prompt')!.params['text'] as string
    assert.ok(remotePrompt.includes('[Attached Files]'))
    assert.ok(remotePrompt.includes('id=art-id-1'))
    assert.ok(remotePrompt.includes('helmx artifacts get art-id-1'))
    assert.ok(remotePrompt.indexOf('[Attached Files]') < remotePrompt.indexOf('--- helmx handoff contract'))

    scriptHerdrSuccess(artifactEnv, 'local-ok')
    assert.equal(await spawnHerdrDirect(artifactEnv, { agentType: 'herdr:agy', attachments: ['art-local-9'] }), 'local-ok')
    const localPrompt = artifactEnv.transport.calls.findLast((c) => c.method === 'agent.prompt')!.params['text'] as string
    assert.ok(localPrompt.includes('spec.md'))
    assert.ok(localPrompt.includes('path=/data/artifacts/1/'))
    assert.ok(localPrompt.includes('helmx artifacts get art-local-9 --output ./spec.md'))
  })

  test('节点通道 hubUrl：可达/loopback 自动放行并注入回连，非法 URL 拒绝，Profile 显式 URL 优先', { timeout: 60_000 }, async () => {
    scriptHerdrSuccess(artifactEnv, 'hub-ok')
    assert.equal(await spawnHerdrDirect(artifactEnv, { agentType: 'herdr:agy@build-01', attachments: ['art-x'] }), 'hub-ok')
    const env01 = artifactEnv.transport.calls.findLast((c) => c.method === 'tab.create')!.params['env'] as Record<string, string>
    assert.equal(env01['HELMX_HUB_URL'], 'http://10.0.0.7:3202')
    assert.equal(env01['HELMX_TOKEN'], 'SECRET-TOKEN')

    scriptHerdrSuccess(artifactEnv, 'node-loopback-ok')
    assert.equal(await spawnHerdrDirect(artifactEnv, { agentType: 'herdr:agy@build-02', attachments: ['art-x'] }), 'node-loopback-ok')
    const env02 = artifactEnv.transport.calls.findLast((c) => c.method === 'tab.create')!.params['env'] as Record<string, string>
    assert.equal(env02['HELMX_HUB_URL'], 'http://127.0.0.1:3202')
    assert.equal(env02['HELMX_TOKEN'], 'SECRET-TOKEN')

    const beforeBad = artifactEnv.transport.calls.filter((c) => c.method === 'tab.create').length
    await assert.rejects(
      spawnHerdrDirect(artifactEnv, { agentType: 'herdr:agy@build-bad', attachments: ['a1'] }),
      (err: unknown) => (err as HelmxError).code === 'remote_hub_unreachable_for_artifacts',
    )
    assert.equal(artifactEnv.transport.calls.filter((c) => c.method === 'tab.create').length, beforeBad)

    artifactEnv.profiles.set('explicit-url', {
      id: 'explicit-url',
      runtime: { kind: 'herdr', agent: 'agy', nodeId: 'build-03', env: { HELMX_HUB_URL: 'http://10.9.9.9:3202' } },
    })
    scriptHerdrSuccess(artifactEnv, 'explicit-ok')
    await spawnHerdrDirect(artifactEnv, { agentType: 'explicit-url' })
    const env03 = artifactEnv.transport.calls.findLast((c) => c.method === 'tab.create')!.params['env'] as Record<string, string>
    assert.equal(env03['HELMX_HUB_URL'], 'http://10.9.9.9:3202')
  })
})
