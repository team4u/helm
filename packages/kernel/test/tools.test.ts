/**
 * Kernel local tool behavior tests (bash / read / read_artifact).
 *
 * Honesty principle: executes real child_process commands, real ArtifactService (InMemory repository +
 * real disk files), and real SDK defineTool handlers; uses fauxProvider only to drive model tool-call decisions,
 * never synchronous mock stubs masking async service signatures.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Ajv } from 'ajv'
import { EDIT_TOOL_RESULT_SCHEMA, type EditToolResult } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import {
  ArtifactService,
  AuthService,
  InMemoryArtifactRepository,
  SecretStash,
  ensureDataDir,
} from '../src/services/index.js'
import {
  buildToolEnv,
  createBashTool,
  createReadArtifactTool,
  createReadTool,
  runGate,
  runShell,
} from '../src/runtime/tools.js'
import type { HelmToolDeps } from '../src/runtime/tool-deps.js'
import { cleanupDir, makeFauxModels, makeTempDir } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

async function openRuntime(dir: string) {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    model: 'faux/faux-1',
    models,
  })
  return Object.assign(runtime, { __faux: faux })
}

/** Real service dependencies: real ArtifactService (Promise API) + real SecretStash. */
async function makeRealDeps(dir: string, stash = new SecretStash()): Promise<HelmToolDeps> {
  await ensureDataDir(dir)
  const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository(), stash)
  return {
    dataDir: dir,
    defaultCwd: dir,
    hubUrl: 'http://127.0.0.1:3202',
    stashEnvFor: (id) => stash.envFor(id),
    redact: (t) => stash.redact(t),
    artifacts,
  }
}

let rootDir: string

before(async () => {
  rootDir = await makeTempDir('helm-tools-test-')
})

after(async () => {
  await cleanupDir(rootDir)
})

describe('runShell real process behavior', { timeout: 60_000 }, () => {
  it('returns exitCode faithfully on success and failure; preserves arrival order across stdout/stderr', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs1'))
    const ok = await runShell(deps, 'echo out; echo err >&2; echo tail')
    assert.equal(ok.ok, true)
    assert.equal(ok.exitCode, 0)
    assert.ok(ok.output.includes('out'))
    assert.ok(ok.output.includes('err'))
    assert.ok(ok.output.includes('tail'))
    const fail = await runShell(deps, 'echo oops >&2; exit 3')
    assert.equal(fail.ok, false)
    assert.equal(fail.exitCode, 3)
    assert.ok(fail.output.includes('oops'))
  })

  it('abort mid-run kills entire process group promptly without waiting 120s timeout', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs2'))
    const sentinel = join(rootDir, 'rs2', 'sentinel.txt')
    const controller = new AbortController()
    const started = Date.now()
    const p = runShell(deps, `sleep 30 && touch ${sentinel}`, {
      timeoutMs: 120_000,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 300)
    const result = await p
    const elapsed = Date.now() - started
    assert.equal(result.ok, false)
    assert.ok(elapsed < 10_000, `abort should kill quickly instead of awaiting timeout (took ${elapsed}ms)`)
    await new Promise((r) => setTimeout(r, 700))
    assert.ok(!existsSyncSafe(sentinel), 'aborted shell must never create sentinel file')
  })

  it('pre-aborted signal never spawns command', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs3'))
    const sentinel = join(rootDir, 'rs3', 'pre.txt')
    const controller = new AbortController()
    controller.abort()
    const result = await runShell(deps, `touch ${sentinel}`, { signal: controller.signal })
    assert.equal(result.ok, false)
    assert.ok(result.output.includes('aborted'))
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(!existsSyncSafe(sentinel), 'pre-aborted signal must not spawn command')
  })

  it('timeoutMs validation explicitly rejects non-positive, fractional, Infinity, NaN, and over-cap values', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs4'))
    for (const bad of [0, -5, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 601_000]) {
      await assert.rejects(
        () => runShell(deps, 'true', { timeoutMs: bad }),
        /invalid_timeout/,
        `timeoutMs=${bad} should explicitly reject`,
      )
    }
  })

  it('kills process group on timeout and marks timedOut=true', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs5'))
    const started = Date.now()
    const result = await runShell(deps, 'sleep 30', { timeoutMs: 500 })
    assert.equal(result.ok, false)
    assert.equal(result.timedOut, true)
    assert.ok(Date.now() - started < 10_000)
  })

  it('env injection: SecretStash injects vars into child env while scrubbing secret from output', { timeout: 60_000 }, async () => {
    const stash = new SecretStash()
    const secretValue = 'sk-super-secret-abcdef123456'
    stash.put(1, 'MY_TOKEN', secretValue)
    const deps = await makeRealDeps(join(rootDir, 'rs6'), stash)
    const result = await runShell(deps, 'echo "token=$MY_TOKEN"', { conversationId: 1 })
    assert.equal(result.ok, true)
    assert.ok(!result.output.includes(secretValue), 'secret plaintext must never appear in output')
    assert.ok(result.output.includes('[REDACTED:stash:'), 'must be replaced by placeholder')
  })

  it('cross-chunk secret splits are still fully redacted after whole-output aggregation', { timeout: 60_000 }, async () => {
    const stash = new SecretStash()
    const secretValue = 'sk-cross-chunk-secret-ZZZZ9999'
    stash.put(1, 'KEY', secretValue)
    const deps = await makeRealDeps(join(rootDir, 'rs7'), stash)
    const result = await runShell(deps, `printf '%s' "$KEY" | dd bs=1 2>/dev/null`, {
      conversationId: 1,
    })
    assert.equal(result.ok, true)
    assert.ok(!result.output.includes(secretValue), 'secret split across chunks must never leak')
    assert.ok(result.output.includes('[REDACTED:stash:'))
  })

  it('multibyte UTF-8 chars split across chunks never tear (no replacement characters)', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs8'))
    // 3-byte UTF-8 CJK characters emitted byte-by-byte via dd; StringDecoder reassembles them losslessly.
    const payload = '\u4f60\u597d\u4e16\u754c\u6c49\u5b57 fidelity test'
    const result = await runShell(
      deps,
      `printf '%s' '${payload}' | dd bs=1 2>/dev/null`,
    )
    assert.equal(result.ok, true)
    assert.equal(result.output, payload)
    assert.ok(!result.output.includes('\uFFFD'), 'must never emit UTF-8 replacement chars')
  })

  it('output exceeding maxOutputBytes returns output_limit_exceeded instead of silently truncating', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs9'))
    const result = await runShell(deps, `head -c 200000 /dev/zero | tr '\\0' 'A'`, {
      maxOutputBytes: 100_000,
    })
    assert.equal(result.ok, false)
    assert.ok(result.output.includes('output_limit_exceeded'))
    assert.ok(!result.output.includes('AAAA'), 'over-limit failure must not return truncated content')
  })

  it('streaming mode (onOutputChunk): caps retained buffer at STREAM_AGGREGATE_LIMIT_BYTES while streaming every chunk', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rs-stream'))
    const chunks: Array<{ stream: 'stdout' | 'stderr'; text: string }> = []
    // Requesting larger maxOutputBytes still enforces STREAM_AGGREGATE_LIMIT_BYTES on retained buffer.
    const result = await runShell(deps, `head -c 600000 /dev/zero | tr '\\0' 'B'`, {
      maxOutputBytes: 64 * 1024 * 1024,
      onOutputChunk: (chunk) => chunks.push(chunk),
    })
    assert.equal(result.ok, false, 'exceeding stream aggregation cap must fail explicitly')
    assert.ok(result.output.includes('output_limit_exceeded'), 'must report output_limit_exceeded')
    assert.ok(result.output.includes('262144'), `error must report real cap (${result.output.slice(0, 120)})`)
    assert.ok(!result.output.includes('BBBB'), 'terminal diagnostic must not echo overflowing content')
    const streamedBytes = chunks
      .filter((c) => c.stream === 'stdout')
      .reduce((sum, c) => sum + Buffer.byteLength(c.text, 'utf8'), 0)
    assert.equal(streamedBytes, 600000, 'per-chunk stream callback must receive all 600000 bytes uninterrupted')
    const okResult = await runShell(deps, `printf 'small-stream'`, {
      maxOutputBytes: 64 * 1024 * 1024,
      onOutputChunk: () => undefined,
    })
    assert.equal(okResult.ok, true)
    assert.equal(okResult.output, 'small-stream')
  })

  it('buildToolEnv: six pinned host vars override colliding stash entries; HELM_DATA_DIR comes from deps', { timeout: 60_000 }, () => {
    const stash = new SecretStash()
    stash.put(7, 'HELM_CWD', '/evil')
    stash.put(7, 'HELM_DATA_DIR', '/evil-data')
    const deps: HelmToolDeps = {
      dataDir: '/d',
      defaultCwd: '/base',
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: (id) => stash.envFor(id),
      redact: (t) => t,
      artifacts: null as never,
    }
    const env = buildToolEnv(deps, '/work', 7)
    assert.equal(env['HELM_ENV'], '1')
    assert.equal(env['HELM_HUB_URL'], 'http://127.0.0.1:3202')
    assert.equal(env['HELM_CONVERSATION_ID'], '7')
    assert.equal(env['HELM_CWD'], '/work')
    assert.equal(env['HELM_DATA_DIR'], '/d')
    assert.equal(env['HELM_TOKEN'], undefined)
  })

  it('buildToolEnv: strips inherited HELM_TOKEN without provider; managed processToken overrides stash collisions', { timeout: 60_000 }, () => {
    const stash = new SecretStash()
    stash.put(8, 'HELM_TOKEN', 'stash-spoofed-token')
    const base: HelmToolDeps = {
      dataDir: '/d',
      defaultCwd: '/base',
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: (id) => stash.envFor(id),
      redact: (t) => t,
      artifacts: null as never,
    }
    const withProvider = buildToolEnv({ ...base, processToken: () => 'managed-tok-1' }, '/work', 8)
    assert.equal(withProvider['HELM_TOKEN'], 'managed-tok-1')
    const noProvider = buildToolEnv(base, '/work', 8)
    assert.equal(noProvider['HELM_TOKEN'], undefined)
  })

  it('runShell: child receives managed HELM_TOKEN while redacting output; omits HELM_TOKEN without provider', { timeout: 60_000 }, async () => {
    const auth = new AuthService(join(rootDir, 'rs10'))
    const managed = auth.createProcessToken()
    const releaseRedaction = (() => {
      const stash = new SecretStash()
      return { stash, release: stash.addRedaction(managed.token) }
    })()
    const depsManaged = await makeRealDeps(join(rootDir, 'rs11'), releaseRedaction.stash)
    const depsWithToken: HelmToolDeps = {
      ...depsManaged,
      processToken: () => managed.token,
    }
    const echo = await runShell(depsWithToken, 'printf %s "$HELM_TOKEN" | dd bs=1 2>/dev/null', { conversationId: 1 })
    assert.equal(echo.ok, true)
    assert.ok(!echo.output.includes(managed.token), 'managed token plaintext must not appear in output')
    assert.ok(echo.output.includes('[REDACTED]'), 'must show REDACTED marker')

    const hostEnv = process.env['HELM_TOKEN']
    const both = await runShell(
      depsWithToken,
      `printf '%s %s' "${hostEnv ?? 'inherited-host-token'}" "$HELM_TOKEN" | dd bs=1 2>/dev/null`,
      { conversationId: 1 },
    )
    assert.equal(both.ok, true)
    assert.ok(!both.output.includes(managed.token), 'managed token must never leak')
    assert.ok(!hostEnv || !both.output.includes(hostEnv), 'inherited host token must never leak')

    const depsPlain = await makeRealDeps(join(rootDir, 'rs12'))
    const absent = await runShell(depsPlain, 'echo "${HELM_TOKEN:-UNSET}"', { conversationId: 1 })
    assert.equal(absent.ok, true)
    assert.ok(absent.output.includes('UNSET'), 'child process must not inherit HELM_TOKEN without provider')

    managed.dispose()
    assert.equal(await new AuthService(join(rootDir, 'rs10')).verifyToken(managed.token), false)
    releaseRedaction.release()
  })
})

describe('runGate real execution', { timeout: 60_000 }, () => {
  it('propagates exitCode and timedOut accurately (0 on success, non-zero on failure)', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rg1'))
    const ok = await runGate(deps, 'echo gate-ok')
    assert.equal(ok.ok, true)
    assert.equal(ok.exitCode, 0)
    assert.equal(ok.timedOut, false)
    assert.ok(ok.output.includes('gate-ok'))
    const fail = await runGate(deps, 'echo gate-err >&2; exit 3')
    assert.equal(fail.ok, false)
    assert.equal(fail.exitCode, 3)
    assert.equal(fail.timedOut, false)
    assert.ok(fail.output.includes('gate-err'))
  })

  it('kills process group on timeoutMs and returns timedOut=true / exitCode=null', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rg2'))
    const started = Date.now()
    const result = await runGate(deps, 'sleep 30', { timeoutMs: 500 })
    assert.equal(result.ok, false)
    assert.equal(result.timedOut, true)
    assert.equal(result.exitCode, null)
    assert.ok(Date.now() - started < 10_000, 'timeout should kill group promptly without awaiting 30s')
    assert.ok(result.output.includes('timeout'))
  })

  it('explicitly rejects invalid timeoutMs via runShell instead of silently defaulting', { timeout: 60_000 }, async () => {
    const deps = await makeRealDeps(join(rootDir, 'rg3'))
    for (const bad of [0, -5, 1.5, Number.NaN, 601_000]) {
      await assert.rejects(
        () => runGate(deps, 'true', { timeoutMs: bad }),
        /invalid_timeout/,
        `timeoutMs=${bad} should explicitly reject`,
      )
    }
  })
})

describe('read tool real file behavior', { timeout: 60_000 }, () => {
  it('reads file inside cwd and returns content via spill', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'rd1')
    const deps = await makeRealDeps(dir)
    writeFileSync(join(dir, 'note.md'), '# title\nbody text')
    const tool = createReadTool(deps)
    const result = await tool.execute(
      { path: 'note.md' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false)
    const structured = result.structuredOutput as { content: string }
    assert.ok(structured.content.includes('# title'))
    // details carries factual metadata only for UI persistence without duplicating content.
    const details = result.details as { path?: string; nodeId?: string; content?: string }
    assert.equal(typeof details.path, 'string')
    assert.equal(details.nodeId, 'local')
    assert.equal('content' in details, false)
  })

  it('permits ../ traversal and absolute paths outside cwd (parity with bash)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'rd2')
    mkdirSync(join(dir, 'inner'), { recursive: true })
    const deps = await makeRealDeps(join(dir, 'inner'))
    writeFileSync(join(dir, 'secret.txt'), 'outside')
    const tool = createReadTool(deps)
    for (const p of ['../secret.txt', join(dir, 'secret.txt'), '/etc/hostname']) {
      const result = await tool.execute({ path: p }, makeApi(join(dir, 'inner')), BACKGROUND_CONTEXT)
      assert.equal(!!result.isError, false, `path ${p} should be readable`)
    }
    const structured = (
      await tool.execute({ path: '../secret.txt' }, makeApi(join(dir, 'inner')), BACKGROUND_CONTEXT)
    ).structuredOutput as { content: string }
    assert.ok(structured.content.includes('outside'), 'should read file outside cwd')
  })

  it('follows symlinks including targets outside cwd (parity with bash)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'rd3')
    const outer = join(rootDir, 'rd3-outer')
    mkdirSync(outer, { recursive: true })
    mkdirSync(join(dir, 'inner'), { recursive: true })
    writeFileSync(join(outer, 'linked.txt'), 'via-symlink')
    symlinkSync(join(outer, 'linked.txt'), join(dir, 'inner', 'link.txt'))
    const deps = await makeRealDeps(join(dir, 'inner'))
    const tool = createReadTool(deps)
    const result = await tool.execute(
      { path: 'link.txt' },
      makeApi(join(dir, 'inner')),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false, 'symlinks should be readable cleanly')
    const structured = result.structuredOutput as { content: string }
    assert.ok(structured.content.includes('via-symlink'))
  })

  it('rejects directories; oversized files return file_too_large pointing to bash + read_artifact', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'rd4')
    const deps = await makeRealDeps(dir)
    const tool = createReadTool(deps)
    const dirResult = await tool.execute({ path: '.' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(dirResult.isError, true)
    const big = Buffer.alloc(129 * 1024, 0x61)
    writeFileSync(join(dir, 'big.txt'), big)
    const bigResult = await tool.execute({ path: 'big.txt' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(bigResult.isError, true)
    const text = (bigResult.output as Array<{ type: string; text: string }>)[0]!.text
    assert.ok(text.includes('file_too_large'))
    assert.ok(text.includes('read_artifact'), 'error message should suggest paginated read_artifact fallback')
  })

  it('redacts secrets from read failure messages', { timeout: 60_000 }, async () => {
    const stash = new SecretStash()
    const secretValue = 'sk-read-error-secret-777'
    stash.put(1, 'TOK', secretValue)
    const dir = join(rootDir, 'rd5')
    const deps = await makeRealDeps(dir, stash)
    const tool = createReadTool(deps)
    const result = await tool.execute(
      { path: 'no-such-file.txt' },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(result.isError, true)
    assert.ok(!JSON.stringify(result).includes(secretValue), 'error text must also be redacted')
  })
})

describe('read_artifact real ArtifactService behavior', { timeout: 60_000 }, () => {
  it('paginates real spilled artifact cleanly through EOF', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra1')
    const deps = await makeRealDeps(dir)
    const fullText = '\u4e2d\u6587'.repeat(8000) // 48000 UTF-8 bytes > 32KiB triggers spill
    const { artifact } = await deps.artifacts.spill(1, 'call-1', fullText)
    assert.ok(artifact, 'text >32KiB should generate a spill artifact')
    const tool = createReadArtifactTool(deps, (conv, owner) => conv === owner)
    let offset = 0
    let chunks = ''
    let guard = 0
    for (;;) {
      const result = await tool.execute(
        { id: artifact!.id, offset, limit: 4096 },
        makeApi(dir, 1),
        BACKGROUND_CONTEXT,
      )
      assert.equal(!!result.isError, false)
      const structured = result.structuredOutput as { chunk: string; nextOffset?: number }
      chunks += structured.chunk
      if (structured.nextOffset === undefined) break
      assert.ok(structured.nextOffset > offset, `nextOffset must advance strictly (${offset} -> ${structured.nextOffset})`)
      offset = structured.nextOffset
      assert.ok(++guard < 100, 'pagination loop must terminate')
    }
    assert.equal(chunks, fullText, 'concatenated pages must match full text losslessly at UTF-8 boundaries')
  })

  it('never emits replacement chars at any byte offset; limit=1 always advances past multibyte chars', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra2')
    const deps = await makeRealDeps(dir)
    const { artifact } = await deps.artifacts.spill(1, 'call-2', '漢字テスト'.repeat(3000))
    const tool = createReadArtifactTool(deps, (conv, owner) => conv === owner)
    const fullText = '漢字テスト'.repeat(3000)
    const buffer = Buffer.from(fullText, 'utf8')
    for (let offset = 0; offset < buffer.length; offset += 997) {
      const result = await tool.execute(
        { id: artifact!.id, offset, limit: 1 },
        makeApi(dir, 1),
        BACKGROUND_CONTEXT,
      )
      const structured = result.structuredOutput as { chunk: string; nextOffset?: number }
      assert.ok(!structured.chunk.includes('\uFFFD'), `offset=${offset} must never emit replacement chars`)
      assert.ok(
        structured.nextOffset === undefined || structured.nextOffset > offset,
        `offset=${offset} limit=1 must still advance`,
      )
    }
    // 1) limit=1 starting mid-char at offset=1 reads 15 consecutive steps cleanly after skipping lead partial sequence
    const midCharOffset = 1 // byte 2 of '漢'
    let headOffset = midCharOffset
    let headTotal = ''
    for (let step = 0; step < 15; step += 1) {
      const result = await tool.execute(
        { id: artifact!.id, offset: headOffset, limit: 1 },
        makeApi(dir, 1),
        BACKGROUND_CONTEXT,
      )
      const structured = result.structuredOutput as { chunk: string; nextOffset?: number }
      assert.ok(!structured.chunk.includes('\uFFFD'), `head step=${step} must never emit replacement chars`)
      assert.ok(
        structured.nextOffset !== undefined && structured.nextOffset > headOffset,
        `head step=${step} nextOffset must increase strictly (${headOffset} -> ${structured.nextOffset})`,
      )
      headTotal += structured.chunk
      headOffset = structured.nextOffset
    }
    assert.equal(headTotal, fullText.slice(1, 16), 'reading mid-char skips partial leading sequence and recovers next 15 chars')

    // 2) limit=1 starting mid-char near EOF reads cleanly to EOF
    let tailOffset = buffer.length - 17
    let tailTotal = ''
    let tailGuard = 0
    for (;;) {
      const result = await tool.execute(
        { id: artifact!.id, offset: tailOffset, limit: 1 },
        makeApi(dir, 1),
        BACKGROUND_CONTEXT,
      )
      const structured = result.structuredOutput as { chunk: string; nextOffset?: number }
      assert.ok(!structured.chunk.includes('\uFFFD'), `tail offset=${tailOffset} must never emit replacement chars`)
      tailTotal += structured.chunk
      if (structured.nextOffset === undefined) break
      assert.ok(structured.nextOffset > tailOffset, `tail nextOffset must advance strictly (${tailOffset} -> ${structured.nextOffset})`)
      tailOffset = structured.nextOffset
      assert.ok(++tailGuard < 20, 'char-by-char tail pagination must terminate cleanly')
    }
    assert.equal(tailTotal, fullText.slice(-5), 'reading mid-char near tail must skip leading fragment and recover trailing 5 chars')
  })

  it('rejects out-of-scope conversations (only authorizes current conversation/ancestor chain)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra3')
    const deps = await makeRealDeps(dir)
    const { artifact } = await deps.artifacts.spill(2, 'call-3', 'owner-2-content-'.repeat(3000))
    const tool = createReadArtifactTool(
      deps,
      (conv, owner) => conv === owner,
    )
    const denied = await tool.execute({ id: artifact!.id }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(denied.isError, true)
    const allowed = await tool.execute({ id: artifact!.id }, makeApi(dir, 2), BACKGROUND_CONTEXT)
    assert.equal(!!allowed.isError, false)
  })

  it('storage read error never masquerades as artifact_not_found (propagates real error)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra3b')
    await ensureDataDir(dir)
    const real = new ArtifactService(dir, new InMemoryArtifactRepository(), new SecretStash())
    const storageBug = new Error('sqlite: disk I/O error')
    const deps: HelmToolDeps = {
      dataDir: dir,
      defaultCwd: dir,
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: () => ({}),
      redact: (t) => t,
      artifacts: {
        spill: (conversationId, callId, text) => real.spill(conversationId, callId, text),
        get: async () => {
          throw storageBug
        },
        readContent: (id) => real.readContent(id),
        readBuffer: (id) => real.readBuffer(id),
      },
    }
    const tool = createReadArtifactTool(deps, () => true)
    const result = await tool.execute({ id: 'any-id' }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(result.isError, true)
    const text = (result.output as Array<{ text: string }>)[0]!.text
    assert.ok(text.includes('artifact_read_failed'), `should report storage read failure: ${text}`)
    assert.ok(text.includes('disk I/O error'), `underlying error must surface: ${text}`)
    assert.ok(!text.includes('artifact_not_found'), `storage failure must not masquerade as missing: ${text}`)
  })

  it('missing artifact returns artifact_not_found; out-of-range offset rejects; final page omits nextOffset field', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra4')
    const deps = await makeRealDeps(dir)
    const tool = createReadArtifactTool(deps, () => true)
    const missing = await tool.execute({ id: 'no-such-id' }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(missing.isError, true)
    assert.ok(
      ((missing.output as Array<{ text: string }>)[0]!.text).includes('artifact_not_found'),
    )
    const { artifact } = await deps.artifacts.spill(1, 'call-4', 'short-content-'.repeat(3000))
    const oob = await tool.execute(
      { id: artifact!.id, offset: 99999 },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(oob.isError, true)
    assert.ok(((oob.output as Array<{ text: string }>)[0]!.text).includes('offset_out_of_range'))
    let lastOffset = 0
    let last: { structuredOutput?: Record<string, unknown> } = {}
    for (let guard = 0; guard < 100; guard++) {
      const page = (await tool.execute(
        { id: artifact!.id, offset: lastOffset },
        makeApi(dir, 1),
        BACKGROUND_CONTEXT,
      )) as { structuredOutput?: Record<string, unknown> }
      last = page
      const next = (page.structuredOutput as { nextOffset?: number }).nextOffset
      if (next === undefined) break
      lastOffset = next
    }
    const structured = last.structuredOutput as Record<string, unknown>
    assert.ok(!('nextOffset' in structured), 'final page must omit undefined nextOffset field')
    assert.equal(JSON.stringify(structured).includes('undefined'), false)
  })
})

describe('bash tool (direct SDK execute call with real service deps)', { timeout: 60_000 }, () => {
  it('executes successfully and returns structuredOutput via real spill', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'bt1')
    const deps = await makeRealDeps(dir)
    const tool = createBashTool(deps)
    const result = await tool.execute(
      { command: 'echo hello-tools' },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false)
    const structured = result.structuredOutput as { ok: boolean; output: string }
    assert.equal(structured.ok, true)
    assert.ok(structured.output.includes('hello-tools'))
    const details = result.details as Record<string, unknown>
    assert.equal(details['ok'], true)
    assert.equal(details['exitCode'], 0)
    assert.equal(details['timedOut'], false)
    assert.equal('output' in details, false)
  })

  it('failed command returns isError; invalid timeoutMs explicitly rejected', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'bt2')
    const deps = await makeRealDeps(dir)
    const tool = createBashTool(deps)
    const fail = await tool.execute(
      { command: 'exit 7' },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(fail.isError, true)
    const bad = await tool.execute(
      { command: 'true', timeoutMs: -1 },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(bad.isError, true)
    assert.ok(
      ((bad.output as Array<{ text: string }>)[0]!.text).includes('invalid_timeout'),
      'invalid timeout must not silently fall back to default',
    )
  })
})

describe('real SDK pipeline (faux model drives tool calls)', { timeout: 60_000 }, () => {
  it('bash tool executes via harness + spills artifact + read_artifact reads back', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'sdk1')
    const kernel = (await openRuntime(dir)) as never as ReturnType<typeof openRuntime> & {
      __faux: FauxHandle
      close(): Promise<void>
      submitInput(id: number, text: string): Promise<unknown>
      waitForIdle(id: number): Promise<void>
      getLastAssistantText(id: number): Promise<string>
      abortConversation(id: number): Promise<void>
      getConversation(id: number): { status: string }
      services: { artifacts: ArtifactService }
    }
    try {
      const bigCommand = `python3 -c "print('B'*40000)"`
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: bigCommand })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('done'),
      ])
      await kernel.submitInput(1, 'generate large output')
      await kernel.waitForIdle(1)
      assert.equal(await kernel.getLastAssistantText(1), 'done')
      const artifacts = await kernel.services.artifacts.list(1)
      const spill = artifacts.find((a) => a.name.startsWith('tool-spill-'))
      assert.ok(spill, 'spill artifact should exist')
      const content = await kernel.services.artifacts.readContent(spill!.id)
      assert.ok(content.includes('BBBBB'))
    } finally {
      await kernel.close()
    }
  })

  it('edit diff persists via real harness into toolResult details (Web diff rendering persistence channel)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'sdk3')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'code.ts'), 'alpha\nbeta\n')
    const kernel = (await openRuntime(dir)) as never as ReturnType<typeof openRuntime> & {
      __faux: FauxHandle
      close(): Promise<void>
      submitInput(id: number, text: string): Promise<unknown>
      waitForIdle(id: number): Promise<void>
      getConversationDetail(id: number): Promise<{ entries: Array<{ kind: string; model?: unknown[] }> }>
    }
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('edit', { path: 'code.ts', oldText: 'beta', newText: 'BETA' })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('done'),
      ])
      await kernel.submitInput(1, 'change file')
      await kernel.waitForIdle(1)
      assert.equal(readFileSync(join(dir, 'code.ts'), 'utf8'), 'alpha\nBETA\n')
      const detail = await kernel.getConversationDetail(1)
      const messages = detail.entries
        .filter((e: { kind: string; model?: unknown[] }) => e.kind === 'pi.tool-result')
        .flatMap((e: { kind: string; model?: unknown[] }) => ((e.model ?? []) as Array<Record<string, unknown>>))
      const editMessage = messages.find((m: Record<string, unknown>) => m['toolName'] === 'edit')
      assert.ok(editMessage, 'edit toolResult message must exist')
      // structuredOutput is not persisted by SDK; Web diff rendering reads persisted details.
      assert.equal('structuredOutput' in editMessage!, false)
      const validate = new Ajv({ allErrors: true, strict: false }).compile<EditToolResult>(EDIT_TOOL_RESULT_SCHEMA)
      assert.ok(validate(editMessage!['details']), `details must satisfy EDIT_TOOL_RESULT_SCHEMA: ${JSON.stringify(validate.errors)}`)
      assert.equal((editMessage!['details'] as EditToolResult).diff.addedLines, 1)
    } finally {
      await kernel.close()
    }
  })

  it('abortConversation during bash run kills shell cleanly without awaiting 120s', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'sdk2')
    const kernel = (await openRuntime(dir)) as never as ReturnType<typeof openRuntime> & {
      __faux: FauxHandle
      close(): Promise<void>
      submitInput(id: number, text: string): Promise<unknown>
      waitForIdle(id: number): Promise<void>
      abortConversation(id: number): Promise<void>
      getConversation(id: number): { status: string }
    }
    try {
      kernel.__faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('bash', { command: `sleep 120` })],
          { stopReason: 'toolUse' },
        ),
      ])
      const started = Date.now()
      void kernel.submitInput(1, 'run long command').catch(() => {})
      await new Promise((r) => setTimeout(r, 400))
      await kernel.abortConversation(1)
      await kernel.waitForIdle(1).catch(() => {})
      const elapsed = Date.now() - started
      assert.ok(elapsed < 30_000, `abort should interrupt tool instead of awaiting timeout (${elapsed}ms)`)
      const conv = kernel.getConversation(1)
      assert.ok(['idle', 'error'].includes(conv.status))
    } finally {
      await kernel.close()
    }
  })
})

describe('shutdown abort state: spill protection & replay marker', { timeout: 60_000 }, () => {
  it('createBashTool throws abort error when aborted mid-run without writing spill artifacts', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'abort-bash')
    const baseDeps = await makeRealDeps(dir)
    let spillCalled = 0
    const deps: HelmToolDeps = {
      ...baseDeps,
      artifacts: {
        ...baseDeps.artifacts,
        spill: async (...args) => {
          spillCalled += 1
          return baseDeps.artifacts.spill(...args)
        },
      },
    }
    const tool = createBashTool(deps)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('kernel closing')), 150)
    try {
      await assert.rejects(
        () =>
          (tool.execute as unknown as (a: unknown, api: unknown, ctx: unknown) => Promise<unknown>)(
            { command: 'sleep 30' },
            makeApi(dir),
            { abortSignal: ac.signal },
          ),
        (err: unknown) => err instanceof Error && err.message === 'kernel closing',
      )
      assert.equal(spillCalled, 0, 'abort must not leave meaningless spill files')
    } finally {
      clearTimeout(timer)
    }
  })

  it('createReadTool throws abort error without calling spill; only read tools declare replay: safe', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'abort-read')
    const baseDeps = await makeRealDeps(dir)
    writeFileSync(join(dir, 'sample.txt'), 'hello abort world\n', 'utf8')
    let spillCalled = 0
    const deps: HelmToolDeps = {
      ...baseDeps,
      artifacts: {
        ...baseDeps.artifacts,
        spill: async (...args) => {
          spillCalled += 1
          return baseDeps.artifacts.spill(...args)
        },
      },
    }
    const readTool = createReadTool(deps)
    const readArtifactTool = createReadArtifactTool(deps, () => true)
    assert.equal(readTool.replay, 'safe')
    assert.equal(readArtifactTool.replay, 'safe')

    const ac = new AbortController()
    const abortReason = new Error('close during read')
    const baseApi = makeApi(dir) as unknown as Record<string, unknown>
    const api = {
      ...baseApi,
      agent: async () => {
        ac.abort(abortReason)
        return { cwd: dir }
      },
    }
    await assert.rejects(
      () =>
        (readTool.execute as unknown as (a: unknown, api: unknown, ctx: unknown) => Promise<unknown>)(
          { path: 'sample.txt' },
          api,
          { abortSignal: ac.signal },
        ),
      (err: unknown) => err === abortReason,
    )
    assert.equal(spillCalled, 0, 'aborted read must not write spill files')
  })
})

/** Minimal live ToolExecutionApi: conversationId / callId / agent(cwd) provided per SDK contract. */
function makeApi(cwd: string, conversationId = 1) {
  return {
    taskId: 'test-task',
    conversationId,
    callId: 'call-test-1',
    registry: { tools: [] },
    agent: async () => ({ cwd }),
    models: {},
    env: undefined,
    now: () => Date.now(),
    output: () => {},
    outputWindow: undefined,
    retainedOutput: () => ({ text: '', truncated: false }),
    diagnostic: () => {},
    details: async () => {},
    commit: async (change: () => unknown) => change(),
    memo: async () => undefined,
    createTask: async () => {
      throw new Error('not used in test')
    },
    getTask: async () => undefined,
    waitForTask: async () => {
      throw new Error('not used in test')
    },
    conversation: async () => undefined,
    executeTool: async () => {
      throw new Error('not used in test')
    },
  } as never
}

function existsSyncSafe(path: string): boolean {
  return existsSync(path)
}
