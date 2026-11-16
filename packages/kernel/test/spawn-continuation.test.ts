/**
 * agent_spawn continuation(runAround) contract test.
 *
 * override:
 * - basis around: plugin in next before after introduce,defaultRun exactly once, result back pass;
 * - double plugin embed set (outside layer first execute priority high): time order and once execute;
 * - handled short route (do not tune next):defaultRun do not execute (since has semantics do not subject to affect);
 * - duplicate invoke next: explicit reject (invalid_hook_result);
 * - already tune next again return handled/transform: explicit reject;
 * - not await  next(async trigger after mention before return):defaultRun exactly once + result
 *   via host join after back pass (do not because handler mention before return while lose result or double execute);
 * - handler throws but already trigger next: error such as on throw, background chain by join converge (without double execute);
 * - without plugin:defaultRun directly execute;
 * - transform and continuation mixed:transform after payload enter continuation;
 * - next pass change write request: eventually defaultRun receives change write after payload.
 *
 * runner: tsx --test; each test explicit timeout: 60_000 guard against deadlock.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { HookPipeline } from '../src/plugins/hooks.js'
import { HelmError, type AgentSpawnRequest } from '@helm/protocol'

function spawnRequest(overrides: Partial<AgentSpawnRequest> = {}): AgentSpawnRequest {
  return {
    parentConversationId: 1,
    prompt: 'test spawn',
    ...overrides,
  }
}

test('runAround basis: plugin before/after package wrap,defaultRun exactly once and result back pass', { timeout: 60_000 }, async () => {
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
      assert.equal(final.prompt, 'rewritten', 'defaultRun should receives change write after request')
      return `native:${final.prompt}`
    },
  )
  assert.equal(outcome, 'native:rewritten')
  assert.equal(defaultRuns, 1)
  assert.deepEqual(order, ['before', 'after'])
})

test('runAround double plugin embed set:priority high outside layer,defaultRun once, two layer after all execute', { timeout: 60_000 }, async () => {
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

test('runAround handled short route (do not tune next):defaultRun do not execute', { timeout: 60_000 }, async () => {
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

test('runAround duplicate invoke next explicit reject (invalid_hook_result), first time chain completed do not double execute', { timeout: 60_000 }, async () => {
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
  assert.equal(defaultRuns, 1, 'duplicate next must not build into second defaultRun')
  assert.ok(secondCallError instanceof HelmError)
  assert.equal((secondCallError as HelmError).code, 'invalid_hook_result')
  assert.ok((secondCallError as HelmError).message.includes('duplicate invoke next'))
})

test('runAround already tune next again return handled explicit reject', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'agent_spawn'>('agent_spawn')
  pipeline.add('test:mixed', async (request, next) => {
    void next(request).catch(() => {})
    return { action: 'handled' as const, result: 'wrong' }
  })
  await assert.rejects(
    () => pipeline.runAround(spawnRequest(), async () => 'native'),
    (err: unknown) => {
      assert.ok(err instanceof HelmError)
      assert.equal(err.code, 'invalid_hook_result')
      assert.ok(err.message.includes('must not again return'))
      return true
    },
  )
})

test('runAround not await  next(async trigger after mention before return):defaultRun exactly once + result back pass', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'agent_spawn'>('agent_spawn')
  let defaultRuns = 0
  const events: string[] = []
  let releaseDefault!: () => void
  const defaultGate = new Promise<void>((resolve) => { releaseDefault = resolve })
  pipeline.add('test:fire-forget', async (request, next) => {
    // async trigger continuation but do not await: micro task after mention before return (simulated bypass async plugin).
    void next({ ...request, prompt: 'fire-forget-rewritten' })
    events.push('handler-returning')
    // mention before return (without waiting): host must join the same promise guard against double execute, do not lose result.
    return
  })
  // gate in defaultRun enter after release (verify join indeed wait for background chain, while non- mention before return).
  setTimeout(() => releaseDefault(), 20)
  const outcome = await pipeline.runAround(
    spawnRequest(),
    async (final) => {
      defaultRuns += 1
      assert.equal(final.prompt, 'fire-forget-rewritten', 'continuation change write should take effect')
      await defaultGate
      return 'native-fire-forget'
    },
  )
  assert.equal(defaultRuns, 1, 'defaultRun exactly once (do not because mention before return while double execute)')
  assert.equal(outcome, 'native-fire-forget', 'host join after result must back pass (do not lose)')
  assert.deepEqual(events, ['handler-returning'])
})

test('runAround handler throws but already trigger next: error such as on throw, background chain by join converge', { timeout: 60_000 }, async () => {
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
      assert.ok(err instanceof HelmError)
      assert.equal(err.code, 'hook_execution_failed')
      assert.ok(String(err.message).includes('handler exploded'))
      return true
    },
  )
  assert.equal(defaultRuns, 1, 'already trigger chain exactly execute once')
  // join semantics: background chain complete (do not pending).
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(defaultSettled, 'background chain should by join converge complete')
})

test('runAround without plugin:defaultRun directly execute', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'agent_spawn'>('agent_spawn')
  const outcome = await pipeline.runAround(spawnRequest(), async (final) => `native:${final.prompt}`)
  assert.equal(outcome, 'native:test spawn')
})

test('runAround transform and continuation mixed:transform change write in continuation before takes effect', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'agent_spawn'>('agent_spawn')
  let defaultRuns = 0
  pipeline.add('test:transformer', async (request) => ({ action: 'transform' as const, value: { ...request, cwd: '/transformed' } }), 300)
  pipeline.add('test:wrapper', async (request, next) => {
    assert.equal(request.cwd, '/transformed', 'transform change write should first at continuation reach')
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

test('runAround only agent_spawn: other hook explicit reject', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'trigger'>('trigger')
  await assert.rejects(
    () => pipeline.runAround({ id: 'x', source: 's', text: 't', createdAt: 0 } as never, async () => undefined as never),
    (err: unknown) => {
      assert.ok(err instanceof HelmError)
      assert.equal(err.code, 'invalid_hook_invocation')
      return true
    },
  )
})
