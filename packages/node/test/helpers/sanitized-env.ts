/**
 * Node-package test helper for stripping host-managed Helm environment variables
 * (delegates to `@helm/test-kit/node`).
 *
 * Preserves the legacy `sanitizedHostEnv` and `HOST_MANAGED_HELM_ENV_NAMES` exports
 * for tests and contract tests under `packages/node`.
 */
export { HOST_MANAGED_HELM_ENV_NAMES, sanitizedHostEnv } from '@helm/test-kit/node';
