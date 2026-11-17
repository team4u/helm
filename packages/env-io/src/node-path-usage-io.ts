/**
 * Real `node:fs/promises` adapter implementing `PathUsageIo` (`@helm/env-io`).
 *
 * Shared by `@helm/kernel` (local Hub scans) and `@helm/node` (remote daemon) so filesystem
 * semantics are never duplicated. Errors preserve their `node:fs` `code` property (`ENOENT`,
 * `EACCES`, `ESRCH`, etc.) for fail-closed classification by `path-usage.ts`.
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
