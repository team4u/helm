/**
 * @helm/kernel service layer unified exports: file assets, authentication, secrets, credentials, and artifacts.
 * Consumers (PluginHost / HTTP / CLI) must import from here instead of deep submodule paths.
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
// Binary artifact reads go through ArtifactService.readBuffer (used by the HTTP layer to transfer raw bytes),
// sharing the same source and validation as readContent (resolveStoredPath prevents arbitrary reads via forged metadata).
