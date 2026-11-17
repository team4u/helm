/**
 * Dynamic plugin command boundary tests (zero domain-specific special cases):
 * - External manifest validation: positional field exists, readFileInto targets a string,
 *   required ordering, duplicate fields/targets, timeoutMs shape — failing explicitly at the
 *   CLI boundary without touching the server.
 * - readFileInto positionals: cross-platform path detection (POSIX/win32/~/explicit relative),
 *   directory and permission I/O diagnostics (explicit failure vs plain string on ENOENT).
 * - Positional vs matching property flag conflicts fail explicitly; --input vs flags/positionals
 *   mutual exclusion.
 * - Positional type coercion per schema (number fields -> number, string -> string).
 * - Generic virtual plugin reuse (non-workflow): positional + readFileInto + timeoutMs combined.
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

/** Starts a mock Hub with injected manifests; default action endpoints return `{ received: body }`. */
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
// Manifest validation (rejects malformed external input at CLI boundary)
// ---------------------------------------------------------------------------

/** Constructs a minimal action manifest (with overridable cli metadata). */
function action(cli: unknown, properties: Record<string, unknown> = {}, required: string[] = []): unknown {
  return {
    pluginId: 'builtin:gadget',
    id: 'deploy',
    description: 'Deploy gadget',
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    outputSchema: { type: 'object' },
    cli,
  }
}

test('manifest validation: positional field must exist in inputSchema.properties', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const hub = await startActionsHub([action({ command: ['gadget', 'deploy'], positional: [{ field: 'ghost' }] })], {}, t)
  const r = await runCliCaptured(['gadget', 'deploy', 'x', '--json'], makeCliEnv(hub.url, dir))
  assert.equal(r.code, 1)
  const err = parseCliError(r)
  assert.equal(err.code, 'invalid_action_manifest')
  assert.match(err.message, /ghost/)
})

test('manifest validation: readFileInto target must exist and be type: string; duplicate fields/targets rejected', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const cases: Array<{ cli: unknown; properties: Record<string, unknown>; match: RegExp }> = [
    {
      // Missing target field
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'src', readFileInto: 'missing' }] },
      properties: { src: { type: 'string' } },
      match: /missing.*does not exist in inputSchema\.properties/,
    },
    {
      // Non-string target field (object)
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'src', readFileInto: 'payload' }] },
      properties: { src: { type: 'string' }, payload: { type: 'object' } },
      match: /must be a type: string property/,
    },
    {
      // Enum-only property (treated as string by flagTypeOf): readFileInto target requires explicit type: 'string'
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'src', readFileInto: 'mode' }] },
      properties: { src: { type: 'string' }, mode: { enum: ['a', 'b'] } },
      match: /must be a type: string property/,
    },
    {
      // Duplicate field
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'src' }, { field: 'src' }] },
      properties: { src: { type: 'string' } },
      match: /writes duplicate field "src"/,
    },
    {
      // readFileInto target collides with another positional field
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'src', readFileInto: 'payload' }, { field: 'payload' }] },
      properties: { src: { type: 'string' }, payload: { type: 'string' } },
      match: /writes duplicate field "payload"/,
    },
    {
      // Two positionals writing the same target
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'a', readFileInto: 'payload' }, { field: 'b', readFileInto: 'payload' }] },
      properties: { a: { type: 'string' }, b: { type: 'string' }, payload: { type: 'string' } },
      match: /writes duplicate field "payload"/,
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

test('manifest validation: required positional cannot follow an optional positional; timeoutMs validation', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const cases: Array<{ cli: unknown; match: RegExp }> = [
    {
      cli: { command: ['gadget', 'deploy'], positional: [{ field: 'opt' }, { field: 'req', required: true }] },
      match: /req.*cannot appear after an optional positional/,
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

  // Valid shapes: timeoutMs=0 (no timeout) and positive finite integers are accepted
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

test('manifest validation: positional field colliding with reserved flag name (input/current) is rejected', { timeout: 60_000 }, async (t) => {
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
  assert.match(err.message, /collides with a reserved flag name/)
})

test('manifest validation: rejects unknown keys and prototype-polluting names; checks Object.hasOwn instead of prototype chain', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  // Field name `toString`: `in` checks pass via prototype chain, whereas Object.hasOwn rejects
  const hubToString = await startActionsHub(
    [action({ command: ['gadget', 'deploy'], positional: [{ field: 'toString' }] }, {})],
    {},
    t,
  )
  const rToString = await runCliCaptured(['gadget', 'deploy', 'x', '--json'], makeCliEnv(hubToString.url, dir))
  assert.equal(rToString.code, 1)
  const errToString = parseCliError(rToString)
  assert.equal(errToString.code, 'invalid_action_manifest')
  assert.match(errToString.message, /toString.*does not exist in inputSchema\.properties/)
  await hubToString.close()

  // JSON payloads can declare own `__proto__` keys: plain object assignment would mutate or lose prototype, so must reject
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    const hub = await startActionsHub([action({ command: ['gadget', 'deploy'], positional: [{ field: bad }] }, {})], {}, t)
    try {
      const r = await runCliCaptured(['gadget', 'deploy', 'x', '--json'], makeCliEnv(hub.url, dir))
      assert.equal(r.code, 1, bad)
      const err = parseCliError(r)
      assert.equal(err.code, 'invalid_action_manifest', bad)
      assert.match(err.message, /prototype-polluting key/, bad)
    } finally {
      await hub.close()
    }
    // Also reject for readFileInto targets
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

  // Unknown keys (e.g. typos): rejected rather than silently ignored
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

test('positional type coercion: strict true/false booleans, JSON parsing by schema type, raw strings', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const manifest = {
    pluginId: 'builtin:gadget',
    id: 'deploy',
    description: 'Deploy gadget',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        dryRun: { type: 'boolean' },
        labels: { type: 'array', items: { type: 'string' } },
        spec: { type: 'object' },
        anything: {}, // Un-typed schema -> JSON passthrough
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

  // Coerces string / boolean / array / object / untyped values together
  const r = await runCliCaptured(['gadget', 'deploy', 'demo', 'true', ' ["a","b"] ', '{"k":1}', '[1,2]'], env)
  assert.equal(r.code, 0, r.err)
  const input = inputOfLast()
  assert.equal(input.name, 'demo')
  assert.equal(input.dryRun, true)
  assert.deepEqual(input.labels, ['a', 'b'])
  assert.deepEqual(input.spec, { k: 1 })
  assert.deepEqual(input.anything, [1, 2])

  // Non-strict boolean: fails locally
  const badBool = await runCliCaptured(['gadget', 'deploy', 'demo', 'yes', '[]', '{}', 'null', '--json'], env)
  assert.equal(badBool.code, 1)
  const badBoolErr = parseCliError(badBool)
  assert.equal(badBoolErr.code, 'invalid_flag_value')
  assert.match(badBoolErr.message, /dryRun.*true\/false/)

  // Invalid JSON in JSON-typed positional: fails locally without sending request
  const badJson = await runCliCaptured(['gadget', 'deploy', 'demo', 'true', 'not-json', '{}', 'null', '--json'], env)
  assert.equal(badJson.code, 1)
  const badJsonErr = parseCliError(badJson)
  assert.equal(badJsonErr.code, 'invalid_flag_value')
  assert.match(badJsonErr.message, /labels.*JSON/)

  // Human mode (without --json) also rejects cleanly
  const badJsonHuman = await runCliCaptured(['gadget', 'deploy', 'demo', 'true', 'not-json', '{}', 'null'], env)
  assert.equal(badJsonHuman.code, 1)
  assert.match(badJsonHuman.err, /positional argument/)
})

// ---------------------------------------------------------------------------
// readFileInto positionals: path detection and I/O diagnostics
// ---------------------------------------------------------------------------

/** Gadget manifest using readFileInto. */
const READ_FILE_MANIFEST = {
  pluginId: 'builtin:gadget',
  id: 'deploy',
  description: 'Deploy gadget',
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

test('readFileInto: reads files into target field; coerces plain values per schema type', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const hub = await startActionsHub([READ_FILE_MANIFEST], {}, t)
  const env = makeCliEnv(hub.url, dir)
  const scriptPath = path.join(dir, 'site.workflow.js')
  await fsp.writeFile(scriptPath, 'export const meta = 1\n', 'utf8')

  // File path + numeric positional (replicas has number schema -> coerced to number instead of string)
  const r = await runCliCaptured(['gadget', 'deploy', scriptPath, '3', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
  assert.equal(body?.input?.payload, 'export const meta = 1\n')
  assert.equal(body?.input?.replicas, 3)
  assert.equal(body?.input?.src, undefined)

  // Non-path string passes as plain value, whereas missing ~/ path fails explicitly
  const byValue = await runCliCaptured(['gadget', 'deploy', 'saved-name', '2', '--json'], env)
  assert.equal(byValue.code, 0, byValue.err)
  const valueBody = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
  assert.equal(valueBody?.input?.src, 'saved-name')
  assert.equal(valueBody?.input?.replicas, 2)

  const tildeMissing = await runCliCaptured(['gadget', 'deploy', '~/definitely-missing-file.js', '2', '--json'], env)
  assert.equal(tildeMissing.code, 1)
  assert.equal(parseCliError(tildeMissing).code, 'positional_file_not_found')

  // Path-like argument targeting missing file: fails explicitly instead of treating it as a plain name.
  // UNC paths (\\srv\share\...) are only expected to return not_found on non-Windows: on Windows stat triggers
  // real network resolution, where unreachable shares yield EHOSTUNREACH/ENOENT-class I/O errors reported as
  // unreadable rather than pretending to be not_found; accept either real platform result.
  const missing: string[] = ['./nope.js', '/definitely/not/here.js', 'C:\\nope\\f.js']
  if (process.platform !== 'win32') missing.push('\\\\srv\\share\\f.js')
  for (const p of missing) {
    const miss = await runCliCaptured(['gadget', 'deploy', p, '1', '--json'], env)
    assert.equal(miss.code, 1, `should fail: ${p}`)
    assert.equal(parseCliError(miss).code, 'positional_file_not_found', p)
  }

  if (process.platform === 'win32') {
    // On Windows, UNC paths remain path-like and must fail explicitly instead of writing to the string field
    // (unreadable if share is unreachable, vs not_found for local missing paths like \\?\).
    const unc = await runCliCaptured(['gadget', 'deploy', '\\\\srv\\share\\f.js', '1', '--json'], env)
    assert.equal(unc.code, 1, 'UNC path syntax must fail explicitly instead of treating as a literal value')
    const uncCode = parseCliError(unc).code
    assert.ok(
      uncCode === 'positional_file_unreadable' || uncCode === 'positional_file_not_found',
      `accept real platform I/O error: ${uncCode}`,
    )
  }

  // Windows backslash relative and ~ paths: also treated as paths, never falling back silently to a literal name
  for (const p of ['.\\nope.js', '..\\nope.js', '~\\nope.js']) {
    const miss = await runCliCaptured(['gadget', 'deploy', p, '1', '--json'], env)
    assert.equal(miss.code, 1, `should fail: ${p}`)
    assert.equal(parseCliError(miss).code, 'positional_file_not_found', p)
  }

  // Invalid numeric positional value: fails explicitly
  const badNum = await runCliCaptured(['gadget', 'deploy', 'x', 'NaN-ish', '--json'], env)
  assert.equal(badNum.code, 1)
  assert.equal(parseCliError(badNum).code, 'invalid_flag_value')
})

test('readFileInto: rejects directories as non-regular files and surfaces permission errors explicitly', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const hub = await startActionsHub([READ_FILE_MANIFEST], {}, t)
  const env = makeCliEnv(hub.url, dir)

  // Existing directory (even without ./ prefix): rejected explicitly instead of passing as workflow name
  const sub = path.join(dir, 'sub')
  await fsp.mkdir(sub)
  const asDir = await runCliCaptured(['gadget', 'deploy', sub, '1', '--json'], env)
  assert.equal(asDir.code, 1)
  const asDirErr = parseCliError(asDir)
  assert.equal(asDirErr.code, 'positional_not_a_file')
  assert.match(asDirErr.message, /does not point to a regular file/)

  // ./ directory also never silently passes as a name: resolves relative to cwd -> missing path error
  const asRelDir = await runCliCaptured(['gadget', 'deploy', './sub', '1', '--json'], env)
  assert.equal(asRelDir.code, 1)
  assert.equal(parseCliError(asRelDir).code, 'positional_file_not_found')

  // ./ directory that actually exists relative to cwd: also rejected as not a regular file.
  // Created under process.cwd() because on cross-volume Windows CI (repo on D:, tmp on C:), path.relative
  // returns an absolute path and `./<abs>` is not a valid relative path; using cwd guarantees the same drive.
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

  // Unreadable file (EACCES): surfaces diagnostic instead of treating as literal name or skipping silently.
  // Root bypasses file permissions (DAC override), so kernel allows reads; skip this check when running as uid 0.
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
// Positional vs flag conflicts / --input mutual exclusion semantics
// ---------------------------------------------------------------------------

test('positional conflicts with matching flag explicitly (no silent override); --input stays raw', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  const hub = await startActionsHub([READ_FILE_MANIFEST], {}, t)
  const env = makeCliEnv(hub.url, dir)
  const scriptPath = path.join(dir, 'a.js')
  await fsp.writeFile(scriptPath, 'A\n', 'utf8')

  // Passing both --src flag and positional writing src: conflicts explicitly
  const clashField = await runCliCaptured(['gadget', 'deploy', 'saved', '1', '--src', 'x', '--json'], env)
  assert.equal(clashField.code, 1)
  assert.equal(parseCliError(clashField).code, 'conflicting_positional')

  // File positional writes payload, so passing --payload also conflicts
  const clashTarget = await runCliCaptured(['gadget', 'deploy', scriptPath, '1', '--payload', 'inline', '--json'], env)
  assert.equal(clashTarget.code, 1)
  assert.equal(parseCliError(clashTarget).code, 'conflicting_positional')

  // --input is mutually exclusive with positionals (using unexpected_positional)
  const mixed = await runCliCaptured(['gadget', 'deploy', 'saved', '1', '--input', '{"src":"x"}', '--json'], env)
  assert.equal(mixed.code, 1)
  assert.equal(parseCliError(mixed).code, 'unexpected_positional')

  // --input passes through verbatim (no merging with flags or positionals)
  const whole = await runCliCaptured(['gadget', 'deploy', '--input', '{"src":"x","replicas":9}', '--json'], env)
  assert.equal(whole.code, 0, whole.err)
  const body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown> } }).body
  assert.deepEqual(body?.input, { src: 'x', replicas: 9 })
})

// ---------------------------------------------------------------------------
// Generic virtual plugin reuse: positional + readFileInto + timeoutMs combined (non-workflow domain)
// ---------------------------------------------------------------------------

test('generic virtual plugin dynamic command: end-to-end positional + file + timeoutMs (--current injects context only)', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  // Unrelated to workflows (report table export): verifies generic extension points without hardcoding
  const manifest = {
    pluginId: 'builtin:reporter',
    id: 'render',
    description: 'Render report table',
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

  // File positional + string flag + numeric positional; --current injects body.conversationId only
  const r = await runCliCaptured(['reporter', 'render', tpl, '2', '--format', 'pdf', '--current', '--json'], envWithConv)
  assert.equal(r.code, 0, r.err)
  const body = (hub.hits.at(-1) as { body?: { input?: Record<string, unknown>; conversationId?: number } }).body
  assert.equal(body?.input?.body, '# title\nbody text\n')
  assert.equal(body?.input?.template, undefined)
  assert.equal(body?.input?.format, 'pdf')
  assert.equal(body?.input?.page, 2)
  assert.equal(body?.conversationId, 5)

  // Human mode: generic key-value output (without domain hardcoding; renders `received` key)
  const human = await runCliCaptured(['reporter', 'render', tpl, '2'], envPlain)
  assert.equal(human.code, 0, human.err)
  assert.match(human.out, /received/)

  // Without --current: must not fabricate any conversation ID
  const plain = await runCliCaptured(['reporter', 'render', tpl, '1', '--json'], envPlain)
  assert.equal(plain.code, 0, plain.err)
  const plainBody = (hub.hits.at(-1) as { body?: { conversationId?: number } }).body
  assert.equal(plainBody?.conversationId, undefined)

  // Missing required positional: missing_positional
  const missing = await runCliCaptured(['reporter', 'render', '--json'], envPlain)
  assert.equal(missing.code, 1)
  assert.equal(parseCliError(missing).code, 'missing_positional')

  // Help generated from dynamic manifest (includes positional signature without special formatting)
  const help = await runCliCaptured(['reporter', 'render', '--help'], envPlain)
  assert.equal(help.code, 0)
  assert.match(help.out, /<template> \[page\]/)
  assert.match(help.out, /--format <string>/)
})

// ---------------------------------------------------------------------------
// --wait semantics core check (timeoutMs=0 passthrough; terminal failures propagate server error envelope)
// ---------------------------------------------------------------------------

test('--wait terminal failure: propagates server workflow_failed envelope with non-zero exit; --json preserves details', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  // Reuses read-file manifest while having server return a failure envelope: verifies CLI does not turn HTTP errors into success
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
// cli.timeoutMs passthrough: small timeout overrides default; 0 disables timeout
// ---------------------------------------------------------------------------

test('cli.timeoutMs override takes effect: 300ms slow response times out with actual ms in message', { timeout: 60_000 }, async (t) => {
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
  assert.ok(elapsed < 3000, `should time out near 300ms override rather than ${elapsed}ms`)
  const err = parseCliError(r)
  assert.equal(err.code, 'timeout')
  assert.match(err.message, /300ms/, 'error message must state the configured ms override rather than hardcoded 30000ms')
})

test('cli.timeoutMs=0: does not apply request timeout to slow responses (supports long --wait)', { timeout: 60_000 }, async (t) => {
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
        // 400ms already exceeds the previous 300ms timeout, confirming timeoutMs=0 disables the request timeout.
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

// ---------------------------------------------------------------------------
// result rendering: protocol display copy (LocalizedText) resolves for human
// output only; --json keeps the raw contract shape (never parsed maps)
// ---------------------------------------------------------------------------

test('action output: human rendering resolves nested LocalizedText display copy; --json keeps raw shape', { timeout: 60_000 }, async (t) => {
  const dir = useTempDir(t, 'helm-cli-dyn-')
  // apps-list-shaped payload: display metadata nested three levels deep
  const payload = {
    apps: [
      {
        pluginId: 'demo:board',
        name: { en: 'Task Board', 'zh-CN': '任务看板' },
        description: { en: 'Kanban for tasks', 'zh-CN': '任务看板描述' },
        enabled: true,
        screens: ['board'],
        catalog: { title: { 'zh-CN': '任务看板' } },
      },
      {
        pluginId: 'demo:stats',
        name: 'Stats',
        enabled: false,
        screens: [],
        counters: { en: 'x', visits: 2 },
      },
    ],
  }
  const hub = await startActionsHub(
    [action({ command: ['gadget', 'deploy'] })],
    { 'POST /api/actions/builtin%3Agadget/deploy': () => ({ body: payload }) },
    t,
  )
  const env = makeCliEnv(hub.url, dir)

  // --json: fidelity passthrough of the raw localized maps
  const rj = await runCliCaptured(['gadget', 'deploy', '--json'], env)
  assert.equal(rj.code, 0, rj.err)
  assert.deepEqual(JSON.parse(rj.out), payload)

  // human: nested display copy resolved with the default locale ('en'); the
  // zh-CN-only catalog title falls back to its first declared locale entry
  const rh = await runCliCaptured(['gadget', 'deploy'], env)
  assert.equal(rh.code, 0, rh.err)
  assert.ok(rh.out.includes('Task Board'), rh.out)
  assert.ok(rh.out.includes('Kanban for tasks'), rh.out)
  assert.ok(rh.out.includes('任务看板'), rh.out)
  // strict shape guard: a record mixing locale and non-locale keys is plain
  // data, never collapsed into display copy
  assert.ok(rh.out.includes('visits'), rh.out)
  assert.ok(!rh.out.includes('"zh-CN"'), `raw localized map must not leak into human output:\n${rh.out}`)
})
