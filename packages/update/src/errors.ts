/**
 * Error contracts shared by every consumer of the update engine.
 *
 * Both classes are part of the cross-process contract: `@helm/node` maps
 * `UpgradeRejectedError` to RPC `invalid` / 4xx and walks `cause` chains for
 * `UpgradeCommitUnconfirmedError` to decide "never roll back". Consumers must import
 * them from this package only, so a single process never holds two module copies
 * (duplicate classes would break `instanceof` identity checks).
 */

/** Policy/input rejection (callers map to 4xx / RPC `invalid`). */
export class UpgradeRejectedError extends Error {}

/**
 * Thrown when `activate` was written to the candidate IPC channel, so the candidate may have already
 * committed upstream while local confirmation was lost. Callers must NOT abort or roll back.
 */
export class UpgradeCommitUnconfirmedError extends Error {}
