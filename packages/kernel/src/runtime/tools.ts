/**
 * kernel self carries local machine tool (combine exit): implement by responsibility split in this directory sub- module, this file only
 * again export, supply runtime.ts / spawn.ts / tool-registry.ts and test since has
 * `./tools.js` import path keep stable.
 *
 * - shell execute engine (runShell / runGate / bash tool):tools/shell-exec.ts- -
 *   real process group, timeout,abort, across chunk UTF-8 fidelity, output limit quota explicit errors;
 * - managed env together into (buildToolEnv / buildManagedEnv / executionScopeHash):
 *   tools/managed-env.ts- - managed HELM_* variable fixed override, together into right threat in
 *   env/scoped-env.ts  ScopedExecutionEnv;
 * - path term method parse (resolveTargetPath):tools/target-path.ts- - by target path
 *   shape choose pure posix/win32 rule, never use Hub host node:path by default rule parse
 *   remote path;isAbsoluteTargetPath/targetPathShape again export self @helm/protocol;
 * - remote guard (env_fabric_missing / node_offline):tools/guards.ts- -
 *   EnvFabric missing and node offline explicit failed, never static default fall back local;
 * - read/write/edit file tool:tools/file-ops.ts + tools/file-env.ts- -
 *   local(process inside fs) and EnvFabric remote branch converge is unify execute environment adapt +
 *   single one template; read-change-write via env/file-mutation-queue mutual exclusion;edit row level difference in
 *   runtime/tool-edit-diff.ts unique implement;
 * - register_artifact / read_artifact:tools/artifact-tools.ts- - real ordinary
 *   file duplicate register (cap 15 MiB, same fd has boundary read, in route change explicit reject) and
 *   spill artifact page read (UTF-8 boundary align guarantee before enter);read_artifact zone
 * artifact missing and store failed to read, after such as through out original error.
 *
 * file path contract (read/write/edit, align pi): conversation cwd only as relative path parse
 * base allow, absolute path and ../ across directory access one rule allows - -bash this then without file boundary, file tool
 * and bash same right, do not set cwd sandbox; permission boundary hand over to OS itself.timeoutMs must is
 * correct finite integer and ≤ cap, illegal value explicit invalid_timeout.SecretStash redaction in aggregate
 * complete all text on execute (first complete concatenate again redact, across chunk tear secret also must however complete
 * match), never reverse restore.
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
// shape decide and term method rule sub- collection consolidate @helm/protocol(browser security pure function, kernel and
// @helm/plugins sharing); this where again export supply since has relative path reference keep stable.
export { isAbsoluteTargetPath, targetPathShape } from '@helm/protocol'
