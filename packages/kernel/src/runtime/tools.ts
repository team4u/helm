/**
 * Built-in kernel tools (barrel re-export): implementations are split by responsibility into submodules under
 * `./tools/`, while this file preserves stable `./tools.js` imports for `runtime.ts`, `spawn.ts`, `tool-registry.ts`,
 * and existing tests.
 *
 * - Shell execution engine (`runShell` / `runGate` / `bash` tool): `tools/shell-exec.ts` —
 *   real process groups, timeout/abort handling, cross-chunk UTF-8 fidelity, explicit errors on output limit overflow;
 * - Managed env assembly (`buildToolEnv` / `buildManagedEnv` / `executionScopeHash`): `tools/managed-env.ts` —
 *   pinned `HELMX_*` variable overrides, assembled coherently under `env/scoped-env.ts` `ScopedExecutionEnv`;
 * - Lexical path resolution (`resolveTargetPath`): `tools/target-path.ts` — picks pure posix/win32 rules based on
 *   target path shape rather than Hub host's `node:path` default; `isAbsoluteTargetPath`/`targetPathShape`
 *   re-exported from `@helmx/protocol`;
 * - Remote guards (`env_fabric_missing` / `node_offline`): `tools/guards.ts` — fails explicitly when
 *   `EnvFabric` is missing or nodes are offline, never falling back silently to local;
 * - File tools (`read` / `write` / `edit`): `tools/file-ops.ts` + `tools/file-env.ts` —
 *   local (in-process fs) and remote `EnvFabric` paths share one execution-environment adapter and
 *   template; read-modify-write serializes via `env/file-mutation-queue`; edit line-level diffs live
 *   solely in `runtime/tool-edit-diff.ts`;
 * - `register_artifact` / `read_artifact`: `tools/artifact-tools.ts` — real regular-file copy
 *   registration (15 MiB cap, bounded single-fd read, explicit rejection on concurrent mutation) and
 *   paginated spill artifact reading (UTF-8 boundary alignment guarantees progress); `read_artifact`
 *   distinguishes missing artifacts from storage read failures, propagating original errors on the latter.
 *
 * File path contract (`read` / `write` / `edit`, aligned with `pi`): conversation `cwd` is only used as
 * the base for relative paths; absolute paths and `../` parent traversals are always permitted (matching
 * `bash` privileges, without a cwd sandbox — permissions are enforced by the OS). `timeoutMs` must be
 * a positive finite integer `<= MAX_TIMEOUT_MS`; invalid values reject explicitly with `invalid_timeout`.
 * `SecretStash` redaction runs across the full aggregated text (concatenate first, then redact so split
 * secrets across chunks still match completely) and never reverses redaction.
 */
export { resolveTargetPath } from './tools/target-path.js'
export {
  runShell,
  runGate,
  createBashTool,
  MAX_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  STREAM_AGGREGATE_LIMIT_BYTES,
  type ShellRunResult,
} from './tools/shell-exec.js'
export { buildToolEnv, buildManagedEnv, executionScopeHash } from './tools/managed-env.js'
export { createReadTool, createWriteTool, createEditTool } from './tools/file-ops.js'
export { READ_FILE_MAX_BYTES } from './tools/file-env.js'
export {
  createRegisterArtifactTool,
  createReadArtifactTool,
  readArtifactBytesFromHandle,
  type ArtifactFileBytes,
  type ArtifactReadHandle,
} from './tools/artifact-tools.js'
// Shape detection and pure lexical helpers live in `@helmx/protocol` (browser-safe, shared by kernel and
// `@helmx/plugins`); re-exported here to preserve existing relative-path imports.
export { isAbsoluteTargetPath, targetPathShape } from '@helmx/protocol'
