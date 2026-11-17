/**
 * Unit tests for runtime/target-cwd (single kernel source of truth for cwd normalization):
 * - resolveTargetPlatform: local defaults to process.platform, optional trusted source can inject Hub
 *   platform; remote uses only TrustedNodePlatformSource reporting;
 * - trustedPlatformFromEnvFabric: local defaults to process.platform (supports Hub override); remote
 *   reads registry record (unregistered / empty platform -> undefined);
 * - normalizeCwdForPlatform / normalizeSessionCwd: rejects relative paths (including drive-relative),
 *   passes through unknown platforms untouched, deterministically converts win32 targets
 *   (/mnt/<drive>, /<drive>, //srv), and explicitly fails unmappable POSIX paths (never leaks broken
 *   POSIX cwds into normalized output).
 *
 * Pure normalizeTargetPath matrix is locked in packages/protocol/test/target-path-platform.test.ts;
 * this suite verifies kernel normalization layer's platform resolution and rejection contracts.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HelmError } from '@helm/protocol'
import {
  normalizeCwdForPlatform,
  normalizeSessionCwd,
  resolveTargetPlatform,
  trustedPlatformFromEnvFabric,
} from '../src/runtime/target-cwd.js'

const isWinHub = process.platform === 'win32'

describe('resolveTargetPlatform: target platform resolution (trusted source)', () => {
  it('local uses process.platform (win32 special-cased, all others follow posix semantics)', { timeout: 60_000 }, () => {
    assert.equal(resolveTargetPlatform('local'), isWinHub ? 'win32' : 'posix')
    assert.equal(resolveTargetPlatform(undefined), isWinHub ? 'win32' : 'posix')
    assert.equal(resolveTargetPlatform(''), isWinHub ? 'win32' : 'posix')
  })

  it('remote respects only trusted source reports: win32 -> win32; linux/darwin -> posix; missing/absent -> undefined (never guesses)', { timeout: 60_000 }, () => {
    const source = (nodeId: string): string | undefined =>
      nodeId === 'win-node' ? 'win32' : nodeId === 'mac-node' ? 'darwin' : nodeId === 'silent' ? '' : undefined
    assert.equal(resolveTargetPlatform('win-node', source), 'win32')
    assert.equal(resolveTargetPlatform('mac-node', source), 'posix')
    assert.equal(resolveTargetPlatform('silent', source), undefined)
    assert.equal(resolveTargetPlatform('unknown-node', source), undefined)
    assert.equal(resolveTargetPlatform('any-remote'), undefined, 'remote defaults to unknown without trusted source')
  })

  it('local defaults to host platform, yet trusted source may inject Hub platform', { timeout: 60_000 }, () => {
    const injected = (): string => 'linux'
    assert.equal(resolveTargetPlatform('local', injected), 'posix')
  })
})

describe('trustedPlatformFromEnvFabric: EnvFabric registry adapter', () => {
  it('local defaults to process.platform; supports Hub platform injection; remote reads registry.get(nodeId).platform', { timeout: 60_000 }, () => {
    const host = {
      registry: {
        get: (nodeId: string): { platform: string } | undefined =>
          nodeId === 'win-node' ? { platform: 'win32' } : nodeId === 'empty' ? { platform: '' } : undefined,
      },
    }
    const source = trustedPlatformFromEnvFabric(host as never)
    assert.equal(source('local'), process.platform)
    assert.equal(source('win-node'), 'win32')
    assert.equal(source('empty'), undefined, 'empty platform report is treated as unknown')
    assert.equal(source('offline-node'), undefined)
  })

  it('uses injected Hub platform for local when EnvFabric provides hubPlatform', { timeout: 60_000 }, () => {
    const source = trustedPlatformFromEnvFabric({
      registry: { get: () => undefined },
      hubPlatform: () => 'linux',
    } as never)
    assert.equal(source('local'), 'linux')
    assert.equal(source('remote'), undefined)
  })

  it('still resolves local when envFabric is omitted (remote unknown)', { timeout: 60_000 }, () => {
    const source = trustedPlatformFromEnvFabric(undefined)
    assert.equal(source('local'), process.platform)
    assert.equal(source('remote'), undefined)
  })
})

describe('normalizeCwdForPlatform: rejects relative paths and normalizes by platform', () => {
  it('rejects relative and drive-relative paths (preserving absolute-path contract)', { timeout: 60_000 }, () => {
    for (const bad of ['relative/ws', './here', '..', 'C:relative', 'c:']) {
      assert.throws(
        () => normalizeCwdForPlatform(bad, 'posix', 'test'),
        (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
        `relative form '${bad}' must reject`,
      )
      assert.throws(
        () => normalizeCwdForPlatform(bad, 'win32', 'test'),
        (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
      )
    }
  })

  it('unknown platform (undefined): passes through untouched without guessing for unverified remote targets', { timeout: 60_000 }, () => {
    assert.equal(normalizeCwdForPlatform('/mnt/c/work', undefined, 'test'), '/mnt/c/work')
    assert.equal(normalizeCwdForPlatform('C:\\work\\x', undefined, 'test'), 'C:\\work\\x')
  })

  it('win32 platform: deterministically converts WSL / Git Bash / UNC forms', { timeout: 60_000 }, () => {
    assert.equal(normalizeCwdForPlatform('/mnt/c/work/x', 'win32', 'test'), 'C:\\work\\x')
    assert.equal(normalizeCwdForPlatform('/d/ws', 'win32', 'test'), 'D:\\ws')
    assert.equal(normalizeCwdForPlatform('//server/share/ws', 'win32', 'test'), '\\\\server\\share\\ws')
  })

  it('win32 platform: rejects unmappable POSIX paths explicitly instead of leaking broken POSIX cwds', { timeout: 60_000 }, () => {
    for (const bad of ['/home/user', '/tmp', '/', '/mnt/cdrom', '/mnt']) {
      assert.throws(
        () => normalizeCwdForPlatform(bad, 'win32', 'test'),
        (e: unknown) => e instanceof HelmError && e.code === 'unmappable_posix_root',
        `unmappable POSIX path '${bad}' must fail explicitly`,
      )
    }
  })

  it('posix platform: normalizes POSIX syntax and never reverse-converts /mnt/<drive>', { timeout: 60_000 }, () => {
    assert.equal(normalizeCwdForPlatform('/mnt/c/work/x/', 'posix', 'test'), '/mnt/c/work/x/')
    assert.equal(normalizeCwdForPlatform('/a//b/./c', 'posix', 'test'), '/a/b/c')
  })
})

describe('normalizeSessionCwd: combines node resolution with platform normalization', () => {
  it('resolves platform by target node before normalizing (win-node / unknown-node / local)', { timeout: 60_000 }, () => {
    const source = (nodeId: string): string | undefined => (nodeId === 'win-node' ? 'win32' : undefined)
    assert.equal(
      normalizeSessionCwd('/mnt/c/work', { nodeId: 'win-node', trustedPlatform: source, entry: 'test' }),
      'C:\\work',
    )
    assert.equal(
      normalizeSessionCwd('/mnt/c/work', { nodeId: 'unknown-node', trustedPlatform: source, entry: 'test' }),
      '/mnt/c/work',
      'remote platform unknown: passes through',
    )
    const localPlatform = isWinHub ? 'win32' : 'posix'
    assert.equal(
      normalizeSessionCwd('/a/b/../c', { nodeId: 'local', trustedPlatform: source, entry: 'test' }),
      localPlatform === 'win32' ? normalizeCwdForPlatform('/a/b/../c', 'win32', 'test') : '/a/c',
    )
  })

  it('rejects relative paths before platform resolution regardless of whether platform is known', { timeout: 60_000 }, () => {
    assert.throws(
      () => normalizeSessionCwd('rel', { nodeId: 'unknown-node', entry: 'test' }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
    )
  })
})
