import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  deleteEnvEntry,
  findEnvKey,
  getEnvEntry,
  prependEnvPath,
  setEnvEntry,
} from '../src/index.js'

describe('process-env: cross-platform env variable casing primitives', { timeout: 60_000 }, () => {
  it('win32: preserves existing Path casing on prependEnvPath without creating a conflicting PATH key', { timeout: 60_000 }, () => {
    const env: Record<string, string> = {
      Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
      TEMP: 'C:\\Temp',
    }
    prependEnvPath(env, 'C:\\Users\\me\\.helmx\\bin', 'win32')
    assert.deepEqual(
      Object.keys(env).filter((k) => k.toUpperCase() === 'PATH'),
      ['Path'],
    )
    assert.equal(
      env['Path'],
      'C:\\Users\\me\\.helmx\\bin;C:\\Windows\\System32;C:\\Program Files\\nodejs',
    )
    assert.equal(env['PATH'], undefined)
    assert.equal(env['TEMP'], 'C:\\Temp')
  })

  it('win32: collapses multiple case variants or creates PATH when missing on prependEnvPath', { timeout: 60_000 }, () => {
    const collided: Record<string, string> = {
      Path: 'C:\\Windows\\System32',
      PATH: 'D:\\Custom\\bin',
    }
    prependEnvPath(collided, 'C:\\helmx\\bin', 'win32')
    assert.deepEqual(
      Object.keys(collided).filter((k) => k.toUpperCase() === 'PATH'),
      ['PATH'],
    )
    assert.equal(collided['PATH'], 'C:\\helmx\\bin;D:\\Custom\\bin')
    assert.equal(collided['Path'], undefined)

    const empty: Record<string, string> = {}
    prependEnvPath(empty, 'C:\\helmx\\bin', 'win32')
    assert.deepEqual(empty, { PATH: 'C:\\helmx\\bin' })
  })

  it('win32: setEnvEntry / getEnvEntry / findEnvKey / deleteEnvEntry operate case-insensitively', { timeout: 60_000 }, () => {
    const env: Record<string, string> = { Path: 'C:\\Win', helmx_token: 'old' }
    assert.equal(findEnvKey(env, 'PATH', 'win32'), 'Path')
    assert.equal(getEnvEntry(env, 'PATH', 'win32'), 'C:\\Win')

    setEnvEntry(env, 'PATH', 'D:\\Override', 'win32')
    assert.deepEqual(Object.keys(env), ['helmx_token', 'PATH'])
    assert.equal(env['PATH'], 'D:\\Override')
    assert.equal(env['Path'], undefined)

    deleteEnvEntry(env, 'HELMX_TOKEN', 'win32')
    assert.equal('helmx_token' in env, false)
  })

  it('linux: Path and PATH stay distinct and separator is colon', { timeout: 60_000 }, () => {
    const env: Record<string, string> = {
      Path: '/not-system-path',
      PATH: '/usr/bin:/bin',
    }
    prependEnvPath(env, '/home/me/.helmx/bin', 'linux')
    assert.equal(env['PATH'], '/home/me/.helmx/bin:/usr/bin:/bin')
    assert.equal(env['Path'], '/not-system-path')

    setEnvEntry(env, 'path', '/lowercase', 'linux')
    assert.equal(env['PATH'], '/home/me/.helmx/bin:/usr/bin:/bin')
    assert.equal(env['Path'], '/not-system-path')
    assert.equal(env['path'], '/lowercase')
    assert.equal(getEnvEntry(env, 'PATH', 'linux'), '/home/me/.helmx/bin:/usr/bin:/bin')
    assert.equal(findEnvKey(env, 'nonexistent', 'linux'), undefined)

    deleteEnvEntry(env, 'Path', 'linux')
    assert.equal('Path' in env, false)
    assert.equal(env['PATH'], '/home/me/.helmx/bin:/usr/bin:/bin')
  })
})
