// adapters: the Node implementations of core's ports (IMPLEMENTATION.md §2.2). Only this package touches node:fs,
// node:child_process and SQLite.
export { OffsetClock, nodeRandom } from './clock/clocks.ts';
export { BASE_VARIABLES, currentPlatform, hostName, nodeEnv, type NodeEnvOptions } from './env/node-env.ts';
export {
  type AuditEntry,
  GuardedFileSystem,
  type GuardOptions,
  type GuardRoots,
  isLiveEntry,
  isLiveName,
  LIVE_CAP,
  LIVE_PREFIX,
  liveAllows,
} from './fs/guarded-fs.ts';
export { NodeFileSystem } from './fs/node-fs.ts';
export { tailLines, treeOf, type TreeItem } from './fs/tree.ts';
export { nodeLinks, normalizeTarget } from './links/node-links.ts';
export { createFileLogger, createLineLogger, type FileLoggerOptions } from './logging/file-logger.ts';
export { REDACTED, redact, redactText } from './logging/redact.ts';
export { caBundle, looksLikePem } from './network/ca-bundle.ts';
export { NodeProcessRunner } from './process/node-process.ts';
export {
  headerVersion,
  instanceMigrations,
  latestVersion,
  type Migration,
  type OpenOptions,
  SqliteStore,
} from './store/sqlite-store.ts';
export {
  BACKUP_EVERY_MS,
  backupDue,
  backupInstanceDatabase,
  BACKUPS_FOLDER,
  KEPT_BACKUPS,
  listBackups,
  openInstanceDatabase,
  type OpenedInstanceDatabase,
} from './store/instance-database.ts';
export {
  CatalogLoader,
  type CatalogLoaderOptions,
  type CatalogRejection,
  type LoadedCatalog,
  verifySignedCatalog,
} from './catalog/catalog-loader.ts';
export { ParcelWatcher } from './watcher/parcel-watcher.ts';
export { ZipArchive } from './zip/zip-archive.ts';
export { classifyFailure, classifyRejection, wouldBeOverwritten } from './git/classify.ts';
export { DugiteGit, type DugiteGitOptions } from './git/dugite-git.ts';
export { newEd25519Key, NodeSigningKeys } from './git/signing-keys.ts';
export {
  basicAuthHeader,
  commandEnv,
  GIT_VARIABLES,
  gitBaseEnv,
  type GitNetwork,
  KEY_FILE_PREFIX,
  pinnedConfig,
  sweepLeftoverKeys,
  testSshOptions,
} from './git/git-env.ts';
export { allowedInCodeRepo, checkCommand, type GitRole } from './git/guard.ts';
export type { GitRunRecord } from './git/runner.ts';
export {
  linuxKind,
  macKind,
  NodeVolumes,
  type NodeVolumesOptions,
  type SimulatedVolume,
  TEST_VOLUMES_FILE,
} from './volumes/node-volumes.ts';
export {
  classifyNetworkError,
  formBody,
  type HttpClient,
  type HttpNetwork,
  type HttpRequest,
  type HttpResponse,
  jsonBody,
  NodeHttpClient,
  type NodeHttpClientOptions,
} from './network/http-client.ts';
export { githubCapabilities, GithubHost } from './hosts/github.ts';
export { GITLAB_SCOPE, gitlabCapabilities, GitlabHost } from './hosts/gitlab.ts';
export { knownEndpoint, NodeHostProbe, plainCapabilities, PlainHost } from './hosts/probe.ts';
