/**
 * node:fs/promises 的 PathUsageIo 真实适配（@helm/env-io）。
 *
 * kernel（Hub 本机扫描）与 @helm/node（远端节点 daemon）共用同一实现，
 * 绝不各自复制 fs 语义。错误对象携带 node:fs 的 `code` 属性（ENOENT /
 * EACCES / ESRCH 等），由 path-usage 纯编排器分类（竞态退出忽略、被拒
 * 记盲区 fail-closed）。
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
