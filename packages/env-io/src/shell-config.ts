/**
 * Cross-platform host Bash shell detection (pure orchestration; I/O is injected via `ShellProbeIo`).
 *
 * Solves `C:\Windows\System32\bash.exe` hijacking on Windows hosts with WSL installed:
 * 1. Probes standard Git Bash install locations (ProgramW6432 / ProgramFiles / ProgramFiles(x86) /
 *    LOCALAPPDATA / Scoop), then derives non-standard Git Bash paths from `where.exe git.exe`.
 * 2. Scans `where.exe bash.exe` while skipping WSL launchers under System32 / Sysnative /
 *    WindowsApps so Windows hosts never silently fall into WSL.
 * 3. If the caller passes an explicit `customShellPath`, honors it (including legacy WSL `-s`
 *    stdin transport).
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

/** Returns true if `path` points to a legacy Windows WSL bash launcher (`System32`/`Sysnative/bash.exe`), which requires stdin transport. */
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
  // Fall back to conventional launcher paths only when SystemRoot is unknown.
  return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized)
}

/** Returns true if `path` is a WSL launcher or Microsoft Store WSL alias (excluded from implicit Windows probing). */
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

/** Build shell launch args: `-s` via stdin for legacy WSL `bash.exe`, `-c` via argv otherwise. */
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

/** Derive sibling Git Bash candidate paths from a `git.exe` path (standard installs, mingw64, and Scoop). */
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

/** Resolve an available bash shell via injected `ShellProbeIo` (never silently falls back into WSL). */
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
