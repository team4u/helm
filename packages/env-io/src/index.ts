/**
 * @helm/env-io: shared execution I/O primitives used by `@helm/kernel`, `@helm/node`, and
 * `@helm/plugin-build`.
 *
 * `@helm/protocol` keeps only serializable RPC shapes (`NodePathUsage`, etc.); actual filesystem
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
