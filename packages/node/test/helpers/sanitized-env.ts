/**
 * Node-package test helper for stripping host-managed Helmx environment variables
 * (delegates to `@helmx/test-kit/node`).
 *
 * Preserves the legacy `sanitizedHostEnv` and `HOST_MANAGED_HELMX_ENV_NAMES` exports
 * for tests and contract tests under `packages/node`.
 */
export { HOST_MANAGED_HELMX_ENV_NAMES, sanitizedHostEnv } from '@helmx/test-kit/node';
