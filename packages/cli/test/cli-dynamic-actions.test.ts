/**
 * motion state plugin command boundary test (zero business special judge):
 * - manifest external input validate:positional field store in,readFileInto target string,
 *   required connect continue, duplicate field/target,timeoutMs shape - -CLI side explicit errors, independent of server side.
 * - readFileInto location parameter: path form across platform identify (POSIX/win32/~/explicit each other for),
 *   directory and permission etc. IO fault explicit diagnose (only ENOENT and non- path form when ordinary value).
 * - location parameter and same name property flag conflict explicit errors;--input and flags/positionals mutual exclusion.
 * - positional by schema type convert (number field rotate number,string keep string).
 * - truly through use virtual plugin (non- workflow):positional + readFileInto + timeoutMs combine re- use.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  makeCliEnv,
  parseCliError,
  runCliCaptured,
  sleep,
  startMockHub,
  useTempDir,
  type CleanupRegistrar,
  type MockHubHandle,
  type MockRouteHandler,
} from './helpers/cli-harness.js'

/** start inject manifests simulated Hub; by default action end point back visible `{ received: body }`. */
async function startActionsHub(
  manifests: readonly unknown[],
  extraRoutes: Record<string, MockRouteHandler> = {},
  autoRegisterCleanup?: CleanupRegistrar,
): Promise<MockHubHandle> {
  return startMockHub(
    {
      'POST /api/actions/builtin%3Agadget/deploy': (body) => ({ body: { received: body } }),
      'POST /api/actions/builtin%3Areporter/render': (body) => ({ body: { received: body } }),
      ...extraRoutes,
    },
    { defaultActions: manifests, autoRegisterCleanup },
  )
}

// ---------------------------------------------------------------------------
// manifest validate (external input in CLI boundary explicit errors)
// ---------------------------------------------------------------------------

/** construct most small action manifest(cli can override). */
function action(cli: unknown, properties: Record<string, unknown> = {}, required: string[] = []): unknown {
  return {
    pluginId: 'builtin:gadget',
    id: 'deploy',
    description: 'deploy small tool',
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    outputSchema: { type: 'object' },
    cli,
  }
}

test('manifest validate:positional field must store in at inputSchema.properties', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const hub = await startActionsHub([action({ command: ['gadget', 'deploy'], positional: [{ field: 'ghost' }] })], {}, t)
  const r = await runCliCaptured(['gadget', 'deploy', 'x', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 1)
  const err = parseCliError(r)
  assert.equal(err.code, 'invalid_action_manifest')
  assert.match(err.message, /ghost/)
})

test('manifest validate:readFileInto target must store in and is string type; duplicate field/target reject', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const cases: Array<{ cli: unknown; properties: Record<string, unknown>; match: RegExp }> = [
    {
      // target field missing
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'src', readFileInto: 'missing' }] },
      properties: { src: { type: 'string' } },
      match: /missing.*do not in inputSchema\.properties/,
    },
    {
      // target field type non- string(object)
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'src', readFileInto: 'payload' }] },
      properties: { src: { type: 'string' }, payload: { type: 'object' } },
      match: /must be type: string property/,
    },
    {
      // enumeration number form (flagTypeOf will when string):readFileInto target must be true type:'string', enumeration reject
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'src', readFileInto: 'mode' }] },
      properties: { src: { type: 'string' }, mode: { enum: ['a', 'b'] } },
      match: /must be type: string property/,
    },
    {
      // field duplicate
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'src' }, { field: 'src' }] },
      properties: { src: { type: 'string' } },
      match: /duplicate write field "src"/,
    },
    {
      // readFileInto target and another positional field collide
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'src', readFileInto: 'payload' }, { field: 'payload' }] },
      properties: { src: { type: 'string' }, payload: { type: 'string' } },
      match: /duplicate write field "payload"/,
    },
    {
      // two positional read the same target
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'a', readFileInto: 'payload' }, { field: 'b', readFileInto: 'payload' }] },
      properties: { a: { type: 'string' }, b: { type: 'string' }, payload: { type: 'string' } },
      match: /duplicate write field "payload"/,
    },
  ]
  for (const c of cases) {
    const hub = await startActionsHub([action(c.cli, c.properties)], {}, t)
    try {
      const r = await runCliCaptured(['gadget', 'deploy', 'a', 'b', '--json'], makeCliEnv(hub.url, dir))
      assert.equal(r.code, 1)
      const err = parseCliError(r)
      assert.equal(err.code, 'invalid_action_manifest')
      assert.match(err.message, c.match)
    } finally {
      await hub.close()
    }
  }
})

test('manifest validate:required positional must not appear in optional after;timeoutMs shape', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const cases: Array<{ cli: unknown; match: RegExp }> = [
    {
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'opt' }, { field: 'req', required: true }] },
      match: /req.*appear in optional after/,
    },
    { cli: { command: ['gadget', 'deploy'], timeoutMs: -1 }, match: /timeoutMs/ },
    { cli: { command: ['gadget', 'deploy'], timeoutMs: Number.POSITIVE_INFINITY }, match: /timeoutMs/ },
    { cli: { command: ['gadget', 'deploy'], timeoutMs: 'fast' }, match: /timeoutMs/ },
  ]
  for (const c of cases) {
    const hub = await startActionsHub([action(c.cli, { opt: { type: 'string' }, req: { type: 'string' } })], {}, t)
    try {
      const r = await runCliCaptured(['gadget', 'deploy', 'a', '--json'], makeCliEnv(hub.url, dir))
      assert.equal(r.code, 1)
      const err = parseCliError(r)
      assert.equal(err.code, 'invalid_action_manifest')
      assert.match(err.message, c.match)
    } finally {
      await hub.close()
    }
  }

  // legal shape:timeoutMs=0(without timeout) and correct count all accept
  for (const timeoutMs of [0, 30_000]) {
    const hub = await startActionsHub([action({ command: ['gadget', 'deploy'], timeoutMs }, { note: { type: 'string' } })], {}, t)
    try {
      const r = await runCliCaptured(['gadget', 'deploy', '--note', 'x', '--json'], makeCliEnv(hub.url, dir))
      assert.equal(r.code, 0, r.err)
    } finally {
      await hub.close()
    }
  }
})

test('manifest validate:positional field collide keep flag name (input/current) reject', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const hub = await startActionsHub(
    [action({ command: ['gadget', 'deploy'], positional: [{ field: 'current' }] }, { current: { type: 'string' } })],
    {},
    t,
  )
  const r = await runCliCaptured(['gadget', 'deploy', 'x', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 1)
  const err = parseCliError(r)
  assert.equal(err.code, 'invalid_action_manifest')
  assert.match(err.message, /collide keep flag name/)
})

test('manifest validate: unknown key and prototype pollute field name reject; inherit property do not compute self has', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  // field declaration is toString:`in` will let through (inherit),hasOwn reject
  const hubToString = await startActionsHub(
    [action({ command: ['gadget', 'deploy'], positional: [{ field: 'toString' }] }, {})],
    {},
    t,
  )
  const rToString = await runCliCaptured(['gadget', 'deploy', 'x', '--json'], makeCliEnv(hubToString.url, dir))
  assert.equal(rToString.code, 1)
  const errToString = parseCliError(rToString)
  assert.equal(errToString.code, 'invalid_action_manifest')
  assert.match(errToString.message, /toString.*do not in inputSchema\.properties/)
  await hubToString.close()

  // JSON text can carry self has __proto__ key: ordinary object assignment will static default lose/change prototype, must reject
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    const hub = await startActionsHub([action({ command: ['gadget', 'deploy'], positional: [{ field: bad }] }, {})], {}, t)
    try {
      const r = await runCliCaptured(['gadget', 'deploy', 'x', '--json'], makeCliEnv(hub.url, dir))
      assert.equal(r.code, 1, bad)
      const err = parseCliError(r)
      assert.equal(err.code, 'invalid_action_manifest', bad)
      assert.match(err.message, /prototype pollute key/, bad)
    } finally {
      await hub.close()
    }
    // readFileInto target same reject
    const hub2 = await startActionsHub(
      [action({ command: ['gadget', 'deploy'], positional: [{ field: 'src', readFileInto: bad }] }, { src: { type: 'string' } })],
      {},
      t,
    )
    try {
      const r = await runCliCaptured(['gadget', 'deploy', 'x', '--json'], makeCliEnv(hub2.url, dir))
      assert.equal(r.code, 1, bad)
      assert.equal(parseCliError(r).code, 'invalid_action_manifest', bad)
    } finally {
      await hub2.close()
    }
  }

  // unknown key (piece together write error etc.): reject while non- static default ignore
  const hubUnknown = await startActionsHub(
    [action({ command: ['gadget', 'deploy'], positional: [{ field: 'src', dest: 'payload' }] }, { src: { type: 'string' } })],
    {},
    t,
  )
  const rUnknown = await runCliCaptured(['gadget', 'deploy', 'x', '--json'], makeCliEnv(hubUnknown.url, dir))
  assert.equal(rUnknown.code, 1)
  const errUnknown = parseCliError(rUnknown)
  assert.equal(errUnknown.code, 'invalid_action_manifest')
  assert.match(errUnknown.message, /unknown key .?dest/)
})

test('positional type convert:boolean strictly true/false,json by type parse,string original', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const manifest = {
    pluginId: 'builtin:gadget',
    id: 'deploy',
    description: 'deploy small tool',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        dryRun: { type: 'boolean' },
        labels: { type: 'array', items: { type: 'string' } },
        spec: { type: 'object' },
        anything: {}, // without type loosely schema -> JSON pass
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    cli: {
      command: ['gadget', 'deploy'],
      positional: [{ field: 'name' }, { field: 'dryRun' }, { field: 'labels' }, { field: 'spec' }, { field: 'anything' }],
    },
  }
  const hub = await startActionsHub([manifest], {}, t)
  const env = makeCliEnv(hub.url, dir)
  const inputOfLast = (): Record<string, unknown> =>
    ((hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } } | undefined)?.body as { input?: Record<string, unknown> })?.input ?? {}

  // string / boolean / array / object / without type all link convert
  const r = await runCliCaptured(['gadget', 'deploy', 'demo', 'true', ' ["a","b"] ', '{"k":1}', '[1,2]'], env)
  assert.equal(r.code, 0, r.err)
  const input = inputOfLast()
  assert.equal(input.name, 'demo')
  assert.equal(input.dryRun, true)
  assert.deepEqual(input.labels, ['a', 'b'])
  assert.deepEqual(input.spec, { k: 1 })
  assert.deepEqual(input.anything, [1, 2])

  // boolean non- strictly value: local explicit errors
  const badBool = await runCliCaptured(['gadget', 'deploy', 'demo', 'yes', '[]', '{}', 'null', '--json'], env)
  assert.equal(badBool.code, 1)
  const badBoolErr = parseCliError(badBool)
  assert.equal(badBoolErr.code, 'invalid_flag_value')
  assert.match(badBoolErr.message, /dryRun.*true\/false/)

  // json location parameter illegal JSON: local explicit errors (do not request)
  const badJson = await runCliCaptured(['gadget', 'deploy', 'demo', 'true', 'not-json', '{}', 'null', '--json'], env)
  assert.equal(badJson.code, 1)
  const badJsonErr = parseCliError(badJson)
  assert.equal(badJsonErr.code, 'invalid_flag_value')
  assert.match(badJsonErr.message, /labels.*JSON/)

  // pure text pattern (without --json) same intercept
  const badJsonHuman = await runCliCaptured(['gadget', 'deploy', 'demo', 'true', 'not-json', '{}', 'null'], env)
  assert.equal(badJsonHuman.code, 1)
  assert.match(badJsonHuman.err, /location parameter/)
})

// ---------------------------------------------------------------------------
// readFileInto location parameter: path identify and IO diagnose
// ---------------------------------------------------------------------------

/** carries readFileInto  gadget manifest. */
const READ_FILE_MANIFEST = {
  pluginId: 'builtin:gadget',
  id: 'deploy',
  description: 'deploy small tool',
  inputSchema: {
    type: 'object',
    properties: {
      src: { type: 'string' },
      payload: { type: 'string' },
      replicas: { type: 'number' },
    },
    additionalProperties: false,
  },
  outputSchema: { type: 'object' },
  cli: {
    command: ['gadget', 'deploy'],
    positional: [{ field: 'src', readFileInto: 'payload' }, { field: 'replicas' }],
  },
}

test('readFileInto: file read target field; ordinary value by schema type convert write field', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const hub = await startActionsHub([READ_FILE_MANIFEST], {}, t)
  const env = makeCliEnv(hub.url, dir)
  const scriptPath = path.join(dir, 'site.workflow.js')
  await fsp.writeFile(scriptPath, 'export const meta = 1\n', 'utf8')

  // file + number location parameter (replicas is number schema -> rotate number while non- string)
  const r = await runCliCaptured(['gadget', 'deploy', scriptPath, '3', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
  assert.equal(body?.input?.payload, 'export const meta = 1\n')
  assert.equal(body?.input?.replicas, 3)
  assert.equal(body?.input?.src, undefined)

  // non- path form + ~/ expand:~ missing file when (path form) explicit errors
  const byValue = await runCliCaptured(['gadget', 'deploy', 'saved-name', '2', '--json'], env)
  assert.equal(byValue.code, 0, byValue.err)
  const valueBody = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
  assert.equal(valueBody?.input?.src, 'saved-name')
  assert.equal(valueBody?.input?.replicas, 2)

  const tildeMissing = await runCliCaptured(['gadget', 'deploy', '~/definitely-missing-file.js', '2', '--json'], env)
  assert.equal(tildeMissing.code, 1)
  assert.equal(parseCliError(tildeMissing).code, 'positional_file_not_found')

  // path form but target missing: explicit errors (not silently when name).
  // UNC form (\\srv\share\...) only in non- Windows assertion not_found:Windows on stat
  // will real start network parse, cannot reach sharing return EHOSTUNREACH/ENOENT of outside IO error,
  // produce logic such as report unreadable(does not pretend to be not_found), this where accept platform real result.
  const missing: string[] = ['./nope.js', '/definitely/not/here.js', 'C:\\nope\\f.js']
  if (process.platform !== 'win32') missing.push('\\\\srv\\share\\f.js')
  for (const p of missing) {
    const miss = await runCliCaptured(['gadget', 'deploy', p, '1', '--json'], env)
    assert.equal(miss.code, 1, `should errors:${p}`)
    assert.equal(parseCliError(miss).code, 'positional_file_not_found', p)
  }

  if (process.platform === 'win32') {
    // Windows on UNC form still is path shape: must not when ordinary value write field, must be explicit errors
    // (network cannot reach when is unreadable; local missing \\?\ prefix etc. price verify does not trigger network parse).
    const unc = await runCliCaptured(['gadget', 'deploy', '\\\\srv\\share\\f.js', '1', '--json'], env)
    assert.equal(unc.code, 1, 'UNC path form must explicit errors, must not when ordinary value')
    const uncCode = parseCliError(unc).code
    assert.ok(
      uncCode === 'positional_file_unreadable' || uncCode === 'positional_file_not_found',
      `accept platform real IO result:${uncCode}`,
    )
  }

  // Windows backslash explicit each other for and ~ form: same is path, missing file must not static default when name
  for (const p of ['.\\nope.js', '..\\nope.js', '~\\nope.js']) {
    const miss = await runCliCaptured(['gadget', 'deploy', p, '1', '--json'], env)
    assert.equal(miss.code, 1, `should errors:${p}`)
    assert.equal(parseCliError(miss).code, 'positional_file_not_found', p)
  }

  // number schema location parameter illegal value: explicit errors
  const badNum = await runCliCaptured(['gadget', 'deploy', 'x', 'NaN-ish', '--json'], env)
  assert.equal(badNum.code, 1)
  assert.equal(parseCliError(badNum).code, 'invalid_flag_value')
})

test('readFileInto: directory is not ordinary file; permission fault not silently when name', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const hub = await startActionsHub([READ_FILE_MANIFEST], {}, t)
  const env = makeCliEnv(hub.url, dir)

  // already exists directory (even if do not carries ./ prefix): not silently when workflow name, explicit errors
  const sub = path.join(dir, 'sub')
  await fsp.mkdir(sub)
  const asDir = await runCliCaptured(['gadget', 'deploy', sub, '1', '--json'], env)
  assert.equal(asDir.code, 1)
  const asDirErr = parseCliError(asDir)
  assert.equal(asDirErr.code, 'positional_not_a_file')
  assert.match(asDirErr.message, /is not ordinary file/)

  // ./ prefix directory same not silently when name: each other for cwd parse after missing -> path form explicit errors
  const asRelDir = await runCliCaptured(['gadget', 'deploy', './sub', '1', '--json'], env)
  assert.equal(asRelDir.code, 1)
  assert.equal(parseCliError(asRelDir).code, 'positional_file_not_found')

  // ./ prefix and real store in (each other for cwd construct): directory same reject.
  // directory create in process.cwd() under: across volume environment (Windows CI  repo in D: while tmp in
  // C:) in path.relative for different volume return absolute path,`./<absolute path>` no longer is legal
  // each other for form;cwd under temp directory guarantee same volume can each other for.
  const relName = `.helm-cli-dyn-rel-${process.pid}-${Date.now()}`
  const relDir = path.join(process.cwd(), relName)
  await fsp.mkdir(relDir)
  try {
    const asRelExists = await runCliCaptured(['gadget', 'deploy', `./${relName}`, '1', '--json'], env)
    assert.equal(asRelExists.code, 1)
    assert.equal(parseCliError(asRelExists).code, 'positional_not_a_file')
  } finally {
    await fsp.rm(relDir, { recursive: true, force: true })
  }

  // without read permission file:EACCES explicit diagnose (not silently when name, not silently skip).
  // root can bypass file permission (DAC override), now read succeeded belong real kernel behavior, skip assertion.
  const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : false
  if (process.platform !== 'win32' && !isRoot) {
    const locked = path.join(dir, 'locked.js')
    await fsp.writeFile(locked, 'secret\n', 'utf8')
    await fsp.chmod(locked, 0o000)
    try {
      const denied = await runCliCaptured(['gadget', 'deploy', locked, '1', '--json'], env)
      assert.equal(denied.code, 1)
      assert.equal(parseCliError(denied).code, 'positional_file_unreadable')
    } finally {
      await fsp.chmod(locked, 0o644).catch(() => {})
    }
  }
})

// ---------------------------------------------------------------------------
// positional and flag conflict / --input mutual exclusion semantics
// ---------------------------------------------------------------------------

test('positional and same name property flag conflict explicit errors (do not silently override);--input still whole fidelity', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const hub = await startActionsHub([READ_FILE_MANIFEST], {}, t)
  const env = makeCliEnv(hub.url, dir)
  const scriptPath = path.join(dir, 'a.js')
  await fsp.writeFile(scriptPath, 'A\n', 'utf8')

  // --src flag and location parameter also to src: conflict errors
  const clashField = await runCliCaptured(['gadget', 'deploy', 'saved', '1', '--src', 'x', '--json'], env)
  assert.equal(clashField.code, 1)
  assert.equal(parseCliError(clashField).code, 'conflicting_positional')

  // file location parameter read payload, also again --payload:readFileInto target also conflict errors
  const clashTarget = await runCliCaptured(['gadget', 'deploy', scriptPath, '1', '--payload', 'inline', '--json'], env)
  assert.equal(clashTarget.code, 1)
  assert.equal(parseCliError(clashTarget).code, 'conflicting_positional')

  // --input whole and location parameter mutual exclusion (along use unexpected_positional semantics)
  const mixed = await runCliCaptured(['gadget', 'deploy', 'saved', '1', '--input', '{"src":"x"}', '--json'], env)
  assert.equal(mixed.code, 1)
  assert.equal(parseCliError(mixed).code, 'unexpected_positional')

  // --input original fidelity (do not and any positional/flag combine)
  const whole = await runCliCaptured(['gadget', 'deploy', '--input', '{"src":"x","replicas":9}', '--json'], env)
  assert.equal(whole.code, 0, whole.err)
  const body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
  assert.deepEqual(body?.input, { src: 'x', replicas: 9 })
})

// ---------------------------------------------------------------------------
// through use virtual plugin re- use:positional + readFileInto + timeoutMs combine (non- workflow domain)
// ---------------------------------------------------------------------------

test('through use virtual plugin motion state command:positional+file+timeoutMs complete link re- use (--current only inject context)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  // and workflow without closure domain (report table export): verify extension point through use can re- use
  const manifest = {
    pluginId: 'builtin:reporter',
    id: 'render',
    description: 'render report table',
    inputSchema: {
      type: 'object',
      properties: {
        template: { type: 'string' },
        body: { type: 'string' },
        format: { type: 'string' },
        page: { type: 'number' },
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    cli: {
      command: ['reporter', 'render'],
      positional: [
        { field: 'template', required: true, readFileInto: 'body' },
        { field: 'page' },
      ],
      timeoutMs: 0,
    },
  }
  const hub = await startActionsHub([manifest], {}, t)
  const tpl = path.join(dir, 'tpl.md')
  await fsp.writeFile(tpl, '# title\nbody text\n', 'utf8')
  const envWithConv = makeCliEnv(hub.url, dir, { HELM_CONVERSATION_ID: '5' })
  const envPlain = makeCliEnv(hub.url, dir)

  // file location parameter + string flag + number positional;--current only inject body.conversationId
  const r = await runCliCaptured(['reporter', 'render', tpl, '2', '--format', 'pdf', '--current', '--json'], envWithConv)
  assert.equal(r.code, 0, r.err)
  const body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown>; conversationId?: number } }).body
  assert.equal(body?.input?.body, '# title\nbody text\n')
  assert.equal(body?.input?.template, undefined)
  assert.equal(body?.input?.format, 'pdf')
  assert.equal(body?.input?.page, 2)
  assert.equal(body?.conversationId, 5)

  // person class pattern: through use key-value output (without business identify;received back visible body)
  const human = await runCliCaptured(['reporter', 'render', tpl, '2'], envPlain)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /received/)

  // do not carries --current: do not fabricate any conversation ID
  const plain = await runCliCaptured(['reporter', 'render', tpl, '1', '--json'], envPlain)
  assert.equal(plain.code, 0, plain.err)
  const plainBody = (hub.hits.at(-1) as { body?: { conversationId?: number } }).body
  assert.equal(plainBody?.conversationId, undefined)

  // required positional missing:missing_positional
  const missing = await runCliCaptured(['reporter', 'render', '--json'], envPlain)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'missing_positional')

  // help from motion state manifest(contains location parameter signature and timeout action without special text proposal)
  const help = await runCliCaptured(['reporter', 'render', '--help'], envPlain)
  assert.equal(help.code, 0)
  assert.match(help.out, /<template> \[page\]/)
  assert.match(help.out, /--format <string>/)
})

// ---------------------------------------------------------------------------
// --wait semantics core inspect (timeoutMs=0 pass-through;failed terminal state by server side error message seal drive non-zero exit)
// ---------------------------------------------------------------------------

test('--wait failed terminal state: server side workflow_failed message seal -> non-zero exit;--json fidelity error details', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  // re- use read file manifest but let server side return failed message seal: verify CLI does not HTTP 200/500 semantics disguise into succeeded
  const hub = await startActionsHub(
    [READ_FILE_MANIFEST],
    {
      'POST /api/actions/builtin%3Agadget/deploy': () => ({
        status: 500,
        body: { error: { code: 'workflow_failed', message: 'boom', details: { runId: 'wf_9', status: 'failed' } } },
      }),
    },
    t,
  )
  const r = await runCliCaptured(['gadget', 'deploy', 'x', '1', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 1)
  const err = parseCliError<{ runId?: string }>(r)
  assert.equal(err.code, 'workflow_failed')
  assert.equal(err.details?.runId, 'wf_9')
})

// ---------------------------------------------------------------------------
// cli.timeoutMs pass-through: small timeout override instance by default and real takes effect;0 means do not apply add timeout
// ---------------------------------------------------------------------------

test('cli.timeoutMs override real takes effect:300ms slow response by override value timeout and error information contains real milli second', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const manifest = {
    pluginId: 'builtin:gadget',
    id: 'deploy',
    description: 'd',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object' },
    cli: { command: ['gadget', 'deploy'], timeoutMs: 300 },
  }
  const hub = await startActionsHub(
    [manifest],
    {
      'POST /api/actions/builtin%3Agadget/deploy': async (_body, _req, res) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000)
          res.on('close', () => {
            clearTimeout(timer)
            resolve()
          })
        })
        return { body: { slow: true } }
      },
    },
    t,
  )
  const started = Date.now()
  const r = await runCliCaptured(['gadget', 'deploy', '--json'], makeCliEnv(hub.url, dir))
  const elapsed = Date.now() - started
  assert.equal(r.code, 1)
  assert.ok(elapsed < 3000, `should in override 300ms timeout while non- ${elapsed}ms`)
  const err = parseCliError(r)
  assert.equal(err.code, 'timeout')
  assert.match(err.message, /300ms/, 'error information must contains real override milli second count while non- instance by default 30000ms')
})

test('cli.timeoutMs=0: slow response do not apply add request timeout (--wait long wait for available)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const manifest = {
    pluginId: 'builtin:gadget',
    id: 'deploy',
    description: 'd',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object' },
    cli: { command: ['gadget', 'deploy'], timeoutMs: 0 },
  }
  const hub = await startActionsHub(
    [manifest],
    {
      'POST /api/actions/builtin%3Agadget/deploy': async () => {
        // 400ms already exceeds before one case 300ms timeout threshold, enough with verify timeoutMs=0 do not apply add request timeout.
        await sleep(400)
        return { body: { done: true } }
      },
    },
    t,
  )
  const r = await runCliCaptured(['gadget', 'deploy', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 0, r.err)
  assert.equal(JSON.parse(r.out).done, true)
})
