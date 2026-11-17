/**
 * Multimodal message attachment tests.
 * Real `createHelm` + faux provider + real `ArtifactService` (real files):
 * - Authorization: own-conversation and parent-conversation artifacts can be attached; cross-conversation
 *   unauthorized attachments fail with `403 artifact_forbidden`; missing artifacts fail with `404`;
 * - SQLite zero bloat: `helm.input` entry `attachments` stores only lightweight pointers (no base64);
 * - Multimodal: image attachments produce `ImageContent` blocks in model requests (captured via faux
 *   `TranscriptContext` user content arrays); text attachments append `[Attached Files]` plain text;
 * - Input hook `transform` rewriting `attachments` undergoes the same authorization check (403 on escalation);
 * - Subagent attachment pass-through: `spawnAgent` pre-validates authorization and injects `[Attached Files]`
 *   blocks into native spawns.
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
  /** Full user contents sent to the model per request (captured via official faux `TranscriptContext`). */
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

/** Captures user message contents (covering both strings and multimodal content arrays). */
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

/** 1x1 PNG (valid image bytes). */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

/** Creates an artifact through the real upload path (`writeUploaded` handles sanitization/registration). */
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

test('authorization: own and parent conversation artifacts attach; cross-conversation 403; missing 404', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const parent = await env.app.kernel.createConversation({ title: 'parent conversation' })
    const child = await env.app.kernel.createConversation({ title: 'sub-conversation', parentConversationId: parent.id })
    const other = await env.app.kernel.createConversation({ title: 'without closure conversation' })

    const ownId = await uploadArtifact(env, child.id, 'own.txt', new TextEncoder().encode('own'))
    const parentId = await uploadArtifact(env, parent.id, 'parent.md', new TextEncoder().encode('parent'))
    const otherId = await uploadArtifact(env, other.id, 'other.txt', new TextEncoder().encode('other'))

    // Own conversation artifact: resolves.
    const own = await env.app.kernel.resolveAuthorizedAttachments(child.id, [ownId])
    assert.equal(own.length, 1)
    assert.equal(own[0]!.ref.name, 'own.txt')
    assert.equal(own[0]!.ref.size, 3)
    assert.ok(own[0]!.absPath.startsWith(env.dataDir), 'absPath should reside inside dataDir')

    // Parent conversation artifact: child conversation may attach.
    const viaParent = await env.app.kernel.resolveAuthorizedAttachments(child.id, [parentId])
    assert.equal(viaParent.length, 1)
    assert.equal(viaParent[0]!.metadata.conversationId, parent.id)

    // Cross-conversation unauthorized: 403 artifact_forbidden.
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

    // Missing: 404 not_found.
    await assert.rejects(
      env.app.kernel.resolveAuthorizedAttachments(child.id, ['no-such-artifact-id']),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'not_found')
        assert.equal(err.status, 404)
        return true
      },
    )

    // Deduplicates repeated IDs.
    const deduped = await env.app.kernel.resolveAuthorizedAttachments(child.id, [ownId, ownId])
    assert.equal(deduped.length, 1)
  } finally {
    await env.close()
  }
})

test('submitInput: text attachments append [Attached Files]; SQLite stores no base64 bloat', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.faux.setResponses([capture(env)])
    const conv = await env.app.kernel.createConversation({ title: 'text attachment' })
    const artId = await uploadArtifact(env, conv.id, 'notes.md', new TextEncoder().encode('# content'))
    await env.app.kernel.submitInput(conv.id, 'please inspect read attachment', { attachments: [artId] })
    await env.app.kernel.waitForIdle(conv.id)

    // Model request: user content includes [Attached Files] manifest.
    assert.equal(env.requests.length, 1)
    const content = env.requests[0]!.userContents.at(-1)
    assert.equal(typeof content, 'string', 'remains plain text when no image attachments are present')
    assert.ok((content as string).includes('please inspect read attachment'))
    assert.ok((content as string).includes('[Attached Files]'))
    assert.ok((content as string).includes(`id=${artId}`))
    assert.ok((content as string).includes(`helm artifacts get ${artId} --output ./notes.md`))

    // SQLite helm.input entry: attachments carry lightweight pointers only, never base64.
    const detail = await env.app.kernel.getConversationDetail(conv.id)
    const inputEntry = detail.entries.find((e) => e.kind === 'helm.input')
    assert.ok(inputEntry !== undefined)
    const data = inputEntry.data as { attachments?: Array<{ id: string; name: string; mimeType: string; size: number }> }
    assert.ok(Array.isArray(data.attachments) && data.attachments.length === 1)
    assert.deepEqual(Object.keys(data.attachments[0]!).sort(), ['id', 'mimeType', 'name', 'size'])
    assert.equal(data.attachments[0]!.name, 'notes.md')
    const raw = JSON.stringify(inputEntry)
    assert.ok(!raw.includes('base64'), 'entry must not contain base64 fields')
    assert.ok(!raw.includes('# content'), 'entry must not inline artifact byte contents')
  } finally {
    await env.close()
  }
})

test('submitInput: image attachments build multimodal ImageContent (base64 data + mimeType)', { timeout: 60_000 }, async () => {
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
    assert.ok(Array.isArray(content), 'user content should be a multimodal array when image attachments are present')
    const blocks = content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
    const textBlock = blocks.find((b) => b.type === 'text')
    assert.ok(textBlock !== undefined)
    assert.ok(textBlock.text!.includes('[Attached Files]'))
    assert.ok(textBlock.text!.includes('side.txt'), 'manifest includes all attachments')
    const imageBlocks = blocks.filter((b) => b.type === 'image')
    assert.equal(imageBlocks.length, 1, 'exactly one image block')
    assert.equal(imageBlocks[0]!.mimeType, 'image/png')
    assert.equal(imageBlocks[0]!.data, Buffer.from(PNG_BYTES).toString('base64'))
  } finally {
    await env.close()
  }
})

test('submitInput: cross-conversation unauthorized attachment fails with 403 (no turn side effects)', { timeout: 60_000 }, async () => {
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

test('submitInput: attachments rewritten by input hook transform still undergo authorization check', { timeout: 60_000 }, async () => {
  // Transform plugin replaces attachments with an unauthorized/foreign artifact ID.
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
      'transformed attachment IDs must still be checked for existence and authorization (404 when missing)',
    )
  } finally {
    await env.close()
  }
})

test('subagent attachments: spawnAgent pre-validates authorization; native spawn injects [Attached Files]', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const parent = await env.app.kernel.createConversation({ title: 'derive parent' })
    const other = await env.app.kernel.createConversation({ title: 'without closure' })
    const otherArt = await uploadArtifact(env, other.id, 'foreign.bin', new Uint8Array([9]))

    // Unauthorized: spawnAgent rejects before entering the hook chain (creates no child conversation).
    const beforeCount = (await env.app.kernel.listConversations()).length
    await assert.rejects(
      env.app.kernel.spawnAgent({
        parentConversationId: parent.id,
        prompt: 'exceeds right task',
        attachments: [otherArt],
      }),
      (err: unknown) => err instanceof HelmError && err.code === 'artifact_forbidden' && err.status === 403,
    )
    assert.equal((await env.app.kernel.listConversations()).length, beforeCount, 'must not create child conversation side effects')

    // Authorized: native spawn injects [Attached Files] block into task prompt (captured by faux).
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
