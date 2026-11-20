/**
 * @helmx/env-io: shared execution I/O primitives used by `@helmx/kernel`, `@helmx/node`, and
 * `@helmx/plugin-build`, plus the shared self-update engine under `update/` (npm registry
 * access, immutable release staging, atomic state records, and the update transaction), the
 * cross-process control channel (`control.ts`), and OS startup service management
 * (`os-service.ts`) — all re-exported from this root.
 *
 * `@helmx/protocol` keeps only serializable RPC shapes (`NodePathUsage`, etc.); actual filesystem
 * and procfs access, case-aware environment variable primitives, host shell probing, and atomic
 * file writes live here so the Hub host, the remote node daemon, and the plugin compiler share a
 * single implementation.
 */
export * from './atomic-write.js'
export * from './path-usage.js'
export * from './node-path-usage-io.js'
export * from './process-env.js'
export * from './shell-config.js'
export * from './node-shell-config-io.js'
export * from './control.js'
export * from './os-service.js'
export * from './update/index.js'
// NOTE: `hub-payload.ts` (tarball unpacking + payload staging + update-ready state, tar-dependent)
// is exported ONLY via the './hub-payload' subpath so the node daemon bundle keeps its
// four-external contract.