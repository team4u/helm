/**
 * packages/node test dedicated use: host managed Helm environment variable strip except assist manually (delegate `@helm/test-kit/node`).
 *
 * keep and original module consistent export symbol `sanitizedHostEnv` and `HOST_MANAGED_HELM_ENV_NAMES`,
 * supply packages/node test and contract test use.
 */
export { HOST_MANAGED_HELM_ENV_NAMES, sanitizedHostEnv } from '@helm/test-kit/node';
