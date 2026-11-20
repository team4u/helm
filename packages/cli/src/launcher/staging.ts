/**
 * Hub payload staging lives in `@helmx/env-io` (`hub-payload.ts`) so the CLI launcher and the
 * in-Hub background updater share one implementation; this module re-exports the CLI-facing
 * surface and keeps the launcher's `UpdateCore` port compatible with the shared
 * `HubUpdateCore` shape (tests inject fakes through the same seam).
 */
export {
  unpackPayloadTarball,
  stageHubRelease,
  assertInstallIsolation,
  resolveRegistryUrlForEnv,
  NPM_INSTALL_TIMEOUT_MS,
  PAYLOAD_CHECK_TIMEOUT_MS,
  defaultHubUpdateCore,
  type HubUpdateCore,
  type StageHubOptions,
  type StagedHubRelease,
} from '@helmx/env-io/hub-payload';
export { defaultUpdateCore, type UpdateCore, type UpdateCoreFetchOptions } from './update-core.js';
