/**
 * @helm/kernel service layer unified exports: file assets, authentication, secrets, credentials, and artifacts.
 * Consumers (PluginHost / HTTP / CLI) must import from here instead of deep submodule paths.
 */
export {
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
  validateProfileInput,
  parseSkillFrontmatter,
  assertSkillId,
  defaultExternalSkillRoots,
  type Profile,
  type SkillSummary,
  type BuiltinSkillAsset,
} from './profiles-skills.js'

export {
  AssetWatcher,
} from './watcher.js'

export {
  AuthService,
  AuthAlreadyConfiguredError,
  InvalidCredentialsError,
  WeakPasswordError,
} from './auth.js'

export {
  CredentialService,
  credentialsPath,
} from './credentials.js'

export {
  ProviderService,
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
  type ArtifactKind,
  type ArtifactMetadata,
} from './artifacts.js'
// Binary artifact reads go through ArtifactService.readBuffer (used by the HTTP layer to transfer raw bytes),
// sharing the same source and validation as readContent (resolveStoredPath prevents arbitrary reads via forged metadata).
