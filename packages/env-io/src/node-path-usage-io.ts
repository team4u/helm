/**
 * node:fs/promises  PathUsageIo real adapt (@helm/env-io).
 *
 * kernel(Hub local machine scan) and @helm/node(remote node daemon) shared use the same implement,
 * never each duplicate fs semantics. error object carry node:fs  `code` property (ENOENT /
 * EACCES / ESRCH etc.), by path-usage pure orchestration classify (race exit ignore, by refuse
 * record blind spot fail-closed).
 */
import { readlink, readdir, stat, readFile, realpath } from 'node:fs/promises'
import type { PathUsageIo } from './path-usage.js'

export function createNodePathUsageIo(): PathUsageIo {
  return {
    readlink: (path) => readlink(path),
    readdir: (path) => readdir(path),
    stat: (path) => stat(path).then((s) => ({ uid: s.uid })),
    readFile: (path) => readFile(path, 'utf8'),
    realpath: (path) => realpath(path),
  }
}
