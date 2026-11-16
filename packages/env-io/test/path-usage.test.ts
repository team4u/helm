/**
 * path-usage 纯扫描编排器测试（注入 io；零真实 /proc 依赖，跨平台可跑）。
 *
 * 覆盖：cwd/fd 命中与子目录、路径分量边界（/a 不匹配 /ab）、(deleted) 后缀、
 * realpath 第二匹配基、ENOENT/ESRCH 退出竞态忽略、持久 EACCES/EPERM 按
 * errno 分治（不论 uid——含同 uid non-dumpable 如 systemd --user——一律
 * 结构性盲区：unobservable 计数 + 诊断含 pid/uid/errno，complete=true）、
 * stat 自身错误同样按 errno 分治、非权限类读取错误（EIO 等）仍
 * complete=false、盲区与命中并存、扫描上限（complete=false）、报告截断
 * （matchedTotal 真值）、平台 not_supported、非法路径拒绝、abort 取消、
 * /proc 不可列举。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scanPathUsage, validatePosixScanPath, type PathUsageIo } from '../src/index.js'

interface Fixture {
  /** procRoot 下的目录名列表（数字为 PID）。 */
  pids: Record<string, { cwd?: string | Error; fds?: Record<string, string | Error> | Error; comm?: string | Error; gone?: boolean; uid?: number }>
}

function err(code: string, message = code): Error {
  return Object.assign(new Error(message), { code })
}

/** fixture io：按 Fixture 表解析 readlink/readdir/readFile；stat 返回每 PID uid（缺省 statUid）；realpath 走映射表。 */
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
      // gone: true 模拟「读取时被拒、复核时已证实退出」（stat ENOENT）。
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
  it('拒绝相对路径 / NUL / 空 / ..与. 段 / 双斜杠 / 超长；归一化尾随斜杠', { timeout: 60_000 }, () => {
    assert.equal(validatePosixScanPath('/a/b').ok, true)
    assert.deepEqual(validatePosixScanPath('/a/b/'), { ok: true, value: '/a/b' })
    assert.equal(validatePosixScanPath('/').ok, true)
    for (const bad of ['', 'a/b', './x', '/a/../b', '/a/./b', '/a//b', '/a\0b', `/${'x'.repeat(4097)}`]) {
      assert.equal(validatePosixScanPath(bad).ok, false, `应拒绝 ${JSON.stringify(bad)}`)
    }
  })
})

describe('scanPathUsage（注入 io）', { timeout: 60_000 }, () => {
  it('cwd 命中：等于目标与子目录；fd 命中：树内文件与目录；含进程名；同 PID 多引用去重（cwd 优先）', { timeout: 60_000 }, async () => {
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
    // 按 PID 去重：11 两个 fd 命中只计一进程（首个 fd 引用）；12 cwd+fd 只计 cwd。
    assert.equal(r.value.matchedTotal, 3)
    assert.deepEqual(
      r.value.processes.map((p) => `${p.pid}:${p.source}:${p.path}`),
      ['10:cwd:/wt/sub', '11:fd:/wt/a.txt', '12:cwd:/wt'],
    )
    assert.ok(r.value.processes.some((p) => p.pid === 10 && p.name === 'worker' && p.path === '/wt/sub'))
  })

  it('路径分量边界：/a 不匹配 /ab、/ax；只匹配 /a 与 /a/*', { timeout: 60_000 }, async () => {
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

  it('(deleted) 后缀：匹配时剥离、报告保留原值', { timeout: 60_000 }, async () => {
    const io = makeIo({ pids: { '30': { cwd: '/wt/gone (deleted)', fds: {} }, '31': { cwd: '/wt (deleted)', fds: {} } } })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.matchedTotal, 2)
    assert.ok(r.value.processes.every((p) => p.path.includes('(deleted)')))
  })

  it('realpath 第二匹配基：软链拼写的候选经 realpath 基命中', { timeout: 60_000 }, async () => {
    const io = makeIo({ pids: { '40': { cwd: '/real/inner', fds: {} } } }, { '/link': '/real' })
    const r = await scanPathUsage('/link', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.matchedTotal, 1)
    assert.equal(r.value.path, '/link')
  })

  it('退出竞态：cwd/fd 的 ENOENT 与 ESRCH 忽略且 complete 保持 true', { timeout: 60_000 }, async () => {
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

  it('持久 EACCES 不论 uid（含同 uid non-dumpable 如 systemd --user）：权限盲区 unobservable 计数，complete=true，诊断含 pid/uid/errno', { timeout: 60_000 }, async () => {
    const io = makeIo({
      pids: {
        '60': { cwd: err('EACCES', 'denied'), uid: 0 }, // 跨 uid：root 属主，任何非 root 扫描方都读不了
        '61': { cwd: '/safe', fds: {} },
        '62': { cwd: '/safe', fds: undefined, uid: 1000 }, // 同 uid 拒读：non-dumpable 场景（属主自己也读不了）
      },
    })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.complete, true, '权限类 errno 持久拒读是结构性盲区，不计入完整性判定')
    assert.equal(r.value.unobservable, 2)
    assert.equal(r.value.matchedTotal, 0)
    assert.ok(
      r.value.diagnostics.some((d) => d.includes('pid 60') && d.includes('uid 0') && d.includes('EACCES') && d.includes('不可观测')),
      String(r.value.diagnostics),
    )
    assert.ok(
      r.value.diagnostics.some((d) => d.includes('pid 62') && d.includes('uid 1000') && d.includes('fd') && d.includes('不可观测')),
      String(r.value.diagnostics),
    )
  })

  it('非权限类读取错误（EIO）：仍 complete=false（fail-closed，不因盲区分治放松）', { timeout: 60_000 }, async () => {
    const io = makeIo({ pids: { '66': { cwd: err('EIO', 'io error') } } })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.complete, false, 'EIO 是扫描异常而非权限盲区')
    assert.equal(r.value.unobservable, 0)
    assert.ok(r.value.diagnostics.some((d) => d.includes('pid 66') && d.includes('EIO') && d.includes('未知')), String(r.value.diagnostics))
  })

  it('stat 自身非退出类错误同样按 errno 分治：EACCES → 盲区（uid 未知也计入）；EIO → complete=false', { timeout: 60_000 }, async () => {
    // cwd 拒读触发复核，stat 自身再拒（EACCES）：uid 未知仍计盲区。
    const base = makeIo({ pids: { '67': { cwd: err('EACCES', 'denied') } } })
    const statDenied: PathUsageIo = { ...base, stat: async () => { throw err('EACCES', 'stat denied') } }
    const a = await scanPathUsage('/wt', { io: statDenied, platform: 'linux' })
    assert.equal(a.ok, true)
    if (!a.ok) return
    assert.equal(a.value.complete, true, 'stat EACCES：权限盲区（uid 未知也计入）')
    assert.equal(a.value.unobservable, 1)
    assert.ok(a.value.diagnostics.some((d) => d.includes('pid 67') && d.includes('EACCES')), String(a.value.diagnostics))

    // stat EIO（非权限类）：无法证明存在状态且非权限 → 扫描异常。
    const statBroken: PathUsageIo = { ...base, stat: async () => { throw err('EIO', 'stat io') } }
    const b = await scanPathUsage('/wt', { io: statBroken, platform: 'linux' })
    assert.equal(b.ok, true)
    if (!b.ok) return
    assert.equal(b.value.complete, false, 'stat EIO：扫描异常（fail-closed）')
    assert.equal(b.value.unobservable, 0)
  })

  it('盲区与命中并存：matchedTotal 如实上报，盲区不吞已有证据', { timeout: 60_000 }, async () => {
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

  it('同一 PID 的 cwd 与 fd 双拒只记一条诊断（权限盲区同料去重计数）', { timeout: 60_000 }, async () => {
    const io = makeIo({ pids: { '70': { cwd: err('EPERM'), fds: undefined, uid: 0 } } })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.complete, true, 'EPERM 权限盲区不计入完整性判定')
    assert.equal(r.value.unobservable, 1, '双拒只计一次')
    assert.equal(r.value.diagnostics.filter((d) => d.includes('pid 70')).length, 1)
  })

  it('扫描上限：PID 数超限时 complete=false 且诊断明示；报告截断按唯一 PID 保留真实总数', { timeout: 60_000 }, async () => {
    const pids: Fixture['pids'] = {}
    for (let i = 0; i < 5; i++) pids[String(100 + i)] = { cwd: `/wt/x${i}`, fds: { '3': `/wt/x${i}/f` } }
    const io = makeIo({ pids })
    const capped = await scanPathUsage('/wt', { io, platform: 'linux', maxPids: 2 })
    assert.equal(capped.ok, true)
    if (!capped.ok) return
    assert.equal(capped.value.complete, false)
    assert.ok(capped.value.diagnostics.some((d) => d.includes('扫描上限')))
    // 只扫前 2 个 PID（升序 100、101），每个 PID 去重后各计一进程。
    assert.equal(capped.value.matchedTotal, 2)

    const reported = await scanPathUsage('/wt', { io, platform: 'linux', maxReported: 2 })
    assert.equal(reported.ok, true)
    if (!reported.ok) return
    assert.equal(reported.value.complete, true)
    assert.equal(reported.value.matchedTotal, 5, '唯一 PID 真实总数（同 PID cwd+fd 不重复计数）')
    assert.equal(reported.value.processes.length, 2)
    assert.equal(reported.value.processesTruncated, true)
  })

  it('平台门：非 Linux 显式 not_supported（不伪造结果）', { timeout: 60_000 }, async () => {
    for (const platform of ['darwin', 'win32', 'freebsd']) {
      const r = await scanPathUsage('/wt', { io: makeIo({ pids: {} }), platform })
      assert.equal(r.ok, false)
      if (r.ok) continue
      assert.equal(r.error.code, 'not_supported')
      assert.ok(r.error.message.includes(platform))
    }
  })

  it('非法目标路径：invalid（相对 / NUL / ..）', { timeout: 60_000 }, async () => {
    for (const bad of ['rel/x', '/a\0b', '/a/../b']) {
      const r = await scanPathUsage(bad, { io: makeIo({ pids: {} }), platform: 'linux' })
      assert.equal(r.ok, false)
      if (r.ok) continue
      assert.equal(r.error.code, 'invalid')
    }
  })

  it('abort：预取消信号返回 aborted', { timeout: 60_000 }, async () => {
    const controller = new AbortController()
    controller.abort()
    const r = await scanPathUsage('/wt', { io: makeIo({ pids: { '1': { cwd: '/x' } } }), platform: 'linux', signal: controller.signal })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.error.code, 'aborted')
  })

  it('/proc 不可列举：EACCES → not_supported、其他 → unknown（绝不静默）', { timeout: 60_000 }, async () => {
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

  it('命中但 comm 不可读：占用事实仍成立（name 缺省不阻塞）', { timeout: 60_000 }, async () => {
    const io = makeIo({ pids: { '80': { cwd: '/wt', fds: {}, comm: err('EACCES') } } })
    const r = await scanPathUsage('/wt', { io, platform: 'linux' })
    assert.equal(r.ok, true)
    if (!r.ok) return
    assert.equal(r.value.matchedTotal, 1)
    assert.equal(r.value.processes[0]!.name, undefined)
    assert.equal(r.value.complete, true, 'comm 不可读不影响占用事实与完整性')
  })

  it('fd 目录可列但单个 fd 链接不可读：EACCES/EPERM → 权限盲区（unobservable 计数）；EIO → complete=false；既有命中仍如实上报', { timeout: 60_000 }, async () => {
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
        assert.equal(r.value.complete, false, 'EIO：扫描异常，不得 complete=true')
        assert.equal(r.value.unobservable, 0, code)
      } else {
        assert.equal(r.value.complete, true, `${code}：权限盲区，不计入完整性判定`)
        assert.equal(r.value.unobservable, 1, code)
      }
      assert.ok(
        r.value.diagnostics.some((d) => d.includes('pid 90') && d.includes('fd/4') && d.includes(code)),
        `${code}：诊断应含 pid 与 fd 序号（实得 ${JSON.stringify(r.value.diagnostics)}）`,
      )
      // fd/3 的命中事实仍如实上报（盲区不吞已有证据）。
      assert.equal(r.value.matchedTotal, 1)
      assert.equal(r.value.processes[0]!.source, 'fd')
    }
  })

  it('fd 循环中取消：大量 fd 扫描时 abort 立即短路（aborted）', { timeout: 60_000 }, async () => {
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
    assert.equal(r.error.code, 'aborted', 'fd 循环每步必须检查取消信号')
  })

  it('退出竞态结算：fd 目录瞬时 EACCES 但复核 stat 证实 PID 已退出 → 忽略，complete=true（不削弱真 EACCES）', { timeout: 60_000 }, async () => {
    // 场景 A：退出中 PID 的 fd 目录短暂 EACCES，随后 stat 证实已退出。
    const exitedIo = makeIo({ pids: { '96': { cwd: '/safe', fds: undefined, gone: true } } })
    const a = await scanPathUsage('/wt', { io: exitedIo, platform: 'linux' })
    assert.equal(a.ok, true)
    if (!a.ok) return
    assert.equal(a.value.complete, true, 'stat 证实退出 → 契约允许的退出竞态，不当盲区')
    assert.deepEqual(a.value.diagnostics, [])

    // 场景 B：cwd 瞬时 EACCES + stat 证实退出 → 同样忽略。
    const cwdGone = makeIo({ pids: { '97': { cwd: err('EACCES'), fds: {}, gone: true } } })
    const b = await scanPathUsage('/wt', { io: cwdGone, platform: 'linux' })
    assert.equal(b.ok, true)
    if (!b.ok) return
    assert.equal(b.value.complete, true)

    // 对照：PID 仍在（stat 成功）时同料 EACCES → 权限盲区（unobservable
    // 计数，绝不当零盲区的干净快照）。
    const alive = makeIo({ pids: { '98': { cwd: '/safe', fds: undefined } } })
    const c = await scanPathUsage('/wt', { io: alive, platform: 'linux' })
    assert.equal(c.ok, true)
    if (!c.ok) return
    assert.equal(c.value.complete, true, 'PID 存活 + 重读仍拒（EACCES）→ 权限盲区，不计入完整性判定')
    assert.equal(c.value.unobservable, 1)
    assert.ok(c.value.diagnostics.some((d) => d.includes('pid 98') && d.includes('fd')))
  })

  it('瞬时拒绝后重读成功（PID 仍在）：采用重读结果，不算盲区', { timeout: 60_000 }, async () => {
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
    assert.equal(r.value.complete, true, '重读成功证明可读：瞬时错误不算盲区')
    assert.equal(r.value.matchedTotal, 1, '重读所得 fd 清单如实扫描命中')
    assert.equal(r.value.processes[0]!.pid, 99)
  })

  it('realpath 失败：EACCES/EPERM → permission_denied；其他 → unknown；ENOENT 保持只用原始路径', { timeout: 60_000 }, async () => {
    const base = makeIo({ pids: { '1': { cwd: '/wt', fds: {} } } })
    const denied: PathUsageIo = { ...base, realpath: async () => { throw err('EACCES', 'no access') } }
    const r1 = await scanPathUsage('/wt', { io: denied, platform: 'linux' })
    assert.equal(r1.ok, false)
    if (!r1.ok) {
      assert.equal(r1.error.code, 'permission_denied')
      assert.ok(r1.error.message.includes('EACCES'), '权限原因可诊断')
    }
    const eperm: PathUsageIo = { ...base, realpath: async () => { throw err('EPERM') } }
    const r2 = await scanPathUsage('/wt', { io: eperm, platform: 'linux' })
    assert.equal(r2.ok, false)
    if (!r2.ok) assert.equal(r2.error.code, 'permission_denied')
    const broken: PathUsageIo = { ...base, realpath: async () => { throw err('ELOOP', 'loop') } }
    const r3 = await scanPathUsage('/wt', { io: broken, platform: 'linux' })
    assert.equal(r3.ok, false)
    if (!r3.ok) assert.equal(r3.error.code, 'unknown')
    // ENOENT：不失败，只用原始路径匹配（既有策略保持）。
    const r4 = await scanPathUsage('/wt', { io: base, platform: 'linux' })
    assert.equal(r4.ok, true)
    if (r4.ok) assert.equal(r4.value.matchedTotal, 1)
  })
})
