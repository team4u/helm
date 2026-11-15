import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runWorkflow, type WorkflowHost, type WorkflowControl } from '../src/workflow/engine/runtime.js'
import type { WorkflowJournalEntry, JournalWriteInput } from '../src/workflow/engine/journal.js'

const timeout = { timeout: 60_000 } as const
const script = (body: string) => `export const meta = { name: 'attempt-replay', description: 'test' }\n${body}`
function journal() {
  const entries: WorkflowJournalEntry[] = []
  return {
    entries,
    append(entry: JournalWriteInput) { entries.push({ ...entry, v: 1, seq: entries.length } as WorkflowJournalEntry) },
  }
}
function host(overrides: Partial<WorkflowHost> = {}): WorkflowHost {
  return {
    async spawnAgent() { throw new Error('unexpected spawn') },
    async resumeAgent() { throw new Error('unexpected resume') },
    abortAgent() {},
    async invokeAction() { throw new Error('unexpected action') },
    ...overrides,
  }
}

const objective = script('return await goal({ label: "worker", objective: "build", maxAttempts: 3 })')

test('two failed attempts replay before resuming the third with the persisted handle and redacted reason', timeout, async () => {
  const original = journal()
  let resumes = 0
  const initial = await runWorkflow({
    script: objective,
    journal: original,
    redact: (text) => text.replaceAll('private-token', '[redacted]'),
    host: host({
      async spawnAgent(request) {
        request.onResolved?.({ conversationId: 77, effectiveCwd: '/project' })
        return { ok: false, error: 'private-token first', timedOut: true }
      },
      async resumeAgent() {
        resumes++
        return resumes === 1 ? { ok: false, error: 'private-token second' } : { ok: true, text: 'done' }
      },
    }),
  })
  assert.equal(initial.status, 'completed', initial.error)
  assert.equal(JSON.stringify(original.entries).includes('private-token'), false)
  assert.deepEqual(original.entries.map((entry) => entry.index), [0, 1, 2])
  assert.deepEqual(original.entries.map((entry) => entry.type === 'agent' ? entry.invocationIndex : null), [0, 0, 0])
  const partial = journal()
  const calls: string[] = []
  const restored = await runWorkflow({
    script: objective,
    journal: { entries: original.entries.slice(0, 2), append: partial.append },
    host: host({
      async resumeAgent(agentId, prompt, options) {
        calls.push(`${agentId}:${options?.resumeRef}`)
        assert.match(prompt, /attempt 2 failed/)
        assert.match(prompt, /\[redacted\] second/)
        return { ok: true, text: 'done' }
      },
    }),
  })
  assert.equal(restored.status, 'completed', restored.error)
  assert.deepEqual(calls, ['wf-agent-0:77'])
  assert.equal((restored.value as { attempts: number }).attempts, 3)
  assert.deepEqual(partial.entries.map((entry) => entry.key), original.entries.map((entry) => entry.key))
  const cached = await runWorkflow({ script: objective, host: host(), journal: { entries: original.entries } })
  assert.equal(cached.status, 'completed', cached.error)
  assert.deepEqual(cached.value, initial.value)
})

test('exhausted goal replays its failed result and later action without spawning or repeating the action', timeout, async () => {
  const log = journal()
  const source = script('const value = await goal({ objective: "fail", maxAttempts: 2 }); const actionResult = await action("effect", {}); return { value, actionResult }')
  const initial = await runWorkflow({
    script: source,
    journal: log,
    host: host({
      async spawnAgent(request) { request.onResolved?.({ conversationId: 7 }); return { ok: false, error: 'first' } },
      async resumeAgent() { return { ok: false, error: 'last' } },
      async invokeAction() { return { pluginId: 'test', actionId: 'effect', result: 'sent' } },
    }),
  })
  assert.equal(initial.status, 'completed', initial.error)
  const replay = await runWorkflow({ script: source, journal: { entries: log.entries, retryFailedCalls: true }, host: host({ async resumeAgent() { throw new Error('unexpected resume') } }) })
  assert.equal(replay.status, 'completed', replay.error)
  assert.deepEqual(replay.value, initial.value)
  assert.equal(replay.progress.some((entry) => entry.type === 'workflow_agent' && entry.state === 'error' && entry.error === 'last'), true)
})

test('a failed source run grants its terminal goal a fresh bounded budget using the persisted conversation', timeout, async () => {
  const log = journal()
  const source = script('const r = await goal({ objective: "build", maxAttempts: 2 }); if (!r.ok) throw new Error("exhausted"); return r')
  const failed = await runWorkflow({ script: source, journal: log, host: host({
    async spawnAgent(request) { request.onResolved?.({ conversationId: 77 }); return { ok: false, error: 'provider down' } },
    async resumeAgent() { return { ok: false, error: 'provider down' } },
  }) })
  assert.equal(failed.status, 'failed')
  const nextLog = journal()
  const prompts: string[] = []
  const recovered = await runWorkflow({ script: source,
    journal: { entries: log.entries, append: nextLog.append, retryFailedCalls: true },
    host: host({ async resumeAgent(_agentId, prompt, options) {
      assert.equal(options?.resumeRef, '77')
      prompts.push(prompt)
      return { ok: false, error: 'still unavailable' }
    } }),
  })
  assert.equal(recovered.status, 'failed')
  assert.equal(prompts.length, 2, 'only the new recovery round consumes the new two-attempt budget')
  assert.match(prompts[0]!, /attempt 2 failed/)
  assert.match(prompts[1]!, /attempt 3 failed/)
  assert.deepEqual(nextLog.entries.map(entry => entry.type === 'agent' ? entry.attempt : null), [1, 2, 3, 4])
})

test('lowering maxAttempts cannot skip a historical attempt and replay a later non-idempotent action', timeout, async () => {
  const log = journal()
  const source = (maxAttempts: number) => script(`const result = await goal({ objective: "build", maxAttempts: ${maxAttempts} }); return [result, await action("effect", {})]`)
  let resumes = 0
  const original = await runWorkflow({
    script: source(3), journal: log,
    host: host({
      async spawnAgent(request) { request.onResolved?.({ conversationId: 7 }); return { ok: false, error: 'first' } },
      async resumeAgent() { return ++resumes === 1 ? { ok: false, error: 'second' } : { ok: true, text: 'done' } },
      async invokeAction() { return { pluginId: 'test', actionId: 'effect', result: 'sent' } },
    }),
  })
  assert.equal(original.status, 'completed', original.error)
  const replay = await runWorkflow({ script: source(2), host: host(), journal: { entries: log.entries } })
  assert.equal(replay.status, 'failed')
  assert.match(replay.error ?? '', /workflow_action_uncertain/)
})

test('parallel agent retries retain their journal slots while the following non-idempotent action replays', timeout, async () => {
  const log = journal()
  const source = script('const first = agent("first", { maxAttempts: 2 }); const second = agent("second"); const values = await Promise.all([first, second]); return [values, await action("effect", {})]')
  let releaseFirst!: () => void
  const firstReady = new Promise<void>((resolve) => { releaseFirst = resolve })
  const initial = await runWorkflow({
    script: source,
    journal: log,
    host: host({
      async spawnAgent(request) {
        if (request.prompt === 'first') {
          request.onResolved?.({ conversationId: 7 })
          await firstReady
          return { ok: false, error: 'retry' }
        }
        releaseFirst()
        return { ok: true, text: 'second-done' }
      },
      async resumeAgent() { return { ok: true, text: 'first-done' } },
      async invokeAction() { return { pluginId: 'test', actionId: 'effect', result: 'sent' } },
    }),
  })
  assert.equal(initial.status, 'completed', initial.error)
  const retry = log.entries.find((entry) => entry.type === 'agent' && entry.attempt === 2)
  assert.equal(retry?.index, 2)
  const cached = await runWorkflow({ script: source, host: host({ async resumeAgent() { throw new Error('unexpected resume') } }), journal: { entries: log.entries } })
  assert.equal(cached.status, 'completed', cached.error)
  assert.deepEqual(cached.value, initial.value)
})

test('manual retry is replayable even when maxAttempts defaults to one', timeout, async () => {
  const log = journal()
  let control!: WorkflowControl
  let release!: (value: { ok: boolean; text?: string; error?: string }) => void
  let attempts = 0
  const source = script('return await agent.withMeta("manual")')
  const original = await runWorkflow({
    script: source, journal: log,
    onControl(value) { control = value },
    host: host({
      async spawnAgent() {
        attempts++
        if (attempts > 1) return { ok: true, text: 'fixed' }
        return new Promise((resolve) => {
          release = resolve
          queueMicrotask(() => { assert.equal(control.retry(0), true) })
        })
      },
      abortAgent() { release({ ok: false, error: 'aborted manually' }) },
    }),
  })
  assert.equal(original.status, 'completed', original.error)
  assert.equal(attempts, 2)
  const replay = await runWorkflow({ script: source, host: host(), journal: { entries: log.entries } })
  assert.equal(replay.status, 'completed', replay.error)
  assert.deepEqual(replay.value, original.value)
})

test('user skip remains skipped during replay with a consistent withMeta result', timeout, async () => {
  const log = journal()
  let control!: WorkflowControl
  let release!: (value: { ok: boolean; error: string }) => void
  const source = script('return await agent.withMeta("skipped")')
  const original = await runWorkflow({
    script: source, journal: log,
    onControl(value) { control = value },
    host: host({
      async spawnAgent() {
        return new Promise((resolve) => {
          release = resolve
          queueMicrotask(() => { assert.equal(control.skip(0), true) })
        })
      },
      abortAgent() { release({ ok: false, error: 'aborted' }) },
    }),
  })
  assert.equal(original.status, 'completed', original.error)
  const cached = await runWorkflow({ script: source, host: host(), journal: { entries: log.entries } })
  assert.equal(cached.status, 'completed', cached.error)
  assert.deepEqual(cached.value, original.value)
  assert.equal(cached.progress.some((entry) => entry.type === 'workflow_agent' && entry.skipped), true)
})

test('fallback gate returns timeout details in the actual execution cwd', timeout, async () => {
  const result = await runWorkflow({
    script: script('return await agent.withMeta("gate", { gate: "test", gateTimeoutMs: 1500 })'),
    host: host({
      async spawnAgent(request) { request.onResolved?.({ conversationId: 7, effectiveCwd: '/worktree' }); return { ok: true, text: 'unverified' } },
      async runGate(_command, options) {
        assert.equal(options.cwd, '/worktree')
        assert.equal(options.gateTimeoutMs, 1500)
        return { ok: false, output: '', exitCode: null, timedOut: true }
      },
    }),
  })
  assert.equal(result.status, 'completed', result.error)
  assert.equal((result.value as { timedOut: boolean }).timedOut, true)
  assert.deepEqual((result.value as { gate: unknown }).gate, { ok: false, output: '', exitCode: null, timedOut: true })
})
