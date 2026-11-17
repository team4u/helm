/**
 * @helm/kernel service layer unify exit: file asset, authentication, secret, credentials and artifact.
 * consumer (PluginHost / HTTP / CLI) one rule from this in import, do not deep sub- module path.
 */
export {
  HELM_DATA_DIR_ENV,
  DATA_SUBDIRS,
  resolveDataDir,
  ensureDataDir,
} from './paths.js'

export {
  FileNotFoundError,
  FileParseError,
  atomicWriteFile,
  atomicWriteJson,
  readTextFile,
  readJsonFile,
  readJsonFileOptional,
  copyFilePrivate,
  isPrivateMode,
} from './atomic-file.js'

export { ConfigService } from './config.js'

export { withFileLock, withProcessFileLock } from './file-lock.js'

export {
  SecretStash,
  REDACTED_PREFIX,
  isValidEnvName,
  makePlaceholder,
  parsePlaceholder,
  validateSecretLifetime,
  MAX_SECRET_TTL_MS,
  type StashedSecret,
} from './secret-stash.js'

export {
  ProfileService,
  SkillService,
  DEFAULT_PROFILE_ID,
  SYSTEM_DEFAULT,
  assertProfileId,
  validateProfileInput,
  parseSkillFrontmatter,
  assertSkillId,
  assertSafeRelativePath,
  defaultExternalSkillRoots,
  type Profile,
  type SkillSummary,
  type BuiltinSkillAsset,
} from './profiles-skills.js'

export {
  AssetWatcher,
  isTmpName,
  ASSET_WATCHER_DEBOUNCE_MS,
  type AssetWatcherOptions,
} from './watcher.js'

export {
  AuthService,
  AuthAlreadyConfiguredError,
  InvalidCredentialsError,
  WeakPasswordError,
  MIN_PASSWORD_LENGTH,
} from './auth.js'

export {
  CredentialService,
  credentialsPath,
  readRawText,
  type CredentialStore,
  type StoredCredential,
} from './credentials.js'

export {
  ProviderService,
  assertProviderId,
  validateProviderConfig,
  type ProviderConfig,
} from './providers.js'

export {
  BINARY_MIME,
  isTextMime,
  detectMimeByExtension,
  detectWorkspaceFileMime,
} from './file-mime.js'

export {
  ArtifactService,
  InMemoryArtifactRepository,
  MAX_ARTIFACT_BYTES,
  sanitizeUploadFilename,
  SPILL_THRESHOLD_BYTES,
  PREVIEW_HEAD_BYTES,
  truncateUtf8Safe,
  type ArtifactKind,
  type ArtifactMetadata,
  type ArtifactRepository,
  type RegisterOptions,
  type SpillResult,
} from './artifacts.js'
// two enter system artifact read away ArtifactService.readBuffer(HTTP layer transfer original byte use),
// and readContent same source same validate (resolveStoredPath guard against fake metadata any read).
