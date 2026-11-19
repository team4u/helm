/**
 * Native Node.js adapter providing filesystem and child-process probing for shell-config.ts.
 */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath as fsRealpath } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { getEnvEntry } from './process-env.js'
import { resolveShellConfigWithIo, type ResolveShellResult, type ShellProbeIo } from './shell-config.js'

/** Terminate a process tree (taskkill /F /T on Windows; process-group SIGKILL on POSIX). */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      const systemRoot = getEnvEntry(process.env, 'SystemRoot', 'win32') ?? 'C:\\Windows'
      const child = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      })
      // A failed spawn emits 'error' asynchronously; consume it to avoid crashing Node.
      child.once('error', () => {})
    } catch {
      // Ignore cleanup errors.
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Process already dead.
    }
  }
}

async function execProbeCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; status: number | null }> {
  return await new Promise((resolve) => {
    let stdout = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      })
    } catch {
      resolve({ stdout: '', status: null })
      return
    }
    const timeout = setTimeout(() => {
      if (child.pid !== undefined) killProcessTree(child.pid)
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.once('error', () => {
      clearTimeout(timeout)
      resolve({ stdout: '', status: null })
    })
    child.once('close', (status) => {
      clearTimeout(timeout)
      resolve({ stdout, status })
    })
  })
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function safeRealpath(targetPath: string): Promise<string | null> {
  try {
    return await fsRealpath(targetPath)
  } catch {
    return null
  }
}

/** Build a ShellProbeIo backed by the current Node.js host, allowing tests to override specific fields. */
export function createNodeShellProbeIo(overrides: Partial<ShellProbeIo> = {}): ShellProbeIo {
  return {
    platform: overrides.platform ?? process.platform,
    env: overrides.env ?? process.env,
    homedir: overrides.homedir ?? os.homedir,
    pathExists: overrides.pathExists ?? pathExists,
    realpath: overrides.realpath ?? safeRealpath,
    execProbe: overrides.execProbe ?? execProbeCommand,
  }
}

/** Resolve available host bash configuration (shared by the Hub local runtime and @helmx/node). */
export async function resolveHostShellConfig(
  customShellPath?: string,
  io?: ShellProbeIo,
): Promise<ResolveShellResult> {
  return resolveShellConfigWithIo(customShellPath, io ?? createNodeShellProbeIo())
}
