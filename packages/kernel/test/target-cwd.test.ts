/**
 * runtime/target-cwd 单元测试（kernel cwd 收口唯一实现）：
 * - resolveTargetPlatform：local 默认 process.platform，显式可信来源可注入
 *   Hub 平台；远端仅信 TrustedNodePlatformSource 上报；
 * - trustedPlatformFromEnvFabric：local 默认 process.platform、支持 Hub 注入；
 *   远端读 registry 注册事实（未注册 / 空 platform = undefined）；
 * - normalizeCwdForPlatform / normalizeSessionCwd：相对路径拒绝（含盘符相对）、
 *   平台未知透传不改写、win32 目标确定性转换（/mnt/<盘符>、/<盘符>、//srv）
 *   与不可映射 POSIX 根显式失败（坏 POSIX cwd 绝不进入收口结果）。
 *
 * normalizeTargetPath 纯函数本体已由 packages/protocol/test/
 * target-path-platform.test.ts 逐用例锁定，此处只测 kernel 收口层的平台
 * 解析与拒绝契约，不重复 protocol 用例矩阵。
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

describe('resolveTargetPlatform：目标平台解析（可信来源）', () => {
  it('local 用 process.platform（win32 特判，其余一律 posix 语义）', { timeout: 60_000 }, () => {
    assert.equal(resolveTargetPlatform('local'), isWinHub ? 'win32' : 'posix')
    assert.equal(resolveTargetPlatform(undefined), isWinHub ? 'win32' : 'posix')
    assert.equal(resolveTargetPlatform(''), isWinHub ? 'win32' : 'posix')
  })

  it('远端仅信来源上报：win32 → win32；linux/darwin → posix；未上报 / 无来源 → undefined（不猜）', { timeout: 60_000 }, () => {
    const source = (nodeId: string): string | undefined =>
      nodeId === 'win-node' ? 'win32' : nodeId === 'mac-node' ? 'darwin' : nodeId === 'silent' ? '' : undefined
    assert.equal(resolveTargetPlatform('win-node', source), 'win32')
    assert.equal(resolveTargetPlatform('mac-node', source), 'posix')
    assert.equal(resolveTargetPlatform('silent', source), undefined)
    assert.equal(resolveTargetPlatform('unknown-node', source), undefined)
    assert.equal(resolveTargetPlatform('any-remote'), undefined, '无来源时远端一律未知')
  })

  it('local 默认宿主平台，但显式可信来源可注入 Hub 平台', { timeout: 60_000 }, () => {
    const injected = (): string => 'linux'
    assert.equal(resolveTargetPlatform('local', injected), 'posix')
  })
})

describe('trustedPlatformFromEnvFabric：EnvFabric 注册事实适配', () => {
  it('local 默认 process.platform；可注入 Hub 平台；远端读 registry.get(nodeId).platform', { timeout: 60_000 }, () => {
    const host = {
      registry: {
        get: (nodeId: string): { platform: string } | undefined =>
          nodeId === 'win-node' ? { platform: 'win32' } : nodeId === 'empty' ? { platform: '' } : undefined,
      },
    }
    const source = trustedPlatformFromEnvFabric(host as never)
    assert.equal(source('local'), process.platform)
    assert.equal(source('win-node'), 'win32')
    assert.equal(source('empty'), undefined, '空 platform 上报视为未知')
    assert.equal(source('offline-node'), undefined)
  })

  it('EnvFabric 显式注入 Hub 平台时 local 使用注入事实', { timeout: 60_000 }, () => {
    const source = trustedPlatformFromEnvFabric({
      registry: { get: () => undefined },
      hubPlatform: () => 'linux',
    } as never)
    assert.equal(source('local'), 'linux')
    assert.equal(source('remote'), undefined)
  })

  it('envFabric 缺席时 local 仍可解析（远端未知）', { timeout: 60_000 }, () => {
    const source = trustedPlatformFromEnvFabric(undefined)
    assert.equal(source('local'), process.platform)
    assert.equal(source('remote'), undefined)
  })
})

describe('normalizeCwdForPlatform：绝对性拒绝与平台收口', () => {
  it('相对路径与盘符相对拒绝（既有绝对路径契约保持）', { timeout: 60_000 }, () => {
    for (const bad of ['relative/ws', './here', '..', 'C:relative', 'c:']) {
      assert.throws(
        () => normalizeCwdForPlatform(bad, 'posix', 'test'),
        (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
        `相对形态 '${bad}' 必须拒绝`,
      )
      assert.throws(
        () => normalizeCwdForPlatform(bad, 'win32', 'test'),
        (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
      )
    }
  })

  it('平台未知（undefined）：透传不改写（远端无可信信息时不猜）', { timeout: 60_000 }, () => {
    assert.equal(normalizeCwdForPlatform('/mnt/c/work', undefined, 'test'), '/mnt/c/work')
    assert.equal(normalizeCwdForPlatform('C:\\work\\x', undefined, 'test'), 'C:\\work\\x')
  })

  it('win32 平台：WSL / Git Bash / UNC 视图确定性转换', { timeout: 60_000 }, () => {
    assert.equal(normalizeCwdForPlatform('/mnt/c/work/x', 'win32', 'test'), 'C:\\work\\x')
    assert.equal(normalizeCwdForPlatform('/d/ws', 'win32', 'test'), 'D:\\ws')
    assert.equal(normalizeCwdForPlatform('//server/share/ws', 'win32', 'test'), '\\\\server\\share\\ws')
  })

  it('win32 平台：不可映射 POSIX 根显式失败（坏 POSIX cwd 不进入收口结果）', { timeout: 60_000 }, () => {
    for (const bad of ['/home/user', '/tmp', '/', '/mnt/cdrom', '/mnt']) {
      assert.throws(
        () => normalizeCwdForPlatform(bad, 'win32', 'test'),
        (e: unknown) => e instanceof HelmError && e.code === 'unmappable_posix_root',
        `无盘符对应 POSIX 根 '${bad}' 必须显式失败`,
      )
    }
  })

  it('posix 平台：词法归一且绝不反向转换 /mnt/<盘符>', { timeout: 60_000 }, () => {
    assert.equal(normalizeCwdForPlatform('/mnt/c/work/x/', 'posix', 'test'), '/mnt/c/work/x/')
    assert.equal(normalizeCwdForPlatform('/a//b/./c', 'posix', 'test'), '/a/b/c')
  })
})

describe('normalizeSessionCwd：节点解析 + 平台收口组合', () => {
  it('按目标节点解析平台后收口（win-node / unknown-node / local）', { timeout: 60_000 }, () => {
    const source = (nodeId: string): string | undefined => (nodeId === 'win-node' ? 'win32' : undefined)
    assert.equal(
      normalizeSessionCwd('/mnt/c/work', { nodeId: 'win-node', trustedPlatform: source, entry: 'test' }),
      'C:\\work',
    )
    assert.equal(
      normalizeSessionCwd('/mnt/c/work', { nodeId: 'unknown-node', trustedPlatform: source, entry: 'test' }),
      '/mnt/c/work',
      '远端平台未知：透传',
    )
    const localPlatform = isWinHub ? 'win32' : 'posix'
    assert.equal(
      normalizeSessionCwd('/a/b/../c', { nodeId: 'local', trustedPlatform: source, entry: 'test' }),
      localPlatform === 'win32' ? normalizeCwdForPlatform('/a/b/../c', 'win32', 'test') : '/a/c',
    )
  })

  it('拒绝链在平台解析之前（相对路径永远拒绝，无论平台是否已知）', { timeout: 60_000 }, () => {
    assert.throws(
      () => normalizeSessionCwd('rel', { nodeId: 'unknown-node', entry: 'test' }),
      (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
    )
  })
})
