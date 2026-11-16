/**
 * 跨平台宿主机 Bash Shell 探测（纯编排器，I/O 经 ShellProbeIo 注入）。
 *
 * 解决 Windows 宿主机在安装 WSL 后被 `C:\Windows\System32\bash.exe` 截胡的问题：
 * 1. 按常见安装位置依次探测 Git Bash（含 ProgramW6432 / ProgramFiles /
 *    ProgramFiles(x86) / LOCALAPPDATA / Scoop），再用 `where.exe git.exe`
 *    反推非标盘符或自定义目录中的 Git Bash；
 * 2. 扫描 `where.exe bash.exe` 全部行，跳过 System32 / Sysnative /
 *    WindowsApps 等 WSL 启动器——绝不让 Windows 宿主机隐式掉入 WSL；
 * 3. 若用户显式传入 `customShellPath`，仍尊重显式配置（含 legacy WSL `-s`
 *    stdin 传输模式）。
 */
import { win32 } from 'node:path'
import { getEnvEntry } from './process-env.js'

export interface ResolvedShellConfig {
  shell: string
  args: string[]
  commandTransport: 'stdin' | 'argv'
}

export type ResolveShellResult =
  | { ok: true; value: ResolvedShellConfig }
  | { ok: false; message: string }

export interface ShellProbeIo {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  readonly homedir: () => string
  pathExists(path: string): Promise<boolean>
  realpath(path: string): Promise<string | null>
  execProbe(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; status: number | null }>
}

const SHELL_PROBE_TIMEOUT_MS = 5000

/** 判定是否为 Windows 旧版 WSL 启动器（System32/Sysnative 下的 bash.exe，需经 stdin 传命令）。 */
export function isLegacyWslBashPath(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const normalized = win32.normalize(path).toLowerCase()
  const systemRoot = getEnvEntry(env, 'SystemRoot', 'win32')
  if (systemRoot) {
    if (!/^[a-z]:[\\/]/i.test(systemRoot)) return false
    return ['System32', 'Sysnative'].some(
      (directory) => normalized === win32.join(systemRoot, directory, 'bash.exe').toLowerCase(),
    )
  }
  // Windows 目录未知时仅按惯例启动器路径回退。
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized)
}

/** 判定是否为 WSL 启动器或 Microsoft Store WSL 别名（禁止宿主机隐式选中）。 */
export function isWslBashLauncherPath(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (isLegacyWslBashPath(path, env)) return true
  const normalized = win32.normalize(path).toLowerCase()
  const localAppData = getEnvEntry(env, 'LOCALAPPDATA', 'win32')
  if (
    localAppData &&
    /^[a-z]:[\\/]/i.test(localAppData) &&
    normalized === win32.join(localAppData, 'Microsoft', 'WindowsApps', 'bash.exe').toLowerCase()
  ) {
    return true
  }
  return normalized.endsWith('\\microsoft\\windowsapps\\bash.exe')
}

/** 构造 bash 启动参数配置：legacy WSL bash.exe 走 `-s` + stdin，其余走 `-c` + argv。 */
export function getBashShellConfig(
  shell: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedShellConfig {
  return isLegacyWslBashPath(shell, env)
    ? { shell, args: ['-s'], commandTransport: 'stdin' }
    : { shell, args: ['-c'], commandTransport: 'argv' }
}

function pushUniqueWin32Path(list: string[], seen: Set<string>, candidate: string): void {
  const key = win32.normalize(candidate).toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  list.push(candidate)
}

/** 从 `git.exe` 路径反推同一次安装的 Git Bash 候选路径（支持标准安装、mingw64 与 Scoop）。 */
export function gitBashCandidatesFromGitExe(gitExePath: string): string[] {
  const normalized = win32.normalize(gitExePath)
  const dir1 = win32.dirname(normalized)
  const dir2 = win32.dirname(dir1)
  const dir3 = win32.dirname(dir2)
  const candidates: string[] = []
  const seen = new Set<string>()
  if (win32.basename(dir1).toLowerCase() === 'shims') {
    pushUniqueWin32Path(candidates, seen, win32.join(dir2, 'apps', 'git', 'current', 'bin', 'bash.exe'))
    pushUniqueWin32Path(candidates, seen, win32.join(dir2, 'apps', 'git-with-openssh', 'current', 'bin', 'bash.exe'))
  }
  for (const root of [dir2, dir3]) {
    if (root === '' || root === win32.dirname(root)) continue
    pushUniqueWin32Path(candidates, seen, win32.join(root, 'bin', 'bash.exe'))
    pushUniqueWin32Path(candidates, seen, win32.join(root, 'usr', 'bin', 'bash.exe'))
  }
  return candidates
}

function collectKnownWindowsGitBashCandidates(io: ShellProbeIo): string[] {
  const candidates: string[] = []
  const seen = new Set<string>()
  const addGitRoot = (root: string | undefined) => {
    if (!root) return
    pushUniqueWin32Path(candidates, seen, win32.join(root, 'Git', 'bin', 'bash.exe'))
  }
  addGitRoot(getEnvEntry(io.env, 'ProgramW6432', 'win32'))
  addGitRoot(getEnvEntry(io.env, 'ProgramFiles', 'win32'))
  addGitRoot(getEnvEntry(io.env, 'ProgramFiles(x86)', 'win32'))
  const localAppData = getEnvEntry(io.env, 'LOCALAPPDATA', 'win32')
  if (localAppData) {
    pushUniqueWin32Path(candidates, seen, win32.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'))
  }
  const scoop = getEnvEntry(io.env, 'SCOOP', 'win32')
  if (scoop) {
    pushUniqueWin32Path(candidates, seen, win32.join(scoop, 'apps', 'git', 'current', 'bin', 'bash.exe'))
  }
  const userProfile = getEnvEntry(io.env, 'USERPROFILE', 'win32') ?? io.homedir()
  if (userProfile) {
    pushUniqueWin32Path(candidates, seen, win32.join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'))
  }
  return candidates
}

async function resolveWindowsWhereCommand(io: ShellProbeIo): Promise<string> {
  const systemRoot = getEnvEntry(io.env, 'SystemRoot', 'win32')
  if (systemRoot && /^[a-z]:[\\/]/i.test(systemRoot)) {
    const sysWhere = win32.join(systemRoot, 'System32', 'where.exe')
    if (await io.pathExists(sysWhere)) return sysWhere
  }
  return 'where'
}

/** 经注入的 ShellProbeIo 解析宿主机可用 bash 配置（绝不静默降级进 WSL）。 */
export async function resolveShellConfigWithIo(
  customShellPath: string | undefined,
  io: ShellProbeIo,
): Promise<ResolveShellResult> {
  if (customShellPath) {
    if (await io.pathExists(customShellPath)) {
      return { ok: true, value: getBashShellConfig(customShellPath, io.env) }
    }
    return { ok: false, message: `Custom shell path not found: ${customShellPath}` }
  }

  if (io.platform === 'win32') {
    const knownCandidates = collectKnownWindowsGitBashCandidates(io)
    const checkedSeen = new Set<string>()
    const checkedList: string[] = []
    const recordChecked = (candidate: string) => {
      pushUniqueWin32Path(checkedList, checkedSeen, candidate)
    }

    for (const candidate of knownCandidates) {
      recordChecked(candidate)
      if (!isWslBashLauncherPath(candidate, io.env) && (await io.pathExists(candidate))) {
        return { ok: true, value: getBashShellConfig(candidate, io.env) }
      }
    }

    const whereCmd = await resolveWindowsWhereCommand(io)
    const gitWhere = await io.execProbe(whereCmd, ['git.exe'], SHELL_PROBE_TIMEOUT_MS)
    if (gitWhere.status === 0 && gitWhere.stdout) {
      const derivedCandidates: string[] = []
      const derivedSeen = new Set<string>()
      const gitLines = gitWhere.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
      for (const gitPath of gitLines) {
        for (const c of gitBashCandidatesFromGitExe(gitPath)) {
          pushUniqueWin32Path(derivedCandidates, derivedSeen, c)
        }
        const realGit = await io.realpath(gitPath)
        if (realGit && realGit !== gitPath) {
          for (const c of gitBashCandidatesFromGitExe(realGit)) {
            pushUniqueWin32Path(derivedCandidates, derivedSeen, c)
          }
        }
      }
      for (const candidate of derivedCandidates) {
        recordChecked(candidate)
        if (!isWslBashLauncherPath(candidate, io.env) && (await io.pathExists(candidate))) {
          return { ok: true, value: getBashShellConfig(candidate, io.env) }
        }
      }
    }

    const bashWhere = await io.execProbe(whereCmd, ['bash.exe'], SHELL_PROBE_TIMEOUT_MS)
    const skippedWsl: string[] = []
    if (bashWhere.status === 0 && bashWhere.stdout) {
      const bashLines = bashWhere.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
      for (const line of bashLines) {
        if (isWslBashLauncherPath(line, io.env)) {
          if (!skippedWsl.includes(line)) skippedWsl.push(line)
          continue
        }
        if (await io.pathExists(line)) {
          return { ok: true, value: getBashShellConfig(line, io.env) }
        }
      }
    }

    const skippedNote =
      skippedWsl.length > 0
        ? `Skipped WSL launcher(s): ${skippedWsl.join(', ')} (Windows host sessions do not implicitly execute inside WSL)\n\n`
        : ''
    const searchedLines = checkedList.length > 0 ? checkedList.map((p) => `  ${p}`).join('\n') : '  (none)'
    return {
      ok: false,
      message:
        `No bash shell found. Options:\n` +
        `  1. Install Git for Windows: https://git-scm.com/download/win\n` +
        `  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
        `  3. Configure an explicit shellPath\n\n` +
        skippedNote +
        `Searched Git Bash in:\n${searchedLines}`,
    }
  }

  if (await io.pathExists('/bin/bash')) {
    return { ok: true, value: getBashShellConfig('/bin/bash', io.env) }
  }
  const whichResult = await io.execProbe('which', ['bash'], SHELL_PROBE_TIMEOUT_MS)
  if (whichResult.status === 0 && whichResult.stdout) {
    const firstMatch = whichResult.stdout.trim().split(/\r?\n/)[0]?.trim()
    if (firstMatch && (await io.pathExists(firstMatch))) {
      return { ok: true, value: getBashShellConfig(firstMatch, io.env) }
    }
  }
  return { ok: true, value: { shell: 'sh', args: ['-c'], commandTransport: 'argv' } }
}
