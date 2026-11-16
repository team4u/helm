/**
 * Node.js 原生适配层：为 shell-config.ts 提供真实文件系统与子进程探测。
 */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath as fsRealpath } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { getEnvEntry } from './process-env.js'
import { resolveShellConfigWithIo, type ResolveShellResult, type ShellProbeIo } from './shell-config.js'

/** 终止探测子进程树（仅用于超时清理自身 spawn 出的短命探测命令）。 */
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
      // 忽略清理失败。
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 进程已退出。
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

/** 创建基于当前 Node.js 宿主的 ShellProbeIo，允许测试覆写部分字段。 */
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

/** 解析宿主机可用的 bash 配置（Hub 本机与 @helm/node 共用同一探测实现）。 */
export async function resolveHostShellConfig(
  customShellPath?: string,
  io?: ShellProbeIo,
): Promise<ResolveShellResult> {
  return resolveShellConfigWithIo(customShellPath, io ?? createNodeShellProbeIo())
}
