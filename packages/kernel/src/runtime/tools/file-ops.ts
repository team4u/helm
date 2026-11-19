/**
 * Kernel built-in file tools (`read` / `write` / `edit`): target conversation `(nodeId, cwd)`, converging
 * local and remote branches via `file-env.ts` unified execution adapters into a single template (equivalent
 * behavior; shares bash permission boundaries without cwd sandboxing, deferring to OS permissions).
 *
 * `read`: regular files only (directories/special files rejected; 128 KiB single-file cap); structured
 * `path` echoes resolved real absolute path (lexical absolute locally, canonical remotely).
 *
 * `write`/`edit`: writes text and performs exact replacement (`oldText` must match uniquely; `newText` is
 * written literally without interpreting `String.replace`'s `$&` tokens). Existing targets resolve via
 * `canonicalPath`/`realpath` so symlink writes hit real files and align mutex keys; new files write at lexical
 * absolute paths; read-modify-write windows share per-node canonical path mutexes via `env/file-mutation-queue`
 * with plugin APIs. On success, `edit` computes real line-level diffs inside the lock prior to writing
 * (sole implementation in `runtime/tool-edit-diff.ts`; matches `@helmx/protocol` `EDIT_TOOL_RESULT_SCHEMA`).
 */
import type { JsonValue } from '@earendil-works/chord/json'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { bool, obj, opt, str } from '@earendil-works/pi-schema'
import { EDIT_TOOL_RESULT_SCHEMA, isAbsoluteTargetPath, type EditToolResult } from '@helmx/protocol'
import { computeEditDiff } from '../tool-edit-diff.js'
import { targetPlatformForNode } from '../target-platform.js'
import { throwIfToolAborted, type HelmxToolDeps } from '../tool-deps.js'
import { cwdScopeViolationText } from './cwd-scope.js'
import { resolveTargetPath } from './target-path.js'
import { resolveToolTarget } from './tool-target.js'
import {
  basenameForShape,
  dirnameForShape,
  readableEnvFor,
  resolveWritableTarget,
  writableEnvFor,
} from './file-env.js'

const readParameters = obj({
  path: str({ description: 'File path (relative to conversation cwd or absolute; supports ../ traversal)' }),
})

/**
 * `read` tool: reads text files on conversation `(nodeId, cwd)`. `cwd` is base only for relative paths;
 * absolute paths and `../` traversals are permitted (matching `bash`). Supports regular files only up to
 * 128 KiB; resolves symlinks remotely via `canonicalPath` before `fileInfo` (`lstat` semantics).
 */
export function createReadTool(deps: HelmxToolDeps): ToolRegistration<typeof readParameters> {
  return defineTool({
    name: 'read',
    // Pure read-only with deterministic callId spill slots: safe to replay after interruption.
    replay: 'safe',
    description:
      'Read text file content. Paths resolve relative to conversation cwd and support absolute paths and ../ traversal (same as bash); ' +
      'supports regular files only up to 128 KiB (for larger output, use bash + paginated read_artifact); reads from the target node when bound remotely.',
    parameters: readParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Actual resolved absolute path read (canonicalized remotely; not raw input)' },
        nodeId: { type: 'string', description: 'Node where file was read' },
        content: { type: 'string' },
      },
      required: ['path', 'nodeId', 'content'],
    },
    async execute(args, api, context) {
      const raw = args.path
      const agent = await api.agent(context)
      // Resolve path using target shape of conversation cwd (POSIX/Windows), never Hub host's default `node:path`
      // (`resolve('C:\\x')` on Linux Hub produces broken paths); `agent()` and tool share SDK Context for cancellation.
      const sessionId = agent.cwd ?? deps.defaultCwd
      const nodeId = deps.nodeIdOf?.(api.conversationId as number) ?? 'local'
      // Platform-aware resolution (shares exact platform source with bash): preserves existing shape rules when remote
      // platform is unknown without guessing; deterministically normalizes POSIX views on win32 and rejects unmappable roots.
      const platformInfo = targetPlatformForNode(deps.envFabric, nodeId)
      if (!isAbsoluteTargetPath(sessionId)) {
        return {
          output: [
            { type: 'text', text: `read_failed: conversation cwd is not an absolute path (${sessionId}); read rejected` },
          ],
          isError: true,
        }
      }
      const resolvedR = resolveTargetPath(
        raw,
        sessionId,
        platformInfo.known ? platformInfo.platform : undefined,
      )
      if (!resolvedR.ok) {
        return { output: [{ type: 'text', text: `invalid_path: ${resolvedR.reason}` }], isError: true }
      }
      const lexicalAbs = resolvedR.abs
      // Profile.restrictToCwd guardrail: lexical escapes (absolute paths / ../) reject before any IO.
      if (
        deps.restrictToCwdOf !== undefined &&
        (await deps.restrictToCwdOf(api.conversationId as number)) === true
      ) {
        const violation = cwdScopeViolationText(
          raw,
          sessionId,
          platformInfo.known ? platformInfo.platform : undefined,
        )
        if (violation !== undefined) {
          return { output: [{ type: 'text', text: violation }], isError: true }
        }
      }
      try {
        // Unified execution env: remote (pre-guards fail explicitly on missing EnvFabric/offline, never falling back locally)
        // and local (`node:fs` + fd verification) share the same read template.
        const envR = readableEnvFor(deps, nodeId, sessionId)
        if ('error' in envR) {
          throwIfToolAborted(context.abortSignal)
          return { output: [{ type: 'text', text: envR.error }], isError: true }
        }
        const readR = await envR.env.readText(lexicalAbs, raw, context)
        if (!readR.ok) {
          throwIfToolAborted(context.abortSignal)
          return { output: [{ type: 'text', text: readR.errorText }], isError: true }
        }
        const content = deps.redact(readR.content)
        // Prevent writing meaningless spill artifacts during shutdown/cancellation windows.
        throwIfToolAborted(context.abortSignal)
        const spill = await deps.artifacts.spill(
          api.conversationId as number,
          `read-${api.callId}`,
          content,
        )
        const structured = { path: readR.displayPath, nodeId, content: spill.text } as JsonValue
        return {
          output: [{ type: 'text', text: spill.text }],
          structuredOutput: structured,
          // `details` persists to SDK toolResult UI channel (`structuredOutput` is unpersisted for embedded callers);
          // omit `content` here since text channel already holds it, avoiding double writes.
          details: { path: readR.displayPath, nodeId } as JsonValue,
        }
      } catch (error) {
        throwIfToolAborted(context.abortSignal)
        return {
          output: [{ type: 'text', text: `read_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
    },
  })
}

const writeParameters = obj({
  path: str({ description: 'Target file path (relative to conversation cwd or absolute; supports ../ traversal, creates missing files/directories)' }),
  content: str({ description: 'UTF-8 text content to write (replaces entire file)' }),
  artifact: opt(
    bool({
      description:
        'Whether to also register as a conversation artifact (visible/previewable/downloadable in Web UI; outputs [Artifact] id=<id> so replies can link [filename](artifact:<id>) or ![caption](artifact:<id>))',
    }),
  ),
})

/** Shared `write`/`edit` error/status messages (unique-match validation inside mutex; shared local/remote).
 * Note: `'node ${nodeId}'` format is preserved for test compatibility (`'node local'`). */
const editTextNotFound = (abs: string): string => `edit_failed: oldText was not found in ${abs} (edit rejected)`
const editTextNotUnique = (abs: string, count: number): string =>
  `edit_failed: oldText appeared ${count} times in ${abs} (must match uniquely; include more surrounding context)`
const editOkText = (abs: string, nodeId: string): string => `edit_ok: ${abs} (node ${nodeId}, replaced 1 occurrence)`

/** `write` tool: writes UTF-8 text files on conversation `(nodeId, cwd)` (shares path/permission boundary with `bash`). */
export function createWriteTool(deps: HelmxToolDeps): ToolRegistration<typeof writeParameters> {
  return defineTool({
    name: 'write',
    description:
      'Write a UTF-8 text file (overwriting any existing content). Paths resolve relative to conversation cwd and support absolute paths and ../ traversal (same as bash), ' +
      'creating parent directories automatically; writes on the target node when bound remotely. Files are written to disk only by default (hidden in Web UI); pass artifact: true to also register as a conversation artifact for Web preview/download and reference via [filename](artifact:<id>) or ![title](artifact:<id>).',
    parameters: writeParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Actual resolved absolute path written (canonicalized if pre-existing; not raw input)' },
        nodeId: { type: 'string', description: 'Node where file was written' },
        bytesWritten: { type: 'number' },
        artifactId: { type: 'string' },
      },
      required: ['path', 'nodeId', 'bytesWritten'],
    },
    async execute(args, api, context) {
      const target0 = await resolveToolTarget(deps, api, context)
      if ('error' in target0) {
        return { output: [{ type: 'text', text: `write_failed: ${target0.error}` }], isError: true }
      }
      const { nodeId, base, platform } = target0
      // Profile.restrictToCwd guardrail: lexical escapes (absolute paths / ../) reject before any IO or dir creation.
      if (
        deps.restrictToCwdOf !== undefined &&
        (await deps.restrictToCwdOf(api.conversationId as number)) === true
      ) {
        const violation = cwdScopeViolationText(args.path, base, platform)
        if (violation !== undefined) {
          return { output: [{ type: 'text', text: violation }], isError: true }
        }
      }
      try {
        const onWriteSuccess = async (targetAbs: string, bytes: number) => {
          if (args.artifact === true) {
            if (deps.artifacts.writeUploaded === undefined) {
              return {
                output: [
                  {
                    type: 'text' as const,
                    text: 'write_failed: artifact service does not support writeUploaded; cannot register conversation artifact',
                  },
                ],
                isError: true,
              }
            }
            const fileName = basenameForShape(targetAbs)
            const meta = await deps.artifacts.writeUploaded(api.conversationId as number, {
              name: fileName,
              bytes: Buffer.from(args.content, 'utf8'),
            })
            return {
              output: [
                {
                  type: 'text' as const,
                  text: `write_ok: ${targetAbs} (node ${nodeId}, ${bytes} bytes)\n[Artifact] id=${meta.id} name=${meta.name}`,
                },
              ],
              structuredOutput: {
                path: targetAbs,
                nodeId,
                bytesWritten: bytes,
                artifactId: meta.id,
              } as JsonValue,
              details: { path: targetAbs, nodeId, bytesWritten: bytes, artifactId: meta.id } as JsonValue,
            }
          }
          return {
            output: [
              { type: 'text' as const, text: `write_ok: ${targetAbs} (node ${nodeId}, ${bytes} bytes)` },
            ],
            structuredOutput: { path: targetAbs, nodeId, bytesWritten: bytes } as JsonValue,
            details: { path: targetAbs, nodeId, bytesWritten: bytes } as JsonValue,
          }
        }

        // Unified execution env: remote (explicit failure on missing EnvFabric/offline, never falls back locally)
        // and local share the exact same write template.
        const envR = writableEnvFor(deps, nodeId, base, 'write')
        if ('error' in envR) {
          return { output: [{ type: 'text', text: envR.error }], isError: true }
        }
        const target = await resolveWritableTarget(envR.env.canonicalProbe, args.path, base, platform, context)
        if (!target.ok) {
          return { output: [{ type: 'text', text: target.message }], isError: true }
        }
        const bytes = Buffer.byteLength(args.content, 'utf8')
        // Mutex queue serializes read-modify-write windows across tools and plugins (see `env/file-mutation-queue.ts`);
        // creates missing parent directories recursively using target path shape rules (`win32` backslash separators).
        return await envR.env.withMutationQueue(target.abs, async () => {
          await envR.env.ensureDir(dirnameForShape(target.abs), context)
          await envR.env.writeFile(target.abs, args.content, context)
          return await onWriteSuccess(target.abs, bytes)
        }, context)
      } catch (error) {
        return {
          output: [{ type: 'text', text: `write_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
    },
  })
}

const editParameters = obj({
  path: str({ description: 'Target file path (relative to conversation cwd or absolute; supports ../ traversal)' }),
  oldText: str({ description: 'Exact text to replace (must occur uniquely once in the file)' }),
  newText: str({ description: 'Replacement text' }),
})

/** Count non-overlapping occurrences (used for `edit` unique-match check). */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * `edit` tool: exact text replacement. `oldText` must match uniquely once in the target file (fails loudly
 * when missing or ambiguous, never fuzzy-matching or skipping); `newText` is substituted literally (ignoring
 * `$&` replacement patterns so behavior matches diff calculation). Shares path/permission boundary with `write`
 * and `bash`. Structured output conforms to `@helmx/protocol` `EditToolResult` and mirrors to `details` (persisted
 * for Web diff rendering while `structuredOutput` feeds embedded callers). Diff runs inside the canonical mutex
 * lock prior to writing (if `computeEditDiff` throws, returns `edit_failed` without modifying the file).
 */
export function createEditTool(deps: HelmxToolDeps): ToolRegistration<typeof editParameters> {
  return defineTool({
    name: 'edit',
    description:
      'Replace an exact text snippet in a file. oldText must occur uniquely once (errors if missing or non-unique); ' +
      'paths resolve relative to conversation cwd and support absolute paths and ../ traversal (same as bash); reads and writes back on the target node when bound remotely.',
    parameters: editParameters,
    structuredOutputSchema: EDIT_TOOL_RESULT_SCHEMA,
    async execute(args, api, context) {
      const target0 = await resolveToolTarget(deps, api, context)
      if ('error' in target0) {
        return { output: [{ type: 'text', text: `edit_failed: ${target0.error}` }], isError: true }
      }
      const { nodeId, base, platform } = target0
      // Profile.restrictToCwd guardrail: lexical escapes (absolute paths / ../) reject before any IO.
      if (
        deps.restrictToCwdOf !== undefined &&
        (await deps.restrictToCwdOf(api.conversationId as number)) === true
      ) {
        const violation = cwdScopeViolationText(args.path, base, platform)
        if (violation !== undefined) {
          return { output: [{ type: 'text', text: violation }], isError: true }
        }
      }
      try {
        // Unified execution env: remote (explicit failure on missing EnvFabric/offline, never falls back locally)
        // and local share the exact same read-modify-write template.
        const envR = writableEnvFor(deps, nodeId, base, 'edit')
        if ('error' in envR) {
          return { output: [{ type: 'text', text: envR.error }], isError: true }
        }
        const target = await resolveWritableTarget(envR.env.canonicalProbe, args.path, base, platform, context)
        if (!target.ok) {
          return { output: [{ type: 'text', text: target.message }], isError: true }
        }
        // Mutex queue covers the entire read-modify-write window so concurrent mutations cannot interleave.
        return await envR.env.withMutationQueue(target.abs, async () => {
          const content = await envR.env.readTextFile(target.abs, context)
          const count = countOccurrences(content, args.oldText)
          if (count === 0) {
            return {
              output: [{ type: 'text', text: editTextNotFound(target.abs) }],
              isError: true,
            }
          }
          if (count > 1) {
            return {
              output: [{ type: 'text', text: editTextNotUnique(target.abs, count) }],
              isError: true,
            }
          }
          const matchOffset = content.indexOf(args.oldText)
          // Literal replacement (ignore `$&` replacement patterns): same exact string drives content and diff computation.
          const updated =
            content.slice(0, matchOffset) +
            args.newText +
            content.slice(matchOffset + args.oldText.length)
          // Compute diff under lock before writing (pure function; throws cleanly without touching disk).
          const diff = computeEditDiff(
            content,
            updated,
            matchOffset,
            args.oldText.length,
            deps.redact,
          )
          await envR.env.writeFile(target.abs, updated, context)
          const structured = {
            path: target.abs,
            nodeId,
            replaced: true,
            diff,
          } satisfies EditToolResult as unknown as JsonValue
          return {
            output: [{ type: 'text', text: editOkText(target.abs, nodeId) }],
            structuredOutput: structured,
            // Web timeline diff UI reads persisted `details` (`structuredOutput` isn't persisted); both channels
            // carry identical values against the single `EDIT_TOOL_RESULT_SCHEMA` contract.
            details: structured,
          }
        }, context)
      } catch (error) {
        return {
          output: [{ type: 'text', text: `edit_failed: ${deps.redact(String(error))}` }],
          isError: true,
        }
      }
    },
  })
}
