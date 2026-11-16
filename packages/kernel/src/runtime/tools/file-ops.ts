/**
 * kernel local machine file tool (read / write / edit): by conversation (nodeId, cwd) target execute,
 * local and remote branch via file-env.ts unify execute environment adapt converge is single one template
 * (behavior etc. price heavy construct; path and bash same right, do not set cwd sandbox, permission boundary hand over to OS).
 *
 * read: only support ordinary file (directory/special file reject, single file 128KiB cap); structure
 * path back visible real target absolute path (local is term method absolute path, remote is canonical).
 *
 * write/edit: write text and precise replace (oldText unique match validate;newText by literal write,
 * do not explain String.replace  $& system replace pattern); target already exists when via canonicalPath/
 * realpath parse to real path again write (symlink alias write to real file, and mutual exclusion queue key align),
 * new file by term method absolute path write; read-change-write window via env/file-mutation-queue and plugin
 * API sharing the same target node canonical path mutual exclusion queue.edit succeeded structure output in lock inside,
 * before based on actually read content compute real row level difference (runtime/tool-edit-diff.ts unique implement,
 * local/remote sharing; conforms to @helm/protocol EDIT_TOOL_RESULT_SCHEMA).
 */
import type { JsonValue } from '@earendil-works/chord/json'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import { bool, obj, opt, str } from '@earendil-works/pi-schema'
import { EDIT_TOOL_RESULT_SCHEMA, isAbsoluteTargetPath, type EditToolResult } from '@helm/protocol'
import { computeEditDiff } from '../tool-edit-diff.js'
import { targetPlatformForNode } from '../target-platform.js'
import { throwIfToolAborted, type HelmToolDeps } from '../tool-deps.js'
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
  path: str({ description: 'file path (each other for conversation cwd or absolute path, support ../ across directory)' }),
})

/**
 * read tool: by conversation (nodeId, cwd) target read text file.cwd only act relative path base allow,
 * absolute path and ../ across directory one rule allows (and bash same right); only support ordinary file, keep
 * 128KiB cap; remote via env RPC(canonicalPath first parse symlink, make lstat semantics
 * fileInfo see to real target).
 */
export function createReadTool(deps: HelmToolDeps): ToolRegistration<typeof readParameters> {
  return defineTool({
    name: 'read',
    // pure only read and spill slot by callId determinism naming: interrupt heavy open allows security replay.
    replay: 'safe',
    description:
      'read text file content; path each other for conversation cwd parse, support absolute path and ../ across directory access (and bash same right); only support ordinary file, single file cap 128KiB(over limit please use bash + read_artifact page); conversation bind set remote node when in target node read.',
    parameters: readParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'actual read absolute path (remote is canonical parse after; non- original reference)' },
        nodeId: { type: 'string', description: 'actual read node' },
        content: { type: 'string' },
      },
      required: ['path', 'nodeId', 'content'],
    },
    async execute(args, api, context) {
      const raw = args.path
      const agent = await api.agent(context)
      // path semantics by conversation cwd target shape (POSIX/Windows) parse, never use Hub host
      // node:path by default rule parse remote path (Linux Hub on resolve('C:\\x') will obtain to
      // error result);api.agent and tool sharing the same SDK Context(cancel pass broadcast to remote).
      const sessionId = agent.cwd ?? deps.defaultCwd
      const nodeId = deps.nodeIdOf?.(api.conversationId as number) ?? 'local'
      // platform aware parse (and bash the same platform source and original language): remote platform unknown when along use by
      // shape choose rule since has semantics (do not guess platform);win32 target on POSIX view path
      // first determinism convert is specification Windows path, cannot mapping bare POSIX explicit reject.
      const platformInfo = targetPlatformForNode(deps.envFabric, nodeId)
      if (!isAbsoluteTargetPath(sessionId)) {
        return {
          output: [
            { type: 'text', text: `read_failed: conversation cwd non- absolute path (${sessionId}), reject read` },
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
      try {
        // unify execute environment: remote (guard first row:EnvFabric missing/node offline explicit failed,
        // never fall back local machine) and local(process inside fs + fd read) the same read template.
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
        // closure stop/cancel window forbidden in disk write without intent meaning spill artifact file.
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
          // details is SDK persist to toolResult message UI channel (structuredOutput do not written to the database,
          // only supply embed set caller); text channel already carry content, does not repeat store content, avoid double write.
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
  path: str({ description: 'target file path (each other for conversation cwd or absolute path, support ../ across directory; allows create new file or subdirectory)' }),
  content: str({ description: 'want write UTF-8 text content (whole override)' }),
  artifact: opt(
    bool({
      description:
        'is otherwise also register is when before conversation artifact (Web UI visible/can preview/can download, and in output in return [Artifact] id=<id>; in back re- body text in available [filename](artifact:<id>) or ![diagram piece](artifact:<id>) directly render)',
    }),
  ),
})

/** write/edit shared use error text proposal (lock inside unique match validate,local/remote sharing). */
const editTextNotFound = (abs: string): string => `edit_failed: oldText in ${abs} in missing (reject without operation edit)`
const editTextNotUnique = (abs: string, count: number): string =>
  `edit_failed: oldText in ${abs} in appear ${count} time (must unique match; please expand large context make oldText unique)`
const editOkText = (abs: string, nodeId: string): string => `edit_ok: ${abs}(node ${nodeId}, already replace 1 where)`

/** write tool: by conversation (nodeId, cwd) target write text file (path and bash same right, do not set cwd sandbox). */
export function createWriteTool(deps: HelmToolDeps): ToolRegistration<typeof writeParameters> {
  return defineTool({
    name: 'write',
    description:
      'write UTF-8 text file (whole override). path each other for conversation cwd parse, support absolute path and ../ across directory access (and bash same right); allows create new file or subdirectory; conversation bind set remote node when in target node write. by default file only write disk (Web UI invisible); if must deliver user in Web preview or download, pass artifact: true sync register is conversation artifact and get artifact ID, in back re- in use [filename](artifact:<id>) or ![title](artifact:<id>) directly render to chat UI.',
    parameters: writeParameters,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'actual write absolute path (already exists file is canonical parse after; non- original reference)' },
        nodeId: { type: 'string', description: 'actual write node' },
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
      try {
        const onWriteSuccess = async (targetAbs: string, bytes: number) => {
          if (args.artifact === true) {
            if (deps.artifacts.writeUploaded === undefined) {
              return {
                output: [
                  {
                    type: 'text' as const,
                    text: 'write_failed: artifact service not config writeUploaded, cannot register conversation artifact',
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
                  text: `write_ok: ${targetAbs}(node ${nodeId},${bytes} byte)\n[Artifact] id=${meta.id} name=${meta.name}`,
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
              { type: 'text' as const, text: `write_ok: ${targetAbs}(node ${nodeId},${bytes} byte)` },
            ],
            structuredOutput: { path: targetAbs, nodeId, bytesWritten: bytes } as JsonValue,
            details: { path: targetAbs, nodeId, bytesWritten: bytes } as JsonValue,
          }
        }

        // unify execute environment: remote (guard first row:EnvFabric missing/node offline explicit failed,
        // never fall back local machine) and local the same write template.
        const envR = writableEnvFor(deps, nodeId, base, 'write')
        if ('error' in envR) {
          return { output: [{ type: 'text', text: envR.error }], isError: true }
        }
        const target = await resolveWritableTarget(envR.env.canonicalProbe, args.path, base, platform, context)
        if (!target.ok) {
          return { output: [{ type: 'text', text: target.message }], isError: true }
        }
        const bytes = Buffer.byteLength(args.content, 'utf8')
        // mutual exclusion queue: same file read-change-write window and plugin/other tool queue up (see env/file-mutation-queue.ts).
        // new file parent directory may missing: first ensure directory (recursive);dirname by target
        // shape rule (win32 backslash isolate symbol).
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
  path: str({ description: 'target file path (each other for conversation cwd or absolute path, support ../ across directory)' }),
  oldText: str({ description: 'want by replace precise text (must in file in exactly appear once)' }),
  newText: str({ description: 'replace after text' }),
})

/** non- overlap appear time count count (edit unique match validate use). */
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
 * edit tool: precise text replace.oldText must in target file in unique precise match (missing
 * or appear many time all explicit errors, never blurry replace or static default skip);newText by literal replace write
 * (do not explain $& system replace pattern, and precise replace contract and difference render consistent); replace after write back
 * original file; path parse and write same contract (and bash same right, do not set cwd sandbox). succeeded structure
 * output is @helm/protocol EditToolResult, and sync mirror to details(SDK persist
 * to toolResult message UI channel,Web difference render read it;structuredOutput do not written to the database,
 * only supply embed set caller): difference in canonical mutual exclusion lock inside, write before
 * based on actually read content compute (computeEditDiff throws then edit_failed and file not by modify),
 * only in write after success return.
 */
export function createEditTool(deps: HelmToolDeps): ToolRegistration<typeof editParameters> {
  return defineTool({
    name: 'edit',
    description:
      'precise replace file text fragment.oldText must in file in exactly appear once (missing or many time appear all errors); path each other for conversation cwd parse, support absolute path and ../ across directory access (and bash same right); conversation bind set remote node when in target node read and write back.',
    parameters: editParameters,
    structuredOutputSchema: EDIT_TOOL_RESULT_SCHEMA,
    async execute(args, api, context) {
      const target0 = await resolveToolTarget(deps, api, context)
      if ('error' in target0) {
        return { output: [{ type: 'text', text: `edit_failed: ${target0.error}` }], isError: true }
      }
      const { nodeId, base, platform } = target0
      try {
        // unify execute environment: remote (guard first row:EnvFabric missing/node offline explicit failed,
        // never fall back local machine) and local the same read-change-write template.
        const envR = writableEnvFor(deps, nodeId, base, 'edit')
        if ('error' in envR) {
          return { output: [{ type: 'text', text: envR.error }], isError: true }
        }
        const target = await resolveWritableTarget(envR.env.canonicalProbe, args.path, base, platform, context)
        if (!target.ok) {
          return { output: [{ type: 'text', text: target.message }], isError: true }
        }
        // mutual exclusion queue: read-change-write whole hold lock (read old content and write back between do not by other change insert).
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
          // literal replace (do not explain $& system pattern): content and difference compute input strictly same source.
          const updated =
            content.slice(0, matchOffset) +
            args.newText +
            content.slice(matchOffset + args.oldText.length)
          // difference in lock inside, write before based on actually read content compute (pure function; throws then file not by modify).
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
            // Web timeline difference render read persist details channel (structuredOutput do not written to the database);
            // two channel same value, render layer only dependency EDIT_TOOL_RESULT_SCHEMA a contract.
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
