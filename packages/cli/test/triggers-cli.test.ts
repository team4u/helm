/**
 * builtin:triggers CLI top-level command mapping test (cron/webhook).
 *
 * and cli.test.ts same discipline: temporary HTTP server simulated Hub contract (real fetch boundary),
 * manifest by already confirm plugin action contract construct (seven action + cli.command semantics path),
 * verify motion state command generate top-level `helm cron ...` / `helm webhook ...`,flag convert,
 * --json,--current and error message seal. simulated is HTTP contract; real Hub end-to-end collection into
 * by main proxy in implement together after run (kernel/test/triggers.test.ts override host side).
 *
 * runner: tsx --test; each items explicit timeout: 60_000.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ActionManifest } from '@helm/protocol'
import {
  makeCliEnv,
  parseCliError,
  runCliCaptured,
  startMockHub,
  useTempDir,
  type CleanupRegistrar,
  type MockHubHandle,
  type MockRouteHandler,
} from './helpers/cli-harness.js'

const TRIGGER_ACTION_IDS = [
  'cron_list',
  'cron_create',
  'cron_delete',
  'cron_trigger',
  'webhook_list',
  'webhook_create',
  'webhook_delete',
] as const

/** contract manifest: and plugin implement same schema(field name/type one one for should). */
function triggersManifests(): ActionManifest[] {
  const cronTarget = {
    targetConversationId: { type: 'number' },
    targetProfileId: { type: 'string' },
    threadKey: { type: 'string' },
  }
  return [
    {
      pluginId: 'builtin:triggers',
      id: 'cron_list',
      description: 'column out cron task',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
      cli: { command: ['cron', 'list'] },
    },
    {
      pluginId: 'builtin:triggers',
      id: 'cron_create',
      description: 'create cron task',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          schedule: { type: 'string' },
          text: { type: 'string' },
          description: { type: 'string' },
          timezone: { type: 'string' },
          enabled: { type: 'boolean' },
          catchUp: { type: 'boolean' },
          ...cronTarget,
        },
        required: ['id', 'schedule', 'text'],
      },
      outputSchema: { type: 'object' },
      cli: { command: ['cron', 'create'] },
    },
    {
      pluginId: 'builtin:triggers',
      id: 'cron_delete',
      description: 'delete cron task',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: { type: 'object' },
      cli: { command: ['cron', 'delete'] },
    },
    {
      pluginId: 'builtin:triggers',
      id: 'cron_trigger',
      description: 'manually trigger once cron task (explicit new event, non- plan patch run)',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: { type: 'object' },
      cli: { command: ['cron', 'trigger'] },
    },
    {
      pluginId: 'builtin:triggers',
      id: 'webhook_list',
      description: 'column out webhook',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
      cli: { command: ['webhook', 'list'] },
    },
    {
      pluginId: 'builtin:triggers',
      id: 'webhook_create',
      description: 'create webhook(secret only human HTTP/CLI config, do not via model forwarding)',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          secret: { type: 'string' },
          description: { type: 'string' },
          targetConversationId: { type: 'number' },
          targetProfileId: { type: 'string' },
          threadKey: { type: 'string' },
        },
        required: ['id', 'secret'],
      },
      outputSchema: { type: 'object' },
      cli: { command: ['webhook', 'create'] },
    },
    {
      pluginId: 'builtin:triggers',
      id: 'webhook_delete',
      description: 'delete webhook',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: { type: 'object' },
      cli: { command: ['webhook', 'delete'] },
    },
  ]
}

/** start carries builtin:triggers action contract simulated Hub. */
async function startTriggersHub(
  t: CleanupRegistrar,
  actionResponse?: (actionId: string, body: unknown) => { status?: number; body?: unknown },
): Promise<MockHubHandle> {
  const routes: Record<string, MockRouteHandler> = Object.fromEntries(
    TRIGGER_ACTION_IDS.map((actionId) => [
      `POST /api/actions/builtin%3Atriggers/${actionId}`,
      (body: unknown) => actionResponse?.(actionId, body) ?? { body: { ok: true, action: actionId } },
    ]),
  )
  return startMockHub(routes, { defaultActions: triggersManifests(), autoRegisterCleanup: t })
}

test('cron sub- command family: top-level path, required validate, type convert and --json', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-triggers-cli-')
  const hub = await startTriggersHub(t, (actionId, body) => {
    if (actionId === 'cron_list') return { body: { jobs: [{ id: 'nightly', schedule: '0 3 * * *', text: 'aggregate', timezone: 'UTC', enabled: true, catchUp: false, nextRunAt: null }] } }
    if (actionId === 'cron_create') return { body: { job: (body as { input: object }).input } }
    if (actionId === 'cron_delete') return { body: { deleted: true } }
    return { body: { triggered: true } }
  })
  const env = makeCliEnv(hub.url, dir)

  // cron list --json
  const list = await runCliCaptured(['cron', 'list', '--json'], env)
  assert.equal(list.code, 0, list.err)
  assert.equal(JSON.parse(list.out).jobs[0]?.id, 'nightly')
  assert.equal(hub.hits.at(-1)?.path, '/api/actions/builtin%3Atriggers/cron_list')

  // cron create: required + optional all amount (boolean/number/string each type via flag convert)
  const created = await runCliCaptured(
    [
      'cron', 'create',
      '--id', 'ci-watch',
      '--schedule', '*/5 * * * *',
      '--text', 'check CI state and gather report',
      '--description', 'five minute inspection',
      '--timezone', 'Asia/Shanghai',
      '--catch-up',
      '--target-conversation-id', '7',
      '--thread-key', 'ci-main',
    ],
    env,
  )
  assert.equal(created.code, 0, created.err)
  const hit = hub.hits.find((h) => h.path === '/api/actions/builtin%3Atriggers/cron_create')!
  assert.deepEqual(hit.body, {
    input: {
      id: 'ci-watch',
      schedule: '*/5 * * * *',
      text: 'check CI state and gather report',
      description: 'five minute inspection',
      timezone: 'Asia/Shanghai',
      catchUp: true,
      targetConversationId: 7,
      threadKey: 'ci-main',
    },
  })

  // missing required: explicit missing_required_flag
  const missing = await runCliCaptured(['cron', 'create', '--id', 'x', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'missing_required_flag')

  // unknown flag reject
  const unknown = await runCliCaptured(['cron', 'create', '--id', 'x', '--schedule', '* * * * *', '--text', 't', '--bogus', '--json'], env)
  assert.equal(unknown.code, 1)
  assert.equal(parseCliError(unknown).code, 'unknown_flag')

  // cron trigger and delete: single required id
  const trig = await runCliCaptured(['cron', 'trigger', '--id', 'ci-watch', '--json'], env)
  assert.equal(trig.code, 0, trig.err)
  assert.deepEqual(JSON.parse(trig.out), { triggered: true })
  const del = await runCliCaptured(['cron', 'delete', '--id', 'ci-watch', '--json'], env)
  assert.equal(del.code, 0, del.err)
  assert.deepEqual(JSON.parse(del.out), { deleted: true })
})

test('webhook sub- command family:create/list/delete top-level path and body shape', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-triggers-cli-')
  const hub = await startTriggersHub(t, (actionId, body) => {
    if (actionId === 'webhook_create') return { body: { webhook: { id: (body as { input: { id: string } }).input.id, hasSecret: true } } }
    if (actionId === 'webhook_list') return { body: { webhooks: [{ id: 'ci', hasSecret: true }] } }
    return { body: { deleted: true } }
  })
  const env = makeCliEnv(hub.url, dir)

  const created = await runCliCaptured(['webhook', 'create', '--id', 'ci', '--secret', 'WHSECRET_CLI_PROBE', '--description', 'CI call back', '--json'], env)
  assert.equal(created.code, 0, created.err)
  const hit = hub.hits.find((h) => h.path === '/api/actions/builtin%3Atriggers/webhook_create')!
  assert.deepEqual(hit.body, {
    input: { id: 'ci', secret: 'WHSECRET_CLI_PROBE', description: 'CI call back' },
  })
  // return metadata excludes secret original text (server side contract; this where verify CLI original pass-through server side output)
  assert.doesNotMatch(created.out, /WHSECRET_CLI_PROBE/)

  const list = await runCliCaptured(['webhook', 'list', '--json'], env)
  assert.equal(list.code, 0, list.err)
  assert.equal(JSON.parse(list.out).webhooks[0]?.id, 'ci')

  const del = await runCliCaptured(['webhook', 'delete', '--id', 'ci', '--json'], env)
  assert.equal(del.code, 0, del.err)
  assert.deepEqual(JSON.parse(del.out), { deleted: true })
})

test('cron/webhook action support --current attach carries conversation context;--input whole commit', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-triggers-cli-')
  const hub = await startTriggersHub(t)
  const env = makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '5' })

  // --current: human conversation context attach carries (cron manage action excludes secret, can security carry)
  const cur = await runCliCaptured(['cron', 'list', '--current', '--json'], env)
  assert.equal(cur.code, 0, cur.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { input: {}, conversationId: 5 })

  // --input whole commit (contains optional field), do not and property flag mix use
  const whole = await runCliCaptured(
    ['cron', 'create', '--input', '{"id":"w","schedule":"0 * * * *","text":"whole package","catchUp":true}', '--json'],
    env,
  )
  assert.equal(whole.code, 0, whole.err)
  assert.deepEqual(hub.hits.at(-1)?.body, {
    input: { id: 'w', schedule: '0 * * * *', text: 'whole package', catchUp: true },
  })

  // mutual exclusion reject
  const mixed = await runCliCaptured(['cron', 'create', '--input', '{"id":"w"}', '--id', 'w', '--json'], env)
  assert.equal(mixed.code, 1)
  assert.equal(parseCliError(mixed).code, 'conflicting_flags')

  // redundant location parameter reject (action without location parameter semantics)
  const extra = await runCliCaptured(['cron', 'trigger', 'stray', '--id', 'x', '--json'], env)
  assert.equal(extra.code, 1)
  assert.equal(parseCliError(extra).code, 'unexpected_positional')
})

test('help column out cron/webhook top-level command; server side error message seal original on throw', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-triggers-cli-')
  const hub = await startTriggersHub(t, () => ({
    status: 409,
    body: { error: { code: 'triggers_job_exists', message: 'task already exists' } },
  }))
  const env = makeCliEnv(hub.url, dir)

  const help = await runCliCaptured(['--help'], env)
  assert.equal(help.code, 0)
  for (const cmd of ['cron list', 'cron create', 'cron delete', 'cron trigger', 'webhook list', 'webhook create', 'webhook delete']) {
    assert.match(help.out, new RegExp(cmd.replace(/ /g, ' ')), `help should contain ${cmd}`)
  }

  // sub- command level help render flag
  const sub = await runCliCaptured(['cron', 'create', '--help'], env)
  assert.equal(sub.code, 0)
  assert.match(sub.out, /--schedule/)
  assert.match(sub.out, /--catch-up/)
  assert.match(sub.out, /--target-conversation-id/)

  // 409 error message seal → non-zero exit + stderr JSON
  const dup = await runCliCaptured(['cron', 'create', '--id', 'd', '--schedule', '* * * * *', '--text', 't', '--json'], env)
  assert.equal(dup.code, 1)
  assert.equal(parseCliError(dup).code, 'triggers_job_exists')
})

test('cron and webhook do not and core command conflict:conversations etc. core command do not subject to manifest affect', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-triggers-cli-')
  const hub = await startTriggersHub(t)
  // re- use the same server append core routing cannot row (startTriggersHub only mapping actions),
  // this where verify is command parse layer: core command prefix store in when manifest declaration do not preempt.
  const env = makeCliEnv(hub.url, dir)

  // cron/webhook do not in core command table: motion state parse after normal execute (hit action end point)
  const r = await runCliCaptured(['cron', 'list', '--json'], env)
  assert.equal(r.code, 0, r.err)
  // illegal sub- command explicit unknown_command(is not static default when cron list execute)
  const bad = await runCliCaptured(['cron', 'bogus', '--json'], env)
  assert.equal(bad.code, 1)
  assert.equal(parseCliError(bad).code, 'unknown_command')
})
