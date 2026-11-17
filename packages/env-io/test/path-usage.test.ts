/**
 * Pure path-usage scan orchestration tests (injected I/O; zero real `/proc` dependency, cross-platform).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scanPathUsage, validatePosixScanPath, type PathUsageIo } from '../src/index.js'

interface Fixture {
  /** PID directories under procRoot. */
  pids: Record<string, { cwd?: string | Error; fds?: Record<string, string | Error> | Error; comm?: string | Error; gone?: boolean; uid?: number }>
}

function err(code: string, message = code): Error {
  return Object.assign(new Error(message), { code })
}

/** Fixture I/O backed by `Fixture` and a realpath lookup table. */
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
        const fds = fixture.pids[f[1]!]?.fds
        if (fds instanceof Error) throw fds
        const v = fds?.[f[2]!]
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
      const pid = m === null ? undefined : fixture.pids[m[1]!]
      if (pid === undefined) throw err('ENOENT')
      // `gone: true` simulates a process that exited between initial read and stat re-check.
      if (pid.gone === true) throw err('ENOENT')
      return { uid: pid.uid ?? statUid }
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

describe('validatePosixScanPath', { timeout: 60_000 }, () => {
  it('rejects relative paths, NUL, empty, dot segments, double slashes, and >4096 chars; normalizes trailing slash', { timeout: 60_000 }, () => {
    assert.equal(validatePosixScanPath('/a/b').ok, true)
    assert.deepEqual(validatePosixScanPath('/a/b/'), { ok: true, value: '/a/b' })
    assert.equal(validatePosixScanPath('/').ok, true)
    for (const bad of ['', 'a/b', './x', '/a/../b', '/a/./b', '/a//b', '/a\0b', `/${'x'.repeat(4097)}`]) {
      assert.equal(validatePosixScanPath(bad).ok, false, `should reject ${JSON.stringify(bad)}`)
    }
  })
})

describe('scanPathUsage (injected io)', { timeout: 60_000 }, () => {
  it('matches cwd/fd hits, reads comm, and deduplicates multiple refs per PID with cwd taking precedence', { timeout: 60_000 }, async () => {
    const io = makeIo({
      pids: {
        '10': { cwd: '/wt/sub', fds: {}, comm: 'worker\n' },
        '11': { cwd: '/elsewhere', fds: { '3': '/wt/a.txt', '4': '/wt/sub/dir' }, comm: 'editor\n' },
        '12': { cwd: '/wt', fds: { '5': '/wt/a.txt' }, comm: 'shell\n' },
        '13': { cwd: '/other', fds: { '3': 'socket:[1]', '4': 'pipe:[2]' }, comm: 'daemon\n' },
      },
    })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.complete, true)
    assert.equal(r.value.matchedTotal, 3)
    assert.deepEqual(
      r.value.processes.map((p) => `${p.pid}:${p.source}:${p.path}`),
      ['10:cwd:/wt/sub', '11:fd:/wt/a.txt', '12:cwd:/wt'],
    )
    assert.ok(r.value.processes.some((p) => p.pid === 10 && p.name === 'worker' && p.path === '/wt/sub'))
  })

  it('enforces component boundaries (/a does not match /ab or /ax)', { timeout: 60_000 }, async () => {
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

  it('strips " (deleted)" suffix when matching while preserving original path in report', { timeout: 60_000 }, async () => {
    const io = makeIo({ pids: { '30': { cwd: '/wt/gone (deleted)', fds: {} }, '31': { cwd: '/wt (deleted)', fds: {} } } })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.matchedTotal, 2)
    assert.ok(r.value.processes.every((p) => p.path.includes('(deleted)')))
  })

  it('also matches via resolved realpath when target traverses a symlink', { timeout: 60_000 }, async () => {
    const io = makeIo({ pids: { '40': { cwd: '/real/inner', fds: {} } } }, { '/link': '/real' })
    const r = await scanPathUsage('/link', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.matchedTotal, 1)
    assert.equal(r.value.path, '/link')
  })

  it('ignores ENOENT/ESRCH exit races and preserves complete=true', { timeout: 60_000 }, async () => {
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

  it('counts persistent EACCES regardless of UID as unobservable while preserving complete=true', { timeout: 60_000 }, async () => {
    const io = makeIo({
      pids: {
        '60': { cwd: err('EACCES', 'denied'), uid: 0 }, // cross-uid root-owned process
        '61': { cwd: '/safe', fds: {} },
        '62': { cwd: '/safe', fds: undefined, uid: 1000 }, // same-uid non-dumpable process
      },
    })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.complete, true, 'permission-class EACCES is a structural blind spot, not a scan error')
    assert.equal(r.value.unobservable, 2)
    assert.equal(r.value.matchedTotal, 0)
    assert.ok(
      r.value.diagnostics.some((d) => d.includes('pid 60') && d.includes('uid 0') && d.includes('EACCES') && d.includes('unobservable')),
      String(r.value.diagnostics),
    )
    assert.ok(
      r.value.diagnostics.some((d) => d.includes('pid 62') && d.includes('uid 1000') && d.includes('fd') && d.includes('unobservable')),
      String(r.value.diagnostics),
    )
  })

  it('marks complete=false on non-permission read errors like EIO (fail-closed)', { timeout: 60_000 }, async () => {
    const io = makeIo({ pids: { '66': { cwd: err('EIO', 'io error') } } })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.complete, false, 'EIO is a scan error, not a permission blind spot')
    assert.equal(r.value.unobservable, 0)
    assert.ok(r.value.diagnostics.some((d) => d.includes('pid 66') && d.includes('EIO') && d.includes('unknown')), String(r.value.diagnostics))
  })

  it('classifies stat errors by errno: EACCES -> unobservable, EIO -> complete=false', { timeout: 60_000 }, async () => {
    const base = makeIo({ pids: { '67': { cwd: err('EACCES', 'denied') } } })
    const statDenied: PathUsageIo = { ...base, stat: async () => { throw err('EACCES', 'stat denied') } }
    const a = await scanPathUsage('/wt', { io: statDenied, platform: 'linux' })
    assert.equal(a.ok, true)
    if (!a.ok) return
    assert.equal(a.value.complete, true, 'stat EACCES counts as a permission blind spot even with unknown uid')
    assert.equal(a.value.unobservable, 1)
    assert.ok(a.value.diagnostics.some((d) => d.includes('pid 67') && d.includes('EACCES')), String(a.value.diagnostics))

    const statBroken: PathUsageIo = { ...base, stat: async () => { throw err('EIO', 'stat io') } }
    const b = await scanPathUsage('/wt', { io: statBroken, platform: 'linux' })
    assert.equal(b.ok, true)
    if (!b.ok) return
    assert.equal(b.value.complete, false, 'stat EIO fails closed')
    assert.equal(b.value.unobservable, 0)
  })

  it('reports verified matches alongside unobservable blind spots', { timeout: 60_000 }, async () => {
    const io = makeIo({
      pids: {
        '67': { cwd: '/wt/sub', fds: {}, comm: 'worker\n', uid: 1000 },
        '68': { cwd: err('EACCES', 'denied'), uid: 0 },
      },
    })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.complete, true)
    assert.equal(r.value.unobservable, 1)
    assert.equal(r.value.matchedTotal, 1)
    assert.equal(r.value.processes[0]!.pid, 67)
  })

  it('deduplicates multiple EACCES/EPERM denials for the same PID', { timeout: 60_000 }, async () => {
    const io = makeIo({ pids: { '70': { cwd: err('EPERM'), fds: undefined, uid: 0 } } })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.complete, true, 'EPERM blind spot does not affect completeness')
    assert.equal(r.value.unobservable, 1, 'both cwd and fd denials on same PID count once')
    assert.equal(r.value.diagnostics.filter((d) => d.includes('pid 70')).length, 1)
  })

  it('enforces maxPids (complete=false) and maxReported truncation (preserving matchedTotal)', { timeout: 60_000 }, async () => {
    const pids: Fixture['pids'] = {}
    for (let i = 0; i < 5; i++) pids[String(100 + i)] = { cwd: `/wt/x${i}`, fds: { '3': `/wt/x${i}/f` } }
    const io = makeIo({ pids })
    const capped = await scanPathUsage('/wt', { io, platform: 'linux', maxPids: 2 })
    assert.equal(capped.ok, true)
    if (!capped.ok) return
    assert.equal(capped.value.complete, false)
    assert.ok(capped.value.diagnostics.some((d) => d.includes('scan limit')))
    assert.equal(capped.value.matchedTotal, 2)

    const reported = await scanPathUsage('/wt', { io, platform: 'linux', maxReported: 2 })
    assert.equal(reported.ok, true)
    if (!reported.ok) return
    assert.equal(reported.value.complete, true)
    assert.equal(reported.value.matchedTotal, 5, 'matchedTotal preserves full unique PID count')
    assert.equal(reported.value.processes.length, 2)
    assert.equal(reported.value.processesTruncated, true)
  })

  it('rejects non-linux platforms explicitly with not_supported', { timeout: 60_000 }, async () => {
    for (const platform of ['darwin', 'win32', 'freebsd']) {
      const r = await scanPathUsage('/wt', { io: makeIo({ pids: {} }), platform })
      assert.equal(r.ok, false)
      if (r.ok) continue
      assert.equal(r.error.code, 'not_supported')
      assert.ok(r.error.message.includes(platform))
    }
  })

  it('rejects invalid target paths with invalid', { timeout: 60_000 }, async () => {
    for (const bad of ['rel/x', '/a\0b', '/a/../b']) {
      const r = await scanPathUsage(bad, { io: makeIo({ pids: {} }), platform: 'linux' })
      assert.equal(r.ok, false)
      if (r.ok) continue
      assert.equal(r.error.code, 'invalid')
    }
  })

  it('returns aborted when signal is already aborted', { timeout: 60_000 }, async () => {
    const controller = new AbortController()
    controller.abort()
    const r = await scanPathUsage('/wt', { io: makeIo({ pids: { '1': { cwd: '/x' } } }), platform: 'linux', signal: controller.signal })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.error.code, 'aborted')
  })

  it('fails closed when /proc cannot be listed (EACCES -> not_supported, others -> unknown)', { timeout: 60_000 }, async () => {
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

  it('still reports matched process when comm is unreadable', { timeout: 60_000 }, async () => {
    const io = makeIo({ pids: { '80': { cwd: '/wt', fds: {}, comm: err('EACCES') } } })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.matchedTotal, 1)
    assert.equal(r.value.processes[0]!.name, undefined)
    assert.equal(r.value.complete, true, 'unreadable comm does not affect match or completeness')
  })

  it('handles per-fd errors when fd dir is readable (EACCES/EPERM -> unobservable, EIO -> complete=false)', { timeout: 60_000 }, async () => {
    for (const code of ['EACCES', 'EPERM', 'EIO']) {
      const io = makeIo({
        pids: {
          '90': { cwd: '/safe', fds: { '3': '/wt/a.txt', '4': err(code), '5': '/elsewhere' } },
        },
      })
      const r = await scanPathUsage('/wt', { io, platform: 'linux' })
      assert.equal(r.ok, true, code)
      if (!r.ok) continue
      if (code === 'EIO') {
        assert.equal(r.value.complete, false, 'EIO fails completeness check')
        assert.equal(r.value.unobservable, 0, code)
      } else {
        assert.equal(r.value.complete, true, `${code}: permission blind spot preserves completeness`)
        assert.equal(r.value.unobservable, 1, code)
      }
      assert.ok(
        r.value.diagnostics.some((d) => d.includes('pid 90') && d.includes('fd/4') && d.includes(code)),
        `${code}: diagnostic should include pid and fd number (got ${JSON.stringify(r.value.diagnostics)})`,
      )
      assert.equal(r.value.matchedTotal, 1)
      assert.equal(r.value.processes[0]!.source, 'fd')
    }
  })

  it('aborts promptly mid-scan inside fd loop', { timeout: 60_000 }, async () => {
    const controller = new AbortController()
    const fds: Record<string, string> = {}
    for (let i = 0; i < 8; i++) fds[String(i)] = `/wt/f${i}`
    const io = makeIo({ pids: { '95': { cwd: '/safe', fds } } })
    let reads = 0
    const counting: PathUsageIo = {
      ...io,
      readlink: async (p) => {
        const value = await io.readlink(p)
        reads += 1
        if (reads >= 2) controller.abort()
        return value
      },
    }
    const r = await scanPathUsage('/wt', { io: counting, platform: 'linux', signal: controller.signal })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.error.code, 'aborted', 'fd loop must check abort signal on each step')
  })

  it('re-checks stat on denied read: ignores exit race vs records persistent EACCES', { timeout: 60_000 }, async () => {
    const exitedIo = makeIo({ pids: { '96': { cwd: '/safe', fds: undefined, gone: true } } })
    const a = await scanPathUsage('/wt', { io: exitedIo, platform: 'linux' })
    assert.equal(a.ok, true)
    if (!a.ok) return
    assert.equal(a.value.complete, true, 'exited PID is ignored as an exit race, not counted as unobservable')
    assert.deepEqual(a.value.diagnostics, [])

    const cwdGone = makeIo({ pids: { '97': { cwd: err('EACCES'), fds: {}, gone: true } } })
    const b = await scanPathUsage('/wt', { io: cwdGone, platform: 'linux' })
    assert.equal(b.ok, true)
    if (!b.ok) return
    assert.equal(b.value.complete, true)

    const alive = makeIo({ pids: { '98': { cwd: '/safe', fds: undefined } } })
    const c = await scanPathUsage('/wt', { io: alive, platform: 'linux' })
    assert.equal(c.ok, true)
    if (!c.ok) return
    assert.equal(c.value.complete, true, 'live PID with persistent EACCES counts as unobservable')
    assert.equal(c.value.unobservable, 1)
    assert.ok(c.value.diagnostics.some((d) => d.includes('pid 98') && d.includes('fd')))
  })

  it('adopts retry success after transient EACCES without recording a blind spot', { timeout: 60_000 }, async () => {
    const base = makeIo({ pids: { '99': { cwd: '/safe', fds: { '3': '/wt/a.txt' }, comm: 'flaky\n' } } })
    let fdReads = 0
    const flaky: PathUsageIo = {
      ...base,
      readdir: async (p) => {
        if (p === '/proc/99/fd') {
          fdReads += 1
          if (fdReads === 1) throw err('EACCES', 'transient')
        }
        return base.readdir(p)
      },
    }
    const r = await scanPathUsage('/wt', { io: flaky, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.complete, true)
    assert.equal(r.value.matchedTotal, 1)
    assert.equal(r.value.processes[0]!.pid, 99)
  })

  it('handles target realpath errors: EACCES/EPERM -> permission_denied, ENOENT -> fallback to raw path, others -> unknown', { timeout: 60_000 }, async () => {
    const base = makeIo({ pids: { '1': { cwd: '/wt', fds: {} } } })
    const denied: PathUsageIo = { ...base, realpath: async () => { throw err('EACCES', 'no access') } }
    const r1 = await scanPathUsage('/wt', { io: denied, platform: 'linux' })
    assert.equal(r1.ok, false)
    if (!r1.ok) {
      assert.equal(r1.error.code, 'permission_denied')
      assert.ok(r1.error.message.includes('EACCES'))
    }
    const eperm: PathUsageIo = { ...base, realpath: async () => { throw err('EPERM') } }
    const r2 = await scanPathUsage('/wt', { io: eperm, platform: 'linux' })
    assert.equal(r2.ok, false)
    if (!r2.ok) assert.equal(r2.error.code, 'permission_denied')
    const broken: PathUsageIo = { ...base, realpath: async () => { throw err('ELOOP', 'loop') } }
    const r3 = await scanPathUsage('/wt', { io: broken, platform: 'linux' })
    assert.equal(r3.ok, false)
    if (!r3.ok) assert.equal(r3.error.code, 'unknown')
    const r4 = await scanPathUsage('/wt', { io: base, platform: 'linux' })
    assert.equal(r4.ok, true)
    if (r4.ok) assert.equal(r4.value.matchedTotal, 1)
  })
})
