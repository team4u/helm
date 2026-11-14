/**
 * path-usage 纯扫描编排器测试（注入 io；零真实 /proc 依赖，跨平台可跑）。
 *
 * 覆盖：cwd/fd 命中与子目录、路径分量边界（/a 不匹配 /ab）、(deleted) 后缀、
 * realpath 第二匹配基、ENOENT/ESRCH 退出竞态忽略、EACCES/EPERM 可见
 * （complete=false + diagnostics 含 uid）、扫描上限（complete=false）、
 * 报告截断（matchedTotal 真值）、平台 not_supported、非法路径拒绝、
 * abort 取消、/proc 不可列举。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scanPathUsage, validatePosixScanPath, type PathUsageIo } from '../src/index.js'

interface Fixture {
  /** procRoot 下的目录名列表（数字为 PID）。 */
  pids: Record<string, { cwd?: string | Error; fds?: Record<string, string | Error>; comm?: string | Error }>
}

function err(code: string, message = code): Error {
  return Object.assign(new Error(message), { code })
}

/** fixture io：按 Fixture 表解析 readlink/readdir/readFile；stat 固定 uid；realpath 走映射表。 */
function makeIo(fixture: Fixture, realpaths: Record<string, string> = {}, statUid = 1000): PathUsageIo {
  const io: PathUsageIo = {
    async readlink(p) {
      const m = /^\/proc\/(\d+)\/cwd$/.exec(p)
      if (m) {
        const v = fixture.pids[m[1]!]?.cwd
        if (v === undefined) throw err('ENOENT')
        if (v instanceof Error) throw v
        return v
      }
      const f = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(p)
      if (f) {
        const v = fixture.pids[f[1]!]?.fds?.[f[2]!]
        if (v === undefined) throw err('ENOENT')
        if (v instanceof Error) throw v
        return v
      }
      throw err('ENOENT')
    },
    async readdir(p) {
      if (p === '/proc') return Object.keys(fixture.pids)
      const m = /^\/proc\/(\d+)\/fd$/.exec(p)
      if (m) {
        const pid = fixture.pids[m[1]!]
        if (pid === undefined) throw err('ENOENT')
        if (pid.fds instanceof Error) throw pid.fds
        if (pid.fds === undefined) throw err('EACCES', 'permission denied')
        return Object.keys(pid.fds)
      }
      throw err('ENOENT')
    },
    async stat(p) {
      const m = /^\/proc\/(\d+)$/.exec(p)
      if (m === undefined || fixture.pids[m[1]!] === undefined) throw err('ENOENT')
      return { uid: statUid }
    },
    async readFile(p) {
      const m = /^\/proc\/(\d+)\/comm$/.exec(p)
      if (m) {
        const v = fixture.pids[m[1]!]?.comm
        if (v === undefined) throw err('EACCES')
        if (v instanceof Error) throw v
        return v
      }
      throw err('ENOENT')
    },
    async realpath(p) {
      if (realpaths[p] !== undefined) return realpaths[p]!
      throw err('ENOENT')
    },
  }
  return io
}

describe('validatePosixScanPath', () => {
  it('拒绝相对路径 / NUL / 空 / ..与. 段 / 双斜杠 / 超长；归一化尾随斜杠', () => {
    assert.equal(validatePosixScanPath('/a/b').ok, true)
    assert.deepEqual(validatePosixScanPath('/a/b/'), { ok: true, value: '/a/b' })
    assert.equal(validatePosixScanPath('/').ok, true)
    for (const bad of ['', 'a/b', './x', '/a/../b', '/a/./b', '/a//b', '/a\0b', `/${'x'.repeat(4097)}`]) {
      assert.equal(validatePosixScanPath(bad).ok, false, `应拒绝 ${JSON.stringify(bad)}`)
    }
  })
})

describe('scanPathUsage（注入 io）', () => {
  it('cwd 命中：等于目标与子目录；fd 命中：树内文件与目录；含进程名', async () => {
    const io = makeIo({
      pids: {
        '10': { cwd: '/wt/sub', fds: {}, comm: 'worker\n' },
        '11': { cwd: '/elsewhere', fds: { '3': '/wt/a.txt', '4': '/wt/sub/dir' }, comm: 'editor\n' },
        '12': { cwd: '/wt', fds: {}, comm: 'shell\n' },
        '13': { cwd: '/other', fds: { '3': 'socket:[1]', '4': 'pipe:[2]' }, comm: 'daemon\n' },
      },
    })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.complete, true)
    assert.equal(r.value.matchedTotal, 4)
    assert.deepEqual(
      r.value.processes.map((p) => `${p.pid}:${p.source}`).sort(),
      ['10:cwd', '11:fd', '11:fd', '12:cwd'],
    )
    assert.ok(r.value.processes.some((p) => p.pid === 10 && p.name === 'worker' && p.path === '/wt/sub'))
  })

  it('路径分量边界：/a 不匹配 /ab、/ax；只匹配 /a 与 /a/*', async () => {
    const io = makeIo({
      pids: {
        '20': { cwd: '/ab' },
        '21': { cwd: '/ax' },
        '22': { cwd: '/a', fds: {} },
        '23': { fds: { '5': '/a-deep/file' } },
      },
    })
    const r = await scanPathUsage('/a', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.matchedTotal, 1)
    assert.equal(r.value.processes[0]!.pid, 22)
  })

  it('(deleted) 后缀：匹配时剥离、报告保留原值', async () => {
    const io = makeIo({ pids: { '30': { cwd: '/wt/gone (deleted)', fds: {} }, '31': { cwd: '/wt (deleted)', fds: {} } } })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.matchedTotal, 2)
    assert.ok(r.value.processes.every((p) => p.path.includes('(deleted)')))
  })

  it('realpath 第二匹配基：软链拼写的候选经 realpath 基命中', async () => {
    const io = makeIo({ pids: { '40': { cwd: '/real/inner', fds: {} } } }, { '/link': '/real' })
    const r = await scanPathUsage('/link', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.matchedTotal, 1)
    assert.equal(r.value.path, '/link')
  })

  it('退出竞态：cwd/fd 的 ENOENT 与 ESRCH 忽略且 complete 保持 true', async () => {
    const io = makeIo({
      pids: {
        '50': { cwd: err('ENOENT'), fds: {} },
        '51': { cwd: err('ESRCH'), fds: err('ESRCH') },
      },
    })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.matchedTotal, 0)
    assert.equal(r.value.complete, true)
    assert.deepEqual(r.value.diagnostics, [])
  })

  it('EACCES/EPERM 可见：complete=false，diagnostics 含 pid 与 uid', async () => {
    const io = makeIo({
      pids: {
        '60': { cwd: err('EACCES', 'denied') },
        '61': { cwd: '/safe', fds: {} },
        '62': { cwd: '/safe', fds: undefined }, // fd 目录列举 EACCES
      },
    })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.complete, false)
    assert.equal(r.value.diagnostics.length, 2)
    assert.ok(r.value.diagnostics.some((d) => d.includes('pid 60') && d.includes('uid 1000') && d.includes('EACCES')), String(r.value.diagnostics))
    assert.ok(r.value.diagnostics.some((d) => d.includes('pid 62') && d.includes('fd')))
  })

  it('同一 PID 的 cwd 与 fd 双拒只记一条诊断', async () => {
    const io = makeIo({ pids: { '70': { cwd: err('EPERM'), fds: undefined } } })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.complete, false)
    assert.equal(r.value.diagnostics.filter((d) => d.includes('pid 70')).length, 1)
  })

  it('扫描上限：PID 数超限时 complete=false 且诊断明示；报告截断保留 matchedTotal 真值', async () => {
    const pids: Fixture['pids'] = {}
    for (let i = 0; i < 5; i++) pids[String(100 + i)] = { cwd: `/wt/x${i}`, fds: {} }
    const io = makeIo({ pids })
    const capped = await scanPathUsage('/wt', { io, platform: 'linux', maxPids: 2 })
    assert.equal(capped.ok, true)
    if (!capped.ok) return
    assert.equal(capped.value.complete, false)
    assert.ok(capped.value.diagnostics.some((d) => d.includes('扫描上限')))
    // 只扫前 2 个 PID（升序 100、101）。
    assert.equal(capped.value.matchedTotal, 2)

    const reported = await scanPathUsage('/wt', { io, platform: 'linux', maxReported: 1 })
    assert.equal(reported.ok, true)
    if (!reported.ok) return
    assert.equal(reported.value.complete, true)
    assert.equal(reported.value.matchedTotal, 5)
    assert.equal(reported.value.processes.length, 1)
    assert.equal(reported.value.processesTruncated, true)
  })

  it('平台门：非 Linux 显式 not_supported（不伪造结果）', async () => {
    for (const platform of ['darwin', 'win32', 'freebsd']) {
      const r = await scanPathUsage('/wt', { io: makeIo({ pids: {} }), platform })
      assert.equal(r.ok, false)
      if (r.ok) continue
      assert.equal(r.error.code, 'not_supported')
      assert.ok(r.error.message.includes(platform))
    }
  })

  it('非法目标路径：invalid（相对 / NUL / ..）', async () => {
    for (const bad of ['rel/x', '/a\0b', '/a/../b']) {
      const r = await scanPathUsage(bad, { io: makeIo({ pids: {} }), platform: 'linux' })
      assert.equal(r.ok, false)
      if (r.ok) continue
      assert.equal(r.error.code, 'invalid')
    }
  })

  it('abort：预取消信号返回 aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const r = await scanPathUsage('/wt', { io: makeIo({ pids: { '1': { cwd: '/x' } } }), platform: 'linux', signal: controller.signal })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.error.code, 'aborted')
  })

  it('/proc 不可列举：EACCES → not_supported、其他 → unknown（绝不静默）', async () => {
    const base = makeIo({ pids: {} })
    const denied: PathUsageIo = { ...base, readdir: async () => { throw err('EACCES', 'no') } }
    const r1 = await scanPathUsage('/wt', { io: denied, platform: 'linux' })
    assert.equal(r1.ok, false)
    if (!r1.ok) assert.equal(r1.error.code, 'not_supported')

    const broken: PathUsageIo = { ...base, readdir: async () => { throw err('EIO', 'io') } }
    const r2 = await scanPathUsage('/wt', { io: broken, platform: 'linux' })
    assert.equal(r2.ok, false)
    if (!r2.ok) assert.equal(r2.error.code, 'unknown')
  })

  it('命中但 comm 不可读：占用事实仍成立（name 缺省不阻塞）', async () => {
    const io = makeIo({ pids: { '80': { cwd: '/wt', fds: {}, comm: err('EACCES') } } })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.matchedTotal, 1)
    assert.equal(r.value.processes[0]!.name, undefined)
    assert.equal(r.value.complete, true, 'comm 不可读不影响占用事实与完整性')
  })
})
