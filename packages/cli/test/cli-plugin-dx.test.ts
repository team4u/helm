/**
 * External plugin DX loop CLI tests: `plugins doctor/reload/rescan` (HTTP endpoints)
 * and `plugins init` (local scaffold without contacting Hub).
 * Uses real `runCli` + mock Hub HTTP contract (real fetch boundary);
 * `init` verifies generated files, invalid name rejection, non-empty dir guard, and `--json` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  makeCliEnv,
  makePluginSummary,
  parseCliError,
  runCliCaptured,
  startMockHub,
  useTempDir,
} from './helpers/cli-harness.js'

const DOCTOR_REPORT = {
  dir: '/abs/plugin',
  pluginId: 'p1',
  ok: true,
  checks: [{ id: 'manifest', label: 'x' }],
}

test('plugins doctor: POST /api/plugins/doctor accepts --path/positional/id', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const hub = await startMockHub(
    {
      'POST /api/plugins/doctor': (body) => {
        if ((body as { id?: string }).id !== undefined) {
          assert.deepEqual(body, { id: 'my-pl' })
          return { body: { ...DOCTOR_REPORT, requestedId: 'my-pl' } }
        }
        assert.deepEqual(body, { path: '/abs/plugin' })
        return { body: DOCTOR_REPORT }
      },
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dataDir)

  // --path (canonical option name)
  const r2 = await runCliCaptured(['plugins', 'doctor', '--path', '/abs/plugin', '--json'], env)
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(JSON.parse(r2.out), DOCTOR_REPORT)

  // Positional absolute path -> path target
  const r3 = await runCliCaptured(['plugins', 'doctor', '/abs/plugin', '--json'], env)
  assert.equal(r3.code, 0, r3.err)
  assert.deepEqual(JSON.parse(r3.out), DOCTOR_REPORT)

  // Positional plugin ID -> id target (doctor [<id>])
  const r4 = await runCliCaptured(['plugins', 'doctor', 'my-pl', '--json'], env)
  assert.equal(r4.code, 0, r4.err)
  assert.deepEqual(JSON.parse(r4.out), { ...DOCTOR_REPORT, requestedId: 'my-pl' })

  // --id explicit flag
  const r5 = await runCliCaptured(['plugins', 'doctor', '--id', 'my-pl', '--json'], env)
  assert.equal(r5.code, 0, r5.err)
  assert.deepEqual(JSON.parse(r5.out), { ...DOCTOR_REPORT, requestedId: 'my-pl' })

  assert.equal(hub.hits.length, 4)
  assert.deepEqual(hub.hits[0]!.body, { path: '/abs/plugin' })
  assert.deepEqual(hub.hits[3]!.body, { id: 'my-pl' })

  // Missing target errors explicitly without contacting Hub
  const r6 = await runCliCaptured(['plugins', 'doctor', '--json'], env)
  assert.notEqual(r6.code, 0)
  assert.equal(hub.hits.length, 4, 'missing argument must not send request')

  // id and path are mutually exclusive
  const r7 = await runCliCaptured(['plugins', 'doctor', 'my-pl', '--path', '/abs/plugin'], env)
  assert.notEqual(r7.code, 0)
  assert.equal(hub.hits.length, 4)
})

test('plugins doctor: human mode prints check results and exits non-zero on failure', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const failing = {
    dir: '/abs/bad',
    pluginId: 'bad',
    ok: false,
    checks: [
      { id: 'manifest', label: 'Manifest and entrypoint resolution' },
      {
        id: 'backend',
        label: 'Backend module generation import',
        error: { code: 'plugin_load_failed', message: 'syntax error' },
      },
    ],
  }
  const hub = await startMockHub({ 'POST /api/plugins/doctor': () => ({ body: failing }) }, { autoRegisterCleanup: t })
  const r = await runCliCaptured(['plugins', 'doctor', '--path', '/abs/bad'], makeCliEnv(hub.url, dataDir))
  assert.notEqual(r.code, 0, 'ok=false should exit non-zero')
  assert.ok(r.out.includes('[ok] manifest'))
  assert.ok(r.out.includes('[!!] backend'))
  assert.ok(r.out.includes('plugin_load_failed'))
  assert.ok(r.out.includes('Result: failed checks found'))
})

test('plugins reload: POST /api/plugins/:id/reload (with URI encoding)', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const hub = await startMockHub(
    {
      'POST /api/plugins/my%3Apl/reload': () => ({
        body: {
          pluginId: 'my:pl',
          wasEnabled: true,
          generation: 2,
          summary: makePluginSummary({ id: 'my:pl', actions: ['a'] }),
        },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['plugins', 'reload', 'my:pl', '--json'], makeCliEnv(hub.url, dataDir))
  assert.equal(r.code, 0, r.err)
  const body = JSON.parse(r.out) as { pluginId: string; generation: number }
  assert.equal(body.pluginId, 'my:pl')
  assert.equal(body.generation, 2)
  assert.equal(hub.hits[0]!.path, '/api/plugins/my%3Apl/reload')
  assert.equal(hub.hits[0]!.method, 'POST')
})

test('plugins rescan:POST /api/plugins/rescan', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const hub = await startMockHub(
    {
      'POST /api/plugins/rescan': () => ({
        body: {
          registered: ['new-one'],
          skipped: 1,
          plugins: [makePluginSummary({ id: 'new-one', name: 'x', enabled: false })],
        },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['plugins', 'rescan', '--json'], makeCliEnv(hub.url, dataDir))
  assert.equal(r.code, 0, r.err)
  const body = JSON.parse(r.out) as { registered: string[]; skipped: number }
  assert.deepEqual(body.registered, ['new-one'])
  assert.equal(hub.hits[0]!.path, '/api/plugins/rescan')
})

test('plugins install: passes source, sets enable in --enable body, checks human output, rejects empty source', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const npmSource = 'npm:helmx-plugin-foo@^1.2.0'
  const installBody = {
    record: {
      id: 'inst-1',
      pluginId: 'helmx-plugin-foo',
      source: { kind: 'npm', raw: npmSource, spec: 'helmx-plugin-foo@^1.2.0' },
      installPath: '/data/plugins/helmx-plugin-foo',
      version: '1.2.0',
      installedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
    summary: makePluginSummary({
      id: 'helmx-plugin-foo',
      enabled: false,
      managed: { installId: 'inst-1', installedVersion: '1.2.0', installedAt: 1_700_000_000_000, source: { kind: 'npm', raw: npmSource, spec: 'helmx-plugin-foo@^1.2.0' } },
    }),
  }
  const hub = await startMockHub(
    {
      'POST /api/plugins/install': (body) => {
        const enable = (body as { enable?: boolean }).enable === true
        return { body: { ...installBody, summary: { ...installBody.summary, enabled: enable } } }
      },
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dataDir)

  // --enable: request body passes enable:true, human output shows enabled
  const r1 = await runCliCaptured(['plugins', 'install', npmSource, '--enable'], env)
  assert.equal(r1.code, 0, r1.err)
  assert.deepEqual(hub.hits[0]!.body, { source: npmSource, enable: true })
  assert.ok(r1.out.includes('helmx-plugin-foo 1.2.0'))
  assert.ok(r1.out.includes('enabled'))

  // Default: request body contains only source, prints disabled status and enable hint
  const r2 = await runCliCaptured(['plugins', 'install', npmSource, '--json'], env)
  assert.equal(r2.code, 0, r2.err)
  assert.deepEqual(hub.hits[1]!.body, { source: npmSource })
  const install = JSON.parse(r2.out) as { record: { id: string }; summary: { managed?: { installId: string } } }
  assert.equal(install.record.id, 'inst-1')
  assert.equal(install.summary.managed?.installId, 'inst-1')

  // Empty source rejected explicitly without contacting Hub
  const empty = await runCliCaptured(['plugins', 'install', '   '], env)
  assert.notEqual(empty.code, 0)
  assert.ok(empty.err.includes('source'))
  assert.equal(hub.hits.length, 2)
})

test('plugins update: POST /api/plugins/:id/update (with URI encoding) and human output', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const hub = await startMockHub(
    {
      'POST /api/plugins/my%3Apl/update': () => ({
        body: {
          record: {
            id: 'inst-1',
            pluginId: 'my:pl',
            source: { kind: 'npm', raw: 'npm:my-pl@^1.2.0', spec: 'my-pl@^1.2.0' },
            installPath: '/data/plugins/my:pl',
            version: '1.3.0',
            installedAt: 1_700_000_000_000,
            updatedAt: 1_700_000_100_000,
          },
          summary: makePluginSummary({ id: 'my:pl' }),
          changed: true,
          previousVersion: '1.2.0',
        },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const r = await runCliCaptured(['plugins', 'update', 'my:pl'], makeCliEnv(hub.url, dataDir))
  assert.equal(r.code, 0, r.err)
  assert.equal(hub.hits[0]!.path, '/api/plugins/my%3Apl/update')
  assert.equal(hub.hits[0]!.method, 'POST')
  assert.deepEqual(hub.hits[0]!.body, {})
  assert.ok(r.out.includes('my:pl'))
  assert.ok(r.out.includes('1.2.0 -> 1.3.0'))
})

test('plugins remove: --json non-interactive, --yes bypass, and non-interactive without --yes confirmation check', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const hub = await startMockHub(
    {
      'POST /api/plugins/my%3Apl/remove': () => ({
        body: { pluginId: 'my:pl', installPath: '/data/plugins/my:pl', wasEnabled: true, installId: 'inst-2' },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dataDir)

  // --json: machine mode is non-interactive (CLI skips prompt) and sends request directly
  const r1 = await runCliCaptured(['plugins', 'remove', 'my:pl', '--json'], env)
  assert.equal(r1.code, 0, r1.err)
  assert.equal(hub.hits[0]!.path, '/api/plugins/my%3Apl/remove')
  const remove = JSON.parse(r1.out) as { pluginId: string; wasEnabled: boolean }
  assert.equal(remove.pluginId, 'my:pl')
  assert.equal(remove.wasEnabled, true)

  // Human mode with --yes: skips prompt, prints removed message and install directory
  const r2 = await runCliCaptured(['plugins', 'remove', 'my:pl', '--yes'], env)
  assert.equal(r2.code, 0, r2.err)
  assert.equal(hub.hits[1]!.path, '/api/plugins/my%3Apl/remove')
  assert.ok(r2.out.includes('Removed my:pl'))
  assert.ok(r2.out.includes('/data/plugins/my:pl'))

  // Human mode without --yes: ensure non-TTY rejection (even if external runner inherits TTY stdin under --test-isolation=none)
  const origIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  try {
    const r3 = await runCliCaptured(['plugins', 'remove', 'my:pl'], env)
    assert.notEqual(r3.code, 0)
    assert.ok(r3.err.includes('--yes'))
    assert.ok(r3.err.includes('confirmation_required') || r3.err.includes('removing'))
  } finally {
    if (origIsTTY) Object.defineProperty(process.stdin, 'isTTY', origIsTTY)
    else delete (process.stdin as { isTTY?: boolean }).isTTY
  }
  assert.equal(hub.hits.length, 2, 'must not call Hub without confirmation')

  // Missing and extra positional arguments rejected without contacting Hub
  const miss = await runCliCaptured(['plugins', 'remove'], env)
  assert.notEqual(miss.code, 0)
  const extra = await runCliCaptured(['plugins', 'update', 'a', 'b'], env)
  assert.notEqual(extra.code, 0)
  assert.equal(hub.hits.length, 2)
})

test('plugins install/update/remove: forwards all 4 source kinds and Hub error envelopes', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const sources = [
    'npm:helmx-plugin-foo@^1.2.0',
    'git:https://github.com/user/helmx-plugin-foo.git@v1.2.0',
    'https://github.com/user/helmx-plugin-foo.git#v1.2.0',
    '/srv/helmx-plugins/foo',
    './relative-plugin',
  ]
  const seen: string[] = []
  const hub = await startMockHub(
    {
      'POST /api/plugins/install': (body) => {
        seen.push((body as { source: string }).source)
        return { status: 201, body: { ok: true } }
      },
      'POST /api/plugins/bad%3Apl/remove': () => ({
        status: 404,
        body: { error: { code: 'plugin_not_managed', message: 'plugin is not a managed installation' } },
      }),
    },
    { autoRegisterCleanup: t },
  )
  const env = makeCliEnv(hub.url, dataDir)
  for (const source of sources) {
    const r = await runCliCaptured(['plugins', 'install', source, '--json'], env)
    assert.equal(r.code, 0, `source=${source}: ${r.err}`)
  }
  assert.deepEqual(seen, sources)

  // Hub structured error propagated verbatim (preserving code/message)
  const err = await runCliCaptured(['plugins', 'remove', 'bad:pl', '--yes', '--json'], env)
  assert.notEqual(err.code, 0)
  assert.equal(parseCliError(err).code, 'plugin_not_managed')
})

test('plugins init: generates local skeleton (default full template: plugin.json + index.ts + tsconfig.json + client/index.tsx)', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const env = makeCliEnv('http://127.0.0.1:1', dataDir)
  // Runs without Hub (local command): unreachable Hub URL proves no network calls are made
  const r = await runCliCaptured(['plugins', 'init', 'my-plugin', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const body = JSON.parse(r.out) as { pluginId: string; dir: string; files: string[]; template: string }
  assert.equal(body.pluginId, 'my-plugin')
  assert.equal(body.template, 'full', 'default template is full')
  assert.ok(body.dir.startsWith(dataDir))
  for (const f of ['plugin.json', 'index.ts', 'tsconfig.json', 'client/index.tsx', 'README.md']) {
    assert.ok(body.files.includes(f), `output should contain ${f}: ${JSON.stringify(body.files)}`)
  }

  const manifest = JSON.parse(await fsp.readFile(path.join(body.dir, 'plugin.json'), 'utf8')) as {
    id: string
    main: string
    clientRoot: string
  }
  assert.equal(manifest.id, 'my-plugin')
  assert.equal(manifest.main, 'index.ts')
  assert.equal(manifest.clientRoot, './client')
  const index = await fsp.readFile(path.join(body.dir, 'index.ts'), 'utf8')
  assert.ok(index.includes(`id: 'my-plugin'`), 'entrypoint id matches directory name')
  assert.ok(index.includes('definePlugin'))
  assert.ok(index.includes("module: 'index.tsx'"), 'UI references client/index.tsx')
  const tsconfig = JSON.parse(await fsp.readFile(path.join(body.dir, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>
  }
  assert.ok(tsconfig.compilerOptions)
  const client = await fsp.readFile(path.join(body.dir, 'client', 'index.tsx'), 'utf8')
  assert.ok(client.includes('export function SamplePanel'))
  assert.ok(client.includes('@helmx/plugin-client'), 'standard template imports host shared frontend package')
  assert.ok(client.includes('usePluginDoc'), 'standard template uses shared hook')
  // Standard template uses shared layout primitives without pseudo-Tailwind class names
  for (const primitive of ['ScreenSection', 'DataTable', 'KvGrid']) {
    assert.ok(client.includes(primitive), `standard template should use shared layout primitive ${primitive}`)
  }
  assert.ok(!/\b(font-medium|text-subtle|text-xs)\b/.test(client), 'standard template must not retain pseudo-Tailwind class names')
  assert.ok(await fsp.stat(path.join(body.dir, 'README.md')))

  // Human mode prints next steps
  const r2 = await runCliCaptured(['plugins', 'init', 'another-one'], env)
  assert.equal(r2.code, 0, r2.err)
  assert.ok(r2.out.includes('Next steps'))
  assert.ok(r2.out.includes('helmx plugins enable another-one'))
})

test('plugins init --template minimal: backend ping action only, no client directory', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const env = makeCliEnv('http://127.0.0.1:1', dataDir)
  const r = await runCliCaptured(['plugins', 'init', 'mini-pl', '--template', 'minimal', '--json'], env)
  assert.equal(r.code, 0, r.err)
  const body = JSON.parse(r.out) as { dir: string; files: string[]; template: string }
  assert.equal(body.template, 'minimal')
  for (const f of ['plugin.json', 'index.ts', 'tsconfig.json', 'README.md']) {
    assert.ok(body.files.includes(f))
  }
  assert.ok(!body.files.some((f) => f.startsWith('client/')), 'minimal does not generate frontend files')
  await assert.rejects(fsp.stat(path.join(body.dir, 'client')), { code: 'ENOENT' })
  const manifest = JSON.parse(await fsp.readFile(path.join(body.dir, 'plugin.json'), 'utf8')) as {
    clientRoot?: string
  }
  assert.equal(manifest.clientRoot, undefined, 'minimal does not declare clientRoot')
  const index = await fsp.readFile(path.join(body.dir, 'index.ts'), 'utf8')
  assert.ok(index.includes("id: 'ping'"), 'minimal includes ping action')

  // Rejects invalid template name
  const bad = await runCliCaptured(['plugins', 'init', 'bad-tpl', '--template', 'huge'], env)
  assert.notEqual(bad.code, 0)
})

test('plugins init: rejects invalid names and non-empty directory unless --force is passed', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-dx-')
  const env = makeCliEnv('http://127.0.0.1:1', dataDir)
  const bad = await runCliCaptured(['plugins', 'init', 'builtin:x'], env)
  assert.notEqual(bad.code, 0)
  const bad2 = await runCliCaptured(['plugins', 'init', 'bad name'], env)
  assert.notEqual(bad2.code, 0)

  // First init succeeds; second init into the same non-empty directory rejects
  await runCliCaptured(['plugins', 'init', 'dup-pl'], env)
  const dup = await runCliCaptured(['plugins', 'init', 'dup-pl'], env)
  assert.notEqual(dup.code, 0)
  assert.ok(dup.err.includes('non-empty') || dup.err.includes('conflict'))
  // --force proceeds by overwriting files
  const forced = await runCliCaptured(['plugins', 'init', 'dup-pl', '--force'], env)
  assert.equal(forced.code, 0, forced.err)

  // --dir custom parent directory
  const parent = path.join(dataDir, 'custom-parent')
  const r3 = await runCliCaptured(['plugins', 'init', 'x-pl', '--dir', parent, '--json'], env)
  assert.equal(r3.code, 0, r3.err)
  const body3 = JSON.parse(r3.out) as { dir: string }
  assert.ok(body3.dir.startsWith(parent))
})

test('plugins build: local prebuilt bundle compilation (--json, --out, --module, clientDependencies, and error guards)', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-build-')
  const env = makeCliEnv('http://127.0.0.1:1', dataDir)

  // 1. Scaffold via `plugins init`, then prebuild locally with `plugins build` (no Hub calls).
  const initRes = await runCliCaptured(['plugins', 'init', 'built-pl', '--json'], env)
  assert.equal(initRes.code, 0, initRes.err)
  const { dir: pluginDir } = JSON.parse(initRes.out) as { dir: string }

  const buildRes = await runCliCaptured(['plugins', 'build', pluginDir, '--json'], env)
  assert.equal(buildRes.code, 0, buildRes.err)
  const buildBody = JSON.parse(buildRes.out) as {
    pluginId: string
    outDir: string
    manifestPath: string
    manifest: { version: number; modules: Record<string, { entryFile: string; contentHash: string; exports: string[] }> }
    totalBytes: number
  }
  assert.equal(buildBody.pluginId, 'built-pl')
  assert.equal(buildBody.outDir, path.join(pluginDir, 'dist-client'))
  assert.equal(buildBody.manifest.version, 1)
  const entry = buildBody.manifest.modules['index.tsx']
  assert.ok(entry && entry.exports.includes('SamplePanel'))
  assert.ok(await fsp.stat(path.join(buildBody.outDir, entry.entryFile)))
  assert.ok(await fsp.stat(path.join(buildBody.outDir, `${entry.entryFile}.gz`)))

  // 2. --out override + --module + clientDependencies + human output
  const depDir = path.join(pluginDir, 'node_modules', 'tiny-cli-dep')
  await fsp.mkdir(depDir, { recursive: true })
  await fsp.writeFile(path.join(depDir, 'package.json'), JSON.stringify({ name: 'tiny-cli-dep', main: 'index.js' }))
  await fsp.writeFile(path.join(depDir, 'index.js'), 'export const tag = "bundled-dep-tag"\n')
  await fsp.writeFile(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify({ id: 'built-pl', main: 'index.ts', clientRoot: './client', clientDependencies: ['tiny-cli-dep'] }),
  )
  await fsp.writeFile(
    path.join(pluginDir, 'client', 'index.tsx'),
    "import { tag } from 'tiny-cli-dep'\nexport function SamplePanel() { return tag }\n",
  )
  const customOut = path.join(dataDir, 'custom-out')
  const build2 = await runCliCaptured(['plugins', 'build', '--dir', pluginDir, '--out', customOut, '--module', 'index.tsx'], env)
  assert.equal(build2.code, 0, build2.err)
  assert.ok(build2.out.includes('Built 1 client module(s) for built-pl'))
  const manifest2 = JSON.parse(await fsp.readFile(path.join(customOut, 'manifest.json'), 'utf8')) as {
    modules: Record<string, { entryFile: string }>
  }
  const compiledCode = await fsp.readFile(path.join(customOut, manifest2.modules['index.tsx']!.entryFile), 'utf8')
  assert.match(compiledCode, /bundled-dep-tag/)

  // 3. Reject missing target directory and escaping clientRoot explicitly
  const missing = await runCliCaptured(['plugins', 'build', path.join(dataDir, 'does-not-exist'), '--json'], env)
  assert.notEqual(missing.code, 0)
  assert.equal(parseCliError(missing).code, 'client_root_invalid')

  const badPlugin = path.join(dataDir, 'escape-pl')
  await fsp.mkdir(badPlugin, { recursive: true })
  await fsp.writeFile(path.join(badPlugin, 'plugin.json'), JSON.stringify({ id: 'escape-pl', clientRoot: '../outside' }))
  const escaping = await runCliCaptured(['plugins', 'build', badPlugin, '--json'], env)
  assert.notEqual(escaping.code, 0)
  assert.equal(parseCliError(escaping).code, 'invalid_plugin_definition')
})

test('plugins build: works when plugin directory traverses a symlinked/alias parent path and still rejects symlink escapes', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-cli-build-alias-')
  const env = makeCliEnv('http://127.0.0.1:1', dataDir)
  const realParent = path.join(dataDir, 'real-parent')
  const aliasParent = path.join(dataDir, 'alias-parent')
  await fsp.mkdir(realParent, { recursive: true })
  // Junction works without admin privileges on Windows and acts as a directory symlink on POSIX,
  // reproducing the dir !== realpath(dir) mismatch (e.g. Windows RUNNER~1 or macOS /var -> /private/var).
  await fsp.symlink(realParent, aliasParent, 'junction')

  const initRes = await runCliCaptured(['plugins', 'init', 'alias-pl', '--dir', aliasParent, '--json'], env)
  assert.equal(initRes.code, 0, initRes.err)
  const { dir: aliasPluginDir } = JSON.parse(initRes.out) as { dir: string }

  const pluginManifestPath = path.join(aliasPluginDir, 'plugin.json')
  await fsp.writeFile(
    pluginManifestPath,
    JSON.stringify({ id: 'alias-pl', main: 'index.ts', clientRoot: './client', clientDist: './custom-dist' }),
  )
  const buildRes = await runCliCaptured(['plugins', 'build', aliasPluginDir, '--json'], env)
  assert.equal(buildRes.code, 0, buildRes.err)
  const buildBody = JSON.parse(buildRes.out) as { outDir: string; manifest: { modules: Record<string, unknown> } }
  assert.equal(buildBody.outDir, path.join(aliasPluginDir, 'custom-dist'))
  assert.ok(buildBody.manifest.modules['index.tsx'])

  // Symlink escape through a non-existent nested subdirectory under clientDist must still be caught.
  const outsideDir = path.join(dataDir, 'outside-target')
  await fsp.mkdir(outsideDir, { recursive: true })
  await fsp.symlink(outsideDir, path.join(aliasPluginDir, 'sym-out'), 'junction')
  await fsp.writeFile(
    pluginManifestPath,
    JSON.stringify({ id: 'alias-pl', main: 'index.ts', clientRoot: './client', clientDist: './sym-out/nested' }),
  )
  const symEscape = await runCliCaptured(['plugins', 'build', aliasPluginDir, '--json'], env)
  assert.notEqual(symEscape.code, 0)
  assert.equal(parseCliError(symEscape).code, 'invalid_plugin_definition')

  // Dangling symlink declared as clientRoot/clientDist must be rejected rather than falling back to parent.
  await fsp.symlink(path.join(dataDir, 'nonexistent-outside'), path.join(aliasPluginDir, 'dangling-client'), 'junction')
  await fsp.writeFile(
    pluginManifestPath,
    JSON.stringify({ id: 'alias-pl', main: 'index.ts', clientRoot: './dangling-client' }),
  )
  const danglingEscape = await runCliCaptured(['plugins', 'build', aliasPluginDir, '--json'], env)
  assert.notEqual(danglingEscape.code, 0)
  assert.equal(parseCliError(danglingEscape).code, 'invalid_plugin_definition')
})
