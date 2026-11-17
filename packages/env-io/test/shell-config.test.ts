import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isLegacyWslBashPath,
  isWslBashLauncherPath,
  resolveShellConfigWithIo,
  type ShellProbeIo,
} from '../src/index.js'

interface FakeIoOptions {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  homedir?: string
  existingPaths?: string[]
  realpaths?: Record<string, string>
  probes?: Record<string, { stdout: string; status: number | null }>
}

function makeFakeIo(opts: FakeIoOptions): { io: ShellProbeIo; probeCalls: Array<{ cmd: string; args: string[] }> } {
  const platform = opts.platform ?? 'win32'
  const normalizeKey = (p: string) => (platform === 'win32' ? p.replaceAll('/', '\\').toLowerCase() : p)
  const existing = new Set((opts.existingPaths ?? []).map(normalizeKey))
  const realpaths = new Map(Object.entries(opts.realpaths ?? {}).map(([k, v]) => [normalizeKey(k), v]))
  const probeCalls: Array<{ cmd: string; args: string[] }> = []

  const io: ShellProbeIo = {
    platform,
    env: opts.env ?? {
      SystemRoot: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\me',
    },
    homedir: () => opts.homedir ?? 'C:\\Users\\me',
    pathExists: async (p) => existing.has(normalizeKey(p)),
    realpath: async (p) => realpaths.get(normalizeKey(p)) ?? null,
    execProbe: async (cmd, args) => {
      probeCalls.push({ cmd, args: [...args] })
      const key = `${cmd} ${args.join(' ')}`
      return opts.probes?.[key] ?? opts.probes?.[args.join(' ')] ?? { stdout: '', status: 1 }
    },
  }
  return { io, probeCalls }
}

describe('shell-config: Windows Git Bash detection and WSL filtering', { timeout: 60_000 }, () => {
  it('finds Git Bash under %ProgramW6432%, %LOCALAPPDATA%, %USERPROFILE%\\scoop, and %SCOOP%', { timeout: 60_000 }, async () => {
    {
      const target = 'D:\\Programs\\Git\\bin\\bash.exe'
      const { io } = makeFakeIo({
        env: { SystemRoot: 'C:\\Windows', ProgramW6432: 'D:\\Programs' },
        existingPaths: [target],
      })
      const res = await resolveShellConfigWithIo(undefined, io)
      assert.deepEqual(res, { ok: true, value: { shell: target, args: ['-c'], commandTransport: 'argv' } })
    }
    {
      const target = 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'
      const { io } = makeFakeIo({ existingPaths: [target] })
      const res = await resolveShellConfigWithIo(undefined, io)
      assert.deepEqual(res, { ok: true, value: { shell: target, args: ['-c'], commandTransport: 'argv' } })
    }
    {
      const target = 'C:\\Users\\me\\scoop\\apps\\git\\current\\bin\\bash.exe'
      const { io } = makeFakeIo({ existingPaths: [target] })
      const res = await resolveShellConfigWithIo(undefined, io)
      assert.deepEqual(res, { ok: true, value: { shell: target, args: ['-c'], commandTransport: 'argv' } })
    }
    {
      const target = 'E:\\ScoopRoot\\apps\\git\\current\\bin\\bash.exe'
      const { io } = makeFakeIo({
        env: { SystemRoot: 'C:\\Windows', SCOOP: 'E:\\ScoopRoot', USERPROFILE: 'C:\\Users\\me' },
        existingPaths: [target],
      })
      const res = await resolveShellConfigWithIo(undefined, io)
      assert.deepEqual(res, { ok: true, value: { shell: target, args: ['-c'], commandTransport: 'argv' } })
    }
  })

  it('derives D:\\Git, mingw64, and Scoop shim paths via where.exe git.exe when defaults are absent', { timeout: 60_000 }, async () => {
    // 1) D:\Git\cmd\git.exe -> D:\Git\bin\bash.exe
    {
      const bash = 'D:\\Git\\bin\\bash.exe'
      const { io, probeCalls } = makeFakeIo({
        existingPaths: ['C:\\Windows\\System32\\where.exe', bash],
        probes: {
          'git.exe': { stdout: 'D:\\Git\\cmd\\git.exe\r\n', status: 0 },
        },
      })
      const res = await resolveShellConfigWithIo(undefined, io)
      assert.deepEqual(res, { ok: true, value: { shell: bash, args: ['-c'], commandTransport: 'argv' } })
      assert.equal(probeCalls[0]?.cmd, 'C:\\Windows\\System32\\where.exe')
      assert.deepEqual(probeCalls[0]?.args, ['git.exe'])
    }
    // 2) E:\Tools\Git\mingw64\bin\git.exe -> E:\Tools\Git\bin\bash.exe
    {
      const bash = 'E:\\Tools\\Git\\bin\\bash.exe'
      const { io } = makeFakeIo({
        existingPaths: [bash],
        probes: {
          'git.exe': { stdout: 'E:\\Tools\\Git\\mingw64\\bin\\git.exe\n', status: 0 },
        },
      })
      const res = await resolveShellConfigWithIo(undefined, io)
      assert.deepEqual(res, { ok: true, value: { shell: bash, args: ['-c'], commandTransport: 'argv' } })
    }
    // 3) D:\Scoop\shims\git.exe -> D:\Scoop\apps\git\current\bin\bash.exe
    {
      const bash = 'D:\\Scoop\\apps\\git\\current\\bin\\bash.exe'
      const { io } = makeFakeIo({
        existingPaths: [bash],
        probes: {
          'git.exe': { stdout: 'D:\\Scoop\\shims\\git.exe\n', status: 0 },
        },
      })
      const res = await resolveShellConfigWithIo(undefined, io)
      assert.deepEqual(res, { ok: true, value: { shell: bash, args: ['-c'], commandTransport: 'argv' } })
    }
  })

  it('skips System32 and WindowsApps WSL launchers from where.exe bash.exe and picks MSYS2 bash.exe', { timeout: 60_000 }, async () => {
    const msysBash = 'C:\\msys64\\usr\\bin\\bash.exe'
    const { io } = makeFakeIo({
      existingPaths: [
        'C:\\Windows\\System32\\where.exe',
        'C:\\Windows\\System32\\bash.exe',
        'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
        msysBash,
      ],
      probes: {
        'git.exe': { stdout: '', status: 1 },
        'bash.exe': {
          stdout: [
            'C:\\Windows\\System32\\bash.exe',
            'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
            msysBash,
          ].join('\r\n'),
          status: 0,
        },
      },
    })
    const res = await resolveShellConfigWithIo(undefined, io)
    assert.deepEqual(res, { ok: true, value: { shell: msysBash, args: ['-c'], commandTransport: 'argv' } })
  })

  it('fails explicitly when only WSL launchers exist and no native Windows Bash is found', { timeout: 60_000 }, async () => {
    const { io } = makeFakeIo({
      existingPaths: [
        'C:\\Windows\\System32\\bash.exe',
        'C:\\Windows\\Sysnative\\bash.exe',
        'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
      ],
      probes: {
        'git.exe': { stdout: '', status: 1 },
        'bash.exe': {
          stdout: [
            'C:\\Windows\\System32\\bash.exe',
            'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
          ].join('\r\n'),
          status: 0,
        },
      },
    })
    const res = await resolveShellConfigWithIo(undefined, io)
    assert.equal(res.ok, false)
    if (!res.ok) {
      assert.match(res.message, /No bash shell found/)
      assert.match(res.message, /Skipped WSL launcher\(s\):/)
      assert.match(res.message, /C:\\Windows\\System32\\bash\.exe/)
      assert.match(res.message, /WindowsApps\\bash\.exe/)
    }
  })

  it('honors explicit customShellPath=System32\\bash.exe with stdin mode; fails when missing', { timeout: 60_000 }, async () => {
    const wsl = 'C:\\Windows\\System32\\bash.exe'
    assert.equal(isLegacyWslBashPath(wsl, { SystemRoot: 'C:\\Windows' }), true)
    assert.equal(isWslBashLauncherPath('D:\\Custom\\Microsoft\\WindowsApps\\bash.exe', {}), true)
    const { io } = makeFakeIo({ existingPaths: [wsl] })
    const res = await resolveShellConfigWithIo(wsl, io)
    assert.deepEqual(res, { ok: true, value: { shell: wsl, args: ['-s'], commandTransport: 'stdin' } })

    const missing = await resolveShellConfigWithIo('D:\\missing\\bash.exe', io)
    assert.deepEqual(missing, { ok: false, message: 'Custom shell path not found: D:\\missing\\bash.exe' })
  })

  it('preserves /bin/bash -> which bash -> sh fallback on linux', { timeout: 60_000 }, async () => {
    {
      const { io } = makeFakeIo({ platform: 'linux', existingPaths: ['/bin/bash'] })
      assert.deepEqual(await resolveShellConfigWithIo(undefined, io), {
        ok: true,
        value: { shell: '/bin/bash', args: ['-c'], commandTransport: 'argv' },
      })
    }
    {
      const { io } = makeFakeIo({
        platform: 'linux',
        existingPaths: ['/usr/local/bin/bash'],
        probes: { bash: { stdout: '/usr/local/bin/bash\n', status: 0 } },
      })
      assert.deepEqual(await resolveShellConfigWithIo(undefined, io), {
        ok: true,
        value: { shell: '/usr/local/bin/bash', args: ['-c'], commandTransport: 'argv' },
      })
    }
    {
      const { io } = makeFakeIo({ platform: 'linux', existingPaths: [] })
      assert.deepEqual(await resolveShellConfigWithIo(undefined, io), {
        ok: true,
        value: { shell: 'sh', args: ['-c'], commandTransport: 'argv' },
      })
    }
  })
})
