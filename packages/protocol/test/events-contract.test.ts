import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HelmxError,
  encodeSessionDocSubParam,
  parseSessionDocSubParam,
  type ConversationDetail,
  type ConversationLive,
  type ConversationSummary,
  type HelmxEvent,
  type HelmxEventType,
  type HelmxResumedFrame,
  type HelmxTransientLiveFrame,
  type PluginSummary,
  type PublicPluginSessionDoc,
  type SessionDocMultiplexAction,
  type SessionDocMultiplexFrame,
  type SessionDocSubscription,
} from '../src/index.js'

function assertValidationError(fn: () => unknown, leakedSecrets: readonly string[] = []): void {
  let caught: unknown
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof HelmxError, `expected HelmxError, got ${String(caught)}`)
  assert.equal(caught.code, 'validation_error')
  assert.equal(caught.status, 400)
  for (const secret of leakedSecrets) {
    assert.ok(!caught.message.includes(secret), `error message leaked secret "${secret}": ${caught.message}`)
  }
}

test('encodeSessionDocSubParam and parseSessionDocSubParam round-trip valid subscriptions', { timeout: 60_000 }, () => {
  const cases: SessionDocSubscription[] = [
    { pluginId: 'builtin:token-speed', name: 'speed', conversationId: 42 },
    { pluginId: 'acme.plugin_v1-alpha', name: 'doc.state_1-a', conversationId: 1 },
    { pluginId: 'a', name: 'b', conversationId: 1 },
    { pluginId: 'p', name: 'n', conversationId: Number.MAX_SAFE_INTEGER },
    {
      pluginId: 'p'.repeat(128),
      name: 'n'.repeat(128),
      conversationId: Number.MAX_SAFE_INTEGER,
    },
  ]

  for (const sub of cases) {
    const encoded = encodeSessionDocSubParam(sub)
    assert.equal(encoded, `${sub.pluginId}/${sub.name}/${String(sub.conversationId)}`)

    const parsed = parseSessionDocSubParam(encoded)
    assert.deepEqual(parsed, sub)

    // Verify URLSearchParams transport round-trip remains strictly consistent.
    const params = new URLSearchParams([['sub', encoded]])
    const fromQuery = params.get('sub')
    assert.ok(fromQuery !== null)
    assert.deepEqual(parseSessionDocSubParam(fromQuery), sub)
  }
})

test('encodeSessionDocSubParam ignores extra fields and never leaks stray properties', { timeout: 60_000 }, () => {
  const secret = 'tok_super_secret_98765'
  const input = {
    pluginId: 'builtin:workflow',
    name: 'runs',
    conversationId: 7,
    token: secret,
  } as unknown as SessionDocSubscription

  const encoded = encodeSessionDocSubParam(input)
  assert.equal(encoded, 'builtin:workflow/runs/7')
  assert.ok(!encoded.includes(secret))
})

test('parseSessionDocSubParam rejects invalid inputs with HelmxError(400) and no token echo', { timeout: 60_000 }, () => {
  const secret = 'secret_bearer_token_xyz'
  const badRawStrings = [
    '',
    '   ',
    'p/n',
    'p/n/1/extra',
    '/p/n/1',
    'p/n/1/',
    '.p/n/1',
    'p/.n/1',
    '-p/n/1',
    'p/-n/1',
    '../n/1',
    'p..q/n/1',
    'p/n..m/1',
    'builtin:p/name:colon/1',
    'p%20/n/1',
    `p/n/1?token=${secret}`,
    `p/n/1&token=${secret}`,
    `p/n/1#${secret}`,
    `p/n/1\n${secret}`,
    `bad/${secret}?/1`,
    'p/n/0',
    'p/n/01',
    'p/n/-1',
    'p/n/1.5',
    'p/n/+1',
    'p/n/1e2',
    'p/n/9007199254740992',
    'p/n/99999999999999999',
    'p/n/abc',
    `${'a'.repeat(129)}/b/1`,
    `a/${'b'.repeat(129)}/1`,
    `${'a'.repeat(128)}/${'b'.repeat(128)}/10000000000000000`,
  ]

  for (const raw of badRawStrings) {
    assertValidationError(() => parseSessionDocSubParam(raw), [secret])
  }

  for (const nonString of [null, undefined, 123, {}, []]) {
    assertValidationError(() => parseSessionDocSubParam(nonString as unknown as string))
  }
})

test('encodeSessionDocSubParam rejects invalid subscription payloads without echoing tokens', { timeout: 60_000 }, () => {
  const secret = 'secret_payload_token_456'

  for (const nonObject of [null, undefined, 'p/n/1', 42, []]) {
    assertValidationError(() => encodeSessionDocSubParam(nonObject as unknown as SessionDocSubscription))
  }

  const invalidPayloads: unknown[] = [
    { pluginId: '', name: 'n', conversationId: 1 },
    { pluginId: `.${secret}`, name: 'n', conversationId: 1 },
    { pluginId: `a..${secret}`, name: 'n', conversationId: 1 },
    { pluginId: 'a/b', name: 'n', conversationId: 1 },
    { pluginId: 'a'.repeat(129), name: 'n', conversationId: 1 },
    { pluginId: 'p', name: '', conversationId: 1 },
    { pluginId: 'p', name: 'bad:colon', conversationId: 1 },
    { pluginId: 'p', name: `n?token=${secret}`, conversationId: 1 },
    { pluginId: 'p', name: 'n..m', conversationId: 1 },
    { pluginId: 'p', name: 'b'.repeat(129), conversationId: 1 },
    { pluginId: 'p', name: 'n', conversationId: 0 },
    { pluginId: 'p', name: 'n', conversationId: -1 },
    { pluginId: 'p', name: 'n', conversationId: 1.5 },
    { pluginId: 'p', name: 'n', conversationId: Number.NaN },
    { pluginId: 'p', name: 'n', conversationId: Number.POSITIVE_INFINITY },
    { pluginId: 'p', name: 'n', conversationId: Number.MAX_SAFE_INTEGER + 1 },
    { pluginId: 'p', name: 'n', conversationId: '1' },
  ]

  for (const payload of invalidPayloads) {
    assertValidationError(() => encodeSessionDocSubParam(payload as SessionDocSubscription), [secret])
  }
})

test('Stage 0 protocol contracts lock transient live, clientHashes, lastEntryId, and multiplex frames', { timeout: 60_000 }, () => {
  // Compile-time guard: 'conversation.live' must stay excluded from durable HelmxEventType / HelmxEvent.
  type LiveExcludedFromEventType = Extract<HelmxEventType, 'conversation.live'> extends never ? true : false
  type LiveExcludedFromHelmxEvent = Extract<HelmxEvent, { type: 'conversation.live' }> extends never ? true : false
  const liveExcludedType: LiveExcludedFromEventType = true
  const liveExcludedEvent: LiveExcludedFromHelmxEvent = true
  assert.equal(liveExcludedType, true)
  assert.equal(liveExcludedEvent, true)

  const pluginSummary: PluginSummary = {
    id: 'builtin:workflow',
    name: 'Workflow',
    locked: false,
    enabled: true,
    hooks: [],
    actions: [],
    tools: [],
    clientHashes: {
      'index.tsx': 'sha256-abc',
      'client.tsx': 'sha256-def',
    },
  }
  assert.equal(pluginSummary.clientHashes?.['index.tsx'], 'sha256-abc')

  const convSummary: ConversationSummary = {
    id: 1,
    title: 'Test',
    profileId: 'default',
    tags: [],
    cwd: '/tmp/work',
    model: 'openai/gpt-5',
    thinkingLevel: 'medium',
    status: 'idle',
    stateChangeSeq: 3,
    completionSeq: 1,
    lastEntryId: 12,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1000,
    updatedAt: 2000,
  }
  const convDetail: ConversationDetail = {
    ...convSummary,
    entries: [],
  }
  assert.equal(convSummary.lastEntryId, 12)
  assert.equal(convDetail.lastEntryId, 12)

  const live: ConversationLive = {
    conversationId: 1,
    text: 'streaming...',
    tools: [],
    updatedAt: 2500,
  }
  const transientFrame: HelmxTransientLiveFrame = { live }
  const resumedFrame: HelmxResumedFrame = {
    bootId: 'boot-1',
    seq: 10,
    headSeq: 12,
    conversationLives: [live],
  }
  assert.equal(transientFrame.live.conversationId, 1)
  assert.equal(resumedFrame.conversationLives?.[0]?.text, 'streaming...')

  const actions: SessionDocMultiplexAction[] = ['snapshot', 'updated', 'deleted']
  const frames: SessionDocMultiplexFrame[] = actions.map((action, idx) => {
    const doc: PublicPluginSessionDoc = {
      pluginId: 'builtin:token-speed',
      name: 'speed',
      conversationId: 1,
      value: action === 'deleted' ? null : { tps: 42 },
      ...(action === 'deleted' ? { deleted: true } : {}),
    }
    return {
      action,
      pluginId: 'builtin:token-speed',
      name: 'speed',
      conversationId: 1,
      seq: idx + 1,
      doc,
    }
  })
  assert.deepEqual(
    frames.map((frame) => frame.action),
    ['snapshot', 'updated', 'deleted'],
  )
  assert.equal(frames[2]?.doc.deleted, true)
})
