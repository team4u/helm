/**
 * End-to-end CLI tests against an in-process HTTP mock Hub (real fetch boundary).
 * Verifies paths, methods, request bodies, --json, --current, dynamic action schemas,
 * error envelopes, and private credential file permissions.
 * Mocks the HTTP contract without spawning a full Hub (no model invocations).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { updateCliCredentials } from '../src/credentials.js'
import { CliError } from '../src/errors.js'
import { withTimeout } from '@helm/test-kit'
import {
  deferred,
  makeCliEnv,
  makeConversationSummary,
  makePluginSummary,
  parseCliError,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

/**
 * Asserts private permissions on a credentials file: POSIX enforces 0600; Windows lacks
 * POSIX modes (NTFS uses ACLs, so stat.mode does not represent 0600) and checks file presence only.
 */
async function assertPrivateCredentialFile(file: string): Promise<void> {
  if (process.platform === 'win32') {
    await fsp.access(file)
    return
  }
  const st = await fsp.stat(file)
  assert.equal(st.mode & 0o777, 0o600)
}

/** Resolves the absolute path to tsx/cli inside the workspace for cross-process TS child invocations. */
function resolveTsxCli(): string {
  const require = createRequire(import.meta.url)
  return require.resolve('tsx/cli')
}

test('setup/login exchanges token and writes 0600 cli-token without modifying providers/pluginSecrets', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const credFile = path.join(dir, 'credentials.json')
  const tokenFile = path.join(dir, 'cli-token')
  // Pre-seed server-side structure + extra unknown keys (no legacy cli key): login must not touch this file
  const legacyBefore = `${JSON.stringify({ providers: { openai: 'sk-x' }, pluginSecrets: { herdr: 's' }, futureKey: 1 }, null, 2)}\n`
  await fsp.writeFile(credFile, legacyBefore)
  const hub = await startMockHub(
    {
      'POST /api/auth/login': (body) => {
        assert.deepEqual(body, { password: 'pw' })
        return { body: { token: 'tok-1' } }
      },
      'GET /api/conversations': () => ({ body: [] }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['login', '--password', 'pw', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: undefined }))
  assert.equal(r.code, 0, r.err)
  assert.equal(JSON.parse(r.out).token, 'tok-1')
  // Login state lives in standalone cli-token (0600); credentials.json remains untouched
  await assertPrivateCredentialFile(tokenFile)
  const saved = JSON.parse(await fsp.readFile(tokenFile, 'utf8')) as Record<string, unknown>
  assert.deepEqual(saved, { hubUrl: hub.url, token: 'tok-1' })
  assert.equal(await fsp.readFile(credFile, 'utf8'), legacyBefore)
  // HELM_TOKEN env var takes precedence over credentials file
  const r2 = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: 'env-tok' }))
  assert.equal(r2.code, 0, r2.err)
  assert.equal(hub.recorded.hits.at(-1)?.authorization, 'Bearer env-tok')
})

test('conversations list noise-free query contract: omits default params, --all sets all=1, --parent sets parent=<id>, rejects invalid combinations', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const listBody: unknown[] = []
  const hub = await startMockHub(
    {
      'GET /api/conversations': () => ({ body: listBody }),
      'GET /api/conversations?all=1': () => ({ body: listBody }),
      'GET /api/conversations?parent=3': () => ({ body: listBody }),
      'GET /api/conversations?parent=3&profileId=worker': () => ({ body: listBody }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  // Default: sends no query params (server defaults to top-level conversations)
  const top = await runCliCaptured(['conversations', 'list', '--json'], env)
  assert.equal(top.code, 0, top.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations')
  // --all: requests all conversations
  const all = await runCliCaptured(['conversations', 'list', '--all', '--json'], env)
  assert.equal(all.code, 0, all.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations?all=1')
  // --parent: requests direct child conversations
  const parent = await runCliCaptured(['conversations', 'list', '--parent', '3', '--json'], env)
  assert.equal(parent.code, 0, parent.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations?parent=3')
  // Composes with existing filters (query key order: parent before profileId, matching command implementation)
  const combo = await runCliCaptured(['conversations', 'list', '--parent', '3', '--profile', 'worker', '--json'], env)
  assert.equal(combo.code, 0, combo.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations?parent=3&profileId=worker')
  // Invalid --parent: rejected client-side without sending requests
  for (const bad of ['abc', '0', '-1', '2.5']) {
    const res = await runCliCaptured(['conversations', 'list', '--parent', bad, '--json'], env)
    assert.equal(res.code, 1, `--parent ${bad} should fail`)
    assert.ok(res.err.includes('parent'), `error should mention parent: ${res.err}`)
  }
  assert.equal(hub.hits.filter((h) => h.path.includes('parent=')).length, 2, 'invalid --parent must not trigger a request')
  // --all and --parent are mutually exclusive: rejected client-side
  const conflict = await runCliCaptured(['conversations', 'list', '--all', '--parent', '3', '--json'], env)
  assert.equal(conflict.code, 1)
  assert.ok(conflict.err.includes('mutually exclusive'), `error should note mutual exclusivity: ${conflict.err}`)
})

test('thinkingLevel CLI passthrough: global default, current conversation override, and Profile merge', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-thinking-cli-')
  const hub = await startMockHub(
    {
      'PUT /api/models/default': (body) => ({ body }),
      'PATCH /api/conversations/7': (body) => ({ body }),
      'GET /api/profiles/worker': () => ({ body: { id: 'worker', model: 'faux/model', name: 'Worker' } }),
      'PUT /api/profiles/worker': (body) => ({ body }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '7' })

  const defaults = await runCliCaptured(['models', 'default', '--thinking', 'high', '--json'], env)
  assert.equal(defaults.code, 0, defaults.err)
  assert.deepEqual(JSON.parse(defaults.out), { thinkingLevel: 'high' })

  const compaction = await runCliCaptured(['models', 'default', '--compaction', 'faux/compact-model', '--compaction-thinking', 'low', '--json'], env)
  assert.equal(compaction.code, 0, compaction.err)
  assert.deepEqual(JSON.parse(compaction.out), { compactionModel: 'faux/compact-model', compactionThinkingLevel: 'low' })

  const clearCompaction = await runCliCaptured(['models', 'default', '--compaction=', '--compaction-thinking=', '--json'], env)
  assert.equal(clearCompaction.code, 0, clearCompaction.err)
  assert.deepEqual(JSON.parse(clearCompaction.out), { compactionModel: '', compactionThinkingLevel: '' })

  // Per-model thinking defaults: provider/model=level (modelId may itself contain slashes); empty level clears.
  const perModel = await runCliCaptured(['models', 'default', '--model-thinking', 'openrouter/vendor/nested-model=high', '--json'], env)
  assert.equal(perModel.code, 0, perModel.err)
  assert.deepEqual(JSON.parse(perModel.out), { modelThinking: 'openrouter/vendor/nested-model', modelThinkingLevel: 'high' })

  const perModelClear = await runCliCaptured(['models', 'default', '--model-thinking', 'openrouter/vendor/nested-model=', '--json'], env)
  assert.equal(perModelClear.code, 0, perModelClear.err)
  assert.deepEqual(JSON.parse(perModelClear.out), { modelThinking: 'openrouter/vendor/nested-model', modelThinkingLevel: '' })

  const perModelCombined = await runCliCaptured(['models', 'default', '--thinking', 'low', '--model-thinking', 'faux/faux-1=max', '--json'], env)
  assert.equal(perModelCombined.code, 0, perModelCombined.err)
  assert.deepEqual(JSON.parse(perModelCombined.out), { thinkingLevel: 'low', modelThinking: 'faux/faux-1', modelThinkingLevel: 'max' })

  // Missing '=' is rejected client-side without sending a request.
  const beforeHits = hub.hits.length
  const perModelBad = await runCliCaptured(['models', 'default', '--model-thinking', 'faux/faux-1', '--json'], env)
  assert.equal(perModelBad.code, 1)
  assert.ok(perModelBad.err.includes('model-thinking'), `error should mention model-thinking: ${perModelBad.err}`)
  assert.equal(hub.hits.length, beforeHits, 'invalid --model-thinking must not trigger a request')

  const conversation = await runCliCaptured(['conversations', 'update', '--current', '--thinking=', '--json'], env)
  assert.equal(conversation.code, 0, conversation.err)
  assert.deepEqual(JSON.parse(conversation.out), { thinkingLevel: '' })

  const profile = await runCliCaptured(['profiles', 'update', 'worker', '--thinking', 'high', '--json'], env)
  assert.equal(profile.code, 0, profile.err)
  assert.deepEqual(JSON.parse(profile.out), { id: 'worker', model: 'faux/model', name: 'Worker', thinkingLevel: 'high' })
})

test('conversations create/send/abort/update/delete paths, bodies, and --current', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/conversations': (body) => ({ body: { id: 7, ...(body as object) } }),
      'POST /api/conversations/7/input': (body) => ({ body: { ok: true, echo: body } }),
      'POST /api/conversations/7/abort': () => ({ body: { ok: true } }),
      'PATCH /api/conversations/7': (body) => ({ body: { id: 7, ...(body as object) } }),
      'DELETE /api/conversations/7': () => ({ status: 204 }),
      'DELETE /api/conversations/1': () => ({ status: 409, body: { error: { code: 'conversation_managed_by_plugin', message: 'conversation is managed by an enabled plugin and cannot be deleted' } } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const created = await runCliCaptured(['conversations', 'create', '--title', 'task', '--tags', 'a,b', '--model', 'openai/gpt', '--json'], env)
  assert.equal(created.code, 0, created.err)
  assert.equal(JSON.parse(created.out).id, 7)
  const createHit = hub.recorded.hits.find((h) => h.path === '/api/conversations')!
  assert.deepEqual(createHit.body, { title: 'task', tags: ['a', 'b'], model: 'openai/gpt' })

  const sent = await runCliCaptured(['send', '7', '你好 世界', '--when-busy', 'followUp', '--origin', 'agent', '--json'], env)
  assert.equal(sent.code, 0, sent.err)
  const sendHit = hub.recorded.hits.find((h) => h.path === '/api/conversations/7/input')!
  assert.deepEqual(sendHit.body, { text: '你好 世界', whenBusy: 'followUp', origin: 'agent' })

  const sentCurrent = await runCliCaptured(['send', '--current', 'hi', '--json'], { ...env, HELM_CONVERSATION_ID: '7' })
  assert.equal(sentCurrent.code, 0, sentCurrent.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/conversations/7/input')

  const aborted = await runCliCaptured(['abort', '--current', '--json'], { ...env, HELM_CONVERSATION_ID: '7' })
  assert.equal(aborted.code, 0, aborted.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/conversations/7/abort')

  const updated = await runCliCaptured(['conversations', 'update', '7', '--pinned', '--unread=false', '--json'], env)
  assert.equal(updated.code, 0, updated.err)
  const patchHit = hub.recorded.hits.find((h) => h.method === 'PATCH')!
  assert.deepEqual(patchHit.body, { pinned: true, unread: false })

  // Empty --model clears model override (PATCH { model: '' }); CLI must support both forms
  const cleared = await runCliCaptured(['conversations', 'update', '7', '--model', '', '--json'], env)
  assert.equal(cleared.code, 0, cleared.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { model: '' })
  const clearedInline = await runCliCaptured(['conversations', 'update', '7', '--model=', '--json'], env)
  assert.equal(clearedInline.code, 0, clearedInline.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { model: '' })
  // Normal overrides pass through verbatim
  const overridden = await runCliCaptured(['conversations', 'update', '7', '--model', 'openai/gpt-4o', '--json'], env)
  assert.equal(overridden.code, 0, overridden.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { model: 'openai/gpt-4o' })

  const deleted = await runCliCaptured(['conversations', 'delete', '7', '--json'], env)
  assert.equal(deleted.code, 0, deleted.err)

  // Plugin-managed 409 error envelope -> JSON on stderr + non-zero exit
  const forbidden = await runCliCaptured(['conversations', 'delete', '1', '--json'], env)
  assert.equal(forbidden.code, 1)
  assert.equal(parseCliError(forbidden).code, 'conversation_managed_by_plugin')
})

test('--current missing/invalid and explicit missing IDs fail explicitly', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const missing = await runCliCaptured(['send', '--current', 'x', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'current_conversation_missing')

  const bad = await runCliCaptured(['send', 'abc', 'x', '--json'], env)
  assert.equal(bad.code, 1)
  assert.equal(parseCliError(bad).code, 'invalid_id')

  const none = await runCliCaptured(['abort', '--json'], env)
  assert.equal(none.code, 1)
  assert.equal(parseCliError(none).code, 'missing_conversation_target')
})

test('asks answer sends answers JSON and expectedStateSeq', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/asks/ask-1/answer': () => ({ body: { askId: 'ask-1', answers: {}, answeredAt: 1 } }),
      'GET /api/asks': () => ({ body: [] }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['asks', 'answer', 'ask-1', '--answers', '{"field":"value"}', '--expected-state-seq', '10', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  const hit = hub.recorded.hits.find((h) => h.path === '/api/asks/ask-1/answer')!
  assert.deepEqual(hit.body, { answers: { field: 'value' }, expectedStateSeq: 10 })
})

test('skills read prints {text} directly as raw text in non-JSON mode', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/skills/demo': () => ({ body: { text: '# title\ncontent' } }),
      'GET /api/skills/demo?path=references%2Fguide.md': () => ({ body: { text: 'manual content' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const text = await runCliCaptured(['skills', 'read', 'demo'], env)
  assert.equal(text.code, 0, text.err)
  assert.ok(text.out.startsWith('# title'))

  const sub = await runCliCaptured(['skills', 'read', 'demo', '--path', 'references/guide.md', '--json'], env)
  assert.equal(sub.code, 0, sub.err)
  const hit = hub.recorded.hits.at(-1)!
  assert.equal(hit.path, '/api/skills/demo?path=references%2Fguide.md')
  assert.deepEqual(JSON.parse(sub.out), { text: 'manual content' })
})

test('providers set sends full array; credentials set/delete use REST paths', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/providers': () => ({ body: [] }),
      'PUT /api/providers': () => ({ body: [] }),
      'GET /api/credentials': () => ({ body: [{ id: 'openai', configured: true }] }),
      'PUT /api/credentials/openai': () => ({ body: { ok: true } }),
      'DELETE /api/credentials/openai': () => ({ status: 204 }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const providers = '[{"id":"gw","protocol":"openai","baseUrl":"https://x","models":["m"],"enabled":true}]'
  const set = await runCliCaptured(['providers', 'set', '--input', providers, '--json'], env)
  assert.equal(set.code, 0, set.err)
  const hit = hub.recorded.hits.find((h) => h.method === 'PUT' && h.path === '/api/providers')!
  assert.ok(Array.isArray(hit.body))

  const cred = await runCliCaptured(['credentials', 'set', 'openai', '--value', 'sk-1', '--json'], env)
  assert.equal(cred.code, 0, cred.err)
  assert.deepEqual(hub.recorded.hits.find((h) => h.path === '/api/credentials/openai')?.body, { value: 'sk-1' })

  const del = await runCliCaptured(['credentials', 'delete', 'openai', '--json'], env)
  assert.equal(del.code, 0, del.err)
})

test('dynamic actions: schema-to-flags, type coercion, --input mutual exclusion, cli.command path, conflict error', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const manifests = [
    {
      pluginId: 'builtin:test', id: 'task.create', description: 'Create task',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, maxTokens: { type: 'number' }, tags: { type: 'array' }, dryRun: { type: 'boolean' } }, required: ['title'] },
      outputSchema: { type: 'object' },
      cli: { command: ['tasks', 'create'] },
    },
    {
      pluginId: 'builtin:triggers', id: 'fire', description: 'Trigger action',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
    },
  ]
  const hub = await startMockHub(
    {
      'POST /api/actions/builtin%3Atest/task.create': () => ({ body: { created: true } }),
      'POST /api/actions/builtin%3Atriggers/fire': () => ({ body: { fired: true } }),
    },
    { defaultActions: manifests, autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // cli.command overrides the default path
  const r = await runCliCaptured(['tasks', 'create', '--title', 'T', '--max-tokens', '4096', '--tags', '["a"]', '--dry-run', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(r.out), { created: true })
  const hit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Atest/task.create')!
  assert.deepEqual(hit.body, { input: { title: 'T', maxTokens: 4096, tags: ['a'], dryRun: true } })

  // Default path strips builtin: prefix
  const fire = await runCliCaptured(['triggers', 'fire', '--json'], env)
  assert.equal(fire.code, 0, fire.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/actions/builtin%3Atriggers/fire')

  // --current attaches conversationId
  const cur = await runCliCaptured(['triggers', 'fire', '--current', '--json'], { ...env, HELM_CONVERSATION_ID: '3' })
  assert.equal(cur.code, 0, cur.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { input: {}, conversationId: 3 })

  // Missing required flag
  const missing = await runCliCaptured(['tasks', 'create', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'missing_required_flag')

  // Rejects unknown flags
  const unknown = await runCliCaptured(['tasks', 'create', '--title', 'T', '--bogus', '--json'], env)
  assert.equal(unknown.code, 1)
  assert.equal(parseCliError(unknown).code, 'unknown_flag')

  // --input and property flags are mutually exclusive
  const mixed = await runCliCaptured(['tasks', 'create', '--input', '{"title":"x"}', '--title', 'y', '--json'], env)
  assert.equal(mixed.code, 1)
  assert.equal(parseCliError(mixed).code, 'conflicting_flags')

  // --input passes full payload verbatim (server validates fields outside schema)
  const whole = await runCliCaptured(['tasks', 'create', '--input', '{"title":"x","extra":1}', '--json'], env)
  assert.equal(whole.code, 0, whole.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { input: { title: 'x', extra: 1 } })

  // Help lists dynamic commands
  const help = await runCliCaptured(['--help'], env)
  assert.equal(help.code, 0)
  assert.match(help.out, /tasks create/)
  assert.match(help.out, /triggers fire/)
})

test('core commands still execute when dynamic commands attempt to shadow core paths; conflicts only fail dynamic invocations', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/actions': () => ({
        body: [
          // Exact collision with core ["conversations", "list"] + prefix collision with ["asks"] parent path
          { pluginId: 'builtin:evil', id: 'list', description: 'shadow', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, cli: { command: ['conversations', 'list'] } },
          { pluginId: 'builtin:evil', id: 'asks-parent', description: 'shadow parent path', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, cli: { command: ['asks'] } },
        ],
      }),
      'GET /api/conversations': () => ({ body: [{ id: 9 }] }),
      'GET /api/asks': () => ({ body: [] }),
      'POST /api/plugins/builtin%3Aevil/disable': () => ({ body: { ok: true } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // Core commands match and execute directly: broken plugins cannot break the core control plane (fault isolation).
  // Even when a dynamic manifest claims parent path ["asks"], `helm asks list` runs directly without fetching manifests.
  const r = await runCliCaptured(['conversations', 'list', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.equal(JSON.parse(r.out)[0]?.id, 9)

  const coreAsks = await runCliCaptured(['asks', 'list', '--json'], env)
  assert.equal(coreAsks.code, 0, coreAsks.err)

  const disable = await runCliCaptured(['plugins', 'disable', 'builtin:evil', '--json'], env)
  assert.equal(disable.code, 0, disable.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/plugins/builtin%3Aevil/disable')

  // Only dynamic command resolution (non-core paths) fetches manifests and explicitly rejects the conflict
  const dyn = await runCliCaptured(['asks', 'bogus', '--json'], env)
  assert.equal(dyn.code, 1)
  assert.equal(parseCliError(dyn).code, 'command_conflict')
})

test('workflows inspect/abort: positional argument maps to runId (dynamic action command)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const manifests = [
    {
      pluginId: 'builtin:workflow', id: 'inspect', description: 'Inspect a workflow run',
      inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { run: { type: 'object' } }, required: ['run'], additionalProperties: false },
      cli: { command: ['workflows', 'inspect'], positional: [{ field: 'runId', required: true }] },
    },
    {
      pluginId: 'builtin:workflow', id: 'abort', description: 'Abort a workflow run',
      inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { run: { type: 'object' } }, required: ['run'], additionalProperties: false },
      cli: { command: ['workflows', 'abort'], positional: [{ field: 'runId', required: true }] },
    },
  ]
  const hub = await startMockHub(
    {
      'POST /api/actions/builtin%3Aworkflow/inspect': () => ({ body: { run: { id: 'run-1', status: 'completed' } } }),
      'POST /api/actions/builtin%3Aworkflow/abort': () => ({ body: { run: { id: 'run-1', status: 'aborted' } } }),
    },
    { defaultActions: manifests, autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const inspect = await runCliCaptured(['workflows', 'inspect', 'run-1', '--json'], env)
  assert.equal(inspect.code, 0, inspect.err)
  const inspectHit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Aworkflow/inspect')!
  assert.deepEqual(inspectHit.body, { input: { runId: 'run-1' } })
  assert.equal((JSON.parse(inspect.out) as { run: { status: string } }).run.status, 'completed')

  // Missing required positional: explicit missing_positional
  const missing = await runCliCaptured(['workflows', 'inspect', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'missing_positional')

  const abort = await runCliCaptured(['workflows', 'abort', 'run-1', '--json'], env)
  assert.equal(abort.code, 0, abort.err)
  const abortHit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Aworkflow/abort')!
  assert.deepEqual(abortHit.body, { input: { runId: 'run-1' } })
})

test('artifacts: streams text directly, requires --output for binary, lists via conversation endpoint', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/conversations/3/artifacts': () => ({ body: [{ id: 'a1', conversationId: 3, kind: 'upload', name: 'out.txt', path: 'artifacts/3/out.txt', mimeType: 'text/plain', size: 3, createdAt: 0 }] }),
      'GET /api/artifacts/a1/content': (_body, req) => {
        const accept = req.headers['accept'] ?? ''
        void accept
        return { body: 'abc' }
      },
      'GET /api/artifacts/a2/content': () => ({ body: '' }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '3' })

  const list = await runCliCaptured(['artifacts', 'list', '--current', '--json'], env)
  assert.equal(list.code, 0, list.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/conversations/3/artifacts')
  assert.equal(JSON.parse(list.out)[0]?.id, 'a1')

  const text = await runCliCaptured(['artifacts', 'get', 'a1'], env)
  assert.equal(text.code, 0, text.err)
  assert.equal(text.out, 'abc\n')
})

test('search,models,plugins,actions list,status', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/search?q=hello%20world': () => ({ body: [{ id: 1 }] }),
      'GET /api/models': () => ({ body: { models: [{ provider: 'openai', modelId: 'gpt', available: true }, { provider: 'anthropic', modelId: 'sonnet', available: true }], thinkingLevels: {} } }),
      'GET /api/models/providers': () => ({ body: [{ id: 'deepseek', name: 'DeepSeek', modelCount: 2, authMethods: [{ type: 'api_key', label: 'API Key' }] }] }),
      'POST /api/models/refresh': (body) => ({
        body: {
          providers: (body as { provider?: string }).provider !== undefined ? [(body as { provider: string }).provider] : [],
          aborted: false,
          errors: {},
          models: [{ provider: 'magpie', modelId: 'magpie-1', available: true }],
          providerCatalog: [],
        },
      }),
      'GET /api/plugins': () => ({ body: [makePluginSummary({ id: 'builtin:profile', name: 'assistant', locked: true })] }),
      'POST /api/plugins/builtin%3Aherdr/disable': () => ({ body: { ok: 1 } }),
      'GET /api/plugins/builtin%3Aherdr/config': () => ({ body: { values: { a: 1 }, schema: {} } }),
      'PUT /api/plugins/builtin%3Aherdr/config': (body) => {
        assert.deepEqual((body as { values: unknown }).values, { a: 2 })
        return { body: { values: { a: 2 }, schema: {} } }
      },
      'GET /api/auth/status': () => ({ body: { configured: true, authenticated: false } }),
      'GET /api/conversations/1': () => ({
        body: makeConversationSummary({ id: 1, title: 'assist', cwd: '/', model: 'm', completionSeq: 1, createdAt: 0, updatedAt: 0 }),
      }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const s = await runCliCaptured(['search', 'hello', 'world', '--json'], env)
  assert.equal(s.code, 0, s.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/search?q=hello%20world')

  const m = await runCliCaptured(['models', 'list', '--json'], env)
  assert.equal(m.code, 0, m.err)
  assert.deepEqual(JSON.parse(m.out), { models: [{ provider: 'openai', modelId: 'gpt', available: true }, { provider: 'anthropic', modelId: 'sonnet', available: true }], thinkingLevels: {} })

  const providers = await runCliCaptured(['models', 'providers', '--json'], env)
  assert.equal(providers.code, 0, providers.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/models/providers')
  assert.equal(JSON.parse(providers.out)[0]?.id, 'deepseek')

  const refreshAll = await runCliCaptured(['models', 'refresh', '--json'], env)
  assert.equal(refreshAll.code, 0, refreshAll.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/models/refresh')
  assert.deepEqual(JSON.parse(refreshAll.out).providers, [])

  const refreshOne = await runCliCaptured(['models', 'refresh', '--provider', 'magpie', '--json'], env)
  assert.equal(refreshOne.code, 0, refreshOne.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/models/refresh')
  assert.deepEqual((hub.recorded.hits.at(-1)?.body as { provider?: string }).provider, 'magpie')
  assert.deepEqual(JSON.parse(refreshOne.out).providers, ['magpie'])
  assert.deepEqual(JSON.parse(refreshOne.out).models, [{ provider: 'magpie', modelId: 'magpie-1', available: true }])

  const p = await runCliCaptured(['plugins', 'list', '--json'], env)
  assert.equal(p.code, 0, p.err)
  assert.equal(JSON.parse(p.out)[0]?.id, 'builtin:profile')

  const d = await runCliCaptured(['plugins', 'disable', 'builtin:herdr', '--json'], env)
  assert.equal(d.code, 0, d.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/plugins/builtin%3Aherdr/disable')

  const cfg = await runCliCaptured(['plugins', 'config', 'builtin:herdr', '--input', '{"a":2}', '--json'], env)
  assert.equal(cfg.code, 0, cfg.err)
  assert.equal(hub.recorded.hits.at(-1)?.method, 'PUT')
  assert.deepEqual(JSON.parse(cfg.out), { values: { a: 2 }, schema: {} })

  const cfgGet = await runCliCaptured(['plugins', 'config', 'builtin:herdr', '--json'], env)
  assert.equal(cfgGet.code, 0, cfgGet.err)
  assert.deepEqual(JSON.parse(cfgGet.out), { values: { a: 1 }, schema: {} })

  const convGet = await runCliCaptured(['conversations', 'get', '1', '--json'], env)
  assert.equal(convGet.code, 0, convGet.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/conversations/1')

  const st = await runCliCaptured(['status', '--json'], env)
  assert.equal(st.code, 0, st.err)
  assert.deepEqual(JSON.parse(st.out), { configured: true, authenticated: false })

  // Human-readable table output (non-JSON)
  const human = await runCliCaptured(['models', 'list'], env)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /provider\s+modelId\s+available/)
  assert.match(human.out, /openai\s+gpt\s+true/)
})

test('models filter: lists disabled models / --disable full-replace / --clear resets (PUT /api/models/filter)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const catalog = {
    models: [
      { provider: 'faux', modelId: 'faux-1', available: true },
      { provider: 'faux', modelId: 'faux-2', available: true, disabled: true },
    ],
    thinkingLevels: {},
  }
  const hub = await startMockHub(
    {
      'GET /api/models': () => ({ body: catalog }),
      'PUT /api/models/filter': () => ({ body: { ok: true, catalog } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // No arguments: shows currently disabled models (human-readable grouped formatting).
  const listHuman = await runCliCaptured(['models', 'filter'], env)
  assert.equal(listHuman.code, 0, listHuman.err)
  assert.match(listHuman.out, /faux\/faux-2/)

  // No arguments with --json: outputs full catalog.
  const listJson = await runCliCaptured(['models', 'filter', '--json'], env)
  assert.equal(listJson.code, 0, listJson.err)
  assert.deepEqual(JSON.parse(listJson.out), catalog)

  // --provider + --disable (repeatable): replaces disabled models for that provider.
  const disable = await runCliCaptured(
    ['models', 'filter', '--provider', 'faux', '--disable', 'faux-2', '--disable', 'faux-1', '--json'],
    env,
  )
  assert.equal(disable.code, 0, disable.err)
  const lastPut = hub.recorded.hits.at(-1)
  assert.equal(lastPut?.method, 'PUT')
  assert.equal(lastPut?.path, '/api/models/filter')
  assert.deepEqual(lastPut?.body, { provider: 'faux', disabledModels: ['faux-2', 'faux-1'] })

  // --provider + --clear: clears disabled models for that provider.
  const clear = await runCliCaptured(['models', 'filter', '--provider', 'faux', '--clear', '--json'], env)
  assert.equal(clear.code, 0, clear.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { provider: 'faux', disabledModels: [] })

  // Standalone --clear: clears all disabled models (omits provider key).
  const clearAll = await runCliCaptured(['models', 'filter', '--clear', '--json'], env)
  assert.equal(clearAll.code, 0, clearAll.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { disabledModels: [] })

  // --disable without --provider: explicitly rejected client-side (server also returns 400).
  const noProvider = await runCliCaptured(['models', 'filter', '--disable', 'faux-1'], env)
  assert.notEqual(noProvider.code, 0)

  // --clear and --disable are mutually exclusive.
  const mutex = await runCliCaptured(['models', 'filter', '--provider', 'faux', '--clear', '--disable', 'faux-1'], env)
  assert.notEqual(mutex.code, 0)
})

test('events watch: SSE snapshot + deltas, --json emits one line per event', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const snapshot = {
    bootId: '00000000-0000-0000-0000-000000000001',
    seq: 5,
    conversations: [makeConversationSummary({ id: 1, title: 'assist', cwd: '/', model: 'm', completionSeq: 1, createdAt: 0, updatedAt: 0 })],
    pendingAsks: [],
    plugins: [],
  }
  const hub = await startMockHub(
    {
      'GET /api/events': (_body, _req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        // Split across chunk and CRLF/LF boundaries to verify parser robustness
        res.write(`event: snapshot\r\ndata: ${JSON.stringify(snapshot)}\r\n\r`)
        res.write(`\nevent: conversation.upsert\ndata: ${JSON.stringify({ seq: 6, event: { type: 'conversation.upsert', conversation: { id: 1, title: 'assist', status: 'working' } } })}\n\n`)
        res.write(': keepalive\n\n')
        res.write(`event: notification\ndata: ${JSON.stringify({ seq: 7, event: { type: 'notification', level: 'info', title: 'hi' } })}\n\n`)
        res.end()
        return null
      },
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const json = await runCliCaptured(['events', 'watch', '--json'], env)
  assert.equal(json.code, 0, json.err)
  const lines = json.out.trim().split('\n').map((l) => JSON.parse(l) as { seq?: number })
  assert.equal(lines[0]?.seq, 5)
  assert.equal(lines[1]?.seq, 6)
  assert.equal(lines[2]?.seq, 7)

  const human = await runCliCaptured(['events', 'watch'], env)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /snapshot seq=5/)
  assert.match(human.out, /conversation\.upsert/)
  assert.match(human.out, /notification/)
})

test('hub unreachable and 401 suggest login', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const unreachable = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv('http://127.0.0.1:1', dir, { HELM_TOKEN: 'x' }))
  assert.equal(unreachable.code, 1)
  assert.equal(parseCliError(unreachable).code, 'hub_unreachable')

  const hub = await startMockHub(
    {
      'GET /api/conversations': () => ({ status: 401, body: { error: { code: 'unauthorized', message: 'token invalid' } } }),
    },
    { autoRegisterCleanup: t },
  )
  const unauth = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(unauth.code, 1)
  const err = parseCliError(unauth)
  assert.equal(err.code, 'unauthorized')
  assert.match(err.message, /helm login/)
})

test('fails explicitly without a token (no silent unauthenticated fallback); --json outputs valid error JSON', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub({ 'GET /api/conversations': () => ({ body: [] }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: undefined }))
  assert.equal(r.code, 1)
  assert.equal(parseCliError(r).code, 'unauthorized')
})

test('unknown and missing commands return dedicated error codes', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub({}, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  const unknown = await runCliCaptured(['bogus', 'cmd', '--json'], env)
  assert.equal(unknown.code, 1)
  assert.equal(parseCliError(unknown).code, 'unknown_command')

  const empty = await runCliCaptured(['--json'], env)
  assert.equal(empty.code, 1)
  assert.equal(parseCliError(empty).code, 'missing_command')

  const partial = await runCliCaptured(['conversations', '--json'], env)
  assert.equal(partial.code, 1)
  assert.equal(parseCliError(partial).code, 'unknown_command')
})

test('setup --password end-to-end; --help works even when Hub is offline', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/auth/setup': (body) => {
        assert.deepEqual(body, { password: 'stdin-pw' })
        return { body: { token: 'tok-2' } }
      },
    },
    { autoRegisterCleanup: t },
  )
  const viaFlag = await runCliCaptured(['setup', '--password', 'stdin-pw', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(viaFlag.code, 0, viaFlag.err)
  assert.equal(JSON.parse(viaFlag.out).token, 'tok-2')
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(saved, { hubUrl: hub.url, token: 'tok-2' })

  // --help works offline (prints core help when Hub is unreachable, noting empty dynamic commands)
  const help = await runCliCaptured(['--help'], makeCliEnv('http://127.0.0.1:1', dir, { HELM_TOKEN: undefined }))
  assert.equal(help.code, 0)
  assert.match(help.out, /Core commands/)
})

test('hidden dynamic actions do not expose commands', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {},
    {
      defaultActions: [{ pluginId: 'builtin:test', id: 'internal', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, cli: { hidden: true } }],
      autoRegisterCleanup: t,
    },
  )
  const r = await runCliCaptured(['test', 'internal', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 1)
  assert.equal(parseCliError(r).code, 'unknown_command')
})

test('dynamic actions with empty command path or invalid segments fail explicitly', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {},
    {
      defaultActions: [{ pluginId: 'builtin:test', id: 'bad', description: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, cli: { command: [] } }],
      autoRegisterCleanup: t,
    },
  )
  const r = await runCliCaptured(['anything', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 1)
  assert.equal(parseCliError(r).code, 'invalid_command_path')
})

test('dynamic actions whose properties collide with reserved flag names remain invokable via --input', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/actions/builtin%3Atest/odd': () => ({ body: { ok: true } }),
    },
    {
      defaultActions: [
        {
          pluginId: 'builtin:test', id: 'odd', description: 'odd property names',
          inputSchema: { type: 'object', properties: { input: { type: 'string' }, current: { type: 'string' }, title: { type: 'string' } } },
          outputSchema: { type: 'object' },
        },
      ],
      autoRegisterCleanup: t,
    },
  )
  const env = makeCliEnv(hub.url, dir)

  // Colliding reserved property names do not disable the action: individual flags are skipped, --input passes them through
  const r = await runCliCaptured(['test', 'odd', '--input', '{"input":"raw","current":"c","title":"t"}', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Atest/odd')!
  assert.deepEqual(hit.body, { input: { input: 'raw', current: 'c', title: 't' } })

  // Help notes that these properties are only writable via --input
  const help = await runCliCaptured(['test', 'odd', '--help'], env)
  assert.equal(help.code, 0)
  assert.match(help.out, /--input/)
  assert.match(help.out, /"input"/)

  // Without positional semantics: extra positionals fail explicitly rather than being silently dropped.
  // All tokens after `--` are literal positionals (including `--json`), so the error outputs plain text.
  const extra = await runCliCaptured(['test', 'odd', 'stray', '--input', '{}', '--json'], env)
  assert.equal(extra.code, 1)
  assert.equal(parseCliError(extra).code, 'unexpected_positional')

  const extraDash = await runCliCaptured(['test', 'odd', '--', 'stray', '--json'], env)
  assert.equal(extraDash.code, 1)
  assert.match(extraDash.err, /unexpected positional argument/)
  assert.match(extraDash.err, /stray --json/)
})

test('camelCase vs kebab-case property collision fails safely instead of last-wins while preserving non-colliding flags', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/actions/builtin%3Atest/dupe': () => ({ body: { ok: true } }),
    },
    {
      defaultActions: [
        {
          pluginId: 'builtin:test', id: 'dupe', description: 'colliding names',
          inputSchema: { type: 'object', properties: { fooBar: { type: 'string' }, 'foo-bar': { type: 'string' }, other: { type: 'string' } } },
          outputSchema: { type: 'object' },
        },
      ],
      autoRegisterCleanup: t,
    },
  )
  const env = makeCliEnv(hub.url, dir)

  // Colliding properties are still writable via --input (both keys transmitted verbatim)
  const whole = await runCliCaptured(['test', 'dupe', '--input', '{"fooBar":"camel","foo-bar":"kebab","other":"x"}', '--json'], env)
  assert.equal(whole.code, 0, whole.err)
  const hit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Atest/dupe')!
  assert.deepEqual((hit.body as { input: unknown }).input, { fooBar: 'camel', 'foo-bar': 'kebab', other: 'x' })

  // Non-colliding `other` still gets its own flag, while ambiguous `--foo-bar` is omitted
  const partial = await runCliCaptured(['test', 'dupe', '--other', 'y', '--json'], env)
  assert.equal(partial.code, 0, partial.err)
  assert.deepEqual((hub.recorded.hits.at(-1)?.body as { input: unknown }).input, { other: 'y' })

  const ambiguous = await runCliCaptured(['test', 'dupe', '--foo-bar', 'z', '--json'], env)
  assert.equal(ambiguous.code, 1)
  assert.equal(parseCliError(ambiguous).code, 'unknown_flag')

  const help = await runCliCaptured(['test', 'dupe', '--help'], env)
  assert.equal(help.code, 0)
  assert.match(help.out, /fooBar/)
})

// ---------------------------------------------------------------------------
// Credentials & fault isolation regressions
// ---------------------------------------------------------------------------

test('corrupt cli-token does not fall back to unauthenticated; core commands fail explicitly, --help still renders with diagnostic', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  // Corrupt token file: reads must error instead of pretending the user is simply logged out
  await fsp.writeFile(path.join(dir, 'cli-token'), '{ broken json !!', 'utf8')
  const hub = await startMockHub({ 'GET /api/conversations': () => ({ body: [] }) }, { autoRegisterCleanup: t })

  // Without env token: core command reads corrupt file and fails explicitly (never falls back silently)
  const r = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(r.code, 1)
  assert.equal(parseCliError(r).code, 'credentials_unreadable')

  // Env token short-circuits disk reads: corrupt file is left untouched and command runs normally
  const bypass = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(bypass.code, 0, bypass.err)
  assert.equal(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8'), '{ broken json !!')

  // --help: core help still prints, credential error goes to stderr (without env token), and avoids misleading "no dynamic actions" text
  const help = await runCliCaptured(['--help'], makeCliEnv(hub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(help.code, 0)
  assert.match(help.out, /Core commands/)
  assert.match(help.err, /CLI credentials file is corrupt/)
  assert.doesNotMatch(help.out, /Hub provided no plugin action commands/)

  // Human mode surfaces the exact credential error
  const human = await runCliCaptured(['conversations', 'list'], makeCliEnv(hub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(human.code, 1)
  assert.match(human.err, /CLI credentials file is corrupt/)
})

test('status works without a token and attaches token when present to report real authentication state', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  // Without stored token: status must not fail with unauthorized
  const hub = await startMockHub(
    {
      'GET /api/auth/status': (_body, req) => ({ body: { configured: true, authenticated: req.headers['authorization'] !== undefined } }),
    },
    { autoRegisterCleanup: t },
  )
  const noTokenEnv = makeCliEnv(hub.url, dir, { HELM_TOKEN: undefined })

  const noToken = await runCliCaptured(['status', '--json'], noTokenEnv)
  assert.equal(noToken.code, 0, noToken.err)
  assert.deepEqual(JSON.parse(noToken.out), { configured: true, authenticated: false })
  assert.equal(hub.recorded.hits.at(-1)?.authorization, undefined)

  // With stored token in cli-token: status attaches Authorization and reports authenticated: true
  await fsp.writeFile(
    path.join(dir, 'cli-token'),
    JSON.stringify({ hubUrl: hub.url, token: 'tok-status' }),
    { mode: 0o600 },
  )
  const withToken = await runCliCaptured(['status', '--json'], noTokenEnv)
  assert.equal(withToken.code, 0, withToken.err)
  assert.deepEqual(JSON.parse(withToken.out), { configured: true, authenticated: true })
  assert.equal(hub.recorded.hits.at(-1)?.authorization, 'Bearer tok-status')

  // setup/login always send unauthenticated requests (strip Authorization header)
  const hub2 = await startMockHub(
    {
      'POST /api/auth/setup': (_body, req) => {
        assert.equal(req.headers['authorization'], undefined, 'setup must be unauthenticated')
        return { body: { token: 'tok-new' } }
      },
    },
    { autoRegisterCleanup: t },
  )
  const setup = await runCliCaptured(['setup', '--password', 'pw', '--json'], makeCliEnv(hub2.url, dir, { HELM_TOKEN: 'ignored-env' }))
  assert.equal(setup.code, 0, setup.err)
})

test('send honors -- separator: --json after -- is sent as message text rather than parsed globally', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub({ 'POST /api/conversations/1/input': () => ({ body: { ok: true } }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  // --json after -- belongs to the message text; --json before -- enables global JSON output
  const r = await runCliCaptured(['send', '1', '--json', '--', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.recorded.hits.find((h) => h.path === '/api/conversations/1/input')!
  assert.deepEqual((hit.body as { text: string }).text, '--json')
  // --json before -- takes effect: outputs JSON
  assert.deepEqual(JSON.parse(r.out), { ok: true })

  // Composing flags works normally
  const normal = await runCliCaptured(['send', '1', 'plain text', '--origin', 'agent', '--json'], env)
  assert.equal(normal.code, 0, normal.err)
  assert.deepEqual((hub.recorded.hits.at(-1)?.body as { text: string; origin: string }), { text: 'plain text', origin: 'agent' })
})

test('cross-Hub isolation: ignores stored token when HELM_HUB_URL points to a different Hub', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  // Old Hub: credentials file stores its hubUrl and token
  const oldHub = await startMockHub(
    {
      'POST /api/auth/login': () => ({ body: { token: 'tok-old-hub' } }),
      'GET /api/conversations': () => ({ body: [] }),
    },
    { autoRegisterCleanup: t },
  )
  const newHub = await startMockHub(
    {
      'GET /api/auth/status': (_body, req) => ({
        body: { configured: true, authenticated: req.headers['authorization'] !== undefined },
      }),
      'GET /api/conversations': () => ({ body: [] }),
    },
    { autoRegisterCleanup: t },
  )

  const login = await runCliCaptured(['login', '--password', 'pw', '--json'], makeCliEnv(oldHub.url, dir, { HELM_TOKEN: undefined }))
  assert.equal(login.code, 0, login.err)
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as { hubUrl: string; token: string }
  assert.equal(saved.hubUrl, oldHub.url)
  assert.equal(saved.token, 'tok-old-hub')

  // When HELM_HUB_URL points to newHub: old token is not sent across Hubs
  const newEnvNoToken = makeCliEnv(newHub.url, dir, { HELM_TOKEN: undefined })
  const probe = await runCliCaptured(['status', '--json'], newEnvNoToken)
  assert.equal(probe.code, 0, probe.err)
  assert.deepEqual(JSON.parse(probe.out), { configured: true, authenticated: false }, 'new Hub must not receive old Hub token')
  const leakHit = newHub.recorded.hits.find((h) => h.path === '/api/auth/status')!
  assert.equal(leakHit.authorization, undefined, 'must not leak old Hub token to new Hub')

  // Authenticated routes fail explicitly with unauthorized (no unauthenticated fallback or stale token reuse)
  const leaked = await runCliCaptured(['conversations', 'list', '--json'], newEnvNoToken)
  assert.equal(leaked.code, 1)
  assert.equal(parseCliError(leaked).code, 'unauthorized')

  // Explicit HELM_TOKEN still takes precedence
  const explicit = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(newHub.url, dir, { HELM_TOKEN: 'tok-new-hub' }))
  assert.equal(explicit.code, 0, explicit.err)
  assert.equal(newHub.recorded.hits.at(-1)?.authorization, 'Bearer tok-new-hub')

  // Without env URL: uses credentials file hubUrl + token consistently
  const sameHub = await runCliCaptured(['conversations', 'list', '--json'], { HELM_DATA_DIR: dir })
  assert.equal(sameHub.code, 0, sameHub.err)
  assert.equal(oldHub.recorded.hits.at(-1)?.authorization, 'Bearer tok-old-hub')
})

test('setup persists credentials even when data directory does not exist yet (creates dir before acquiring lock)', { timeout: 60_000 }, async (t) => {
  const parentDir = useTempDir(t, 'helm-cli-fresh-')
  const dir = path.join(parentDir, 'nested-data') // Directory does not exist yet
  const hub = await startMockHub({ 'POST /api/auth/setup': () => ({ body: { token: 'tok-fresh' } }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(['setup', '--password', 'pw', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: undefined }))
  assert.equal(r.code, 0, r.err)
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as { token: string }
  assert.equal(saved.token, 'tok-fresh')
  await assertPrivateCredentialFile(path.join(dir, 'cli-token'))
  // No leftover lock or temp files
  const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes('.lock') || f.includes('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('cross-process concurrency: child CLI cli-token writes and Hub credentials.json writes do not interfere when login responses are released together', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helm-cli-race-')
  const contenders = 4
  const arrived = deferred()
  const release = deferred()
  let loginsInFlight = 0
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const tsxCli = resolveTsxCli()
  const cliEntry = path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts')

  // Synchronize real CLI processes at the point just before they persist cli-token.
  const hub = await startMockHub(
    {
      'POST /api/auth/login': async (body) => {
        if (++loginsInFlight === contenders) arrived.resolve()
        await release.promise
        return { body: { token: `tok-cli-${(body as { password: string }).password}` } }
      },
    },
    { autoRegisterCleanup: t },
  )
  const runCliChild = (dataDir: string, password: string): Promise<{ code: number | null; err: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [tsxCli, cliEntry, 'login', '--password', password, '--json'], {
        env: { ...process.env, ...makeCliEnv(hub.url, dataDir, { HELM_TOKEN: '' }) },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let err = ''
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')))
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, err }))
    })
  const { CredentialService } = await import('../../kernel/src/services/index.js')
  const svc = new CredentialService(dataDir)
  await svc.set('base', 'sk-base-0123456789')

  const children = Array.from({ length: contenders }, (_, i) => runCliChild(dataDir, `pw-${i}`))
  try {
    await withTimeout(Promise.race([
      arrived.promise,
      ...children.map((child) => child.then(({ err }) => assert.fail(`CLI exited before the login barrier: ${err}`))),
    ]), 15_000, 'all CLI children must reach the login barrier')
    const serverSets = Array.from({ length: contenders }, (_, i) => svc.set(`provider-${i}`, `sk-value-${i}`))
    release.resolve()
    const [childResults] = await Promise.all([Promise.all(children), Promise.all(serverSets)])
    for (const result of childResults) assert.equal(result.code, 0, result.err)
  } finally {
    release.resolve()
    await Promise.allSettled(children)
  }

  // Provider secrets stay intact (credentials.json no longer carries CLI login state); cli-token holds the last child's token
  const final = JSON.parse(await fsp.readFile(path.join(dataDir, 'credentials.json'), 'utf8')) as Record<string, unknown> & {
    providers: Record<string, { value: string }>
  }
  assert.equal(final['cli'], undefined, 'login state must not be written into credentials.json')
  const finalToken = JSON.parse(await fsp.readFile(path.join(dataDir, 'cli-token'), 'utf8')) as { hubUrl: string; token: string }
  assert.equal(finalToken.hubUrl, hub.url)
  assert.match(finalToken.token, /^tok-cli-pw-[0-3]$/)
  const ids = await svc.list()
  assert.deepEqual(ids, ['base', 'provider-0', 'provider-1', 'provider-2', 'provider-3'])
  for (let i = 0; i < contenders; i++) {
    assert.equal(final.providers[`provider-${i}`]?.value, `sk-value-${i}`)
  }
  // 0600 permissions and no leftover lock/temp files (Windows has no POSIX mode, verifies existence only)
  await assertPrivateCredentialFile(path.join(dataDir, 'credentials.json'))
  await assertPrivateCredentialFile(path.join(dataDir, 'cli-token'))
  const leftovers = (await fsp.readdir(dataDir)).filter((f) => f.includes('.lock') || f.includes('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('origin binding: cli-token only authenticates the matching Hub and omits token when targeting another Hub', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/auth/login': () => ({ body: { token: 'tok-origin' } }),
      'GET /api/conversations': () => ({ body: [] }),
    },
    { autoRegisterCleanup: t },
  )
  const login = await runCliCaptured(['login', '--password', 'pw', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(login.code, 0, login.err)
  const tokenFile = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(tokenFile, { hubUrl: hub.url, token: 'tok-origin' })
  await assertPrivateCredentialFile(path.join(dir, 'cli-token'))
  // Matching origin carries token
  const same = await runCliCaptured(['conversations', 'list', '--json'], { HELM_DATA_DIR: dir, HELM_TOKEN: '' })
  assert.equal(same.code, 0, same.err)
  assert.equal(hub.recorded.hits.at(-1)?.authorization, 'Bearer tok-origin')

  // Origin binding: omits stored token when HELM_HUB_URL points to a different Hub
  const otherHub = await startMockHub(
    {
      'GET /api/auth/status': (_body, req) => ({ body: { configured: true, authenticated: req.headers['authorization'] !== undefined } }),
    },
    { autoRegisterCleanup: t },
  )
  const probe = await runCliCaptured(['status', '--json'], makeCliEnv(otherHub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(probe.code, 0, probe.err)
  assert.deepEqual(JSON.parse(probe.out), { configured: true, authenticated: false }, 'new Hub must not receive old Hub token')
})

test('corrupt cli-token errors explicitly; HELM_TOKEN env var bypasses disk reads', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub({ 'GET /api/conversations': () => ({ body: [] }) }, { autoRegisterCleanup: t })
  await fsp.writeFile(path.join(dir, 'cli-token'), '{ broken !!', { mode: 0o600 })

  // Without env token: corrupt file errors explicitly instead of falling back to unauthenticated
  const broken = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(broken.code, 1)
  assert.equal(parseCliError(broken).code, 'credentials_unreadable')

  // Env token takes precedence: skips disk reads so corrupt file is untouched and command runs normally
  const bypass = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: 'env-tok' }))
  assert.equal(bypass.code, 0, bypass.err)
  assert.equal(hub.recorded.hits.at(-1)?.authorization, 'Bearer env-tok')
  assert.equal(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8'), '{ broken !!')
})

// ---------------------------------------------------------------------------
// Workflow & core API alignment tests
// ---------------------------------------------------------------------------

/** Action manifest for builtin:workflow (minimal contract matching plugin declaration). */
const WF_RUN_MANIFESTS = [
  {
    pluginId: 'builtin:workflow',
    id: 'run',
    description: 'Start a workflow run',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        script: { type: 'string' },
        args: {},
        resumeFromRunId: { type: 'string' },
        conversationId: { type: 'number' },
        wait: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { run: { type: 'object' } }, required: ['run'], additionalProperties: false },
    cli: {
      command: ['workflows', 'run'],
      positional: [{ field: 'name', readFileInto: 'script' }],
      timeoutMs: 0,
    },
  },
  {
    pluginId: 'builtin:workflow',
    id: 'runs',
    description: 'List workflow runs',
    inputSchema: {
      type: 'object',
      properties: { conversationId: { type: 'number' } },
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { runs: { type: 'array' } }, required: ['runs'], additionalProperties: false },
    cli: { command: ['workflows', 'runs'] },
  },
]

test('conversations entry: parses and validates [id] <entryId> and --current', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/conversations/7/entries/42': () => ({
        body: { id: '42', kind: 'pi.tool-result', model: [{ role: 'toolResult', content: [{ type: 'text', text: 'full text' }] }] },
      }),
      'GET /api/conversations/9/entries/42': () => ({ body: { id: '42', kind: 'pi.assistant' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const envCurrent = makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '9' })

  const explicit = await runCliCaptured(['conversations', 'entry', '7', '42', '--json'], env)
  assert.equal(explicit.code, 0, explicit.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations/7/entries/42')
  assert.equal(JSON.parse(explicit.out).id, '42')

  const current = await runCliCaptured(['conversations', 'entry', '--current', '42', '--json'], envCurrent)
  assert.equal(current.code, 0, current.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations/9/entries/42')

  const currentFlag = await runCliCaptured(['conversations', 'entry', '--current', '42', '--json'], envCurrent)
  assert.equal(currentFlag.code, 0, currentFlag.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations/9/entries/42')

  // Missing entryId / invalid entryId / missing conversation target: fail explicitly without sending a request
  const noEntry = await runCliCaptured(['conversations', 'entry', '7', '--json'], env)
  assert.equal(noEntry.code, 1)
  assert.equal(parseCliError(noEntry).code, 'missing_conversation_target')

  const badEntry = await runCliCaptured(['conversations', 'entry', '7', 'abc', '--json'], env)
  assert.equal(badEntry.code, 1)
  assert.equal(parseCliError(badEntry).code, 'invalid_id')

  const zero = await runCliCaptured(['conversations', 'entry', '7', '0', '--json'], env)
  assert.equal(zero.code, 1)
  assert.equal(parseCliError(zero).code, 'invalid_id')

  const extra = await runCliCaptured(['conversations', 'entry', '7', '42', 'x', '--json'], env)
  assert.equal(extra.code, 1)
})

test('conversations get: --limit/--cursor map to query params; --current reads env var', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/conversations/7': () => ({
        body: { id: 7, title: 'x', entries: [], nextCursor: '{"a":1}' },
      }),
      'GET /api/conversations/7?limit=10': () => ({ body: { id: 7, entries: [] } }),
      'GET /api/conversations/7?cursor=%7B%22a%22%3A1%7D': () => ({ body: { id: 7, entries: [] } }),
      'GET /api/conversations/7?limit=10&cursor=%7B%22a%22%3A1%7D': () => ({ body: { id: 7, entries: [] } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const plain = await runCliCaptured(['conversations', 'get', '7', '--json'], env)
  assert.equal(plain.code, 0, plain.err)
  assert.equal(JSON.parse(plain.out).id, 7)

  const limited = await runCliCaptured(['conversations', 'get', '7', '--limit', '10', '--json'], env)
  assert.equal(limited.code, 0, limited.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations/7?limit=10')

  const cursor = await runCliCaptured(['conversations', 'get', '7', '--cursor', '{"a":1}', '--json'], env)
  assert.equal(cursor.code, 0, cursor.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations/7?cursor=%7B%22a%22%3A1%7D')

  const both = await runCliCaptured(
    ['conversations', 'get', '--current', '--limit', '10', '--cursor', '{"a":1}', '--json'],
    makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '7' }),
  )
  assert.equal(both.code, 0, both.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations/7?limit=10&cursor=%7B%22a%22%3A1%7D')

  // Invalid limit fails explicitly without sending request
  const bad = await runCliCaptured(['conversations', 'get', '7', '--limit', '0', '--json'], env)
  assert.equal(bad.code, 1)
  assert.equal(parseCliError(bad).code, 'invalid_flag_value')
})

test('conversations list: --profile maps to profileId and --status validates against enum', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/conversations': () => ({ body: [] }),
      'GET /api/conversations?profileId=worker': () => ({ body: [] }),
      'GET /api/conversations?status=idle': () => ({ body: [] }),
      'GET /api/conversations?profileId=worker&status=working': () => ({ body: [] }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const byProfile = await runCliCaptured(['conversations', 'list', '--profile', 'worker', '--json'], env)
  assert.equal(byProfile.code, 0, byProfile.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations?profileId=worker')

  const byStatus = await runCliCaptured(['conversations', 'list', '--status', 'idle', '--json'], env)
  assert.equal(byStatus.code, 0, byStatus.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations?status=idle')

  const both = await runCliCaptured(['conversations', 'list', '--profile', 'worker', '--status', 'working', '--json'], env)
  assert.equal(both.code, 0, both.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations?profileId=worker&status=working')

  const bad = await runCliCaptured(['conversations', 'list', '--status', 'bogus', '--json'], env)
  assert.equal(bad.code, 1)
  assert.equal(parseCliError(bad).code, 'invalid_flag_value')
})

test('send --meta: passes JSON object as body.meta; rejects non-object JSON at CLI boundary', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/conversations/7/input': () => ({ status: 202, body: { submissionId: 'sub-9' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const ok = await runCliCaptured(['send', '7', '你好', '--meta', '{"source":"cron","n":1}', '--json'], env)
  assert.equal(ok.code, 0, ok.err)
  const hit = hub.hits.find((h) => h.path === '/api/conversations/7/input')!
  assert.deepEqual(hit.body, { text: '你好', meta: { source: 'cron', n: 1 } })

  const asArray = await runCliCaptured(['send', '7', 'x', '--meta', '[1]', '--json'], env)
  assert.equal(asArray.code, 1)
  assert.equal(parseCliError(asArray).code, 'invalid_flag_value')

  // Omits meta key when --meta is not provided (preserving -- separator semantics: --json before -- is stripped, after -- stays in text)
  const noMeta = await runCliCaptured(['send', '7', '--json', '--', '--json'], env)
  assert.equal(noMeta.code, 0, noMeta.err)
  assert.deepEqual((hub.hits.at(-1)?.body as { text: string }).text, '--json')
  assert.ok(!('meta' in (hub.hits.at(-1)?.body as Record<string, unknown>)))
})

test('send --wait: uses ?wait=1; --json returns full result, human mode prints answer text', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const result = {
    conversationId: 7,
    submissionId: 'sub-9',
    text: '你好',
    entry: {
      id: 'e1',
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'text', text: 'answer body' }] }],
    },
  }
  const hub = await startMockHub(
    {
      'POST /api/conversations/7/input?wait=1': () => ({ body: result }),
      'POST /api/conversations/7/input': () => ({ status: 202, body: { submissionId: 'sub-9' } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const json = await runCliCaptured(['send', '7', '你好', '--wait', '--json'], env)
  assert.equal(json.code, 0, json.err)
  assert.deepEqual(JSON.parse(json.out), result)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations/7/input?wait=1')

  const human = await runCliCaptured(['send', '7', '你好', '--wait'], env)
  assert.equal(human.code, 0, human.err)
  assert.equal(human.out, 'answer body\n')

  // Wait failure (input_unanswered 409) -> non-zero exit + error envelope
  const hub2 = await startMockHub(
    {
      'POST /api/conversations/7/input?wait=1': () => ({
        status: 409,
        body: { error: { code: 'input_unanswered', message: 'input did not receive an answer (aborted)' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const failed = await runCliCaptured(['send', '7', 'x', '--wait', '--json'], makeCliEnv(hub2.url, dir))
  assert.equal(failed.code, 1)
  assert.equal(parseCliError(failed).code, 'input_unanswered')
})

test('workflows runs: lists all runs, --current filters by conversationId, extra positionals rejected', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/actions/builtin%3Aworkflow/runs': (body) => {
        const input = (body as { input?: { conversationId?: number } }).input ?? {}
        return {
          body:
            input.conversationId === 7
              ? { runs: [] }
              : { runs: [{ id: 'wf_1', name: 'demo', conversationId: 1, status: 'completed', createdAt: 1, updatedAt: 1 }] },
        }
      },
    },
    { defaultActions: WF_RUN_MANIFESTS, autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const all = await runCliCaptured(['workflows', 'runs', '--json'], env)
  assert.equal(all.code, 0, all.err)
  assert.equal((JSON.parse(all.out) as { runs: Array<{ id: string }> }).runs[0]?.id, 'wf_1')
  assert.equal(hub.hits.at(-1)?.path, '/api/actions/builtin%3Aworkflow/runs')

  const filtered = await runCliCaptured(['workflows', 'runs', '--current', '--json'], { ...env, HELM_CONVERSATION_ID: '7' })
  assert.equal(filtered.code, 0, filtered.err)
  // --current injects conversationId context (body.conversationId);
  // server runs action uses it as filter (input.conversationId takes precedence).
  const filteredBody = (hub.hits.at(-1) as { body?: { conversationId?: number } }).body
  assert.equal(filteredBody?.conversationId, 7)

  const stray = await runCliCaptured(['workflows', 'runs', 'wf_1', '--json'], env)
  assert.equal(stray.code, 1)
  assert.equal(parseCliError(stray).code, 'unexpected_positional')
})

test('workflows run --wait: prints run/result on success and exits non-zero on failure', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const workflowName = `saved-${path.basename(dir)}`
  const doneRun = {
    id: 'wf_w',
    name: workflowName,
    conversationId: 1,
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
    result: { answer: 42 },
  }
  const hub = await startMockHub(
    {
      'POST /api/actions/builtin%3Aworkflow/run': (body) => {
        const input = (body as { input?: { wait?: boolean } }).input ?? {}
        if (input.wait === true) return { body: { run: doneRun } }
        return {
          status: 200,
          body: { run: { id: 'wf_w', name: workflowName, conversationId: 1, status: 'running', createdAt: 1, updatedAt: 1 } },
        }
      },
    },
    { defaultActions: WF_RUN_MANIFESTS, autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const json = await runCliCaptured(['workflows', 'run', workflowName, '--wait', '--json'], env)
  assert.equal(json.code, 0, json.err)
  assert.deepEqual((JSON.parse(json.out) as { run: unknown }).run, doneRun)
  const waitBody = (hub.hits.at(-1) as { body?: { input?: { wait?: boolean; name?: string } } }).body
  assert.equal(waitBody?.input?.wait, true)
  assert.equal(waitBody?.input?.name, workflowName)

  const human = await runCliCaptured(['workflows', 'run', workflowName, '--wait'], env)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /wf_w/)
  assert.match(human.out, /42/)

  // Without --wait, returns running run immediately
  const asyncRun = await runCliCaptured(['workflows', 'run', workflowName, '--json'], env)
  assert.equal(asyncRun.code, 0, asyncRun.err)
  assert.equal((JSON.parse(asyncRun.out) as { run: { status: string } }).run.status, 'running')

  // Failure terminal state: Hub error envelope -> non-zero exit (never mistakes empty result for success)
  const hub2 = await startMockHub(
    {
      'POST /api/actions/builtin%3Aworkflow/run': () => ({
        status: 500,
        body: { error: { code: 'workflow_failed', message: 'boom', details: { runId: 'wf_f', status: 'failed' } } },
      }),
    },
    { defaultActions: WF_RUN_MANIFESTS, autoRegisterCleanup: t },
  )
  const failed = await runCliCaptured(['workflows', 'run', workflowName, '--wait', '--json'], makeCliEnv(hub2.url, dir))
  assert.equal(failed.code, 1)
  assert.equal(parseCliError(failed).code, 'workflow_failed')
})

test('workflows run: file positional reads script, name positional sets name, passes --resume-from-run-id and --args', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const workflowName = `saved-${path.basename(dir)}`
  const hub = await startMockHub(
    {
      'POST /api/actions/builtin%3Aworkflow/run': () => ({ body: { run: { id: 'wf_x', status: 'running' } } }),
    },
    { defaultActions: WF_RUN_MANIFESTS, autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)
  const scriptPath = path.join(dir, 'demo.workflow.js')
  await fsp.writeFile(scriptPath, 'export const meta = { name: "f" }\nreturn 1\n', 'utf8')

  // File positional -> readFileInto script
  const byFile = await runCliCaptured(['workflows', 'run', scriptPath, '--json'], env)
  assert.equal(byFile.code, 0, byFile.err)
  let body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
  assert.match(String(body?.input?.script), /name: "f"/)
  assert.equal(body?.input?.name, undefined)

  // Missing file with ./ prefix fails explicitly (never falls back to name)
  const missing = await runCliCaptured(['workflows', 'run', './nope.js', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'positional_file_not_found')

  // Plain name (non-path) -> name field; kebab-case --resume-from-run-id maps to camelCase
  const byName = await runCliCaptured(
    ['workflows', 'run', workflowName, '--args', JSON.stringify({ x: 1 }), '--resume-from-run-id', 'wf_prev', '--json'],
    env,
  )
  assert.equal(byName.code, 0, byName.err)
  body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
  assert.equal(body?.input?.name, workflowName)
  assert.equal(body?.input?.script, undefined)
  assert.deepEqual(body?.input?.args, { x: 1 })
  assert.equal(body?.input?.resumeFromRunId, 'wf_prev')

  // Explicit --name flag bypasses readFileInto even if it matches a real directory, delegating validation to Hub
  const explicitName = await runCliCaptured(['workflows', 'run', '--name', dir, '--json'], env)
  assert.equal(explicitName.code, 0, explicitName.err)
  body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
  assert.equal(body?.input?.name, dir)
  assert.equal(body?.input?.script, undefined)
})

test('plugins doc: GET /api/plugins/:id/docs/:name; --json returns full envelope, human mode prints value', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/plugins/builtin%3Astatusboard/docs/board': () => ({
        body: { pluginId: 'builtin:statusboard', name: 'board', value: { count: 42 } },
      }),
      'GET /api/plugins/builtin%3Astatusboard/docs/notes': () => ({
        body: { pluginId: 'builtin:statusboard', name: 'notes', value: 'plain text document' },
      }),
      'GET /api/plugins/builtin%3Astatusboard/docs/secret': () => ({
        status: 404,
        body: { error: { code: 'plugin_doc_not_found', message: 'document not published' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  const json = await runCliCaptured(['plugins', 'doc', 'builtin:statusboard', 'board', '--json'], env)
  assert.equal(json.code, 0, json.err)
  assert.deepEqual(JSON.parse(json.out), { pluginId: 'builtin:statusboard', name: 'board', value: { count: 42 } })

  const human = await runCliCaptured(['plugins', 'doc', 'builtin:statusboard', 'board'], env)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /count/)
  assert.match(human.out, /42/)

  const textValue = await runCliCaptured(['plugins', 'doc', 'builtin:statusboard', 'notes'], env)
  assert.equal(textValue.code, 0, textValue.err)
  assert.equal(textValue.out, 'notes\nplain text document\n')

  const missing = await runCliCaptured(['plugins', 'doc', 'builtin:statusboard', 'secret', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'plugin_doc_not_found')

  const noArgs = await runCliCaptured(['plugins', 'doc', 'builtin:statusboard', '--json'], env)
  assert.equal(noArgs.code, 1)
  assert.equal(parseCliError(noArgs).code, 'missing_id')
})

// ---------------------------------------------------------------------------
// Credential lock permission error handling
// ---------------------------------------------------------------------------

test('fails explicitly on permission error reading existing credential lock while preserving lock and token files', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-lock-error-')
  const lockPath = path.join(dir, 'cli-token.lock')
  const tokenPath = path.join(dir, 'cli-token')
  const owner = `${process.pid} existing-owner\n`
  await fsp.writeFile(lockPath, owner)
  await fsp.writeFile(tokenPath, 'original')
  const readFile = fsp.readFile.bind(fsp)
  const stub = t.mock.method(fsp, 'readFile', async (...args: Parameters<typeof fsp.readFile>) => {
    if (String(args[0]) === lockPath) throw Object.assign(new Error('access denied'), { code: 'EACCES' })
    return readFile(...args)
  })
  try {
    await assert.rejects(updateCliCredentials(dir, { token: 'replacement' }), (error: unknown) =>
      error instanceof CliError && error.code === 'credentials_lock_failed')
    stub.mock.restore()
    assert.equal(await readFile(lockPath, 'utf8'), owner)
    assert.equal(await readFile(tokenPath, 'utf8'), 'original')
    assert.deepEqual((await fsp.readdir(dir)).sort(), ['cli-token', 'cli-token.lock'])
  } finally {
    stub.mock.restore()
  }
})
