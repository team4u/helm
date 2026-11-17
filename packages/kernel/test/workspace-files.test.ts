/**
 * Workspace file reading integration & MIME detection tests:
 * - detectWorkspaceFileMime: markdown, structured text, source/config text, binary formats,
 *   and unknown/extensionless 8 KiB UTF-8 / NUL / split multi-byte boundary sniffing.
 * - KernelRuntime.readConversationFile + HTTP GET /api/conversations/:id/files/content:
 *   local read, subdir & safe .., escaping .. (403), symlink escape (403), directory (400),
 *   missing file (404), >15 MiB (413), SecretStash redaction on .env/.ts/extensionless text,
 *   binary PNG exact byte preservation, headers (cache-control: private, no-store, nosniff,
 *   content-disposition, inline CSP sandbox), 501 when unimplemented, remote node via EnvFabric
 *   & offline node (409 node_offline).
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, describe, it } from 'node:test'
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HelmError } from '@helm/protocol'
import { createNodeDaemon } from '@helm/node'
import {
  KernelRuntime,
  MAX_ARTIFACT_BYTES,
  attachNodeWsGateway,
  createHubHandler,
  detectWorkspaceFileMime,
} from '../src/index.js'
import type { KernelRuntimeLike } from '../src/http/index.js'
import { cleanupDir, makeFauxModels, makeTempDir, waitFor } from './helpers.js'

describe('detectWorkspaceFileMime', { timeout: 60_000 }, () => {
  it('classifies markdown, structured text, source/config extensions, and binary formats', { timeout: 60_000 }, () => {
    for (const name of ['README.md', 'guide.markdown', 'page.mdx']) {
      assert.deepEqual(detectWorkspaceFileMime(name), { mimeType: 'text/markdown', isText: true }, name)
    }

    const structured: Array<[string, string]> = [
      ['pkg.json', 'application/json'],
      ['pom.xml', 'application/xml'],
      ['icon.svg', 'image/svg+xml'],
      ['index.html', 'text/html'],
      ['about.htm', 'text/html'],
      ['app.css', 'text/css'],
      ['data.csv', 'text/csv'],
      ['cfg.yaml', 'text/yaml'],
      ['cfg.yml', 'text/yaml'],
      ['main.js', 'text/javascript'],
      ['mod.mjs', 'text/javascript'],
      ['lib.cjs', 'text/javascript'],
    ]
    for (const [name, mimeType] of structured) {
      assert.deepEqual(detectWorkspaceFileMime(name), { mimeType, isText: true }, name)
    }

    for (const name of [
      'a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.jsx', 'a.py', 'a.go', 'a.rs',
      'a.java', 'a.kt', 'a.swift', 'a.c', 'a.h', 'a.cpp', 'a.hpp', 'a.cc', 'a.cs',
      'a.rb', 'a.php', 'a.lua', 'a.sh', 'a.bash', 'a.zsh', 'a.fish', 'a.ps1',
      'a.bat', 'a.cmd', 'a.sql', 'a.toml', 'a.ini', 'a.properties', 'a.cfg',
      'a.conf', '.env', '.env.local', 'a.jsonc', 'a.json5', 'a.scss', 'a.less',
      'a.tsv', 'a.diff', 'a.patch', 'a.txt', 'a.log', '.gitignore', '.editorconfig',
      'Dockerfile', 'Makefile',
    ]) {
      assert.deepEqual(detectWorkspaceFileMime(name), { mimeType: 'text/plain', isText: true }, name)
    }

    const binaries: Array<[string, string]> = [
      ['a.png', 'image/png'],
      ['a.jpg', 'image/jpeg'],
      ['a.jpeg', 'image/jpeg'],
      ['a.gif', 'image/gif'],
      ['a.webp', 'image/webp'],
      ['a.ico', 'image/x-icon'],
      ['a.avif', 'image/avif'],
      ['a.pdf', 'application/pdf'],
      ['a.zip', 'application/zip'],
      ['a.gz', 'application/gzip'],
      ['a.mp3', 'audio/mpeg'],
      ['a.wav', 'audio/wav'],
      ['a.ogg', 'audio/ogg'],
      ['a.mp4', 'video/mp4'],
      ['a.webm', 'video/webm'],
    ]
    for (const [name, mimeType] of binaries) {
      assert.deepEqual(detectWorkspaceFileMime(name), { mimeType, isText: false }, name)
    }
  })

  it('sniffs unknown/extensionless files up to 8 KiB for UTF-8 validity and NUL absence', { timeout: 60_000 }, () => {
    assert.deepEqual(detectWorkspaceFileMime('unknownfile'), {
      mimeType: 'application/octet-stream',
      isText: false,
    })
    assert.deepEqual(detectWorkspaceFileMime('emptyfile', new Uint8Array(0)), {
      mimeType: 'text/plain',
      isText: true,
    })
    assert.deepEqual(detectWorkspaceFileMime('notes', new TextEncoder().encode('hello 世界\n')), {
      mimeType: 'text/plain',
      isText: true,
    })
    assert.deepEqual(detectWorkspaceFileMime('nul.unknown', new Uint8Array([0x61, 0x00, 0x62])), {
      mimeType: 'application/octet-stream',
      isText: false,
    })
    assert.deepEqual(detectWorkspaceFileMime('badutf8.unknown', new Uint8Array([0xff, 0xfe, 0x80])), {
      mimeType: 'application/octet-stream',
      isText: false,
    })

    // Multi-byte UTF-8 character ('中' = E4 B8 AD) split across the 8192-byte sniff boundary:
    // bytes 0..8189 are 'a', bytes 8190..8192 are E4 B8 AD (split between 8191 and 8192).
    const splitBuf = new Uint8Array(8200)
    splitBuf.fill(0x61)
    splitBuf[8190] = 0xe4
    splitBuf[8191] = 0xb8
    splitBuf[8192] = 0xad
    assert.deepEqual(detectWorkspaceFileMime('split-utf8', splitBuf), {
      mimeType: 'text/plain',
      isText: true,
    })

    // Genuine invalid UTF-8 right before 8192 must still be rejected as binary.
    const badBoundary = new Uint8Array(8200)
    badBoundary.fill(0x61)
    badBoundary[8190] = 0xff
    badBoundary[8191] = 0x80
    assert.deepEqual(detectWorkspaceFileMime('bad-boundary', badBoundary), {
      mimeType: 'application/octet-stream',
      isText: false,
    })
  })
})

describe('workspace file reader & HTTP GET /api/conversations/:id/files/content', { timeout: 60_000 }, () => {
  let root: string
  let dataDir: string
  let workspaceDir: string
  let outsideDir: string
  let kernel: KernelRuntime
  let handler: (req: Request) => Promise<Response>
  let token: string
  let convId: number

  before(async () => {
    root = await makeTempDir('helm-ws-files-')
    dataDir = join(root, 'data')
    workspaceDir = join(root, 'workspace')
    outsideDir = join(root, 'outside')
    await mkdir(dataDir, { recursive: true })
    await mkdir(join(workspaceDir, 'sub', 'nested'), { recursive: true })
    await mkdir(outsideDir, { recursive: true })

    const { models } = makeFauxModels()
    kernel = await KernelRuntime.open({
      dataDir,
      cwd: workspaceDir,
      model: 'faux/faux-1',
      models,
      autoResume: false,
    })
    handler = createHubHandler(kernel)
    const setupRes = await handler(
      new Request('http://127.0.0.1:3202/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'test-password-123' }),
      }),
    )
    assert.equal(setupRes.status, 200)
    token = ((await setupRes.json()) as { token: string }).token

    const conv = await kernel.createConversation({ title: 'ws-files', cwd: workspaceDir })
    convId = conv.id
  })

  after(async () => {
    await kernel.close()
    await cleanupDir(root)
  })

  async function requestFile(id: number, query: string): Promise<Response> {
    return handler(
      new Request(`http://127.0.0.1:3202/api/conversations/${id}/files/content${query}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    )
  }

  it('reads local workspace files, subdirectories, safe .. traversal, and safe symlinks with expected headers', { timeout: 60_000 }, async () => {
    await writeFile(join(workspaceDir, 'readme.md'), '# Title\nHello 世界\n', 'utf8')
    await writeFile(join(workspaceDir, 'sub', 'nested', 'code.ts'), 'export const x = 1\n', 'utf8')
    await symlink(join(workspaceDir, 'sub', 'nested', 'code.ts'), join(workspaceDir, 'safe-link.ts'))

    const mdRes = await requestFile(convId, `?path=${encodeURIComponent('readme.md')}`)
    assert.equal(mdRes.status, 200)
    assert.equal(mdRes.headers.get('content-type'), 'text/markdown; charset=utf-8')
    assert.equal(mdRes.headers.get('cache-control'), 'private, no-store')
    assert.equal(mdRes.headers.get('x-content-type-options'), 'nosniff')
    assert.match(mdRes.headers.get('content-disposition') ?? '', /^attachment; filename="readme\.md"/)
    assert.equal(mdRes.headers.get('content-security-policy'), null)
    const mdText = await mdRes.text()
    assert.equal(mdText, '# Title\nHello 世界\n')
    assert.equal(mdRes.headers.get('content-length'), String(Buffer.byteLength(mdText, 'utf8')))

    // .. that stays within workspace cwd is permitted
    const traversalRes = await requestFile(convId, `?path=${encodeURIComponent('sub/nested/../nested/code.ts')}`)
    assert.equal(traversalRes.status, 200)
    assert.equal(traversalRes.headers.get('content-type'), 'text/plain; charset=utf-8')
    assert.equal(await traversalRes.text(), 'export const x = 1\n')

    // Symlink resolving inside workspace cwd is permitted
    const safeLinkRes = await requestFile(convId, `?path=${encodeURIComponent('safe-link.ts')}`)
    assert.equal(safeLinkRes.status, 200)
    assert.equal(await safeLinkRes.text(), 'export const x = 1\n')
  })

  it('rejects escaping .. paths, absolute outside paths, and escaping symlinks with 403', { timeout: 60_000 }, async () => {
    const outsideSecret = join(outsideDir, 'secret.txt')
    await writeFile(outsideSecret, 'top-secret-outside', 'utf8')
    await symlink(outsideSecret, join(workspaceDir, 'escape-link.txt'))
    await symlink(outsideDir, join(workspaceDir, 'escape-dir'))

    for (const badPath of [
      '../outside/secret.txt',
      'sub/../../outside/secret.txt',
      '../definitely-does-not-exist.txt',
      outsideSecret,
      'escape-link.txt',
      'escape-dir/secret.txt',
    ]) {
      const res = await requestFile(convId, `?path=${encodeURIComponent(badPath)}`)
      assert.equal(res.status, 403, `expected 403 for ${badPath}, got ${res.status}`)
      const body = (await res.json()) as { error: { code: string } }
      assert.equal(body.error.code, 'path_outside_workspace', badPath)
    }
  })

  it('validates query params, cwd root, directories, missing files, missing conversations, and >15 MiB files', { timeout: 60_000 }, async () => {
    const noPath = await requestFile(convId, '')
    assert.equal(noPath.status, 400)
    assert.equal(((await noPath.json()) as { error: { code: string } }).error.code, 'validation_error')

    const emptyPath = await requestFile(convId, '?path=%20%20')
    assert.equal(emptyPath.status, 400)

    const dotPath = await requestFile(convId, '?path=.')
    assert.equal(dotPath.status, 400)
    assert.equal(((await dotPath.json()) as { error: { code: string } }).error.code, 'invalid_path')

    const nulPath = await requestFile(convId, `?path=${encodeURIComponent('a\0b')}`)
    assert.equal(nulPath.status, 400)
    assert.equal(((await nulPath.json()) as { error: { code: string } }).error.code, 'invalid_path')

    const longPath = await requestFile(convId, `?path=${'a'.repeat(1025)}`)
    assert.equal(longPath.status, 400)
    assert.equal(((await longPath.json()) as { error: { code: string } }).error.code, 'invalid_path')

    const dirRes = await requestFile(convId, '?path=sub')
    assert.equal(dirRes.status, 400)
    assert.equal(((await dirRes.json()) as { error: { code: string } }).error.code, 'not_a_regular_file')

    const missingFile = await requestFile(convId, '?path=missing.txt')
    assert.equal(missingFile.status, 404)
    assert.equal(((await missingFile.json()) as { error: { code: string } }).error.code, 'file_not_found')

    const missingConv = await requestFile(999999, '?path=readme.md')
    assert.equal(missingConv.status, 404)
    assert.equal(((await missingConv.json()) as { error: { code: string } }).error.code, 'not_found')

    // > 15 MiB file -> 413 file_too_large
    const bigPath = join(workspaceDir, 'too-big.bin')
    await writeFile(bigPath, new Uint8Array(MAX_ARTIFACT_BYTES + 1))
    const tooLarge = await requestFile(convId, '?path=too-big.bin')
    assert.equal(tooLarge.status, 413)
    assert.equal(((await tooLarge.json()) as { error: { code: string } }).error.code, 'file_too_large')
  })

  it('redacts SecretStash secrets from .env, .ts, and extensionless text files while preserving binary PNG bytes', { timeout: 60_000 }, async () => {
    const secretVal = 'sk-workspace-secret-token-xyz-987654'
    const placeholder = kernel.stash.put(convId, 'WS_TEST_SECRET', secretVal)

    await writeFile(join(workspaceDir, '.env'), `WS_TEST_SECRET=${secretVal}\nPUBLIC=ok\n`, 'utf8')
    await writeFile(join(workspaceDir, 'secret.ts'), `const key = "${secretVal}"\n`, 'utf8')
    await writeFile(join(workspaceDir, 'PLAIN_NOTES'), `note secret: ${secretVal}\n`, 'utf8')

    for (const file of ['.env', 'secret.ts', 'PLAIN_NOTES']) {
      const res = await requestFile(convId, `?path=${encodeURIComponent(file)}`)
      assert.equal(res.status, 200, file)
      assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8', file)
      const body = await res.text()
      assert.ok(!body.includes(secretVal), `${file} must not leak secret`)
      assert.ok(body.includes(placeholder), `${file} must include redaction placeholder`)
    }

    // Binary PNG with non-UTF-8 bytes & NUL bytes must remain byte-for-byte intact
    const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80])
    await writeFile(join(workspaceDir, 'logo.png'), pngBytes)
    const pngRes = await requestFile(convId, '?path=logo.png')
    assert.equal(pngRes.status, 200)
    assert.equal(pngRes.headers.get('content-type'), 'image/png')
    assert.equal(pngRes.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual([...new Uint8Array(await pngRes.arrayBuffer())], [...pngBytes])
  })

  it('sets inline disposition and sandbox CSP for inline HTML and SVG', { timeout: 60_000 }, async () => {
    await writeFile(join(workspaceDir, 'page.html'), '<h1>Hello</h1><script>alert(1)</script>', 'utf8')
    await writeFile(join(workspaceDir, 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8')

    const htmlInline = await requestFile(convId, '?path=page.html&inline=1')
    assert.equal(htmlInline.status, 200)
    assert.equal(htmlInline.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.match(htmlInline.headers.get('content-disposition') ?? '', /^inline; filename="page\.html"/)
    assert.equal(htmlInline.headers.get('content-security-policy'), 'sandbox')

    const svgInline = await requestFile(convId, '?path=chart.svg&inline=1')
    assert.equal(svgInline.status, 200)
    assert.equal(svgInline.headers.get('content-type'), 'image/svg+xml; charset=utf-8')
    assert.match(svgInline.headers.get('content-disposition') ?? '', /^inline; filename="chart\.svg"/)
    assert.equal(svgInline.headers.get('content-security-policy'), 'sandbox')

    // Without inline=1 -> attachment and no sandbox CSP
    const htmlAttach = await requestFile(convId, '?path=page.html')
    assert.equal(htmlAttach.status, 200)
    assert.match(htmlAttach.headers.get('content-disposition') ?? '', /^attachment; filename="page\.html"/)
    assert.equal(htmlAttach.headers.get('content-security-policy'), null)
  })

  it('returns 501 not_implemented when KernelRuntimeLike.readConversationFile is absent', { timeout: 60_000 }, async () => {
    const stubKernel: KernelRuntimeLike = {
      dataDir,
      auth: kernel.auth,
      events: kernel.events,
      profiles: kernel.profiles,
      skills: kernel.skills,
      credentials: kernel.credentials,
      providers: kernel.providers,
      artifacts: kernel.artifacts,
      plugins: kernel.plugins,
      listConversations: () => [],
      getConversationDetail: () => { throw new HelmError('not_found', 'missing', 404) },
      createConversation: () => { throw new Error('unused') },
      updateConversation: () => { throw new Error('unused') },
      deleteConversation: () => {},
      submitInput: () => ({ submissionId: 'x' }),
      waitForInput: () => { throw new Error('unused') },
      abortConversation: () => {},
      resetConversation: () => { throw new Error('unused') },
      compactConversation: () => { throw new Error('unused') },
      forkConversation: () => { throw new Error('unused') },
      listAsks: () => [],
      answerAsk: () => {},
      cancelAsk: () => {},
      search: () => [],
      listModels: () => ({ models: [], thinkingLevels: {} }),
      listModelProviders: () => [],
      listNodes: () => [],
      issueNodeToken: () => { throw new Error('unused') },
      removeNode: () => {},
      execEnv: () => { throw new Error('unused') },
    }
    const stubHandler = createHubHandler(stubKernel)
    const res = await stubHandler(
      new Request('http://127.0.0.1:3202/api/conversations/1/files/content?path=a.txt', {
        headers: { authorization: `Bearer ${token}` },
      }),
    )
    assert.equal(res.status, 501)
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'not_implemented')
  })

  it('reads remote node workspace files over EnvFabric and rejects offline nodes with 409 node_offline', { timeout: 60_000 }, async () => {
    const remoteWs = join(root, 'remote-ws')
    const remoteData = join(root, 'remote-node-data')
    const remoteOutside = join(root, 'remote-outside.txt')
    await mkdir(remoteWs, { recursive: true })
    await mkdir(remoteData, { recursive: true })
    await writeFile(join(remoteWs, 'remote.json'), '{"remote":true}\n', 'utf8')
    await writeFile(remoteOutside, 'remote-outside-secret', 'utf8')
    await symlink(remoteOutside, join(remoteWs, 'escape-remote.txt'))

    const server = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    assert.ok(addr !== null && typeof addr === 'object')
    const gateway = attachNodeWsGateway(server, { registry: kernel.envFabric.registry })

    const issued = await kernel.issueNodeToken('remote-ws-node')
    const daemon = await createNodeDaemon({
      hubUrl: `http://127.0.0.1:${addr.port}`,
      identity: { nodeId: issued.nodeId, token: issued.token },
      dataDir: remoteData,
      reconnectBaseDelayMs: 50,
      reconnectMaxDelayMs: 200,
      log: () => undefined,
    })

    try {
      assert.ok(await daemon.waitUntilRegistered())

      const remoteConv = await kernel.createConversation({
        title: 'remote-ws-conv',
        nodeId: 'remote-ws-node',
        cwd: remoteWs,
      })

      const okRes = await requestFile(remoteConv.id, '?path=remote.json')
      assert.equal(okRes.status, 200)
      assert.equal(okRes.headers.get('content-type'), 'application/json; charset=utf-8')
      assert.equal(await okRes.text(), '{"remote":true}\n')

      const escapeTraversal = await requestFile(remoteConv.id, '?path=../remote-outside.txt')
      assert.equal(escapeTraversal.status, 403)
      assert.equal(((await escapeTraversal.json()) as { error: { code: string } }).error.code, 'path_outside_workspace')

      const escapeSymlink = await requestFile(remoteConv.id, '?path=escape-remote.txt')
      assert.equal(escapeSymlink.status, 403)
      assert.equal(((await escapeSymlink.json()) as { error: { code: string } }).error.code, 'path_outside_workspace')

      // Close daemon -> offline node must fail with 409 node_offline, never fall back to local
      await daemon.close()
      await waitFor(() => !kernel.envFabric.isOnline('remote-ws-node'), 10_000)
      const offlineRes = await requestFile(remoteConv.id, '?path=remote.json')
      assert.equal(offlineRes.status, 409)
      assert.equal(((await offlineRes.json()) as { error: { code: string } }).error.code, 'node_offline')
    } finally {
      await daemon.close().catch(() => {})
      await gateway.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
