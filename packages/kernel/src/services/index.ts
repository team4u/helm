/**
 * @helm/kernel 服务层统一出口：文件资产、鉴权、机密、凭据与产物。
 * 消费方（PluginHost / HTTP / CLI）一律从这里导入，不深入子模块路径。
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
  ArtifactService,
  InMemoryArtifactRepository,
  MAX_ARTIFACT_BYTES,
  sanitizeUploadFilename,
  SPILL_THRESHOLD_BYTES,
  PREVIEW_HEAD_BYTES,
  truncateUtf8Safe,
  type ArtifactMetadata,
  type ArtifactRepository,
  type RegisterOptions,
  type SpillResult,
} from './artifacts.js'
// 二进制产物读取走 ArtifactService.readBuffer（HTTP 层传输原始字节用），
// 与 readContent 同源同校验（resolveStoredPath 防伪 metadata 任意读）。
