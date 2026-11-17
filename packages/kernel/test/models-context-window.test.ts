/**
 * model directory contextWindow serialization and models.changed force complete link (real KernelRuntime + HTTP):
 *
 * 1. GET /api/models(and kernel.listModels same source): real known window carry contextWindow,
 *    static default (helmContextWindowKnown:false) and illegal window (Infinity) must omit;
 * 2. motion state provider directory change (reloadModels -> rebuild -> models.changed):idle conversation
 *    do not any new input, use amount cache via event set to force complete unknown->known / known->remove,
 *    summary via conversation.upsert can reach SSE and stateChangeSeq do not change;
 * 3. Magpie field parse itself do not in this test (magpie-plugin.test lock official field); this where model
 *    form align builtin:magpie toPiModel artifact: known window without mark record, unknown carry
 *    helmContextWindowKnown:false + keep guard default 128k.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Model, Provider } from '@earendil-works/pi-ai'
import type { ConversationSummary } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { startHub } from '../src/http/index.js'
import { makeFauxModels, useTempDir, waitFor } from './helpers.js'

/** and HelmModelSourceMeta / PiMagpieModel same form: unknown window mark record follow model object pass-through. */
type WindowedModel = Model<string> & { helmContextWindowKnown?: boolean }

/** wait for designate ordinal after appear carry target window conversation.upsert(has boundary polling, never unbounded etc.). */
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
        `8s inside not observe to conversation ${conversationId} window is ${String(expected)}  conversation.upsert` +
          `(upserts=${JSON.stringify(upserts.map((s) => s.contextUsage))})`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('directory contextWindow throw shadow and models.changed force complete:unknown→known→remove,stateChangeSeq do not change', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-models-window-')
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  let kernel: KernelRuntime | undefined
  try {
    kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
    const upserts: ConversationSummary[] = []
    kernel.events.subscribe((frame) => {
      const event = frame.event as { type?: string; conversation?: ConversationSummary }
      if (event.type === 'conversation.upsert' && event.conversation) upserts.push(event.conversation)
    })

    // motion state provider (form align Magpie toPiModel artifact): directory array can swap = simulated directory refresh.
    const { faux } = makeFauxModels({ provider: 'win', models: [{ id: 'm-ctx' }, { id: 'm-bad' }] })
    const unknownModel: WindowedModel = { ...faux.getModel('m-ctx')!, contextWindow: 128_000, helmContextWindowKnown: false }
    const badModel: WindowedModel = { ...faux.getModel('m-bad')!, contextWindow: Number.POSITIVE_INFINITY }
    const knownModel: WindowedModel = { ...faux.getModel('m-ctx')!, contextWindow: 400_000 }
    let current: WindowedModel[] = [unknownModel, badModel]
    const provider = {
      ...faux.provider,
      getModels: () => current,
      getAllModels: () => current,
    } as unknown as Provider
    const unregister = await kernel.registerRuntimeProvider(provider, 'builtin:demo')

    // HTTP directory regression: and kernel.listModels same source. first create authentication (first time start establish token).
    hub = await startHub({ kernel, port: 0 })
    const setup = await fetch(`${hub.url}/api/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'fixture-window-pass' }),
    })
    assert.ok(setup.status === 200 || setup.status === 409, `auth setup unexpected state ${setup.status}`)
    let token = setup.status === 200 ? ((await setup.json()) as { token: string }).token : undefined
    if (token === undefined) {
      const login = await fetch(`${hub.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'fixture-window-pass' }),
      })
      assert.equal(login.status, 200, 'setup already config when login must succeeded')
      token = ((await login.json()) as { token: string }).token
    }
    const httpModels = async (): Promise<Array<Record<string, unknown>>> => {
      const response = await fetch(`${hub!.url}/api/models`, { headers: { authorization: `Bearer ${token}` } })
      assert.equal(response.status, 200)
      return ((await response.json()) as { models: Array<Record<string, unknown>> }).models
    }
    const httpEntry = async (modelId: string): Promise<Record<string, unknown> | undefined> =>
      (await httpModels()).find((entry) => entry['provider'] === 'win' && entry['modelId'] === modelId)

    // initial directory: unknown window and illegal window all must omit contextWindow.
    assert.equal('contextWindow' in ((await httpEntry('m-ctx')) ?? {}), false, 'static default window must not appear in HTTP directory')
    assert.equal('contextWindow' in ((await httpEntry('m-bad')) ?? {}), false, 'non- finite window must not appear in HTTP directory')

    // conversation bind set m-ctx; detail read returns non-blockingly and schedules background usage refresh: window unknown (tokens estimate compute still in).
    const created = await kernel.createConversation({ model: 'win/m-ctx' })
    const id = created.id
    const initialDetail = await kernel.getConversationDetail(id)
    await waitFor(() => kernel!.getConversation(id).contextUsage !== undefined, 10_000)
    const settledInitialDetail = await kernel.getConversationDetail(id)
    assert.ok(settledInitialDetail.contextUsage, 'detail situation read must carry use amount estimate compute')
    assert.equal(settledInitialDetail.contextUsage?.contextWindow, undefined, 'initial directory window unknown')
    const seqBefore = initialDetail.stateChangeSeq

    // directory refresh: same model unknown→known.idle conversation do not new input, use amount via models.changed force complete.
    current = [knownModel, badModel]
    await kernel.reloadModels()
    await waitForUpsertWindow(upserts, id, 0, 400_000)
    const knownDetail = await kernel.getConversationDetail(id)
    assert.equal(knownDetail.contextUsage?.contextWindow, 400_000, 'refresh after window append complete')
    assert.equal(knownDetail.stateChangeSeq, seqBefore, 'usage-only must not push enter stateChangeSeq')
    assert.equal((await httpEntry('m-ctx'))!['contextWindow'], 400_000, 'HTTP directory carry real known window')

    // provider no longer supply should model: window restore unknown and can reach SSE.
    const afterKnown = upserts.length
    current = [badModel]
    await kernel.reloadModels()
    await waitForUpsertWindow(upserts, id, afterKnown, undefined)
    assert.equal((await kernel.getConversationDetail(id)).contextUsage?.contextWindow, undefined, 'model remove after window restore unknown')

    await unregister()
  } finally {
    await hub?.close().catch(() => {})
    await kernel?.close().catch(() => {})
  }
})
