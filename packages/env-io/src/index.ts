/**
 * @helm/env-io: shared execution I/O primitives used by both `@helm/kernel` and `@helm/node`.
 *
 * `@helm/protocol` keeps only serializable RPC shapes (`NodePathUsage`, etc.); actual filesystem
 * and procfs access, case-aware environment variable primitives, and host shell probing live here
 * so the Hub host and remote node daemon share a single implementation.
 */
export * from './path-usage.js'
export * from './node-path-usage-io.js'
export * from './process-env.js'
export * from './shell-config.js'
export * from './node-shell-config-io.js'
