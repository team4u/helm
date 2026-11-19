/**
 * `Profile.restrictToCwd` guardrail: rejects file-tool operations whose lexical resolution leaves the
 * conversation cwd (absolute paths and `../` escapes alike), and spawn requests whose explicit model-provided
 * `cwd` points outside the parent conversation cwd.
 *
 * Honesty contract: this is a model-facing boundary, not an OS sandbox —
 * - purely lexical containment against the target path shape (single source `isStrictlyInsideRoot`): symlinks
 *   inside cwd remain the user's filesystem reality (same privilege boundary as bash, whose commands keep running);
 * - host/plugin-directed rewrites (workflow worktree isolation via `agent_spawn` hooks) run after the spawn-entry
 *   check and are trusted capabilities, not model cwd choices;
 * - hard isolation for untrusted roles belongs to node-level deployment (bind the Profile to a dedicated node).
 */
import { targetPathShape, type TargetPlatform } from '@helmx/protocol'
import { isStrictlyInsideRoot, resolveTargetPath } from './target-path.js'

/** Shared violation text: names the raw input, the resolved escape, and the boundary. */
export function pathOutsideCwdText(raw: string, resolvedAbs: string, cwd: string): string {
  return (
    `path_outside_workspace: ${raw} resolves to ${resolvedAbs}, outside the conversation cwd (${cwd}); ` +
    'this conversation is restricted to its working directory (Profile.restrictToCwd)'
  )
}

/**
 * Resolve `raw` against `base` (conversation cwd) and return the violation text when the lexical result
 * escapes; `undefined` means inside (or unresolvable — invalid shapes reject separately in each tool).
 */
export function cwdScopeViolationText(
  raw: string,
  base: string,
  platform?: TargetPlatform,
): string | undefined {
  const resolved = resolveTargetPath(raw, base, platform)
  if (!resolved.ok) return undefined
  const shape = platform === 'win32' ? 'win32' : targetPathShape(base) ?? targetPathShape(resolved.abs)
  if (isStrictlyInsideRoot(resolved.abs, base, shape)) return undefined
  return pathOutsideCwdText(raw, resolved.abs, base)
}
