/**
 * CLI all link test: temporary HTTP server simulated Hub contract (real fetch boundary).
 * verify: path/method/request body/--json/--current/motion state action schema/error message seal/credentials file keep key.
 * simulated is HTTP contract, do not declare call real Hub collection into (without model invoke).
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
import {
  makeCliEnv,
  makeConversationSummary,
  makePluginSummary,
  parseCliError,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

/**
 * credentials file permission assertion: non- Windows strictly assertion POSIX 0600;Windows without POSIX mode
 * (NTFS away ACL,stat.mode do not express 0600), do not assertion pattern, only confirm file store in.
 */
async function assertPrivateCredentialFile(file: string): Promise<void> {
  if (process.platform === 'win32') {
    await fsp.access(file)
    return
  }
  const st = await fsp.stat(file)
  assert.equal(st.mode & 0o777, 0o600)
}

/** repository inside tsx/cli absolute path (across process child process execute TS entry use), self testDir one by one level to on parse. */
function resolveTsxCli(): string {
  const require = createRequire(import.meta.url)
  return require.resolve('tsx/cli')
}

test('setup/login swap token write 0600 cli-token, do not touch providers/pluginSecrets key', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const credFile = path.join(dir, 'credentials.json')
  const tokenFile = path.join(dir, 'cli-token')
  // pre- placement server side structure + extra unknown key (without old cli key): login must not touch this file
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
  // login state in independent cli-token(0600),credentials.json original do not motion
  await assertPrivateCredentialFile(tokenFile)
  const saved = JSON.parse(await fsp.readFile(tokenFile, 'utf8')) as Record<string, unknown>
  assert.deepEqual(saved, { hubUrl: hub.url, token: 'tok-1' })
  assert.equal(await fsp.readFile(credFile, 'utf8'), legacyBefore)
  // env HELM_TOKEN priority high at credentials file
  const r2 = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: 'env-tok' }))
  assert.equal(r2.code, 0, r2.err)
  assert.equal(hub.recorded.hits.at(-1)?.authorization, 'Bearer env-tok')
})

test('conversations list drop noise query contract: default do not carries parameter,--all  all=1,--parent  parent=<id>, illegal combine refuse', { timeout: 60_000 }, async (t) => {
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
  // default: do not carries any query(server side by default only top-level)
  const top = await runCliCaptured(['conversations', 'list', '--json'], env)
  assert.equal(top.code, 0, top.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations')
  // --all: all amount
  const all = await runCliCaptured(['conversations', 'list', '--all', '--json'], env)
  assert.equal(all.code, 0, all.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations?all=1')
  // --parent: precise directly sub-conversation
  const parent = await runCliCaptured(['conversations', 'list', '--parent', '3', '--json'], env)
  assert.equal(parent.code, 0, parent.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations?parent=3')
  // and since has filter dimension stack add (query serialization order:parent first at profileId, and command implement consistent)
  const combo = await runCliCaptured(['conversations', 'list', '--parent', '3', '--profile', 'worker', '--json'], env)
  assert.equal(combo.code, 0, combo.err)
  assert.equal(hub.hits.at(-1)?.path, '/api/conversations?parent=3&profileId=worker')
  // illegal --parent: client directly reject, do not start request
  for (const bad of ['abc', '0', '-1', '2.5']) {
    const res = await runCliCaptured(['conversations', 'list', '--parent', bad, '--json'], env)
    assert.equal(res.code, 1, `--parent ${bad} should errors`)
    assert.ok(res.err.includes('parent'), `errors should mention and parent:${res.err}`)
  }
  assert.equal(hub.hits.filter((h) => h.path.includes('parent=')).length, 2, 'illegal --parent must not start request')
  // --all and --parent mutual exclusion: client reject
  const conflict = await runCliCaptured(['conversations', 'list', '--all', '--parent', '3', '--json'], env)
  assert.equal(conflict.code, 1)
  assert.ok(conflict.err.includes('mutual exclusion'), `errors should note mutual exclusion:${conflict.err}`)
})

test('think Profile CLI pass-through: global part update, when before conversation override and Profile merge', { timeout: 60_000 }, async (t) => {
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

  const conversation = await runCliCaptured(['conversations', 'update', '--current', '--thinking=', '--json'], env)
  assert.equal(conversation.code, 0, conversation.err)
  assert.deepEqual(JSON.parse(conversation.out), { thinkingLevel: '' })

  const profile = await runCliCaptured(['profiles', 'update', 'worker', '--thinking', 'high', '--json'], env)
  assert.equal(profile.code, 0, profile.err)
  assert.deepEqual(JSON.parse(profile.out), { id: 'worker', model: 'faux/model', name: 'Worker', thinkingLevel: 'high' })
})

test('conversations create/send/abort/update/delete path,body and --current', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/conversations': (body) => ({ body: { id: 7, ...(body as object) } }),
      'POST /api/conversations/7/input': (body) => ({ body: { ok: true, echo: body } }),
      'POST /api/conversations/7/abort': () => ({ body: { ok: true } }),
      'PATCH /api/conversations/7': (body) => ({ body: { id: 7, ...(body as object) } }),
      'DELETE /api/conversations/7': () => ({ status: 204 }),
      'DELETE /api/conversations/1': () => ({ status: 409, body: { error: { code: 'conversation_managed_by_plugin', message: 'conversation by enabled plugin hosting, forbidden delete' } } }),
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

  // --model empty string = clear model override (PATCH {model:''}); server side already support,CLI must can express
  const cleared = await runCliCaptured(['conversations', 'update', '7', '--model', '', '--json'], env)
  assert.equal(cleared.code, 0, cleared.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { model: '' })
  const clearedInline = await runCliCaptured(['conversations', 'update', '7', '--model=', '--json'], env)
  assert.equal(clearedInline.code, 0, clearedInline.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { model: '' })
  // normal override still original pass-through
  const overridden = await runCliCaptured(['conversations', 'update', '7', '--model', 'openai/gpt-4o', '--json'], env)
  assert.equal(overridden.code, 0, overridden.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { model: 'openai/gpt-4o' })

  const deleted = await runCliCaptured(['conversations', 'delete', '7', '--json'], env)
  assert.equal(deleted.code, 0, deleted.err)

  // through use plugin manage right 409 error message seal -> stderr JSON + non-zero exit
  const forbidden = await runCliCaptured(['conversations', 'delete', '1', '--json'], env)
  assert.equal(forbidden.code, 1)
  assert.equal(parseCliError(forbidden).code, 'conversation_managed_by_plugin')
})

test('--current missing/illegal explicit ID all explicit errors', { timeout: 60_000 }, async (t) => {
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

test('asks answer send answers JSON and expectedStateSeq', { timeout: 60_000 }, async (t) => {
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

test('skills read direct out {text}, non- JSON pattern original text', { timeout: 60_000 }, async (t) => {
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

test('providers set send complete array;credentials set/delete use REST path', { timeout: 60_000 }, async (t) => {
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

test('motion state action:schema rotate flag, type convert,--input mutual exclusion,cli.command path, conflict errors', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const manifests = [
    {
      pluginId: 'builtin:test', id: 'task.create', description: 'create task',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, maxTokens: { type: 'number' }, tags: { type: 'array' }, dryRun: { type: 'boolean' } }, required: ['title'] },
      outputSchema: { type: 'object' },
      cli: { command: ['tasks', 'create'] },
    },
    {
      pluginId: 'builtin:triggers', id: 'fire', description: 'trigger',
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

  // cli.command override by default path
  const r = await runCliCaptured(['tasks', 'create', '--title', 'T', '--max-tokens', '4096', '--tags', '["a"]', '--dry-run', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(r.out), { created: true })
  const hit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Atest/task.create')!
  assert.deepEqual(hit.body, { input: { title: 'T', maxTokens: 4096, tags: ['a'], dryRun: true } })

  // by default path stripBuiltin
  const fire = await runCliCaptured(['triggers', 'fire', '--json'], env)
  assert.equal(fire.code, 0, fire.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/actions/builtin%3Atriggers/fire')

  // --current attach carries conversationId
  const cur = await runCliCaptured(['triggers', 'fire', '--current', '--json'], { ...env, HELM_CONVERSATION_ID: '3' })
  assert.equal(cur.code, 0, cur.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { input: {}, conversationId: 3 })

  // required missing
  const missing = await runCliCaptured(['tasks', 'create', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'missing_required_flag')

  // unknown flag reject
  const unknown = await runCliCaptured(['tasks', 'create', '--title', 'T', '--bogus', '--json'], env)
  assert.equal(unknown.code, 1)
  assert.equal(parseCliError(unknown).code, 'unknown_flag')

  // --input and property flag mutual exclusion
  const mixed = await runCliCaptured(['tasks', 'create', '--input', '{"title":"x"}', '--title', 'y', '--json'], env)
  assert.equal(mixed.code, 1)
  assert.equal(parseCliError(mixed).code, 'conflicting_flags')

  // --input whole commit (contains schema outside field, server side validate fall back)
  const whole = await runCliCaptured(['tasks', 'create', '--input', '{"title":"x","extra":1}', '--json'], env)
  assert.equal(whole.code, 0, whole.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { input: { title: 'x', extra: 1 } })

  // help contains motion state command
  const help = await runCliCaptured(['--help'], env)
  assert.equal(help.code, 0)
  assert.match(help.out, /tasks create/)
  assert.match(help.out, /triggers fire/)
})

test('motion state command preempt core path when core still execute; invoke motion state path only then reject', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/actions': () => ({
        body: [
          // and core ["conversations","list"] all etc. conflict + and ["asks"] prefix conflict parent path declaration
          { pluginId: 'builtin:evil', id: 'list', description: 'preempt', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, cli: { command: ['conversations', 'list'] } },
          { pluginId: 'builtin:evil', id: 'asks-parent', description: 'preempt parent path', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, cli: { command: ['asks'] } },
        ],
      }),
      'GET /api/conversations': () => ({ body: [{ id: 9 }] }),
      'GET /api/asks': () => ({ body: [] }),
      'POST /api/plugins/builtin%3Aevil/disable': () => ({ body: { ok: true } }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dir)

  // core command precise match i.e. execute: broken plugin conflict declaration must not block assert core manage side (fault isolated).
  // even if motion state declaration preempt parent path ["asks"], core asks list still directly execute, do not pull manifest
  const r = await runCliCaptured(['conversations', 'list', '--json'], env)
  assert.equal(r.code, 0, r.err)
  assert.equal(JSON.parse(r.out)[0]?.id, 9)

  const coreAsks = await runCliCaptured(['asks', 'list', '--json'], env)
  assert.equal(coreAsks.code, 0, coreAsks.err)

  const disable = await runCliCaptured(['plugins', 'disable', 'builtin:evil', '--json'], env)
  assert.equal(disable.code, 0, disable.err)
  assert.equal(hub.recorded.hits.at(-1)?.path, '/api/plugins/builtin%3Aevil/disable')

  // only truly parse motion state command (non- core precise match) when only then pull manifest and explicit reject conflict
  const dyn = await runCliCaptured(['asks', 'bogus', '--json'], env)
  assert.equal(dyn.code, 1)
  assert.equal(parseCliError(dyn).code, 'command_conflict')
})

test('workflows inspect/abort: location parameter mapping runId(motion state action command)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const manifests = [
    {
      pluginId: 'builtin:workflow', id: 'inspect', description: 'view single workflow run detail situation',
      inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { run: { type: 'object' } }, required: ['run'], additionalProperties: false },
      cli: { command: ['workflows', 'inspect'], positional: [{ field: 'runId', required: true }] },
    },
    {
      pluginId: 'builtin:workflow', id: 'abort', description: 'abort workflow run',
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

  // required location parameter missing: explicit missing_positional
  const missing = await runCliCaptured(['workflows', 'inspect', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'missing_positional')

  const abort = await runCliCaptured(['workflows', 'abort', 'run-1', '--json'], env)
  assert.equal(abort.code, 0, abort.err)
  const abortHit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Aworkflow/abort')!
  assert.deepEqual(abortHit.body, { input: { runId: 'run-1' } })
})

test('artifacts: text direct out, two enter system force --output, list away conversation end point', { timeout: 60_000 }, async (t) => {
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

  // person class can read pattern output table (non- JSON)
  const human = await runCliCaptured(['models', 'list'], env)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /provider\s+modelId\s+available/)
  assert.match(human.out, /openai\s+gpt\s+true/)
})

test('models filter: view disable manifest / --disable all amount replace / --clear empty (PUT /api/models/filter)', { timeout: 60_000 }, async (t) => {
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

  // without parameter: render when before directory in disabled model (person class can read group render).
  const listHuman = await runCliCaptured(['models', 'filter'], env)
  assert.equal(listHuman.code, 0, listHuman.err)
  assert.match(listHuman.out, /faux\/faux-2/)

  // without parameter --json: output complete catalog.
  const listJson = await runCliCaptured(['models', 'filter', '--json'], env)
  assert.equal(listJson.code, 0, listJson.err)
  assert.deepEqual(JSON.parse(listJson.out), catalog)

  // --provider + --disable(can duplicate): all amount replace the provider disable collection.
  const disable = await runCliCaptured(
    ['models', 'filter', '--provider', 'faux', '--disable', 'faux-2', '--disable', 'faux-1', '--json'],
    env,
  )
  assert.equal(disable.code, 0, disable.err)
  const lastPut = hub.recorded.hits.at(-1)
  assert.equal(lastPut?.method, 'PUT')
  assert.equal(lastPut?.path, '/api/models/filter')
  assert.deepEqual(lastPut?.body, { provider: 'faux', disabledModels: ['faux-2', 'faux-1'] })

  // --provider + --clear: placement empty the provider disable collection.
  const clear = await runCliCaptured(['models', 'filter', '--provider', 'faux', '--clear', '--json'], env)
  assert.equal(clear.code, 0, clear.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { provider: 'faux', disabledModels: [] })

  // default --clear: empty all (without provider key).
  const clearAll = await runCliCaptured(['models', 'filter', '--clear', '--json'], env)
  assert.equal(clearAll.code, 0, clearAll.err)
  assert.deepEqual(hub.recorded.hits.at(-1)?.body, { disabledModels: [] })

  // without --provider carry --disable: explicit reject (server side same 400,CLI pre- intercept).
  const noProvider = await runCliCaptured(['models', 'filter', '--disable', 'faux-1'], env)
  assert.notEqual(noProvider.code, 0)

  // --clear and --disable mutual exclusion.
  const mutex = await runCliCaptured(['models', 'filter', '--provider', 'faux', '--clear', '--disable', 'faux-1'], env)
  assert.notEqual(mutex.code, 0)
})

test('events watch:SSE snapshot + incremental,--json each row output', { timeout: 60_000 }, async (t) => {
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
        // across chunk crack frame boundary (\r\n and \n mix use,split boundary) verify parse robust
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

test('hub cannot reach and 401 hint login', { timeout: 60_000 }, async (t) => {
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

test('without token when explicit errors (not silently bare run);--json error is legal JSON', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub({ 'GET /api/conversations': () => ({ body: [] }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: undefined }))
  assert.equal(r.code, 1)
  assert.equal(parseCliError(r).code, 'unauthorized')
})

test('unknown command and missing command error code', { timeout: 60_000 }, async (t) => {
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

test('setup --password closed ring;--help without Hub also available', { timeout: 60_000 }, async (t) => {
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

  // --help without Hub available (Hub cannot reach when help still output, motion state command empty hint)
  const help = await runCliCaptured(['--help'], makeCliEnv('http://127.0.0.1:1', dir, { HELM_TOKEN: undefined }))
  assert.equal(help.code, 0)
  assert.match(help.out, /core command/)
})

test('motion state action hidden do not expose command', { timeout: 60_000 }, async (t) => {
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

test('motion state action empty command path and illegal segment explicit errors', { timeout: 60_000 }, async (t) => {
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

test('motion state action property name collide keep flag name when still can invoke (only via --input express)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/actions/builtin%3Atest/odd': () => ({ body: { ok: true } }),
    },
    {
      defaultActions: [
        {
          pluginId: 'builtin:test', id: 'odd', description: 'strange property name',
          inputSchema: { type: 'object', properties: { input: { type: 'string' }, current: { type: 'string' }, title: { type: 'string' } } },
          outputSchema: { type: 'object' },
        },
      ],
      autoRegisterCleanup: t,
    },
  )
  const env = makeCliEnv(hub.url, dir)

  // collide keep name property do not disable the whole action: skip independent flag, via whole --input express
  const r = await runCliCaptured(['test', 'odd', '--input', '{"input":"raw","current":"c","title":"t"}', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Atest/odd')!
  assert.deepEqual(hit.body, { input: { input: 'raw', current: 'c', title: 't' } })

  // help in note these property only can via --input express
  const help = await runCliCaptured(['test', 'odd', '--help'], env)
  assert.equal(help.code, 0)
  assert.match(help.out, /--input/)
  assert.match(help.out, /"input"/)

  // without location parameter semantics: extra location parameter explicit reject, never without sound discard.
  // `--` after token all is literal location parameter (contains --json), reason error is pure text while non- JSON
  const extra = await runCliCaptured(['test', 'odd', 'stray', '--input', '{}', '--json'], env)
  assert.equal(extra.code, 1)
  assert.equal(parseCliError(extra).code, 'unexpected_positional')

  const extraDash = await runCliCaptured(['test', 'odd', '--', 'stray', '--json'], env)
  assert.equal(extraDash.code, 1)
  assert.match(extraDash.err, /redundant location parameter/)
  assert.match(extraDash.err, /stray --json/)
})

test('camelCase and kebab collide name property not silently last-wins, normal property still available flag', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'POST /api/actions/builtin%3Atest/dupe': () => ({ body: { ok: true } }),
    },
    {
      defaultActions: [
        {
          pluginId: 'builtin:test', id: 'dupe', description: 'collide name',
          inputSchema: { type: 'object', properties: { fooBar: { type: 'string' }, 'foo-bar': { type: 'string' }, other: { type: 'string' } } },
          outputSchema: { type: 'object' },
        },
      ],
      autoRegisterCleanup: t,
    },
  )
  const env = makeCliEnv(hub.url, dir)

  // collide name property via whole --input express (two key all original send reach, without losing any a)
  const whole = await runCliCaptured(['test', 'dupe', '--input', '{"fooBar":"camel","foo-bar":"kebab","other":"x"}', '--json'], env)
  assert.equal(whole.code, 0, whole.err)
  const hit = hub.recorded.hits.find((h) => h.path === '/api/actions/builtin%3Atest/dupe')!
  assert.deepEqual((hit.body as { input: unknown }).input, { fooBar: 'camel', 'foo-bar': 'kebab', other: 'x' })

  // not collide name other still available independent flag; and collide name after missing ambiguity --foo-bar flag
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
// credentials and fault isolated regression
// ---------------------------------------------------------------------------

test('cli-token corrupt must not by static default when without credentials; core command explicit errors,--help fall back and diagnose', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  // login state file corrupt: read when must errors while non- when empty (lose is login state, but static default will disguise into not login)
  await fsp.writeFile(path.join(dir, 'cli-token'), '{ broken json !!', 'utf8')
  const hub = await startMockHub({ 'GET /api/conversations': () => ({ body: [] }) }, { autoRegisterCleanup: t })

  // without env token: core command read to corrupt file explicit errors (never static default when without credentials continue run)
  const r = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(r.code, 1)
  assert.equal(parseCliError(r).code, 'credentials_unreadable')

  // env token takes precedence short route disk: corrupt file do not by trigger touch, command per common execute
  const bypass = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(bypass.code, 0, bypass.err)
  assert.equal(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8'), '{ broken json !!')

  // --help: core help still available, credentials issue separate diagnose to stderr(without env token when), do not false call Hub no action
  const help = await runCliCaptured(['--help'], makeCliEnv(hub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(help.code, 0)
  assert.match(help.out, /core command/)
  assert.match(help.err, /CLI credentials file corrupt/)
  assert.doesNotMatch(help.out, /Hub not provide plugin action command/)

  // pure text pattern error same explicit
  const human = await runCliCaptured(['conversations', 'list'], makeCliEnv(hub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(human.code, 1)
  assert.match(human.err, /CLI credentials file corrupt/)
})

test('status without token also can request, has token attach carries (authenticated reverse reflect real state)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  // without any already store token:status do not because missing token report unauthorized
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

  // already store token(cli-token file):status attach carries Authorization,Hub can back real authenticated
  await fsp.writeFile(
    path.join(dir, 'cli-token'),
    JSON.stringify({ hubUrl: hub.url, token: 'tok-status' }),
    { mode: 0o600 },
  )
  const withToken = await runCliCaptured(['status', '--json'], noTokenEnv)
  assert.equal(withToken.code, 0, withToken.err)
  assert.deepEqual(JSON.parse(withToken.out), { configured: true, authenticated: true })
  assert.equal(hub.recorded.hits.at(-1)?.authorization, 'Bearer tok-status')

  // setup/login still explicit anonymous request (do not carries token)
  const hub2 = await startMockHub(
    {
      'POST /api/auth/setup': (_body, req) => {
        assert.equal(req.headers['authorization'], undefined, 'setup must anonymous')
        return { body: { token: 'tok-new' } }
      },
    },
    { autoRegisterCleanup: t },
  )
  const setup = await runCliCaptured(['setup', '--password', 'pw', '--json'], makeCliEnv(hub2.url, dir, { HELM_TOKEN: 'ignored-env' }))
  assert.equal(setup.code, 0, setup.err)
})

test('send respect -- isolate symbol:--json as text send while non- by global strip', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub({ 'POST /api/conversations/1/input': () => ({ body: { ok: true } }) }, { autoRegisterCleanup: t })
  const env = makeCliEnv(hub.url, dir)

  // -- after --json is await send text one part; mention before appear --json still takes effect is global output switch
  const r = await runCliCaptured(['send', '1', '--json', '--', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const hit = hub.recorded.hits.find((h) => h.path === '/api/conversations/1/input')!
  assert.deepEqual((hit.body as { text: string }).text, '--json')
  // -- before --json takes effect: output is JSON
  assert.deepEqual(JSON.parse(r.out), { ok: true })

  // combine flag do not subject to affect
  const normal = await runCliCaptured(['send', '1', 'ordinary text', '--origin', 'agent', '--json'], env)
  assert.equal(normal.code, 0, normal.err)
  assert.deepEqual((hub.recorded.hits.at(-1)?.body as { text: string; origin: string }), { text: 'ordinary text', origin: 'agent' })
})

test('across Hub do not old token:HELM_HUB_URL points to new address when ignore credentials in token', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  // old Hub: credentials file record its address and token
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

  // HELM_HUB_URL change refer new Hub: credentials in old token do not follow row (status anonymous can probe, request indeed out)
  const newEnvNoToken = makeCliEnv(newHub.url, dir, { HELM_TOKEN: undefined })
  const probe = await runCliCaptured(['status', '--json'], newEnvNoToken)
  assert.equal(probe.code, 0, probe.err)
  assert.deepEqual(JSON.parse(probe.out), { configured: true, authenticated: false }, 'new Hub must not receives old Hub  token')
  const leakHit = newHub.recorded.hits.find((h) => h.path === '/api/auth/status')!
  assert.equal(leakHit.authorization, undefined, 'must not old Hub  token to new Hub')

  // must authentication path without token when explicit unauthorized(not silently bare run, also do not use old token patch)
  const leaked = await runCliCaptured(['conversations', 'list', '--json'], newEnvNoToken)
  assert.equal(leaked.code, 1)
  assert.equal(parseCliError(leaked).code, 'unauthorized')

  // explicit HELM_TOKEN still takes precedence (user itself guarantee it belongs to target Hub)
  const explicit = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(newHub.url, dir, { HELM_TOKEN: 'tok-new-hub' }))
  assert.equal(explicit.code, 0, explicit.err)
  assert.equal(newHub.recorded.hits.at(-1)?.authorization, 'Bearer tok-new-hub')

  // without env URL when along use credentials file hubUrl + token(same source consistent)
  const sameHub = await runCliCaptured(['conversations', 'list', '--json'], { HELM_DATA_DIR: dir })
  assert.equal(sameHub.code, 0, sameHub.err)
  assert.equal(oldHub.recorded.hits.at(-1)?.authorization, 'Bearer tok-old-hub')
})

test('first time data directory missing when setup still can credentials (directory first create, lock after add)', { timeout: 60_000 }, async (t) => {
  const parentDir = useTempDir(t, 'helm-cli-fresh-')
  const dir = path.join(parentDir, 'nested-data') // directory missing
  const hub = await startMockHub({ 'POST /api/auth/setup': () => ({ body: { token: 'tok-fresh' } }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(['setup', '--password', 'pw', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: undefined }))
  assert.equal(r.code, 0, r.err)
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as { token: string }
  assert.equal(saved.token, 'tok-fresh')
  await assertPrivateCredentialFile(path.join(dir, 'cli-token'))
  // lock and temp file leaves no residue
  const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes('.lock') || f.includes('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('across process concurrency: real child process CLI write cli-token and Hub CredentialService.set write credentials.json mutual do not interference (connect continue 3 round verify stable)', { timeout: 60_000 }, async (t) => {
  const rootDir = useTempDir(t, 'helm-cli-race-')
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const tsxCli = resolveTsxCli()
  const cliEntry = path.join(repoRoot, 'packages', 'cli', 'src', 'index.ts')

  // CLI child process: real independent Node process login write cli-token(Hub swap token)
  const hub = await startMockHub(
    {
      'POST /api/auth/login': (body) => ({ body: { token: `tok-cli-${(body as { password: string }).password}` } }),
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
  // connect continue many round (each round all new dataDir, directory missing verify first time create): stack add lock competition window, ensure fix after 100% stable
  const ROUNDS = 3
  const { CredentialService } = await import('../../kernel/src/services/index.js')
  for (let round = 0; round < ROUNDS; round++) {
    const dataDir = path.join(rootDir, `round-${round}`)
    // pre- placement server side key, then 4 real CLI child process (write cli-token) and 4 time process inside CredentialService.set(write credentials.json) concurrency
    await fsp.mkdir(dataDir, { recursive: true })
    await fsp.writeFile(path.join(dataDir, 'credentials.json'), JSON.stringify({ providers: {}, pluginSecrets: {} }), { mode: 0o600 })
    const svc = new CredentialService(dataDir)
    await svc.set('base', 'sk-base-0123456789')

    const children: Promise<{ code: number | null; err: string }>[] = Array.from({ length: 4 }, (_, i) => runCliChild(dataDir, `pw-${i}`))
    const serverSets: Promise<void>[] = Array.from({ length: 4 }, (_, i) => svc.set(`provider-${i}`, `sk-value-${i}`))
    const childResults = await Promise.all(children)
    await Promise.all(serverSets)
    for (const r of childResults) {
      assert.equal(r.code, 0, ` ${round + 1}/${ROUNDS} round CLI child process failed: ${r.err}`)
    }

    // model secret key all keep (credentials.json no longer bear load CLI login state);cli-token independent (finally once child process write)
    const final = JSON.parse(await fsp.readFile(path.join(dataDir, 'credentials.json'), 'utf8')) as Record<string, unknown> & {
      providers: Record<string, { value: string }>
    }
    assert.equal(final['cli'], undefined, 'login state must not again write credentials.json')
    const finalToken = JSON.parse(await fsp.readFile(path.join(dataDir, 'cli-token'), 'utf8')) as { hubUrl: string; token: string }
    assert.equal(finalToken.hubUrl, hub.url)
    assert.match(finalToken.token, /^tok-cli-pw-[0-3]$/)
    const ids = await svc.list()
    assert.deepEqual(ids, ['base', 'provider-0', 'provider-1', 'provider-2', 'provider-3'])
    for (let i = 0; i < 4; i++) {
      assert.equal(final.providers[`provider-${i}`]?.value, `sk-value-${i}`)
    }
    // 0600 and without lock/temp file leftover (two file all verify;Windows without POSIX mode only verify store in)
    await assertPrivateCredentialFile(path.join(dataDir, 'credentials.json'))
    await assertPrivateCredentialFile(path.join(dataDir, 'cli-token'))
    const leftovers = (await fsp.readdir(dataDir)).filter((f) => f.includes('.lock') || f.includes('.tmp'))
    assert.deepEqual(leftovers, [])
  }
})

test('origin bind set:cli-token record token only to same source Hub, swap Hub does not carry', { timeout: 60_000 }, async (t) => {
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
  // same source request carry token
  const same = await runCliCaptured(['conversations', 'list', '--json'], { HELM_DATA_DIR: dir, HELM_TOKEN: '' })
  assert.equal(same.code, 0, same.err)
  assert.equal(hub.recorded.hits.at(-1)?.authorization, 'Bearer tok-origin')

  // origin bind set:HELM_HUB_URL points to another Hub when does not carry record token
  const otherHub = await startMockHub(
    {
      'GET /api/auth/status': (_body, req) => ({ body: { configured: true, authenticated: req.headers['authorization'] !== undefined } }),
    },
    { autoRegisterCleanup: t },
  )
  const probe = await runCliCaptured(['status', '--json'], makeCliEnv(otherHub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(probe.code, 0, probe.err)
  assert.deepEqual(JSON.parse(probe.out), { configured: true, authenticated: false }, 'new Hub must not receives old Hub  token')
})

test('cli-token file corrupt when explicit errors;HELM_TOKEN environment variable takes precedence short route disk do not read corrupt file', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub({ 'GET /api/conversations': () => ({ body: [] }) }, { autoRegisterCleanup: t })
  await fsp.writeFile(path.join(dir, 'cli-token'), '{ broken !!', { mode: 0o600 })

  // without env token: corrupt explicit errors (not silently when without credentials)
  const broken = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: '' }))
  assert.equal(broken.code, 1)
  assert.equal(parseCliError(broken).code, 'credentials_unreadable')

  // env token takes precedence: short route disk, corrupt file do not by trigger touch, command per common execute
  const bypass = await runCliCaptured(['conversations', 'list', '--json'], makeCliEnv(hub.url, dir, { HELM_TOKEN: 'env-tok' }))
  assert.equal(bypass.code, 0, bypass.err)
  assert.equal(hub.recorded.hits.at(-1)?.authorization, 'Bearer env-tok')
  assert.equal(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8'), '{ broken !!')
})

// ---------------------------------------------------------------------------
// workflow and core interface align test (original cli-alignment back fill)
// ---------------------------------------------------------------------------

/** builtin:workflow action manifest(and plugin declaration consistent most small contract shape). */
const WF_RUN_MANIFESTS = [
  {
    pluginId: 'builtin:workflow',
    id: 'run',
    description: 'start workflow run',
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
    description: 'column out workflow run record',
    inputSchema: {
      type: 'object',
      properties: { conversationId: { type: 'number' } },
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { runs: { type: 'array' } }, required: ['runs'], additionalProperties: false },
    cli: { command: ['workflows', 'runs'] },
  },
]

test('conversations entry:[id] <entryId>/--current parse and validate', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/conversations/7/entries/42': () => ({
        body: { id: '42', kind: 'pi.tool-result', model: [{ role: 'toolResult', content: [{ type: 'text', text: 'all text' }] }] },
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

  // missing entryId / illegal entryId / missing conversation target: explicit errors (do not request)
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

test('conversations get:--limit/--cursor mapping query;--current read env', { timeout: 60_000 }, async (t) => {
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

  // illegal limit explicit errors (do not request)
  const bad = await runCliCaptured(['conversations', 'get', '7', '--limit', '0', '--json'], env)
  assert.equal(bad.code, 1)
  assert.equal(parseCliError(bad).code, 'invalid_flag_value')
})

test('conversations list:--profile mapping profileId,--status validate enumeration after query', { timeout: 60_000 }, async (t) => {
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

test('send --meta:JSON object body.meta; non- object JSON in CLI layer explicit reject', { timeout: 60_000 }, async (t) => {
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

  // do not provide --meta when body excludes meta key (keep -- isolate symbol text behavior:
  // global --json in -- before strip, after --json as await send text)
  const noMeta = await runCliCaptured(['send', '7', '--json', '--', '--json'], env)
  assert.equal(noMeta.code, 0, noMeta.err)
  assert.deepEqual((hub.hits.at(-1)?.body as { text: string }).text, '--json')
  assert.ok(!('meta' in (hub.hits.at(-1)?.body as Record<string, unknown>)))
})

test('send --wait:?wait=1;json output complete result, person class pattern direct out answer text', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const result = {
    conversationId: 7,
    submissionId: 'sub-9',
    text: '你好',
    entry: {
      id: 'e1',
      kind: 'pi.assistant',
      model: [{ role: 'assistant', content: [{ type: 'text', text: 'answer body text' }] }],
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
  assert.equal(human.out, 'answer body text\n')

  // wait failed (input_unanswered 409)→ non-zero exit + error message seal
  const hub2 = await startMockHub(
    {
      'POST /api/conversations/7/input?wait=1': () => ({
        status: 409,
        body: { error: { code: 'input_unanswered', message: 'input not obtain answer (aborted)' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const failed = await runCliCaptured(['send', '7', 'x', '--wait', '--json'], makeCliEnv(hub2.url, dir))
  assert.equal(failed.code, 1)
  assert.equal(parseCliError(failed).code, 'input_unanswered')
})

test('workflows runs: column out all;--current filter conversationId; redundant location parameter reject', { timeout: 60_000 }, async (t) => {
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
  // --current inject action conversationId context (body.conversationId);
  // server side runs action with it as filter (input.conversationId takes precedence).
  const filteredBody = (hub.hits.at(-1) as { body?: { conversationId?: number } }).body
  assert.equal(filteredBody?.conversationId, 7)

  const stray = await runCliCaptured(['workflows', 'runs', 'wf_1', '--json'], env)
  assert.equal(stray.code, 1)
  assert.equal(parseCliError(stray).code, 'unexpected_positional')
})

test('workflows run --wait: terminal state succeeded output run/result;failed non-zero exit', { timeout: 60_000 }, async (t) => {
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

  // do not carries --wait return run in run
  const asyncRun = await runCliCaptured(['workflows', 'run', workflowName, '--json'], env)
  assert.equal(asyncRun.code, 0, asyncRun.err)
  assert.equal((JSON.parse(asyncRun.out) as { run: { status: string } }).run.status, 'running')

  // failed terminal state:Hub error message seal → non-zero exit (does not empty result when succeeded)
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

test('workflows run: file location parameter read script, name write name,--resume-from-run-id and --args pass-through', { timeout: 60_000 }, async (t) => {
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

  // file location parameter -> readFileInto script
  const byFile = await runCliCaptured(['workflows', 'run', scriptPath, '--json'], env)
  assert.equal(byFile.code, 0, byFile.err)
  let body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
  assert.match(String(body?.input?.script), /name: "f"/)
  assert.equal(body?.input?.name, undefined)

  // ./ prefix but file missing: explicit errors (do not guess contains meaning)
  const missing = await runCliCaptured(['workflows', 'run', './nope.js', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'positional_file_not_found')

  // name (non- path form)-> name field;--resume-from-run-id kebab mapping camelCase
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

  // explicit property flag without going through readFileInto, even if value points to real directory also original hand over to Hub validate.
  const explicitName = await runCliCaptured(['workflows', 'run', '--name', dir, '--json'], env)
  assert.equal(explicitName.code, 0, explicitName.err)
  body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
  assert.equal(body?.input?.name, dir)
  assert.equal(body?.input?.script, undefined)
})

test('plugins doc:GET /api/plugins/:id/docs/:name;json all amount, person class pattern direct out value', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-test-')
  const hub = await startMockHub(
    {
      'GET /api/plugins/builtin%3Astatusboard/docs/board': () => ({
        body: { pluginId: 'builtin:statusboard', name: 'board', value: { count: 42 } },
      }),
      'GET /api/plugins/builtin%3Astatusboard/docs/notes': () => ({
        body: { pluginId: 'builtin:statusboard', name: 'notes', value: 'pure text document' },
      }),
      'GET /api/plugins/builtin%3Astatusboard/docs/secret': () => ({
        status: 404,
        body: { error: { code: 'plugin_doc_not_found', message: 'without public document' } },
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
  assert.equal(textValue.out, 'notes\npure text document\n')

  const missing = await runCliCaptured(['plugins', 'doc', 'builtin:statusboard', 'secret', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'plugin_doc_not_found')

  const noArgs = await runCliCaptured(['plugins', 'doc', 'builtin:statusboard', '--json'], env)
  assert.equal(noArgs.code, 1)
  assert.equal(parseCliError(noArgs).code, 'missing_id')
})

// ---------------------------------------------------------------------------
// credentials lock permission exception (original credentials-lock-errors back fill)
// ---------------------------------------------------------------------------

test('read hold has in credentials lock encounters permission error when explicit failed, and keep lock and credentials', { timeout: 60_000 }, async (t) => {
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
