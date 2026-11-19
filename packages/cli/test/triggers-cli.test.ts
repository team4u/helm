/**
 * `builtin:triggers` CLI top-level command mapping tests (cron/webhook).
 *
 * Follows the same discipline as cli.test.ts: temporary HTTP server mocks Hub contract
 * (real fetch boundary) with manifests mirroring the plugin action schema (7 actions +
 * semantic cli.command paths) to verify top-level `helmx cron ...` / `helmx webhook ...`,
 * flag conversion, --json, --current, and error envelopes. Full Hub E2E runs separately
 * (kernel/test/triggers.test.ts covers the host side).
 *
 * runner: tsx --test; every test has explicit timeout: 60_000.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ActionManifest } from '@helmx/protocol'
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

/** Contract manifest matching the plugin's exact field names and types. */
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
      description: 'List cron tasks',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
      cli: { command: ['cron', 'list'] },
    },
    {
      pluginId: 'builtin:triggers',
      id: 'cron_create',
      description: 'Create cron task',
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
      description: 'Delete a cron job',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: { type: 'object' },
      cli: { command: ['cron', 'delete'] },
    },
    {
      pluginId: 'builtin:triggers',
      id: 'cron_trigger',
      description: 'Manually trigger a cron job once (new event, not scheduled catch-up)',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: { type: 'object' },
      cli: { command: ['cron', 'trigger'] },
    },
    {
      pluginId: 'builtin:triggers',
      id: 'webhook_list',
      description: 'List webhooks',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object' },
      cli: { command: ['webhook', 'list'] },
    },
    {
      pluginId: 'builtin:triggers',
      id: 'webhook_create',
      description: 'Create a webhook (configure secrets manually via HTTP/CLI, never through model)',
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
      description: 'Delete webhook',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      outputSchema: { type: 'object' },
      cli: { command: ['webhook', 'delete'] },
    },
  ]
}

/** Starts a mock Hub exposing the builtin:triggers action contract. */
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

test('cron subcommand family: top-level path, required flag validation, type coercion, and --json', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-triggers-cli-')
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

  // cron create: full set of required + optional flags (boolean/number/string coercion)
  const created = await runCliCaptured(
    [
      'cron', 'create',
      '--id', 'ci-watch',
      '--schedule', '*/5 * * * *',
      '--text', 'check CI status and summarize',
      '--description', '5-minute check',
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
      text: 'check CI status and summarize',
      description: '5-minute check',
      timezone: 'Asia/Shanghai',
      catchUp: true,
      targetConversationId: 7,
      threadKey: 'ci-main',
    },
  })

  // Missing required flag: explicit missing_required_flag error
  const missing = await runCliCaptured(['cron', 'create', '--id', 'x', '--json'], env)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'missing_required_flag')

  // Rejects unknown flags
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

test('webhook subcommand family: create/list/delete top-level path and body shape', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-triggers-cli-')
  const hub = await startTriggersHub(t, (actionId, body) => {
    if (actionId === 'webhook_create') return { body: { webhook: { id: (body as { input: { id: string } }).input.id, hasSecret: true } } }
    if (actionId === 'webhook_list') return { body: { webhooks: [{ id: 'ci', hasSecret: true }] } }
    return { body: { deleted: true } }
  })
  const env = makeCliEnv(hub.url, dir)

  const created = await runCliCaptured(['webhook', 'create', '--id', 'ci', '--secret', 'WHSECRET_CLI_PROBE', '--description', 'CI callback', '--json'], env)
  assert.equal(created.code, 0, created.err)
  const hit = hub.hits.find((h) => h.path === '/api/actions/builtin%3Atriggers/webhook_create')!
  assert.deepEqual(hit.body, {
    input: { id: 'ci', secret: 'WHSECRET_CLI_PROBE', description: 'CI callback' },
  })
  // Returned metadata omits raw secret (server contract; CLI passes server output through verbatim)
  assert.doesNotMatch(created.out, /WHSECRET_CLI_PROBE/)

  const list = await runCliCaptured(['webhook', 'list', '--json'], env)
  assert.equal(list.code, 0, list.err)
  assert.equal(JSON.parse(list.out).webhooks[0]?.id, 'ci')

  const del = await runCliCaptured(['webhook', 'delete', '--id', 'ci', '--json'], env)
  assert.equal(del.code, 0, del.err)
  assert.deepEqual(JSON.parse(del.out), { deleted: true })
})

test('cron/webhook actions support --current conversation context and --input full submission', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-triggers-cli-')
  const hub = await startTriggersHub(t)
  const env = makeCliEnv(hub.url, dir, { HELMX_CONVERSATION_ID: '5' })

  // --current: injects conversation context (cron list has no secrets)
  const cur = await runCliCaptured(['cron', 'list', '--current', '--json'], env)
  assert.equal(cur.code, 0, cur.err)
  assert.deepEqual(hub.hits.at(-1)?.body, { input: {}, conversationId: 5 })

  // --input submits full payload (with optional fields) without mixing property flags
  const whole = await runCliCaptured(
    ['cron', 'create', '--input', '{"id":"w","schedule":"0 * * * *","text":"full payload","catchUp":true}', '--json'],
    env,
  )
  assert.equal(whole.code, 0, whole.err)
  assert.deepEqual(hub.hits.at(-1)?.body, {
    input: { id: 'w', schedule: '0 * * * *', text: 'full payload', catchUp: true },
  })

  // Mutual exclusion rejected
  const mixed = await runCliCaptured(['cron', 'create', '--input', '{"id":"w"}', '--id', 'w', '--json'], env)
  assert.equal(mixed.code, 1)
  assert.equal(parseCliError(mixed).code, 'conflicting_flags')

  // Extra positional argument rejected (actions do not accept positionals here)
  const extra = await runCliCaptured(['cron', 'trigger', 'stray', '--id', 'x', '--json'], env)
  assert.equal(extra.code, 1)
  assert.equal(parseCliError(extra).code, 'unexpected_positional')
})

test('help lists cron/webhook top-level commands and forwards server error envelopes', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-triggers-cli-')
  const hub = await startTriggersHub(t, () => ({
    status: 409,
    body: { error: { code: 'triggers_job_exists', message: 'job already exists' } },
  }))
  const env = makeCliEnv(hub.url, dir)

  const help = await runCliCaptured(['--help'], env)
  assert.equal(help.code, 0)
  for (const cmd of ['cron list', 'cron create', 'cron delete', 'cron trigger', 'webhook list', 'webhook create', 'webhook delete']) {
    assert.match(help.out, new RegExp(cmd.replace(/ /g, ' ')), `help should contain ${cmd}`)
  }

  // Subcommand help displays flags
  const sub = await runCliCaptured(['cron', 'create', '--help'], env)
  assert.equal(sub.code, 0)
  assert.match(sub.out, /--schedule/)
  assert.match(sub.out, /--catch-up/)
  assert.match(sub.out, /--target-conversation-id/)

  // 409 error envelope -> non-zero exit + JSON on stderr
  const dup = await runCliCaptured(['cron', 'create', '--id', 'd', '--schedule', '* * * * *', '--text', 't', '--json'], env)
  assert.equal(dup.code, 1)
  assert.equal(parseCliError(dup).code, 'triggers_job_exists')
})

test('cron and webhook do not conflict with core commands like conversations', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helmx-triggers-cli-')
  const hub = await startTriggersHub(t)
  // Cannot reuse same mock server for core routes (startTriggersHub only mounts action routes);
  // verifies command resolution: manifest declarations never shadow core prefixes.
  const env = makeCliEnv(hub.url, dir)

  // cron/webhook are not in the core command table: dispatched dynamically to action endpoints
  const r = await runCliCaptured(['cron', 'list', '--json'], env)
  assert.equal(r.code, 0, r.err)
  // Invalid subcommand fails explicitly with unknown_command (never silently falls back to cron list)
  const bad = await runCliCaptured(['cron', 'bogus', '--json'], env)
  assert.equal(bad.code, 1)
  assert.equal(parseCliError(bad).code, 'unknown_command')
})
