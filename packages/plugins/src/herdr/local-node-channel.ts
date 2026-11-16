/**
 * Minimal production helper for local node connections (`nodeId === 'local'`):
 * - Real IPC: on Unix, connect directly to the UDS path; on Windows, convert the marker
 *   file path into the Named Pipe name per herdr's actual rules (see the windowsPipeNameOf source-evidence comment);
 * - Real execution environment: the `NodeExecutionEnv` structure already satisfies `HerdrNodeEnv` (a Pick subset).
 *
 * Windows pipe name rules (verified against interprocess 2.4.2 source, not guessed):
 * - `src/os/windows/path_conversion.rs` `pathcvt` (L126-137): a namespaced name is just
 *   `\\` + `.` (local host) + `\\pipe\\` + the raw name joined segment by segment, **without replacing
 *   colons/slashes** (after herdr's marker path `C:\\Users\\...\\herdr.sock` enters the pipe name, the colon
 *   stays as-is -- NPFS does not forbid `:` in names apart from NUL and path-separator semantics);
 * - `src/os/windows/local_socket/name_type.rs` `map_generic_namespaced_osstr`:
 *   a full pipe path already in `\\HOST\\pipe\\NAME` form passes through unchanged (`is_pipefs`).
 * Derived from source; not verified on a physical Windows machine (tests state this honestly).
 */

import { connect } from 'node:net'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import type { RpcResult } from '@helm/protocol'
import type { HerdrNodeChannel, HerdrNodeEnv } from './contracts.js'
import { isWindowsShapedPath } from './transport.js'

/** The local-host segment of interprocess's `\\<host>\\pipe\\<name>` (pathcvt LOCAL_HOSTNAME). */
const PIPE_PREFIX = '\\\\.\\pipe\\'

/**
 * Windows marker file path -> named pipe connection name.
 * Rule = `\\.\\pipe\\` + the raw path (only normalize forward slashes to backslashes; colons/other characters as-is).
 * A full pipe path (`\\.\\pipe\\...` or `\\HOST\\pipe\\...`) is returned unchanged.
 */
export function windowsPipeNameOf(markerPath: string): string {
  const normalized = markerPath.replaceAll('/', '\\')
  if (isPipePath(normalized)) return normalized
  return PIPE_PREFIX + normalized
}

/** Same rule as interprocess `is_pipefs`: `\\HOST\\pipe\\...` (non-empty host segment) is a full pipe path. */
function isPipePath(path: string): boolean {
  if (!path.startsWith('\\\\')) return false
  const hostEnd = path.indexOf('\\', 2)
  if (hostEnd <= 2) return false
  return path.startsWith('\\pipe\\', hostEnd)
}

/**
 * Endpoint form detection: a full pipe path or a Windows path shape (drive letter/UNC) means named pipe;
 * anything else (POSIX paths, incl. explicit relative/absolute UDS paths) is a Unix socket. Pure path-shape detection
 * independent of the Hub process platform (a Windows endpoint explicitly configured on a Linux Hub still connects as a pipe).
 */
export function endpointKindOf(endpoint: string): 'unix-socket' | 'named-pipe' {
  return isWindowsShapedPath(endpoint) || isPipePath(endpoint.replaceAll('/', '\\')) ? 'named-pipe' : 'unix-socket'
}

/** Establish a socket connection to the local Herdr IPC endpoint (Unix UDS / Windows Named Pipe). */
export function connectHerdrEndpoint(endpoint: string, kind: 'unix-socket' | 'named-pipe') {
  if (kind === 'named-pipe') {
    return connect(windowsPipeNameOf(endpoint))
  }
  return connect(endpoint)
}

/**
 * Local node channel (`nodeId === 'local'`; every other node is rejected -- when EnvFabric is not injected,
 * transport explicitly reports herdr_node_unavailable for remote targets; never uses this class as a local fallback).
 * One request per connection: write a single-line request, return on the first newline response, then close.
 */
export class LocalNodeChannel implements HerdrNodeChannel {
  private readonly envCache = new Map<string, HerdrNodeEnv>()

  isOnline(nodeId: string): boolean {
    return nodeId === 'local'
  }

  getNodeHubUrl(): string | undefined {
    return undefined
  }

  /** The local node is the Hub host itself: the platform is process.platform (for cwd normalization). */
  nodePlatform(nodeId: string): string | undefined {
    return nodeId === 'local' ? process.platform : undefined
  }

  async ipcCall(
    nodeId: string,
    input: { endpoint?: string; session?: string; line: string; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<RpcResult<string>> {
    if (nodeId !== 'local') {
      return { ok: false, error: { code: 'invalid', message: `LocalNodeChannel only carries the 'local' node (got '${nodeId}')` } }
    }
    if (input.endpoint === undefined) {
      return { ok: false, error: { code: 'invalid', message: 'ipcCall requires an explicit endpoint' } }
    }
    if (signal?.aborted) {
      return { ok: false, error: { code: 'aborted', message: 'ipcCall aborted' } }
    }
    return await new Promise<RpcResult<string>>((resolve) => {
      // Endpoint form follows path shape (a Windows endpoint must be converted to the pipe name; never connect to the marker file).
      const socket = connectHerdrEndpoint(input.endpoint!, endpointKindOf(input.endpoint!))
      socket.setNoDelay(true)
      const chunks: Buffer[] = []
      let done = false
      const settle = (result: RpcResult<string>) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        socket.destroy()
        resolve(result)
      }
      const timer =
        input.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              settledTimeout = true
              settle({ ok: false, error: { code: 'timeout', message: `ipcCall no response within ${input.timeoutMs}ms` } })
            }, input.timeoutMs)
      timer?.unref?.()
      let settledTimeout = false
      const onAbort = () => settle({ ok: false, error: { code: 'aborted', message: 'ipcCall aborted' } })
      signal?.addEventListener('abort', onAbort, { once: true })
      socket.on('connect', () => socket.write(`${input.line}\n`))
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        const joined = Buffer.concat(chunks)
        const newline = joined.indexOf(0x0a)
        if (newline >= 0) settle({ ok: true, value: joined.subarray(0, newline).toString('utf8') })
      })
      socket.once('close', () => {
        if (settledTimeout || signal?.aborted) return
        const joined = Buffer.concat(chunks)
        settle(
          joined.length === 0
            ? { ok: false, error: { code: 'unknown', message: 'ipc endpoint closed before response' } }
            : { ok: true, value: joined.toString('utf8').split('\n')[0]! },
        )
      })
      socket.once('error', (err) => {
        if (settledTimeout || signal?.aborted) return
        settle({ ok: false, error: { code: 'unknown', message: err.message } })
      })
    })
  }

  envFor(nodeId: string, cwd: string): HerdrNodeEnv {
    if (nodeId !== 'local') {
      throw new Error(`LocalNodeChannel only carries the file environment of the 'local' node (got '${nodeId}')`)
    }
    const cached = this.envCache.get(cwd)
    if (cached !== undefined) return cached
    // The NodeExecutionEnv structure already satisfies HerdrNodeEnv (a Pick subset); cancellation is derived
    // by the caller at the exec options (transport-layer withAbortSignal).
    const env: HerdrNodeEnv = new NodeExecutionEnv({ cwd })
    this.envCache.set(cwd, env)
    return env
  }
}
