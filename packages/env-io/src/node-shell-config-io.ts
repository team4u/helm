/**
 * Node.js original generate adapt layer: is shell-config.ts provide real file system and child process probe.
 */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath as fsRealpath } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { getEnvEntry } from './process-env.js'
import { resolveShellConfigWithIo, type ResolveShellResult, type ShellProbeIo } from './shell-config.js'

/** terminate probe child process tree (only used to timeout clean up itself spawn out short life probe command). */
export function killProbeProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      const systemRoot = getEnvEntry(process.env, 'SystemRoot', 'win32') ?? 'C:\\Windows'
      const child = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      })
      child.once('error', () => {})
    } catch {
      // ignore clean up failed.
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // process already exit.
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
      if (child.pid !== undefined) killProbeProcessTree(child.pid)
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

/** create based on when before Node.js host ShellProbeIo, allows test override part field. */
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

/** parse host machine available bash config (Hub local machine and @helm/node shared use the same probe implement). */
export async function resolveHostShellConfig(
  customShellPath?: string,
  io?: ShellProbeIo,
): Promise<ResolveShellResult> {
  return resolveShellConfigWithIo(customShellPath, io ?? createNodeShellProbeIo())
}
