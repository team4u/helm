/**
 * library-store.ts -- the file library of saved workflows (an internal module split out of WorkflowService).
 *
 * <dataDir>/workflows/<name>.js is the single source of truth:
 * - name safety (SAFE_NAME guards path traversal) + symlink-escape rejection (realpath must resolve
 *   back to the same-name position inside the workflows directory);
 * - overwrite refused by default (409 workflow_already_exists); atomic writes (temp file in the same
 *   directory + fsync; creation claims the path atomically via link, overwrite swaps atomically via rename);
 * - save(fromRunId) resolves script sources via the injected loadRunRecord callback into the run store.
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { HelmError } from '@helm/protocol'
import type {
  SavedWorkflowDetail,
  SavedWorkflowSummary,
  WorkflowDeleteResult,
  WorkflowSaveRequest,
  WorkflowSaveResult,
} from '../../contracts.js'
import { extractMeta, hasMetaDeclaration, type WorkflowMeta } from './meta.js'
import { MAX_SCRIPT_LENGTH, precheckScriptSyntax } from './runtime.js'

/** Safe name for a saved workflow: starts alphanumeric, limited to [A-Za-z0-9._-], guarding path traversal. */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Real file facts (mtime ms + byte size); read failures throw io_error explicitly. */
export function fileStatsOf(path: string): { updatedAt: number; size: number } {
  try {
    const stats = statSync(path)
    return { updatedAt: Math.trunc(stats.mtimeMs), size: stats.size }
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    throw new HelmError('io_error', `cannot read file facts ${path}: ${err.message}`, 500, {
      path,
      code: err.code,
    })
  }
}

/** Metadata corruption of a single script does not block the whole directory; keep the entry and return diagnostics. */
function summaryFromSource(
  name: string,
  path: string,
  source: string,
  stats: { updatedAt: number; size: number },
): SavedWorkflowSummary {
  try {
    const { meta } = extractMeta(source)
    return {
      name,
      path,
      updatedAt: stats.updatedAt,
      size: stats.size,
      description: meta.description,
      ...(meta.whenToUse !== undefined ? { whenToUse: meta.whenToUse } : {}),
      ...(meta.phases !== undefined ? { phases: meta.phases } : {}),
    }
  } catch (error) {
    return { name, path, updatedAt: stats.updatedAt, size: stats.size, metadataError: error instanceof Error ? error.message : String(error) }
  }
}

/** The persisted-record slice needed by save(fromRunId) to resolve script sources (compatible with the run store's RunRecord). */
export interface RunScriptSourceRecord {
  kind?: 'workflow' | 'subagent'
  script?: string
  scriptPath?: string
}

export interface WorkflowLibraryOptions {
  dataDir: string
  /** Run-record read slice (not_found etc. thrown as-is by the run store). */
  loadRunRecord(runId: string): RunScriptSourceRecord
}

export class WorkflowLibrary {
  private readonly dataDir: string
  private readonly loadRunRecord: (runId: string) => RunScriptSourceRecord

  constructor(options: WorkflowLibraryOptions) {
    this.dataDir = options.dataDir
    this.loadRunRecord = options.loadRunRecord
  }

  workflowsDir(): string {
    return join(this.dataDir, 'workflows')
  }

  /** List workflow scripts with meta declarations; invalid meta attaches metadataError; file read errors fail explicitly. */
  list(): SavedWorkflowSummary[] {
    const dir = this.workflowsDir()
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      // Directory not yet present: an empty list is the fact, not a degradation.
      if (err.code === 'ENOENT') return []
      throw new HelmError('io_error', `cannot read the workflows directory ${dir}: ${err.message}`, 500, {
        path: dir,
        code: err.code,
      })
    }
    const out: SavedWorkflowSummary[] = []
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.js')) continue
      const name = entry.slice(0, -3)
      if (!SAFE_NAME.test(name)) continue
      const path = join(dir, entry)
      let source: string
      try {
        source = readFileSync(path, 'utf-8')
      } catch (error) {
        const err = error as NodeJS.ErrnoException
        // The list is a best-effort directory view: a single unreadable file is skipped but not concealed.
        if (err.code === 'ENOENT') continue
        throw new HelmError('io_error', `cannot read workflow script ${path}: ${err.message}`, 500, {
          path,
          code: err.code,
        })
      }
      // Plain non-workflow .js files (build artifacts, drafts) must not appear in the list.
      if (!hasMetaDeclaration(source)) continue
      const stats = fileStatsOf(path)
      out.push(summaryFromSource(name, path, source, stats))
    }
    return out
  }

  /** Read a saved workflow's full definition (read-only source + metadata + real file facts). */
  get(name: string): SavedWorkflowDetail {
    const path = this.resolveSavedName(name)
    const source = this.readScriptFile(path)
    const stats = fileStatsOf(path)
    return { ...summaryFromSource(name, path, source, stats), script: source }
  }

  /**
   * Save a workflow definition (exactly one of script / fromRunId):
   * - strict boundary validation + validateScript's full checks + the pure syntax precheck with the
   *   worker's exact shape (compile-only, zero side effects);
   * - name safety (SAFE_NAME guards path traversal); an explicit name disagreeing with meta.name is rejected;
   * - overwrite refused by default (409 workflow_already_exists); only overwrite: true overwrites;
   * - atomic write: temp file in the same directory + fsync; creation claims the path atomically via
   *   link (exactly one of concurrent same-name creations succeeds), overwrite swaps atomically via rename;
   * - symlink-escape defense: when the target exists, its realpath must still be at the same-name position inside the workflows directory.
   */
  save(request: WorkflowSaveRequest): WorkflowSaveResult {
    const sources = [request.script, request.fromRunId].filter((v) => v !== undefined)
    if (sources.length !== 1) {
      throw new HelmError(
        'validation_error',
        'save requires exactly one of script or fromRunId',
        400,
        { provided: sources.length },
      )
    }

    let script: string
    if (request.script !== undefined) {
      script = request.script
    } else {
      const record = this.loadRunRecord(request.fromRunId!)
      if (record.kind === 'subagent') {
        throw new HelmError(
          'validation_error',
          `run ${request.fromRunId} is a background subagent with no workflow script to save`,
          400,
          { runId: request.fromRunId, kind: 'subagent' },
        )
      }
      if (record.script !== undefined) {
        script = record.script
      } else if (record.scriptPath !== undefined) {
        script = this.readScriptFile(record.scriptPath)
      } else {
        throw new HelmError(
          'validation_error',
          `run ${request.fromRunId} persisted no script source (no inline script or scriptPath); cannot save`,
          400,
          { runId: request.fromRunId },
        )
      }
    }

    let meta: WorkflowMeta
    try {
      meta = precheckScriptSyntax(script).meta
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new HelmError('workflow_script_invalid', `workflow script validation failed: ${message}`, 400)
    }

    const name = request.name ?? meta.name
    if (!SAFE_NAME.test(name)) {
      throw new HelmError(
        'validation_error',
        `workflow name "${name}" is invalid: must match ${SAFE_NAME.source} (path-traversal guard)`,
        400,
        { name },
      )
    }
    if (request.name !== undefined && request.name !== meta.name) {
      throw new HelmError(
        'validation_error',
        `save name ${request.name} disagrees with the script's meta.name "${meta.name}"; unify the names first`,
        400,
        { name: request.name, metaName: meta.name },
      )
    }

    const dir = this.workflowsDir()
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${name}.js`)
    const existing = this.savedEntryStats(name, target)
    if (existing !== undefined && request.overwrite !== true) {
      throw new HelmError(
        'workflow_already_exists',
        `a workflow named ${name} already exists (${target}); overwrite: true is required to overwrite`,
        409,
        { name, path: target },
      )
    }

    // Atomic write: temp file in the same directory + fsync; creation claims via link (exactly one
    // concurrent creation succeeds), overwrite swaps via rename. Temp file names don't end in .js, so they never leak into list().
    const tmp = join(dir, `.save-${name}-${randomUUID()}.tmp`)
    try {
      const fd = openSync(tmp, 'wx', 0o644)
      try {
        writeSync(fd, script, null, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      if (existing === undefined) {
        try {
          linkSync(tmp, target)
        } catch (error) {
          const err = error as NodeJS.ErrnoException
          if (err.code === 'EEXIST') {
            throw new HelmError(
              'workflow_already_exists',
              `a workflow named ${name} already exists (a concurrent write created it first); overwrite: true is required to overwrite`,
              409,
              { name, path: target },
            )
          }
          throw error
        }
        unlinkSync(tmp)
      } else {
        renameSync(tmp, target)
      }
    } catch (error) {
      // Temp-file cleanup is best-effort: cleanup failures are not part of the business result (tmp never leaks into list).
      try {
        unlinkSync(tmp)
      } catch {
        // already consumed by rename/link, or never existed
      }
      if (error instanceof HelmError) throw error
      const err = error as NodeJS.ErrnoException
      throw new HelmError('io_error', `failed to write workflow definition ${target}: ${err.message}`, 500, {
        path: target,
        code: err.code,
      })
    }

    // Real summary: re-read facts from the real fs after saving (never return a fake status assembled from inputs).
    const written = fileStatsOf(target)
    return {
      created: existing === undefined,
      workflow: summaryFromSource(name, target, script, written),
    }
  }

  /** Delete a saved workflow definition file (historical run records unaffected; explicit 404 when absent). */
  delete(name: string): WorkflowDeleteResult {
    if (!SAFE_NAME.test(name)) {
      throw new HelmError(
        'validation_error',
        `workflow name "${name}" is invalid: must match ${SAFE_NAME.source} (path-traversal guard)`,
        400,
        { name },
      )
    }
    const dir = this.workflowsDir()
    const target = join(dir, `${name}.js`)
    let entry: ReturnType<typeof lstatSync>
    try {
      entry = lstatSync(target)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        throw new HelmError('not_found', `workflow ${name} does not exist`, 404, { name, path: target })
      }
      throw new HelmError('io_error', `cannot read workflow definition entry ${target}: ${err.message}`, 500, {
        path: target,
        code: err.code,
      })
    }
    // Symlink: realpath must resolve back to the same-name position inside the workflows directory
    // (anything outside is refused -- delete neither the target nor the link itself: an existing link means the
    if (entry.isSymbolicLink()) {
      const real = realpathSync(target)
      const expected = join(realpathSync(dir), `${name}.js`)
      if (real !== expected) {
        throw new HelmError(
          'validation_error',
          `workflow "${name}" is a symlink pointing outside the directory (${real}); deletion refused`,
          400,
          { name, real },
        )
      }
    } else if (!entry.isFile()) {
      throw new HelmError(
        'validation_error',
        `workflow definition entry ${target} is not a regular file; deletion refused`,
        400,
        { name, path: target },
      )
    }
    try {
      unlinkSync(target)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      throw new HelmError('io_error', `failed to delete workflow definition ${target}: ${err.message}`, 500, {
        path: target,
        code: err.code,
      })
    }
    return { deleted: true, name, path: target }
  }

  /**
   * Existing-entry check for the save target: return real file facts, or undefined (absent).
   * Symlinks pointing outside the directory (same realpath check as resolveSavedName) are always refused.
   */
  private savedEntryStats(name: string, target: string): { updatedAt: number; size: number } | undefined {
    try {
      // resolveSavedName returns the path itself for absent targets and explicitly rejects out-of-dir symlinks.
      const resolved = this.resolveSavedName(name)
      const stats = statSync(resolved)
      if (!stats.isFile()) {
        throw new HelmError(
          'validation_error',
          `workflow definition entry ${target} is not a regular file; cannot overwrite`,
          400,
          { name, path: target },
        )
      }
      return { updatedAt: Math.trunc(stats.mtimeMs), size: stats.size }
    } catch (error) {
      if (error instanceof HelmError) throw error
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return undefined
      throw new HelmError('io_error', `cannot stat workflow definition entry ${target}: ${err.message}`, 500, {
        path: target,
        code: err.code,
      })
    }
  }

  resolveSavedName(name: string): string {
    if (!SAFE_NAME.test(name)) {
      throw new HelmError(
        'validation_error',
        `workflow name "${name}" is invalid: must match ${SAFE_NAME.source} (path-traversal guard)`,
        400,
        { name },
      )
    }
    // SAFE_NAME already excludes '/', but a symlink could re-point the name outside the directory:
    // realpath validates the resolved real path still stays inside the workflows directory.
    const dir = this.workflowsDir()
    const target = join(dir, `${name}.js`)
    try {
      const real = realpathSync(target)
      const realDir = realpathSync(dir)
      if (real !== join(realDir, `${name}.js`)) {
        throw new HelmError(
          'validation_error',
          `workflow "${name}" is a symlink pointing outside the directory (${real}); refused`,
          400,
          { name, real },
        )
      }
      return target
    } catch (error) {
      if (error instanceof HelmError) throw error
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return target // absent: readScriptFile reports not_found
      throw new HelmError('io_error', `cannot resolve workflow path ${target}: ${err.message}`, 500, {
        path: target,
        code: err.code,
      })
    }
  }

  resolveExplicitPath(scriptPath: string): string {
    // Explicit user file path: use it if readable; no sandbox promise (consistent with docs).
    return resolve(scriptPath)
  }

  readScriptFile(path: string): string {
    let source: string
    try {
      const st = statSync(path)
      if (!st.isFile()) {
        throw new HelmError('not_found', `workflow script is not a regular file: ${path}`, 404, { path })
      }
      source = readFileSync(path, 'utf-8')
    } catch (error) {
      if (error instanceof HelmError) throw error
      const err = error as NodeJS.ErrnoException
      throw new HelmError('not_found', `workflow script file unreadable (${err.code ?? 'unknown'}): ${path}`, 404, {
        path,
        code: err.code,
      })
    }
    if (source.length > MAX_SCRIPT_LENGTH) {
      throw new HelmError(
        'validation_error',
        `workflow script is ${source.length} chars, over the cap of ${MAX_SCRIPT_LENGTH}`,
        400,
        { path },
      )
    }
    return source
  }

  /** Extract the full meta (falls back to undefined; full validation lives in the engine's validateScript). */
  peekMeta(script: string): WorkflowMeta | undefined {
    try {
      return extractMeta(script).meta
    } catch {
      return undefined
    }
  }
}
