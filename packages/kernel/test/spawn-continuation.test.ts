/**
 * agent_spawn continuation (runAround) contract tests.
 *
 * Covers:
 * - Basic around: plugin wraps before/after next, defaultRun executes once, result passes back;
 * - Nested double plugins (outermost executes first with higher priority): ordered and single execution;
 * - handled short-circuit (without calling next): defaultRun does not run (preserves existing semantics);
 * - Calling next twice: explicitly rejected (invalid_hook_result);
 * - Returning handled/transform after already calling next: explicitly rejected;
 * - Calling next without await (returns early after async kick-off): defaultRun runs once and host joins
 *   to propagate the result (never lost or double-executed on early handler return);
 * - Handler throws after invoking next: error propagates as thrown and host joins background chain (no double execution);
 * - No plugins: defaultRun runs directly;
 * - Combined transform and continuation: transformed payload enters continuation;
 * - Mutating request passed to next: defaultRun receives the mutated payload.
 *
 * Runner: tsx --test; every test has explicit timeout: 60_000 to guard against deadlocks.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { HookPipeline } from '../src/plugins/hooks.js'
import { HelmxError, type AgentSpawnRequest } from '@helmx/protocol'

function spawnRequest(overrides: Partial<AgentSpawnRequest> = {}): AgentSpawnRequest {
  return {
    parentConversationId: 1,
    prompt: 'test spawn',
    ...overrides,
  }
}

test('runAround basic: plugin wraps before/after, defaultRun runs once and returns result', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'agent_spawn'>('agent_spawn')
  const order: string[] = []
  let defaultRuns = 0
  pipeline.add('test:around', async (request, next) => {
    order.push('before')
    const result = await next({ ...request, prompt: 'rewritten' })
    order.push('after')
    return result
  })
  const outcome = await pipeline.runAround(
    spawnRequest(),
    async (final) => {
      defaultRuns += 1
      assert.equal(final.prompt, 'rewritten', 'defaultRun should receive the rewritten request')
      return `native:${final.prompt}`
    },
  )
  assert.equal(outcome, 'native:rewritten')
  assert.equal(defaultRuns, 1)
  assert.deepEqual(order, ['before', 'after'])
})

test('runAround nested double plugins: higher priority runs outermost, defaultRun runs once, both after hooks run', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'agent_spawn'>('agent_spawn')
  const order: string[] = []
  let defaultRuns = 0
  pipeline.add('test:inner', async (request, next) => {
    order.push('inner-before')
    const r = await next(request)
    order.push('inner-after')
    return r
  }, 100)
  pipeline.add('test:outer', async (request, next) => {
    order.push('outer-before')
    const r = await next({ ...request, agentType: 'outer-seen' })
    order.push('outer-after')
    return r
  }, 200)
  const outcome = await pipeline.runAround(
    spawnRequest(),
    async (final) => {
      defaultRuns += 1
      assert.equal(final.agentType, 'outer-seen')
      return 'done'
    },
  )
  assert.equal(outcome, 'done')
  assert.equal(defaultRuns, 1)
  assert.deepEqual(order, ['outer-before', 'inner-before', 'inner-after', 'outer-after'])
})

test('runAround handled short-circuit (without calling next): defaultRun does not execute', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'agent_spawn'>('agent_spawn')
  let defaultRuns = 0
  pipeline.add('test:taker', async () => ({ action: 'handled' as const, result: 'taken-over' }))
  const outcome = await pipeline.runAround(
    spawnRequest(),
    async () => {
      defaultRuns += 1
      return 'native'
    },
  )
  assert.equal(outcome, 'taken-over')
  assert.equal(defaultRuns, 0)
})

test('runAround duplicate next invocation explicitly rejects (invalid_hook_result) while first chain completes once', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'agent_spawn'>('agent_spawn')
  let defaultRuns = 0
  let secondCallError: unknown
  pipeline.add('test:double', async (request, next) => {
    const first = await next(request)
    try {
      await next(request)
    } catch (error) {
      secondCallError = error
    }
    return first
  })
  const outcome = await pipeline.runAround(
    spawnRequest(),
    async () => {
      defaultRuns += 1
      return 'native-once'
    },
  )
  assert.equal(outcome, 'native-once')
  assert.equal(defaultRuns, 1, 'duplicate next must not trigger a second defaultRun')
  assert.ok(secondCallError instanceof HelmxError)
  assert.equal((secondCallError as HelmxError).code, 'invalid_hook_result')
  assert.ok((secondCallError as HelmxError).message.includes('duplicate invoke next'))
})

test('runAround returning handled after calling next explicitly rejects', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'agent_spawn'>('agent_spawn')
  pipeline.add('test:mixed', async (request, next) => {
    void next(request).catch(() => {})
    return { action: 'handled' as const, result: 'wrong' }
  })
  await assert.rejects(
    () => pipeline.runAround(spawnRequest(), async () => 'native'),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError)
      assert.equal(err.code, 'invalid_hook_result')
      assert.ok(err.message.includes('must not again return'))
      return true
    },
  )
})

test('runAround unawaited next (early return after async trigger): defaultRun runs once and propagates result', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'agent_spawn'>('agent_spawn')
  let defaultRuns = 0
  const events: string[] = []
  let releaseDefault!: () => void
  const defaultGate = new Promise<void>((resolve) => { releaseDefault = resolve })
  pipeline.add('test:fire-forget', async (request, next) => {
    // Trigger continuation asynchronously without awaiting: returns early after a microtask (simulates non-blocking plugin).
    void next({ ...request, prompt: 'fire-forget-rewritten' })
    events.push('handler-returning')
    // Early return without waiting: host must join the same promise to prevent double execution and preserve the result.
    return
  })
  // Release gate after defaultRun begins (verifies join waits on background chain instead of early return).
  setTimeout(() => releaseDefault(), 20)
  const outcome = await pipeline.runAround(
    spawnRequest(),
    async (final) => {
      defaultRuns += 1
      assert.equal(final.prompt, 'fire-forget-rewritten', 'continuation rewrite should take effect')
      await defaultGate
      return 'native-fire-forget'
    },
  )
  assert.equal(defaultRuns, 1, 'defaultRun runs exactly once (not twice on early return)')
  assert.equal(outcome, 'native-fire-forget', 'result must still propagate after host join')
  assert.deepEqual(events, ['handler-returning'])
})

test('runAround handler throws after triggering next: error propagates as thrown and background chain drains via join', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'agent_spawn'>('agent_spawn')
  let defaultRuns = 0
  let defaultSettled = false
  pipeline.add('test:throwing', async (request, next) => {
    void next(request).then(() => { defaultSettled = true }, () => { defaultSettled = true })
    throw new Error('handler exploded')
  })
  await assert.rejects(
    () => pipeline.runAround(
      spawnRequest(),
      async () => {
        defaultRuns += 1
        return 'native-after-throw'
      },
    ),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError)
      assert.equal(err.code, 'hook_execution_failed')
      assert.ok(String(err.message).includes('handler exploded'))
      return true
    },
  )
  assert.equal(defaultRuns, 1, 'already-triggered chain runs exactly once')
  // Join semantics: background chain settles without staying pending.
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(defaultSettled, 'background chain should settle cleanly via join')
})

test('runAround without plugins: defaultRun runs directly', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'agent_spawn'>('agent_spawn')
  const outcome = await pipeline.runAround(spawnRequest(), async (final) => `native:${final.prompt}`)
  assert.equal(outcome, 'native:test spawn')
})

test('runAround mixed transform and continuation: transform rewrite applies before continuation', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'agent_spawn'>('agent_spawn')
  let defaultRuns = 0
  pipeline.add('test:transformer', async (request) => ({ action: 'transform' as const, value: { ...request, cwd: '/transformed' } }), 300)
  pipeline.add('test:wrapper', async (request, next) => {
    assert.equal(request.cwd, '/transformed', 'transform rewrite should reach continuation first')
    return next(request)
  }, 200)
  const outcome = await pipeline.runAround(
    spawnRequest(),
    async (final) => {
      defaultRuns += 1
      assert.equal(final.cwd, '/transformed')
      return 'mixed-ok'
    },
  )
  assert.equal(outcome, 'mixed-ok')
  assert.equal(defaultRuns, 1)
})

test('runAround only supports agent_spawn: other hooks explicitly reject', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'trigger'>('trigger')
  await assert.rejects(
    () => pipeline.runAround({ id: 'x', source: 's', text: 't', createdAt: 0 } as never, async () => undefined as never),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError)
      assert.equal(err.code, 'invalid_hook_invocation')
      return true
    },
  )
})
