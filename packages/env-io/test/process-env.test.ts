import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  deleteEnvEntry,
  findEnvKey,
  getEnvEntry,
  prependEnvPath,
  setEnvEntry,
} from '../src/index.js'

describe('process-env：跨平台环境变量大小写原语', { timeout: 60_000 }, () => {
  it('win32：宿主只有 Path 时 prependEnvPath 原地前置且不生成冲突 PATH 键', { timeout: 60_000 }, () => {
    const env: Record<string, string> = {
      Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
      TEMP: 'C:\\Temp',
    }
    prependEnvPath(env, 'C:\\Users\\me\\.helm\\bin', 'win32')
    assert.deepEqual(
      Object.keys(env).filter((k) => k.toUpperCase() === 'PATH'),
      ['Path'],
    )
    assert.equal(
      env['Path'],
      'C:\\Users\\me\\.helm\\bin;C:\\Windows\\System32;C:\\Program Files\\nodejs',
    )
    assert.equal(env['PATH'], undefined)
    assert.equal(env['TEMP'], 'C:\\Temp')
  })

  it('win32：已存在多份大小写变体或缺失时 prependEnvPath 收敛为单键', { timeout: 60_000 }, () => {
    const collided: Record<string, string> = {
      Path: 'C:\\Windows\\System32',
      PATH: 'D:\\Custom\\bin',
    }
    prependEnvPath(collided, 'C:\\helm\\bin', 'win32')
    assert.deepEqual(
      Object.keys(collided).filter((k) => k.toUpperCase() === 'PATH'),
      ['PATH'],
    )
    assert.equal(collided['PATH'], 'C:\\helm\\bin;D:\\Custom\\bin')
    assert.equal(collided['Path'], undefined)

    const empty: Record<string, string> = {}
    prependEnvPath(empty, 'C:\\helm\\bin', 'win32')
    assert.deepEqual(empty, { PATH: 'C:\\helm\\bin' })
  })

  it('win32：setEnvEntry / getEnvEntry / findEnvKey / deleteEnvEntry 大小写不敏感合并', { timeout: 60_000 }, () => {
    const env: Record<string, string> = { Path: 'C:\\Win', helm_token: 'old' }
    assert.equal(findEnvKey(env, 'PATH', 'win32'), 'Path')
    assert.equal(getEnvEntry(env, 'PATH', 'win32'), 'C:\\Win')

    setEnvEntry(env, 'PATH', 'D:\\Override', 'win32')
    assert.deepEqual(Object.keys(env), ['helm_token', 'PATH'])
    assert.equal(env['PATH'], 'D:\\Override')
    assert.equal(env['Path'], undefined)

    deleteEnvEntry(env, 'HELM_TOKEN', 'win32')
    assert.equal('helm_token' in env, false)
  })

  it('linux：Path 与 PATH 互不干扰，分隔符为冒号', { timeout: 60_000 }, () => {
    const env: Record<string, string> = {
      Path: '/not-system-path',
      PATH: '/usr/bin:/bin',
    }
    prependEnvPath(env, '/home/me/.helm/bin', 'linux')
    assert.equal(env['PATH'], '/home/me/.helm/bin:/usr/bin:/bin')
    assert.equal(env['Path'], '/not-system-path')

    setEnvEntry(env, 'path', '/lowercase', 'linux')
    assert.equal(env['PATH'], '/home/me/.helm/bin:/usr/bin:/bin')
    assert.equal(env['Path'], '/not-system-path')
    assert.equal(env['path'], '/lowercase')
    assert.equal(getEnvEntry(env, 'PATH', 'linux'), '/home/me/.helm/bin:/usr/bin:/bin')
    assert.equal(findEnvKey(env, 'nonexistent', 'linux'), undefined)

    deleteEnvEntry(env, 'Path', 'linux')
    assert.equal('Path' in env, false)
    assert.equal(env['PATH'], '/home/me/.helm/bin:/usr/bin:/bin')
  })
})
