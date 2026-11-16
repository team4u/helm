/**
 * runtime/target-cwd unit test (kernel cwd consolidate unique implement):
 * - resolveTargetPlatform:local by default process.platform, explicit can message source can inject
 *   Hub platform; remote only message TrustedNodePlatformSource on report;
 * - trustedPlatformFromEnvFabric:local by default process.platform, support Hub inject;
 *   remote read registry register fact (not registered / empty platform = undefined);
 * - normalizeCwdForPlatform / normalizeSessionCwd: relative path reject (contains symbol each other for),
 *   platform unknown pass-through do not change write,win32 target determinism convert (/mnt/<symbol>,/<symbol>,//srv)
 *   and cannot mapping POSIX explicit failed (broken POSIX cwd never enter consolidate result).
 *
 * normalizeTargetPath pure function this body already by packages/protocol/test/
 * target-path-platform.test.ts one by one case lock, this where only test kernel consolidate layer platform
 * parse and reject contract, does not repeat protocol case matrix.
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

describe('resolveTargetPlatform: target platform parse (can message source)', () => {
  it('local use process.platform(win32 special judge, the rest one rule posix semantics)', { timeout: 60_000 }, () => {
    assert.equal(resolveTargetPlatform('local'), isWinHub ? 'win32' : 'posix')
    assert.equal(resolveTargetPlatform(undefined), isWinHub ? 'win32' : 'posix')
    assert.equal(resolveTargetPlatform(''), isWinHub ? 'win32' : 'posix')
  })

  it('remote only message source on report:win32 → win32;linux/darwin → posix; not on report / without source → undefined(do not guess)', { timeout: 60_000 }, () => {
    const source = (nodeId: string): string | undefined =>
      nodeId === 'win-node' ? 'win32' : nodeId === 'mac-node' ? 'darwin' : nodeId === 'silent' ? '' : undefined
    assert.equal(resolveTargetPlatform('win-node', source), 'win32')
    assert.equal(resolveTargetPlatform('mac-node', source), 'posix')
    assert.equal(resolveTargetPlatform('silent', source), undefined)
    assert.equal(resolveTargetPlatform('unknown-node', source), undefined)
    assert.equal(resolveTargetPlatform('any-remote'), undefined, 'without source when remote one rule unknown')
  })

  it('local by default host platform, but explicit can message source can inject Hub platform', { timeout: 60_000 }, () => {
    const injected = (): string => 'linux'
    assert.equal(resolveTargetPlatform('local', injected), 'posix')
  })
})

describe('trustedPlatformFromEnvFabric:EnvFabric register fact adapt', () => {
  it('local by default process.platform; can inject Hub platform; remote read registry.get(nodeId).platform', { timeout: 60_000 }, () => {
    const host = {
      registry: {
        get: (nodeId: string): { platform: string } | undefined =>
          nodeId === 'win-node' ? { platform: 'win32' } : nodeId === 'empty' ? { platform: '' } : undefined,
      },
    }
    const source = trustedPlatformFromEnvFabric(host as never)
    assert.equal(source('local'), process.platform)
    assert.equal(source('win-node'), 'win32')
    assert.equal(source('empty'), undefined, 'empty platform on report treated as unknown')
    assert.equal(source('offline-node'), undefined)
  })

  it('EnvFabric explicit inject Hub platform when local use inject fact', { timeout: 60_000 }, () => {
    const source = trustedPlatformFromEnvFabric({
      registry: { get: () => undefined },
      hubPlatform: () => 'linux',
    } as never)
    assert.equal(source('local'), 'linux')
    assert.equal(source('remote'), undefined)
  })

  it('envFabric missing seat when local still can parse (remote unknown)', { timeout: 60_000 }, () => {
    const source = trustedPlatformFromEnvFabric(undefined)
    assert.equal(source('local'), process.platform)
    assert.equal(source('remote'), undefined)
  })
})

describe('normalizeCwdForPlatform: absolute reject and platform consolidate', () => {
  it('relative path and symbol each other for reject (since has absolute path contract keep)', { timeout: 60_000 }, () => {
    for (const bad of ['relative/ws', './here', '..', 'C:relative', 'c:']) {
      assert.throws(
        () => normalizeCwdForPlatform(bad, 'posix', 'test'),
        (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
        `each other for form '${bad}' must reject`,
      )
      assert.throws(
        () => normalizeCwdForPlatform(bad, 'win32', 'test'),
        (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
      )
    }
  })

  it('platform unknown (undefined): pass-through do not change write (remote without can message information when do not guess)', { timeout: 60_000 }, () => {
    assert.equal(normalizeCwdForPlatform('/mnt/c/work', undefined, 'test'), '/mnt/c/work')
    assert.equal(normalizeCwdForPlatform('C:\\work\\x', undefined, 'test'), 'C:\\work\\x')
  })

  it('win32 platform:WSL / Git Bash / UNC view determinism convert', { timeout: 60_000 }, () => {
    assert.equal(normalizeCwdForPlatform('/mnt/c/work/x', 'win32', 'test'), 'C:\\work\\x')
    assert.equal(normalizeCwdForPlatform('/d/ws', 'win32', 'test'), 'D:\\ws')
    assert.equal(normalizeCwdForPlatform('//server/share/ws', 'win32', 'test'), '\\\\server\\share\\ws')
  })

  it('win32 platform: cannot mapping POSIX explicit failed (broken POSIX cwd does not enter consolidate result)', { timeout: 60_000 }, () => {
    for (const bad of ['/home/user', '/tmp', '/', '/mnt/cdrom', '/mnt']) {
      assert.throws(
        () => normalizeCwdForPlatform(bad, 'win32', 'test'),
        (e: unknown) => e instanceof HelmError && e.code === 'unmappable_posix_root',
        `without symbol for should POSIX  '${bad}' must explicit failed`,
      )
    }
  })

  it('posix platform: term method archive one and never reverse convert /mnt/<symbol>', { timeout: 60_000 }, () => {
    assert.equal(normalizeCwdForPlatform('/mnt/c/work/x/', 'posix', 'test'), '/mnt/c/work/x/')
    assert.equal(normalizeCwdForPlatform('/a//b/./c', 'posix', 'test'), '/a/b/c')
  })
})

describe('normalizeSessionCwd: node parse + platform consolidate combine', () => {
  it('by target node parse platform after consolidate (win-node / unknown-node / local)', { timeout: 60_000 }, () => {
    const source = (nodeId: string): string | undefined => (nodeId === 'win-node' ? 'win32' : undefined)
    assert.equal(
      normalizeSessionCwd('/mnt/c/work', { nodeId: 'win-node', trustedPlatform: source, entry: 'test' }),
      'C:\\work',
    )
    assert.equal(
      normalizeSessionCwd('/mnt/c/work', { nodeId: 'unknown-node', trustedPlatform: source, entry: 'test' }),
      '/mnt/c/work',
      'remote platform unknown: pass-through',
    )
    const localPlatform = isWinHub ? 'win32' : 'posix'
    assert.equal(
      normalizeSessionCwd('/a/b/../c', { nodeId: 'local', trustedPlatform: source, entry: 'test' }),
      localPlatform === 'win32' ? normalizeCwdForPlatform('/a/b/../c', 'win32', 'test') : '/a/c',
    )
  })

  it('reject chain in platform parse before (relative path forever reject, regardless of platform is otherwise known)', { timeout: 60_000 }, () => {
    assert.throws(
      () => normalizeSessionCwd('rel', { nodeId: 'unknown-node', entry: 'test' }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
    )
  })
})
