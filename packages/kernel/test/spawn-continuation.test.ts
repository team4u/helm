/**
 * agent_spawn continuation（runAround）契约测试。
 *
 * 覆盖：
 * - 基础 around：插件在 next 前后介入，defaultRun 恰好一次、结果回传；
 * - 双插件嵌套（外层先执行 priority 高）：次序与一次执行；
 * - handled 短路（不调 next）：defaultRun 不执行（既有语义不受影响）；
 * - 重复调用 next：显式拒绝（invalid_hook_result）；
 * - 已调 next 再返回 handled/transform：显式拒绝；
 * - 未 await 的 next（异步触发后提前返回）：defaultRun 恰好一次 + 结果
 *   经宿主 join 后回传（不因 handler 提前返回而丢结果或双执行）；
 * - handler 抛错但已触发 next：错误如实上抛，后台链被 join 收敛（无双执行）；
 * - 无插件：defaultRun 直接执行；
 * - transform 与 continuation 混合：transform 后的载荷进入 continuation；
 * - next 传入改写请求：最终 defaultRun 收到改写后的载荷。
 *
 * runner: tsx --test；每测试显式 timeout: 60_000 防死锁。
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

test('runAround 基础：插件 before/after 包裹，defaultRun 恰好一次且结果回传', { timeout: 60_000 }, async () => {
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
      assert.equal(final.prompt, 'rewritten', 'defaultRun 应收到改写后的请求')
      return `native:${final.prompt}`
    },
  )
  assert.equal(outcome, 'native:rewritten')
  assert.equal(defaultRuns, 1)
  assert.deepEqual(order, ['before', 'after'])
})

test('runAround 双插件嵌套：priority 高者外层，defaultRun 一次，两层 after 均执行', { timeout: 60_000 }, async () => {
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

test('runAround handled 短路（不调 next）：defaultRun 不执行', { timeout: 60_000 }, async () => {
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

test('runAround 重复调用 next 显式拒绝（invalid_hook_result），首次链已完成不双执行', { timeout: 60_000 }, async () => {
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
  assert.equal(defaultRuns, 1, '重复 next 不得造成二次 defaultRun')
  assert.ok(secondCallError instanceof HelmError)
  assert.equal((secondCallError as HelmError).code, 'invalid_hook_result')
  assert.ok((secondCallError as HelmError).message.includes('重复调用 next'))
})

test('runAround 已调 next 再返回 handled 显式拒绝', { timeout: 60_000 }, async () => {
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
      assert.ok(err.message.includes('不得再返回'))
      return true
    },
  )
})

test('runAround 未 await 的 next（异步触发后提前返回）：defaultRun 恰好一次 + 结果回传', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'agent_spawn'>('agent_spawn')
  let defaultRuns = 0
  const events: string[] = []
  let releaseDefault!: () => void
  const defaultGate = new Promise<void>((resolve) => { releaseDefault = resolve })
  pipeline.add('test:fire-forget', async (request, next) => {
    // 异步触发 continuation 但不 await：微任务后提前返回（模拟绕过 async 的插件）。
    void next({ ...request, prompt: 'fire-forget-rewritten' })
    events.push('handler-returning')
    // 提前返回（不等待）：宿主必须 join 同一 promise 防双执行、不丢结果。
    return
  })
  // gate 在 defaultRun 进入后释放（证实 join 确实等待后台链，而非提前返回）。
  setTimeout(() => releaseDefault(), 20)
  const outcome = await pipeline.runAround(
    spawnRequest(),
    async (final) => {
      defaultRuns += 1
      assert.equal(final.prompt, 'fire-forget-rewritten', 'continuation 的改写应生效')
      await defaultGate
      return 'native-fire-forget'
    },
  )
  assert.equal(defaultRuns, 1, 'defaultRun 恰好一次（不因提前返回而双执行）')
  assert.equal(outcome, 'native-fire-forget', '宿主 join 后结果必须回传（不丢）')
  assert.deepEqual(events, ['handler-returning'])
})

test('runAround handler 抛错但已触发 next：错误如实上抛，后台链被 join 收敛', { timeout: 60_000 }, async () => {
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
  assert.equal(defaultRuns, 1, '已触发的链恰好执行一次')
  // join 语义：后台链完成（不悬挂）。
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(defaultSettled, '后台链应被 join 收敛完成')
})

test('runAround 无插件：defaultRun 直接执行', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'agent_spawn'>('agent_spawn')
  const outcome = await pipeline.runAround(spawnRequest(), async (final) => `native:${final.prompt}`)
  assert.equal(outcome, 'native:test spawn')
})

test('runAround transform 与 continuation 混合：transform 改写在 continuation 之前生效', { timeout: 60_000 }, async () => {
  const pipeline = new HookPipeline<'agent_spawn'>('agent_spawn')
  let defaultRuns = 0
  pipeline.add('test:transformer', async (request) => ({ action: 'transform' as const, value: { ...request, cwd: '/transformed' } }), 300)
  pipeline.add('test:wrapper', async (request, next) => {
    assert.equal(request.cwd, '/transformed', 'transform 改写应先于 continuation 到达')
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

test('runAround 仅 agent_spawn：其他钩子显式拒绝', { timeout: 60_000 }, async () => {
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
