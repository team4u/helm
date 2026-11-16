import { posix, win32 } from 'node:path'
import { HelmError } from '@helm/protocol'
import type { Context } from '@earendil-works/chord/context'
import type { HerdrNodeChannel, HerdrNodeEnv, HerdrTarget } from './contracts.js'
import { checkAborted, contextOf, HerdrTransportError } from './transport-shared.js'

/**
 * `.helm/wf-out-*` handoff file IO and cross-platform path safety boundary (split out of transport.ts,
 * behavior line-for-line equivalent to before the split):
 * - filename whitelist OUTPUT_FILE_PATTERN (rejects herdr_invalid_output_name);
 * - local: cwd realpath + `.helm` must be a real directory (not a symlink) and still inside the real cwd;
 *   O_NOFOLLOW opening converges TOCTOU (Windows has no O_NOFOLLOW; falls back to post-read realpath recheck);
 * - remote: pick win32/posix pure rules by the cwd path shape to join `<cwd>/.helm`, validate via the node env's
 *   canonicalPath, and after reading recheck the canonical path still anchors inside realHelm;
 * - missing directory = 404 herdr_output_missing (the only self-healable boundary); remove semantics are idempotent;
 * - MAX_OUTPUT_BYTES size cap; over the limit fails explicitly, never silently truncated.
 */

/** Handoff file read cap; over the limit fails explicitly, never silently truncated and passed off as success. */
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
export const OUTPUT_FILE_PATTERN = /^wf-out-[A-Za-z0-9_.-]{1,64}\.(json|md)$/

export function assertSafeOutputName(fileName: string, target: string): void {
  if (!OUTPUT_FILE_PATTERN.test(fileName)) {
    throw new HerdrTransportError('herdr_invalid_output_name', `refusing unsafe output file name: ${fileName}`, target)
  }
}

/** Local output path: validate the cwd really exists, `.helm` is a real directory (not a symlink) and inside the real cwd. */
async function resolveLocalOutputPath(cwd: string, fileName: string, target: string): Promise<string> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  let realCwd: string
  try {
    realCwd = await fs.realpath(cwd)
  } catch (err) {
    throw new HerdrTransportError('herdr_invalid_cwd', `cwd not accessible: ${cwd}`, target, { cause: err })
  }
  const helmDir = path.join(realCwd, '.helm')
  let helmStat
  try {
    helmStat = await fs.lstat(helmDir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // Missing directory = missing handoff file: read reports 404, remove is idempotent (the one self-heal boundary).
      throw new HelmError('herdr_output_missing', `handoff directory does not exist: ${helmDir}`, 404)
    }
    throw new HerdrTransportError('herdr_io', `failed to inspect ${helmDir}: ${code ?? String(err)}`, target, { cause: err })
  }
  if (helmStat.isSymbolicLink() || !helmStat.isDirectory()) {
    throw new HerdrTransportError('herdr_output_escaping', `.helm must be a real directory inside cwd`, target)
  }
  // realpath then re-verify: no intermediate symlink inside the directory may move the final path out of the cwd.
  const realHelm = await fs.realpath(helmDir)
  if (realHelm !== helmDir) {
    throw new HerdrTransportError('herdr_output_escaping', `.helm resolves outside cwd`, target)
  }
  return path.join(helmDir, fileName)
}

export async function readLocalOutput(cwd: string, fileName: string, signal: AbortSignal | undefined, target: string, redact: (s: string) => string): Promise<string> {
  const fs = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  checkAborted(signal, target)
  const path = await resolveLocalOutputPath(cwd, fileName, target)
  // Open with O_NOFOLLOW to converge TOCTOU: when lstat and readFile are separated, the file can be replaced
  // by a symlink escaping .helm within the window; reject symlinks at open time, then fstat+read from the same
  // handle (Windows has no O_NOFOLLOW; the post-read realpath recheck still anchors inside .helm).
  const noFollow = fs.constants.O_NOFOLLOW ?? 0
  let fh: Awaited<ReturnType<typeof fs.open>>
  try {
    fh = await fs.open(path, fs.constants.O_RDONLY | noFollow)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new HelmError('herdr_output_missing', `handoff file does not exist: ${path}`, 404)
    }
    if (code === 'ELOOP') {
      throw new HerdrTransportError('herdr_output_escaping', `output path is a symlink: ${path}`, target)
    }
    throw new HerdrTransportError('herdr_io', `failed to open output file: ${redact(String(err))}`, target, { cause: err })
  }
  try {
    const stat = await fh.stat()
    if (!stat.isFile()) {
      throw new HerdrTransportError('herdr_output_not_file', `output path is not a regular file: ${path}`, target)
    }
    if (stat.size > MAX_OUTPUT_BYTES) {
      throw new HerdrTransportError('herdr_output_too_large', `output exceeds ${MAX_OUTPUT_BYTES} bytes`, target)
    }
    const content = await fh.readFile('utf8')
    if (Buffer.byteLength(content, 'utf8') > MAX_OUTPUT_BYTES) {
      throw new HerdrTransportError('herdr_output_too_large', `output grew past limit while reading`, target)
    }
    if (!noFollow) {
      const real = await fs.realpath(path)
      if (!pathContains(await fs.realpath(dirname(path)), real)) {
        throw new HerdrTransportError('herdr_output_escaping', `output resolves outside .helm`, target)
      }
    }
    return content
  } finally {
    await fh.close().catch(() => {})
  }
}

export async function removeLocalOutput(cwd: string, fileName: string, signal: AbortSignal | undefined, target: string, redact: (s: string) => string): Promise<void> {
  const fs = await import('node:fs/promises')
  checkAborted(signal, target)
  let path: string
  try {
    path = await resolveLocalOutputPath(cwd, fileName, target)
  } catch (err) {
    // Missing directory/file: remove semantics are an idempotent no-op (consistent with the plugin's one self-heal boundary).
    if (err instanceof HelmError && err.code === 'herdr_output_missing') return
    throw err
  }
  try {
    const stat = await fs.lstat(path)
    if (!stat.isFile()) {
      throw new HerdrTransportError('herdr_output_not_file', `output path is not a regular file: ${path}`, target)
    }
    await fs.unlink(path)
  } catch (err) {
    if (err instanceof HerdrTransportError || err instanceof HelmError) throw err
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new HerdrTransportError('herdr_io', `failed to remove output file: ${redact(String(err))}`, target, { cause: err })
  }
}

/**
 * The pure path rules for the target path's shape (independent of the Hub process platform):
 * Windows shape (drive letter or UNC `\\server\\share`) uses win32 rules; the rest use POSIX.
 */
function pathRulesFor(path: string): typeof posix | typeof win32 {
  return isWindowsShapedPath(path) ? win32 : posix
}

/** Windows path shape: drive letter (C:\\ or C:/) or UNC (\\server\\share). Pure rule check. */
export function isWindowsShapedPath(path: string): boolean {
  return /^([A-Za-z]:[\\/]|\\\\[^\\])/.test(path)
}

/** Whether a path is absolute (POSIX `/` or Windows drive/UNC; rejects `C:relative`). Pure rule. */
export function isAbsoluteAnyPath(path: string): boolean {
  return isWindowsShapedPath(path) ? win32.isAbsolute(path) : posix.isAbsolute(path)
}

/**
 * Cross-platform safe containment: child must equal root or live under root (normalized comparison,
 * no extra directory separators -- when root is `/`, `/foo` is legally contained, `//foo` yields nothing extra).
 * Both root and child are already canonically resolved paths (guaranteed by the caller).
 */
export function pathContains(root: string, child: string): boolean {
  if (root === child) return true
  const rules = pathRulesFor(root)
  const rootPrefix = root.endsWith(rules.sep) ? root.slice(0, -1) : root
  return child.startsWith(rootPrefix + rules.sep)
}

/**
 * Remote node output directory resolution (the same safety boundary as local resolveLocalOutputPath):
 * - the cwd picks win32/posix pure rules by its own path shape to join `<cwd>/.helm` (the Hub's
 *   node:path.join would split Windows paths per the Hub platform -- a Linux Hub treats `\\` as an
 *   ordinary character producing a wrong directory name, a Windows Hub shreds a POSIX cwd);
 * - the cwd is validated really resolvable via env.canonicalPath (unreachable = invalid_cwd);
 * - `<realCwd>/.helm` must be a real directory (missing = the 404 self-heal boundary; symlink/non-directory = escape rejection);
 * - after canonicalization it must still fall inside realCwd (pathContains; intermediate symlinks intercepted).
 */
async function resolveNodeOutputDir(
  env: HerdrNodeEnv,
  cwd: string,
  target: string,
  context: Context,
): Promise<{ realCwd: string; realHelm: string }> {
  const rules = pathRulesFor(cwd)
  const canonicalCwd = await env.canonicalPath(cwd, context)
  if (!canonicalCwd.ok) {
    throw new HerdrTransportError(
      'herdr_invalid_cwd',
      `cwd not accessible on node: ${canonicalCwd.error.code}: ${canonicalCwd.error.message}`,
      target,
      { cause: new Error(canonicalCwd.error.message) },
    )
  }
  const realCwd = canonicalCwd.value
  const helmDir = rules.join(realCwd, '.helm')
  const helmInfo = await env.fileInfo(helmDir, context)
  if (!helmInfo.ok) {
    const code = helmInfo.error.code
    if (code === 'not_found' || code === 'not_directory') {
      // Missing directory = missing handoff file: read reports 404, remove is idempotent (the one self-heal boundary).
      throw new HelmError('herdr_output_missing', `handoff directory does not exist: ${helmDir}`, 404)
    }
    throw new HerdrTransportError(
      'herdr_io',
      `failed to inspect ${helmDir}: ${code}: ${helmInfo.error.message}`,
      target,
    )
  }
  if (helmInfo.value.kind === 'symlink' || helmInfo.value.kind !== 'directory') {
    throw new HerdrTransportError('herdr_output_escaping', `.helm must be a real directory inside cwd`, target)
  }
  const canonicalHelm = await env.canonicalPath(helmDir, context)
  if (!canonicalHelm.ok) {
    throw new HerdrTransportError('herdr_io', `failed to resolve ${helmDir}: ${canonicalHelm.error.message}`, target)
  }
  const realHelm = canonicalHelm.value
  if (!pathContains(realCwd, realHelm)) {
    throw new HerdrTransportError('herdr_output_escaping', `.helm resolves outside cwd`, target)
  }
  return { realCwd, realHelm }
}

export async function readNodeOutput(
  nodeChannel: HerdrNodeChannel,
  nodeId: string,
  target: HerdrTarget,
  targetLabel: string,
  cwd: string,
  fileName: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const context = contextOf(signal, targetLabel)
  const env = nodeChannel.envFor(nodeId, cwd)
  const { realHelm } = await resolveNodeOutputDir(env, cwd, targetLabel, context)
  const filePath = pathRulesFor(realHelm).join(realHelm, fileName)
  const info = await env.fileInfo(filePath, context)
  if (!info.ok) {
    if (info.error.code === 'not_found') {
      throw new HelmError('herdr_output_missing', `handoff file does not exist: ${filePath}`, 404)
    }
    throw new HerdrTransportError('herdr_io', `failed to inspect output file: ${info.error.code}: ${info.error.message}`, targetLabel)
  }
  if (info.value.kind !== 'file') {
    throw new HerdrTransportError('herdr_output_not_file', `output path is not a regular file: ${filePath}`, targetLabel)
  }
  if (info.value.size > MAX_OUTPUT_BYTES) {
    throw new HerdrTransportError('herdr_output_too_large', `output exceeds ${MAX_OUTPUT_BYTES} bytes`, targetLabel)
  }
  const content = await env.readTextFile(filePath, context)
  if (!content.ok) {
    throw new HerdrTransportError('herdr_io', `failed to read output file: ${content.error.code}: ${content.error.message}`, targetLabel)
  }
  // Post-read canonical recheck (TOCTOU convergence): between fileInfo (lstat) and readTextFile (follows
  // symlinks) the file can be replaced by a symlink escaping .helm; the node env has no O_NOFOLLOW semantics,
  // so realpath rechecks that the actually read path still anchors inside realHelm (content already read but never returned).
  const canonical = await env.canonicalPath(filePath, context)
  if (!canonical.ok) {
    throw new HerdrTransportError('herdr_io', `failed to resolve ${filePath}: ${canonical.error.message}`, targetLabel)
  }
  if (!pathContains(realHelm, canonical.value)) {
    throw new HerdrTransportError('herdr_output_escaping', `output resolves outside .helm`, targetLabel)
  }
  if (Buffer.byteLength(content.value, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new HerdrTransportError('herdr_output_too_large', `output grew past limit while reading`, targetLabel)
  }
  return content.value
}

export async function removeNodeOutput(
  nodeChannel: HerdrNodeChannel,
  nodeId: string,
  targetLabel: string,
  cwd: string,
  fileName: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const context = contextOf(signal, targetLabel)
  const env = nodeChannel.envFor(nodeId, cwd)
  let realHelm: string
  try {
    realHelm = (await resolveNodeOutputDir(env, cwd, targetLabel, context)).realHelm
  } catch (err) {
    // Missing directory: remove is an idempotent no-op (consistent with local semantics).
    if (err instanceof HelmError && err.code === 'herdr_output_missing') return
    throw err
  }
  const filePath = pathRulesFor(realHelm).join(realHelm, fileName)
  const info = await env.fileInfo(filePath, context)
  if (!info.ok) {
    if (info.error.code === 'not_found') return // missing file: idempotent
    throw new HerdrTransportError('herdr_io', `failed to inspect output file: ${info.error.code}: ${info.error.message}`, targetLabel)
  }
  if (info.value.kind !== 'file') {
    throw new HerdrTransportError('herdr_output_not_file', `output path is not a regular file: ${filePath}`, targetLabel)
  }
  const removed = await env.remove(filePath, { force: true }, context)
  if (!removed.ok) {
    throw new HerdrTransportError('herdr_io', `failed to remove output file: ${removed.error.code}: ${removed.error.message}`, targetLabel)
  }
}
