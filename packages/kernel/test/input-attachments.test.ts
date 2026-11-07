/**
 * 模块二测试：消息多模态附件。
 * 真实 createHelm + faux provider + 真实 ArtifactService（真实文件落盘）：
 * - 授权：本会话产物可挂载；父会话产物允许子会话挂载；跨会话未授权 403
 *   artifact_forbidden；不存在 404；
 * - SQLite 零膨胀：helm.input entry 的 attachments 仅轻量指针（无 base64）；
 * - 多模态：图片附件构造 ImageContent 块进入模型请求（faux TranscriptContext
 *   捕获 user content 数组）；文本附件拼接 [Attached Files] 纯文本；
 * - input hook transform 改写 attachments 后同权校验（越权 403）；
 * - subagent attachments 透传：spawnAgent 前置授权校验 + 原生 spawn 注入
 *   [Attached Files] 块。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxProvider,
  fauxAssistantMessage,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'
import { HelmError, type PluginDefinition } from '@helm/protocol'
import { createHelm } from '../src/app.js'

interface Env {
  dataDir: string
  faux: ReturnType<typeof fauxProvider>
  app: Awaited<ReturnType<typeof createHelm>>
  /** 每次模型请求的完整消息（faux 官方 TranscriptContext 捕获）。 */
  requests: Array<{ userContents: unknown[] }>
  close(): Promise<void>
}

async function makeEnv(): Promise<Env> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-attach-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  const requests: Env['requests'] = []
  faux.setResponses([])
  return {
    dataDir,
    faux,
    app,
    requests,
    async close() {
      await app.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** capture 响应：记录 user content（区分 string 与多模态数组）。 */
function capture(env: Env): FauxResponseStep {
  return (context) => {
    env.requests.push({
      userContents: context.messages
        .filter((m) => m.role === 'user')
        .map((m) => (m as { content: unknown }).content),
    })
    return fauxAssistantMessage('收到附件')
  }
}

/** 1x1 PNG（合法图片字节）。 */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

/** 经真实上传路径创建产物（writeUploaded 走完整净化/落盘/登记）。 */
async function uploadArtifact(
  env: Env,
  conversationId: number,
  name: string,
  bytes: Uint8Array,
  mimeType?: string,
): Promise<string> {
  const meta = await env.app.kernel.artifacts.writeUploaded(conversationId, {
    name,
    bytes,
    ...(mimeType !== undefined ? { mimeType } : {}),
  })
  return meta.id
}

test('授权：本会话产物与父会话产物可挂载；跨会话未授权 403；不存在 404', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const parent = await env.app.kernel.createConversation({ title: '父会话' })
    const child = await env.app.kernel.createConversation({ title: '子会话', parentConversationId: parent.id })
    const other = await env.app.kernel.createConversation({ title: '无关会话' })

    const ownId = await uploadArtifact(env, child.id, 'own.txt', new TextEncoder().encode('own'))
    const parentId = await uploadArtifact(env, parent.id, 'parent.md', new TextEncoder().encode('parent'))
    const otherId = await uploadArtifact(env, other.id, 'other.txt', new TextEncoder().encode('other'))

    // 本会话产物：可解析。
    const own = await env.app.kernel.resolveAuthorizedAttachments(child.id, [ownId])
    assert.equal(own.length, 1)
    assert.equal(own[0]!.ref.name, 'own.txt')
    assert.equal(own[0]!.ref.size, 3)
    assert.ok(own[0]!.absPath.startsWith(env.dataDir), 'absPath 指向 dataDir 内')

    // 父会话产物：允许子会话挂载。
    const viaParent = await env.app.kernel.resolveAuthorizedAttachments(child.id, [parentId])
    assert.equal(viaParent.length, 1)
    assert.equal(viaParent[0]!.metadata.conversationId, parent.id)

    // 跨会话未授权：403 artifact_forbidden。
    await assert.rejects(
      env.app.kernel.resolveAuthorizedAttachments(child.id, [otherId]),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'artifact_forbidden')
        assert.equal(err.status, 403)
        const details = err.details as { conversationId: number; artifactId: string; artifactConversationId: number }
        assert.equal(details.conversationId, child.id)
        assert.equal(details.artifactConversationId, other.id)
        return true
      },
    )

    // 不存在：404 not_found。
    await assert.rejects(
      env.app.kernel.resolveAuthorizedAttachments(child.id, ['no-such-artifact-id']),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'not_found')
        assert.equal(err.status, 404)
        return true
      },
    )

    // 重复 ID 去重。
    const deduped = await env.app.kernel.resolveAuthorizedAttachments(child.id, [ownId, ownId])
    assert.equal(deduped.length, 1)
  } finally {
    await env.close()
  }
})

test('submitInput：文本附件拼 [Attached Files]；SQLite 零 base64 膨胀', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([capture(env)])
    const conv = await env.app.kernel.createConversation({ title: '文本附件' })
    const artId = await uploadArtifact(env, conv.id, 'notes.md', new TextEncoder().encode('# 内容'))
    await env.app.kernel.submitInput(conv.id, '请查阅附件', { attachments: [artId] })
    await env.app.kernel.waitForIdle(conv.id)

    // 模型请求：user content 含 [Attached Files] 清单。
    assert.equal(env.requests.length, 1)
    const content = env.requests[0]!.userContents.at(-1)
    assert.equal(typeof content, 'string', '无图片附件时保持纯文本')
    assert.ok((content as string).includes('请查阅附件'))
    assert.ok((content as string).includes('[Attached Files]'))
    assert.ok((content as string).includes(`id=${artId}`))
    assert.ok((content as string).includes(`helm artifacts get ${artId} --output ./notes.md`))

    // SQLite helm.input entry：attachments 仅轻量指针，绝无 base64。
    const detail = await env.app.kernel.getConversationDetail(conv.id)
    const inputEntry = detail.entries.find((e) => e.kind === 'helm.input')
    assert.ok(inputEntry !== undefined)
    const data = inputEntry.data as { attachments?: Array<{ id: string; name: string; mimeType: string; size: number }> }
    assert.ok(Array.isArray(data.attachments) && data.attachments.length === 1)
    assert.deepEqual(Object.keys(data.attachments[0]!).sort(), ['id', 'mimeType', 'name', 'size'])
    assert.equal(data.attachments[0]!.name, 'notes.md')
    const raw = JSON.stringify(inputEntry)
    assert.ok(!raw.includes('base64'), 'entry 不得含 base64 字段')
    assert.ok(!raw.includes('# 内容'), 'entry 不得携带产物字节内容')
  } finally {
    await env.close()
  }
})

test('submitInput：图片附件构造多模态 ImageContent（base64 data + mimeType）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([capture(env)])
    const conv = await env.app.kernel.createConversation({ title: '图片附件' })
    const pngId = await uploadArtifact(env, conv.id, 'shot.png', PNG_BYTES, 'image/png')
    const txtId = await uploadArtifact(env, conv.id, 'side.txt', new TextEncoder().encode('side'))
    await env.app.kernel.submitInput(conv.id, '看图', { attachments: [pngId, txtId] })
    await env.app.kernel.waitForIdle(conv.id)

    assert.equal(env.requests.length, 1)
    const content = env.requests[0]!.userContents.at(-1)
    assert.ok(Array.isArray(content), '图片附件时 user content 应为多模态数组')
    const blocks = content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
    const textBlock = blocks.find((b) => b.type === 'text')
    assert.ok(textBlock !== undefined)
    assert.ok(textBlock.text!.includes('[Attached Files]'))
    assert.ok(textBlock.text!.includes('side.txt'), '清单包含全部附件')
    const imageBlocks = blocks.filter((b) => b.type === 'image')
    assert.equal(imageBlocks.length, 1, '恰好一个图片块')
    assert.equal(imageBlocks[0]!.mimeType, 'image/png')
    assert.equal(imageBlocks[0]!.data, Buffer.from(PNG_BYTES).toString('base64'))
  } finally {
    await env.close()
  }
})

test('submitInput：跨会话未授权附件 403（不产生任何回合副作用）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const a = await env.app.kernel.createConversation({ title: 'A' })
    const b = await env.app.kernel.createConversation({ title: 'B' })
    const artId = await uploadArtifact(env, a.id, 'a.txt', new TextEncoder().encode('a'))
    await assert.rejects(
      env.app.kernel.submitInput(b.id, '越权挂载', { attachments: [artId] }),
      (err: unknown) => err instanceof HelmError && err.code === 'artifact_forbidden' && err.status === 403,
    )
  } finally {
    await env.close()
  }
})

test('submitInput：input hook transform 改写 attachments 后同权校验', { timeout: 60_000 }, async () => {
  // transform 插件：把 attachments 替换为另一个（越权的）产物 ID。
  const evil: PluginDefinition = {
    id: 'test:transform-attachments',
    async definePlugin(ctx) {
      ctx.hook.onInput((payload) => {
        if (payload.input.text === '触发改写') {
          return {
            action: 'transform',
            value: {
              ...payload,
              input: {
                ...payload.input,
                attachments: [
                  { id: 'foreign-artifact-id', name: 'x', mimeType: 'text/plain', size: 1 },
                ],
              },
            },
          }
        }
        return undefined
      })
    },
  }
  const env = await makeEnv()
  try {
    await env.app.kernel.plugins.register(evil)
    const conv = await env.app.kernel.createConversation({ title: 'transform' })
    await assert.rejects(
      env.app.kernel.submitInput(conv.id, '触发改写'),
      (err: unknown) => err instanceof HelmError && err.code === 'not_found' && err.status === 404,
      'transform 后的附件 ID 同样走存在性与授权校验（不存在即 404）',
    )
  } finally {
    await env.close()
  }
})

test('subagent attachments：spawnAgent 前置授权校验；原生 spawn 注入 [Attached Files]', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const parent = await env.app.kernel.createConversation({ title: '派生父' })
    const other = await env.app.kernel.createConversation({ title: '无关' })
    const otherArt = await uploadArtifact(env, other.id, 'foreign.bin', new Uint8Array([9]))

    // 越权：spawnAgent 在进入 hook 链之前即拒绝（不创建子会话）。
    const beforeCount = (await env.app.kernel.listConversations()).length
    await assert.rejects(
      env.app.kernel.spawnAgent({
        parentConversationId: parent.id,
        prompt: '越权任务',
        attachments: [otherArt],
      }),
      (err: unknown) => err instanceof HelmError && err.code === 'artifact_forbidden' && err.status === 403,
    )
    assert.equal((await env.app.kernel.listConversations()).length, beforeCount, '不产生子会话副作用')

    // 合法：原生 spawn 任务提示词注入 [Attached Files] 块（faux 捕获子会话请求）。
    const artId = await uploadArtifact(env, parent.id, 'spec.md', new TextEncoder().encode('spec-body'))
    env.faux.setResponses([capture(env)])
    const result = await env.app.kernel.spawnAgent({
      parentConversationId: parent.id,
      prompt: '按附件干活',
      attachments: [artId],
    })
    assert.equal(result, '收到附件')
    const childContent = env.requests[0]!.userContents.at(-1)
    assert.ok(typeof childContent === 'string')
    assert.ok((childContent as string).includes('[Attached Files]'))
    assert.ok((childContent as string).includes('按附件干活'))
    assert.ok((childContent as string).includes(`id=${artId}`))
  } finally {
    await env.close()
  }
})
