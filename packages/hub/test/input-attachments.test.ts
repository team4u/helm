/**
 * module two test: message multimodal attachment.
 * real createHelm + faux provider + real ArtifactService(real file):
 * - authorization: this conversation artifact can mount; parent conversation artifact allows sub-conversation mount; across conversation unauthorized 403
 *   artifact_forbidden; missing 404;
 * - SQLite zero expansion:helm.input entry  attachments only light amount pointer (without base64);
 * - multimodal: diagram piece attachment construct ImageContent chunk enter model request (faux TranscriptContext
 *   catch user content array); text attachment concatenate [Attached Files] pure text;
 * - input hook transform change write attachments after same right validate (exceeds right 403);
 * - subagent attachments pass-through:spawnAgent pre- authorization validate + original generate spawn inject
 *   [Attached Files] chunk.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fauxAssistantMessage,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'
import { HelmError, type PluginDefinition } from '@helm/protocol'
import { openHubTestEnv, type FauxProviderHandle, type HubTestApp } from './helpers/hub-test-env.js'

interface Env {
  dataDir: string
  faux: FauxProviderHandle
  app: HubTestApp
  /** each time model request complete message (faux official TranscriptContext catch). */
  requests: Array<{ userContents: unknown[] }>
  close(): Promise<void>
}

async function makeEnv(): Promise<Env> {
  const env = await openHubTestEnv({ prefix: 'helm-attach-', swallowCloseError: true })
  const requests: Env['requests'] = []
  env.faux.setResponses([])
  return {
    dataDir: env.dataDir,
    faux: env.faux,
    app: env.app,
    requests,
    close: env.close,
  }
}

/** capture response: record user content(zone string and multimodal array). */
function capture(env: Env): FauxResponseStep {
  return (context) => {
    env.requests.push({
      userContents: context.messages
        .filter((m) => m.role === 'user')
        .map((m) => (m as { content: unknown }).content),
    })
    return fauxAssistantMessage('receives attachment')
  }
}

/** 1x1 PNG(legal diagram piece byte). */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

/** via real upload path create artifact (writeUploaded away complete clean//register). */
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

test('authorization: this conversation artifact and parent conversation artifact can mount; across conversation unauthorized 403; missing 404', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const parent = await env.app.kernel.createConversation({ title: 'parent conversation' })
    const child = await env.app.kernel.createConversation({ title: 'sub-conversation', parentConversationId: parent.id })
    const other = await env.app.kernel.createConversation({ title: 'without closure conversation' })

    const ownId = await uploadArtifact(env, child.id, 'own.txt', new TextEncoder().encode('own'))
    const parentId = await uploadArtifact(env, parent.id, 'parent.md', new TextEncoder().encode('parent'))
    const otherId = await uploadArtifact(env, other.id, 'other.txt', new TextEncoder().encode('other'))

    // this conversation artifact: can parse.
    const own = await env.app.kernel.resolveAuthorizedAttachments(child.id, [ownId])
    assert.equal(own.length, 1)
    assert.equal(own[0]!.ref.name, 'own.txt')
    assert.equal(own[0]!.ref.size, 3)
    assert.ok(own[0]!.absPath.startsWith(env.dataDir), 'absPath points to dataDir inside')

    // parent conversation artifact: allows sub-conversation mount.
    const viaParent = await env.app.kernel.resolveAuthorizedAttachments(child.id, [parentId])
    assert.equal(viaParent.length, 1)
    assert.equal(viaParent[0]!.metadata.conversationId, parent.id)

    // across conversation unauthorized:403 artifact_forbidden.
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

    // missing:404 not_found.
    await assert.rejects(
      env.app.kernel.resolveAuthorizedAttachments(child.id, ['no-such-artifact-id']),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'not_found')
        assert.equal(err.status, 404)
        return true
      },
    )

    // duplicate ID dedupe.
    const deduped = await env.app.kernel.resolveAuthorizedAttachments(child.id, [ownId, ownId])
    assert.equal(deduped.length, 1)
  } finally {
    await env.close()
  }
})

test('submitInput: text attachment piece together [Attached Files];SQLite zero base64 expansion', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([capture(env)])
    const conv = await env.app.kernel.createConversation({ title: 'text attachment' })
    const artId = await uploadArtifact(env, conv.id, 'notes.md', new TextEncoder().encode('# content'))
    await env.app.kernel.submitInput(conv.id, 'please inspect read attachment', { attachments: [artId] })
    await env.app.kernel.waitForIdle(conv.id)

    // model request:user content contains [Attached Files] manifest.
    assert.equal(env.requests.length, 1)
    const content = env.requests[0]!.userContents.at(-1)
    assert.equal(typeof content, 'string', 'without diagram piece attachment when keep pure text')
    assert.ok((content as string).includes('please inspect read attachment'))
    assert.ok((content as string).includes('[Attached Files]'))
    assert.ok((content as string).includes(`id=${artId}`))
    assert.ok((content as string).includes(`helm artifacts get ${artId} --output ./notes.md`))

    // SQLite helm.input entry:attachments only light amount pointer, absolute without base64.
    const detail = await env.app.kernel.getConversationDetail(conv.id)
    const inputEntry = detail.entries.find((e) => e.kind === 'helm.input')
    assert.ok(inputEntry !== undefined)
    const data = inputEntry.data as { attachments?: Array<{ id: string; name: string; mimeType: string; size: number }> }
    assert.ok(Array.isArray(data.attachments) && data.attachments.length === 1)
    assert.deepEqual(Object.keys(data.attachments[0]!).sort(), ['id', 'mimeType', 'name', 'size'])
    assert.equal(data.attachments[0]!.name, 'notes.md')
    const raw = JSON.stringify(inputEntry)
    assert.ok(!raw.includes('base64'), 'entry must not contains base64 field')
    assert.ok(!raw.includes('# content'), 'entry must not carry artifact byte content')
  } finally {
    await env.close()
  }
})

test('submitInput: diagram piece attachment construct multimodal ImageContent(base64 data + mimeType)', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([capture(env)])
    const conv = await env.app.kernel.createConversation({ title: 'diagram piece attachment' })
    const pngId = await uploadArtifact(env, conv.id, 'shot.png', PNG_BYTES, 'image/png')
    const txtId = await uploadArtifact(env, conv.id, 'side.txt', new TextEncoder().encode('side'))
    await env.app.kernel.submitInput(conv.id, 'see diagram', { attachments: [pngId, txtId] })
    await env.app.kernel.waitForIdle(conv.id)

    assert.equal(env.requests.length, 1)
    const content = env.requests[0]!.userContents.at(-1)
    assert.ok(Array.isArray(content), 'diagram piece attachment when user content should be multimodal array')
    const blocks = content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
    const textBlock = blocks.find((b) => b.type === 'text')
    assert.ok(textBlock !== undefined)
    assert.ok(textBlock.text!.includes('[Attached Files]'))
    assert.ok(textBlock.text!.includes('side.txt'), 'manifest contains all attachment')
    const imageBlocks = blocks.filter((b) => b.type === 'image')
    assert.equal(imageBlocks.length, 1, 'exactly a diagram piece chunk')
    assert.equal(imageBlocks[0]!.mimeType, 'image/png')
    assert.equal(imageBlocks[0]!.data, Buffer.from(PNG_BYTES).toString('base64'))
  } finally {
    await env.close()
  }
})

test('submitInput: across conversation unauthorized attachment 403(produces no turn side effect)', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const a = await env.app.kernel.createConversation({ title: 'A' })
    const b = await env.app.kernel.createConversation({ title: 'B' })
    const artId = await uploadArtifact(env, a.id, 'a.txt', new TextEncoder().encode('a'))
    await assert.rejects(
      env.app.kernel.submitInput(b.id, 'exceeds right mount', { attachments: [artId] }),
      (err: unknown) => err instanceof HelmError && err.code === 'artifact_forbidden' && err.status === 403,
    )
  } finally {
    await env.close()
  }
})

test('submitInput:input hook transform change write attachments after same right validate', { timeout: 60_000 }, async () => {
  // transform plugin: attachments replace is another (exceeds right) artifact ID.
  const evil: PluginDefinition = {
    id: 'test:transform-attachments',
    async definePlugin(ctx) {
      ctx.hook.onInput((payload) => {
        if (payload.input.text === 'trigger change write') {
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
      env.app.kernel.submitInput(conv.id, 'trigger change write'),
      (err: unknown) => err instanceof HelmError && err.code === 'not_found' && err.status === 404,
      'transform after attachment ID same away store in and authorization validate (missing i.e. 404)',
    )
  } finally {
    await env.close()
  }
})

test('subagent attachments:spawnAgent pre- authorization validate; original generate spawn inject [Attached Files]', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const parent = await env.app.kernel.createConversation({ title: 'derive parent' })
    const other = await env.app.kernel.createConversation({ title: 'without closure' })
    const otherArt = await uploadArtifact(env, other.id, 'foreign.bin', new Uint8Array([9]))

    // exceeds right:spawnAgent in enter hook chain before i.e. reject (do not create sub-conversation).
    const beforeCount = (await env.app.kernel.listConversations()).length
    await assert.rejects(
      env.app.kernel.spawnAgent({
        parentConversationId: parent.id,
        prompt: 'exceeds right task',
        attachments: [otherArt],
      }),
      (err: unknown) => err instanceof HelmError && err.code === 'artifact_forbidden' && err.status === 403,
    )
    assert.equal((await env.app.kernel.listConversations()).length, beforeCount, 'produces no sub-conversation side effect')

    // legal: original generate spawn task prompt inject [Attached Files] chunk (faux catch sub-conversation request).
    const artId = await uploadArtifact(env, parent.id, 'spec.md', new TextEncoder().encode('spec-body'))
    env.faux.setResponses([capture(env)])
    const result = await env.app.kernel.spawnAgent({
      parentConversationId: parent.id,
      prompt: 'by attachment dry',
      attachments: [artId],
    })
    assert.equal(result, 'receives attachment')
    const childContent = env.requests[0]!.userContents.at(-1)
    assert.ok(typeof childContent === 'string')
    assert.ok((childContent as string).includes('[Attached Files]'))
    assert.ok((childContent as string).includes('by attachment dry'))
    assert.ok((childContent as string).includes(`id=${artId}`))
  } finally {
    await env.close()
  }
})
