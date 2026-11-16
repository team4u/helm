/**
 * path-usage pure scan orchestration test (inject io; zero real /proc dependency, across platform can run).
 *
 * override:cwd/fd hit and subdirectory, path amount boundary (/a does not match /ab),(deleted) suffix,
 * realpath second match base,ENOENT/ESRCH exit race ignore, durable EACCES/EPERM by
 * errno govern (do not argument uid- - contains same uid non-dumpable such as systemd --user- - one rule
 * structure blind spot:unobservable counter + diagnose contains pid/uid/errno,complete=true),
 * stat itself error same by errno govern, non- permission class read error (EIO etc.) still
 * complete=false, blind spot and hit and store, scan cap (complete=false), report truncate
 * (matchedTotal true value), platform not_supported, illegal path reject,abort cancel,
 * /proc cannot column raise.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scanPathUsage, validatePosixScanPath, type PathUsageIo } from '../src/index.js'

interface Fixture {
  /** procRoot under directory name list (number is PID). */
  pids: Record<string, { cwd?: string | Error; fds?: Record<string, string | Error> | Error; comm?: string | Error; gone?: boolean; uid?: number }>
}

function err(code: string, message = code): Error {
  return Object.assign(new Error(message), { code })
}

/** fixture io: by Fixture table parse readlink/readdir/readFile;stat return each PID uid(default statUid);realpath away mapping table. */
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
      // gone: true simulated read when by refuse, re-check when already verify exit (stat ENOENT).
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
  it('reject relative path / NUL / empty / ..and. segment / double slash / over long; archive one tail follow slash', { timeout: 60_000 }, () => {
    assert.equal(validatePosixScanPath('/a/b').ok, true)
    assert.deepEqual(validatePosixScanPath('/a/b/'), { ok: true, value: '/a/b' })
    assert.equal(validatePosixScanPath('/').ok, true)
    for (const bad of ['', 'a/b', './x', '/a/../b', '/a/./b', '/a//b', '/a\0b', `/${'x'.repeat(4097)}`]) {
      assert.equal(validatePosixScanPath(bad).ok, false, `should reject ${JSON.stringify(bad)}`)
    }
  })
})

describe('scanPathUsage(inject io)', { timeout: 60_000 }, () => {
  it('cwd hit: equals target and subdirectory;fd hit: tree inside file and directory; contains process name; same PID many reference dedupe (cwd takes precedence)', { timeout: 60_000 }, async () => {
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
    // by PID dedupe:11 two fd hit only count one process (first fd reference);12 cwd+fd only count cwd.
    assert.equal(r.value.matchedTotal, 3)
    assert.deepEqual(
      r.value.processes.map((p) => `${p.pid}:${p.source}:${p.path}`),
      ['10:cwd:/wt/sub', '11:fd:/wt/a.txt', '12:cwd:/wt'],
    )
    assert.ok(r.value.processes.some((p) => p.pid === 10 && p.name === 'worker' && p.path === '/wt/sub'))
  })

  it('path amount boundary:/a does not match /ab,/ax; only match /a and /a/*', { timeout: 60_000 }, async () => {
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

  it('(deleted) suffix: match when strip, report keep original value', { timeout: 60_000 }, async () => {
    const io = makeIo({ pids: { '30': { cwd: '/wt/gone (deleted)', fds: {} }, '31': { cwd: '/wt (deleted)', fds: {} } } })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.matchedTotal, 2)
    assert.ok(r.value.processes.every((p) => p.path.includes('(deleted)')))
  })

  it('realpath second match base: symlink piece together write choose via realpath base hit', { timeout: 60_000 }, async () => {
    const io = makeIo({ pids: { '40': { cwd: '/real/inner', fds: {} } } }, { '/link': '/real' })
    const r = await scanPathUsage('/link', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.matchedTotal, 1)
    assert.equal(r.value.path, '/link')
  })

  it('exit race:cwd/fd  ENOENT and ESRCH ignore and complete keep true', { timeout: 60_000 }, async () => {
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

  it('durable EACCES do not argument uid(contains same uid non-dumpable such as systemd --user): permission blind spot unobservable counter,complete=true, diagnose contains pid/uid/errno', { timeout: 60_000 }, async () => {
    const io = makeIo({
      pids: {
        '60': { cwd: err('EACCES', 'denied'), uid: 0 }, // across uid:root belong main, any non- root scan way all read do not
        '61': { cwd: '/safe', fds: {} },
        '62': { cwd: '/safe', fds: undefined, uid: 1000 }, // same uid refuse read:non-dumpable scenario (belong main itself also read do not)
      },
    })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.complete, true, 'permission class errno durable refuse read is structure blind spot, do not count complete decide')
    assert.equal(r.value.unobservable, 2)
    assert.equal(r.value.matchedTotal, 0)
    assert.ok(
      r.value.diagnostics.some((d) => d.includes('pid 60') && d.includes('uid 0') && d.includes('EACCES') && d.includes('cannot observability')),
      String(r.value.diagnostics),
    )
    assert.ok(
      r.value.diagnostics.some((d) => d.includes('pid 62') && d.includes('uid 1000') && d.includes('fd') && d.includes('cannot observability')),
      String(r.value.diagnostics),
    )
  })

  it('non- permission class read error (EIO): still complete=false(fail-closed, do not because blind spot govern relax)', { timeout: 60_000 }, async () => {
    const io = makeIo({ pids: { '66': { cwd: err('EIO', 'io error') } } })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.complete, false, 'EIO is scan exception while non- permission blind spot')
    assert.equal(r.value.unobservable, 0)
    assert.ok(r.value.diagnostics.some((d) => d.includes('pid 66') && d.includes('EIO') && d.includes('unknown')), String(r.value.diagnostics))
  })

  it('stat itself non- exit class error same by errno govern:EACCES → blind spot (uid unknown also count);EIO → complete=false', { timeout: 60_000 }, async () => {
    // cwd refuse read trigger re-check,stat itself again refuse (EACCES):uid unknown still count blind spot.
    const base = makeIo({ pids: { '67': { cwd: err('EACCES', 'denied') } } })
    const statDenied: PathUsageIo = { ...base, stat: async () => { throw err('EACCES', 'stat denied') } }
    const a = await scanPathUsage('/wt', { io: statDenied, platform: 'linux' })
    assert.equal(a.ok, true)
    if (!a.ok) return
    assert.equal(a.value.complete, true, 'stat EACCES: permission blind spot (uid unknown also count)')
    assert.equal(a.value.unobservable, 1)
    assert.ok(a.value.diagnostics.some((d) => d.includes('pid 67') && d.includes('EACCES')), String(a.value.diagnostics))

    // stat EIO(non- permission class): cannot verify store in state and non- permission → scan exception.
    const statBroken: PathUsageIo = { ...base, stat: async () => { throw err('EIO', 'stat io') } }
    const b = await scanPathUsage('/wt', { io: statBroken, platform: 'linux' })
    assert.equal(b.ok, true)
    if (!b.ok) return
    assert.equal(b.value.complete, false, 'stat EIO: scan exception (fail-closed)')
    assert.equal(b.value.unobservable, 0)
  })

  it('blind spot and hit and store:matchedTotal such as on report, blind spot do not swallow already has verify based on', { timeout: 60_000 }, async () => {
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

  it('the same PID  cwd and fd double refuse only record a diagnose (permission blind spot same expect dedupe counter)', { timeout: 60_000 }, async () => {
    const io = makeIo({ pids: { '70': { cwd: err('EPERM'), fds: undefined, uid: 0 } } })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.complete, true, 'EPERM permission blind spot do not count complete decide')
    assert.equal(r.value.unobservable, 1, 'double refuse only count once')
    assert.equal(r.value.diagnostics.filter((d) => d.includes('pid 70')).length, 1)
  })

  it('scan cap:PID count over limit when complete=false and diagnose show; report truncate by unique PID keep real total count', { timeout: 60_000 }, async () => {
    const pids: Fixture['pids'] = {}
    for (let i = 0; i < 5; i++) pids[String(100 + i)] = { cwd: `/wt/x${i}`, fds: { '3': `/wt/x${i}/f` } }
    const io = makeIo({ pids })
    const capped = await scanPathUsage('/wt', { io, platform: 'linux', maxPids: 2 })
    assert.equal(capped.ok, true)
    if (!capped.ok) return
    assert.equal(capped.value.complete, false)
    assert.ok(capped.value.diagnostics.some((d) => d.includes('scan cap')))
    // only scan before 2  PID(rise order 100,101), each PID dedupe after each count one process.
    assert.equal(capped.value.matchedTotal, 2)

    const reported = await scanPathUsage('/wt', { io, platform: 'linux', maxReported: 2 })
    assert.equal(reported.ok, true)
    if (!reported.ok) return
    assert.equal(reported.value.complete, true)
    assert.equal(reported.value.matchedTotal, 5, 'unique PID real total count (same PID cwd+fd does not repeat counter)')
    assert.equal(reported.value.processes.length, 2)
    assert.equal(reported.value.processesTruncated, true)
  })

  it('platform gate: non- Linux explicit not_supported(do not fabricate result)', { timeout: 60_000 }, async () => {
    for (const platform of ['darwin', 'win32', 'freebsd']) {
      const r = await scanPathUsage('/wt', { io: makeIo({ pids: {} }), platform })
      assert.equal(r.ok, false)
      if (r.ok) continue
      assert.equal(r.error.code, 'not_supported')
      assert.ok(r.error.message.includes(platform))
    }
  })

  it('illegal target path:invalid(each other for / NUL / ..)', { timeout: 60_000 }, async () => {
    for (const bad of ['rel/x', '/a\0b', '/a/../b']) {
      const r = await scanPathUsage(bad, { io: makeIo({ pids: {} }), platform: 'linux' })
      assert.equal(r.ok, false)
      if (r.ok) continue
      assert.equal(r.error.code, 'invalid')
    }
  })

  it('abort: pre- cancel signal return aborted', { timeout: 60_000 }, async () => {
    const controller = new AbortController()
    controller.abort()
    const r = await scanPathUsage('/wt', { io: makeIo({ pids: { '1': { cwd: '/x' } } }), platform: 'linux', signal: controller.signal })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.error.code, 'aborted')
  })

  it('/proc cannot column raise:EACCES → not_supported, other → unknown(never static default)', { timeout: 60_000 }, async () => {
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

  it('hit but comm cannot read: occupy fact still into establish (name default non-blocking)', { timeout: 60_000 }, async () => {
    const io = makeIo({ pids: { '80': { cwd: '/wt', fds: {}, comm: err('EACCES') } } })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.matchedTotal, 1)
    assert.equal(r.value.processes[0]!.name, undefined)
    assert.equal(r.value.complete, true, 'comm cannot read does not affect occupy fact and complete')
  })

  it('fd directory can column but single fd link cannot read:EACCES/EPERM → permission blind spot (unobservable counter);EIO → complete=false; since has hit still such as on report', { timeout: 60_000 }, async () => {
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
        assert.equal(r.value.complete, false, 'EIO: scan exception, must not complete=true')
        assert.equal(r.value.unobservable, 0, code)
      } else {
        assert.equal(r.value.complete, true, `${code}: permission blind spot, do not count complete decide`)
        assert.equal(r.value.unobservable, 1, code)
      }
      assert.ok(
        r.value.diagnostics.some((d) => d.includes('pid 90') && d.includes('fd/4') && d.includes(code)),
        `${code}: diagnose should contains pid and fd ordinal (got ${JSON.stringify(r.value.diagnostics)})`,
      )
      // fd/3 hit fact still such as on report (blind spot do not swallow already has verify based on).
      assert.equal(r.value.matchedTotal, 1)
      assert.equal(r.value.processes[0]!.source, 'fd')
    }
  })

  it('fd loop in cancel: large amount fd scan when abort immediately short route (aborted)', { timeout: 60_000 }, async () => {
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
    assert.equal(r.error.code, 'aborted', 'fd loop each step must check cancel signal')
  })

  it('exit race compute:fd directory instantaneous EACCES but re-check stat verify PID already exit → ignore,complete=true(do not pare weak true EACCES)', { timeout: 60_000 }, async () => {
    // scenario A: exit in PID  fd directory short temporary EACCES, then stat verify already exit.
    const exitedIo = makeIo({ pids: { '96': { cwd: '/safe', fds: undefined, gone: true } } })
    const a = await scanPathUsage('/wt', { io: exitedIo, platform: 'linux' })
    assert.equal(a.ok, true)
    if (!a.ok) return
    assert.equal(a.value.complete, true, 'stat verify exit → contract allows exit race, do not when blind spot')
    assert.deepEqual(a.value.diagnostics, [])

    // scenario B:cwd instantaneous EACCES + stat verify exit → same ignore.
    const cwdGone = makeIo({ pids: { '97': { cwd: err('EACCES'), fds: {}, gone: true } } })
    const b = await scanPathUsage('/wt', { io: cwdGone, platform: 'linux' })
    assert.equal(b.ok, true)
    if (!b.ok) return
    assert.equal(b.value.complete, true)

    // compare:PID still in (stat succeeded) when same expect EACCES → permission blind spot (unobservable
    // counter, never when zero blind spot clean snapshot).
    const alive = makeIo({ pids: { '98': { cwd: '/safe', fds: undefined } } })
    const c = await scanPathUsage('/wt', { io: alive, platform: 'linux' })
    assert.equal(c.ok, true)
    if (!c.ok) return
    assert.equal(c.value.complete, true, 'PID store + heavy read still refuse (EACCES)→ permission blind spot, do not count complete decide')
    assert.equal(c.value.unobservable, 1)
    assert.ok(c.value.diagnostics.some((d) => d.includes('pid 98') && d.includes('fd')))
  })

  it('instantaneous reject after heavy read succeeded (PID still in): adopt heavy read result, do not compute blind spot', { timeout: 60_000 }, async () => {
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
    assert.equal(r.value.complete, true, 'heavy read succeeded verify can read: instantaneous error do not compute blind spot')
    assert.equal(r.value.matchedTotal, 1, 'heavy read which obtain fd manifest such as scan hit')
    assert.equal(r.value.processes[0]!.pid, 99)
  })

  it('realpath failed:EACCES/EPERM → permission_denied; other → unknown;ENOENT keep only use original path', { timeout: 60_000 }, async () => {
    const base = makeIo({ pids: { '1': { cwd: '/wt', fds: {} } } })
    const denied: PathUsageIo = { ...base, realpath: async () => { throw err('EACCES', 'no access') } }
    const r1 = await scanPathUsage('/wt', { io: denied, platform: 'linux' })
    assert.equal(r1.ok, false)
    if (!r1.ok) {
      assert.equal(r1.error.code, 'permission_denied')
      assert.ok(r1.error.message.includes('EACCES'), 'permission reason can diagnose')
    }
    const eperm: PathUsageIo = { ...base, realpath: async () => { throw err('EPERM') } }
    const r2 = await scanPathUsage('/wt', { io: eperm, platform: 'linux' })
    assert.equal(r2.ok, false)
    if (!r2.ok) assert.equal(r2.error.code, 'permission_denied')
    const broken: PathUsageIo = { ...base, realpath: async () => { throw err('ELOOP', 'loop') } }
    const r3 = await scanPathUsage('/wt', { io: broken, platform: 'linux' })
    assert.equal(r3.ok, false)
    if (!r3.ok) assert.equal(r3.error.code, 'unknown')
    // ENOENT: do not failed, only use original path match (since has policy keep).
    const r4 = await scanPathUsage('/wt', { io: base, platform: 'linux' })
    assert.equal(r4.ok, true)
    if (r4.ok) assert.equal(r4.value.matchedTotal, 1)
  })
})
