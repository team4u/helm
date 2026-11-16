/**
 * packages/node 测试专用：宿主受管 Helm 环境变量剥除助手（委托 `@helm/test-kit/node`）。
 *
 * 保持与原模块一致的导出符号 `sanitizedHostEnv` 与 `HOST_MANAGED_HELM_ENV_NAMES`，
 * 供 packages/node 测试及契约测试使用。
 */
export { HOST_MANAGED_HELM_ENV_NAMES, sanitizedHostEnv } from '@helm/test-kit/node';
