import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JournalWriteInput, WorkflowJournalEntry } from '../src/workflow/engine/journal.js'
import { runWorkflow, type WorkflowHost } from '../src/workflow/engine/runtime.js'

const timeout = { timeout: 60_000 } as const
const source = (name: string, body: string) => `export const meta = { name: ${JSON.stringify(name)}, description: 'test' }\n${body}`
function ledger() {
  const entries: WorkflowJournalEntry[] = []
  return {
    entries,
    append(entry: JournalWriteInput) { entries.push({ ...entry, v: 1, seq: entries.length } as WorkflowJournalEntry) },
  }
}
function makeHost(overrides: Partial<WorkflowHost>): WorkflowHost {
  return {
    async spawnAgent() { throw new Error('unexpected spawn') },
    abortAgent() {},
    async invokeAction() { throw new Error('unexpected action') },
    ...overrides,
  }
}

const master = source('master', `
const pair = await parallel([() => workflow('alpha'), () => workflow('beta')])
if (pair.some(value => value === null)) throw new Error('module failed')
return pair
`)

test('a failed concurrent module leaves sibling agents and non-idempotent actions cached across repeated resumes', timeout, async () => {
  const scripts: Record<string, string> = {
    alpha: source('alpha', `await agent('alpha', { label: 'plan' }); return await action('charge', {})`),
    beta: source('beta', `
const plan = await agent('beta', { label: 'plan' })
if (!plan) throw new Error('beta failed')
return [plan, await agent('verify', { resume: 'plan' })]
`),
  }
  let charges = 0
  let firstRun = true
  let betaLiveId = ''
  const spawned: string[] = []
  const resumed: string[] = []
  const host = makeHost({
    loadWorkflow: ref => ({ ok: true, script: scripts[ref.name!]! }),
    async spawnAgent(request) {
      spawned.push(request.prompt)
      request.onResolved?.({ conversationId: spawned.length + 10 })
      if (request.prompt === 'beta') {
        betaLiveId = request.agentId
        return firstRun ? { ok: false, error: 'beta failed' } : { ok: true, text: 'beta fixed' }
      }
      return { ok: true, text: 'alpha done' }
    },
    async resumeAgent(agentId) {
      assert.equal(agentId, betaLiveId, 'same-label resume must use the beta conversation')
      resumed.push(agentId)
      return { ok: true, text: 'verified' }
    },
    async invokeAction(actionId) {
      charges++
      return { pluginId: 'test', actionId, result: { sent: charges } }
    },
  })
  const initialLog = ledger()
  const initial = await runWorkflow({ script: master, host, journal: initialLog })
  assert.equal(initial.status, 'failed')
  assert.equal(charges, 1)
  firstRun = false
  spawned.length = 0
  const recoveryLog = ledger()
  const recovery = await runWorkflow({ script: master, host, journal: { entries: initialLog.entries, append: recoveryLog.append } })
  assert.equal(recovery.status, 'completed', recovery.error)
  assert.deepEqual(recovery.value, [{ sent: 1 }, ['beta fixed', 'verified']])
  assert.deepEqual(spawned, ['beta'])
  assert.equal(resumed.length, 1)
  assert.equal(charges, 1, 'the successful sibling charge must not execute again')
  assert.equal(new Set(recoveryLog.entries.map(entry => entry.index)).size, recoveryLog.entries.length)
  const cached = await runWorkflow({ script: master, host, journal: { entries: recoveryLog.entries } })
  assert.equal(cached.status, 'completed', cached.error)
  assert.deepEqual(cached.value, recovery.value)
  assert.deepEqual(spawned, ['beta'])
  assert.equal(resumed.length, 1)
  assert.equal(charges, 1)
})

test('scope paths survive reversed nested-workflow load completion order', timeout, async () => {
  const run = async (blocked: string, entries?: WorkflowJournalEntry[]) => {
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    let spawns = 0
    const log = ledger()
    const host = makeHost({
      async loadWorkflow(ref) {
        if (ref.name === blocked) await ready
        else release()
        return { ok: true, script: source(ref.name!, `return await agent.withMeta(${JSON.stringify(ref.name)}, { label: 'plan' })`) }
      },
      async spawnAgent(request) {
        spawns++
        assert.equal(entries, undefined, 'restoring must not spawn despite reversed scope creation order')
        request.onResolved?.({ conversationId: request.prompt === 'alpha' ? 21 : 22 })
        return { ok: true, text: request.prompt }
      },
    })
    const result = await runWorkflow({ script: master, host, journal: { entries, append: log.append } })
    return { result, log, spawns }
  }
  const original = await run('alpha')
  assert.equal(original.result.status, 'completed', original.result.error)
  const recovered = await run('beta', original.log.entries)
  assert.equal(recovered.result.status, 'completed', recovered.result.error)
  assert.deepEqual(recovered.result.value, original.result.value)
  assert.equal(recovered.spawns, 0)
})

test('changing a parent agent cannot replay descendant non-idempotent actions under changed upstream state', timeout, async () => {
  let spawns = 0
  let effects = 0
  const host = makeHost({
    loadWorkflow: () => ({ ok: true, script: source('child', `return await action('charge', {})`) }),
    async spawnAgent() { spawns++; return { ok: true, text: 'plan' } },
    async invokeAction(actionId) { effects++; return { pluginId: 'test', actionId, result: 'sent' } },
  })
  const script = (prompt: string) => source('parent', `await agent(${JSON.stringify(prompt)}); return await workflow('child')`)
  const log = ledger()
  assert.equal((await runWorkflow({ script: script('original'), host, journal: log })).status, 'completed')
  const changed = await runWorkflow({ script: script('changed'), host, journal: { entries: log.entries } })
  assert.equal(changed.status, 'failed')
  assert.match(changed.error ?? '', /workflow_action_uncertain/)
  assert.equal(spawns, 1)
  assert.equal(effects, 1)
})
