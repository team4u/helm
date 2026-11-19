/**
 * Model catalog contextWindow serialization and models.changed backfill pipeline (real KernelRuntime + HTTP):
 *
 * 1. GET /api/models (sharing source with kernel.listModels): includes contextWindow when truly known;
 *    omits silently defaulted (helmxContextWindowKnown: false) and invalid (Infinity) values;
 * 2. Dynamic provider catalog updates (reloadModels -> rebuild -> models.changed): idle conversations
 *    receive usage cache backfills via event subscription (unknown -> known / known -> cleared) with
 *    no new user input; summaries deliver via SSE conversation.upsert without changing stateChangeSeq;
 * 3. Magpie-specific field parsing is tested separately (magpie-plugin.test locks official fields);
 *    here models mirror builtin:magpie toPiModel output (known windows carry no marker; unknown windows
 *    carry helmxContextWindowKnown: false + defensive 128k default).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Model, Provider } from '@earendil-works/pi-ai'
import type { ConversationSummary } from '@helmx/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { startHub } from '../src/http/index.js'
import { makeFauxModels, useTempDir, waitFor } from './helpers.js'

/** Matches HelmxModelSourceMeta / PiMagpieModel: unknown-window marker passes through via model objects. */
type WindowedModel = Model<string> & { helmxContextWindowKnown?: boolean }

/** Polls with bounded timeout until a conversation.upsert carrying expected window appears after afterIndex. */
async function waitForUpsertWindow(
  upserts: ConversationSummary[],
  conversationId: number,
  afterIndex: number,
  expected: number | undefined,
): Promise<ConversationSummary> {
  const deadline = Date.now() + 8_000
  for (;;) {
    for (let i = afterIndex; i < upserts.length; i += 1) {
      const summary = upserts[i]!
      if (
        summary.id === conversationId &&
        summary.contextUsage !== undefined &&
        summary.contextUsage.contextWindow === expected
      ) {
        return summary
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `did not observe conversation.upsert with contextWindow=${String(expected)} for conversation ${conversationId} within 8s ` +
          `(upserts=${JSON.stringify(upserts.map((s) => s.contextUsage))})`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('catalog contextWindow projection and models.changed backfill: unknown -> known -> cleared, keeping stateChangeSeq unchanged', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-models-window-')
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
    const upserts: ConversationSummary[] = []
    kernel.events.subscribe((frame) => {
      const event = frame.event as { type?: string; conversation?: ConversationSummary }
      if (event.type === 'conversation.upsert' && event.conversation) upserts.push(event.conversation)
    })

    // Dynamic provider (matching Magpie toPiModel output): mutable array simulates catalog refresh.
    const { faux } = makeFauxModels({ provider: 'win', models: [{ id: 'm-ctx' }, { id: 'm-bad' }] })
    const unknownModel: WindowedModel = { ...faux.getModel('m-ctx')!, contextWindow: 128_000, helmxContextWindowKnown: false }
    const badModel: WindowedModel = { ...faux.getModel('m-bad')!, contextWindow: Number.POSITIVE_INFINITY }
    const knownModel: WindowedModel = { ...faux.getModel('m-ctx')!, contextWindow: 400_000 }
    let current: WindowedModel[] = [unknownModel, badModel]
    const provider = {
      ...faux.provider,
      getModels: () => current,
      getAllModels: () => current,
    } as unknown as Provider
    const unregister = await kernel.registerRuntimeProvider(provider, 'builtin:demo')

    // HTTP catalog check (sharing source with kernel.listModels). Initialize auth first to obtain token.
    hub = await startHub({ kernel, port: 0 })
    const setup = await fetch(`${hub.url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'fixture-window-pass' }),
    })
    assert.ok(setup.status === 200 || setup.status === 409, `unexpected auth setup status ${setup.status}`)
    let token = setup.status === 200 ? ((await setup.json()) as { token: string }).token : undefined
    if (token === undefined) {
      const login = await fetch(`${hub.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'fixture-window-pass' }),
      })
      assert.equal(login.status, 200, 'login should succeed when auth is already configured')
      token = ((await login.json()) as { token: string }).token
    }
    const httpModels = async (): Promise<Array<Record<string, unknown>>> => {
      const response = await fetch(`${hub!.url}/api/models`, { headers: { authorization: `Bearer ${token}` } })
      assert.equal(response.status, 200)
      return ((await response.json()) as { models: Array<Record<string, unknown>> }).models
    }
    const httpEntry = async (modelId: string): Promise<Record<string, unknown> | undefined> =>
      (await httpModels()).find((entry) => entry['provider'] === 'win' && entry['modelId'] === modelId)

    // Initial catalog: unknown and invalid contextWindow must both be omitted.
    assert.equal('contextWindow' in ((await httpEntry('m-ctx')) ?? {}), false, 'silently defaulted window must not appear in HTTP catalog')
    assert.equal('contextWindow' in ((await httpEntry('m-bad')) ?? {}), false, 'non-finite window must not appear in HTTP catalog')

    // Bind conversation to m-ctx; detail read is non-blocking and triggers async usage refresh (tokens known, window unknown).
    const created = await kernel.createConversation({ model: 'win/m-ctx' })
    const id = created.id
    const initialDetail = await kernel.getConversationDetail(id)
    await waitFor(() => kernel!.getConversation(id).contextUsage !== undefined, 10_000)
    const settledInitialDetail = await kernel.getConversationDetail(id)
    assert.ok(settledInitialDetail.contextUsage, 'detail read should include estimated token usage')
    assert.equal(settledInitialDetail.contextUsage?.contextWindow, undefined, 'initial catalog window is unknown')
    const seqBefore = initialDetail.stateChangeSeq

    // Catalog refresh: same model transitions unknown -> known; idle conversation usage is backfilled via models.changed.
    current = [knownModel, badModel]
    await kernel.reloadModels()
    await waitForUpsertWindow(upserts, id, 0, 400_000)
    const knownDetail = await kernel.getConversationDetail(id)
    assert.equal(knownDetail.contextUsage?.contextWindow, 400_000, 'window is backfilled after refresh')
    assert.equal(knownDetail.stateChangeSeq, seqBefore, 'usage-only update must not advance stateChangeSeq')
    assert.equal((await httpEntry('m-ctx'))!['contextWindow'], 400_000, 'HTTP catalog exposes known window')

    // Provider stops offering model: window reverts to undefined and broadcasts to SSE.
    const afterKnown = upserts.length
    current = [badModel]
    await kernel.reloadModels()
    await waitForUpsertWindow(upserts, id, afterKnown, undefined)
    assert.equal((await kernel.getConversationDetail(id)).contextUsage?.contextWindow, undefined, 'window reverts to unknown after model disappears')

    await unregister()
  } finally {
    await hub?.close().catch(() => {})
    await kernel?.close().catch(() => {})
  }
})
