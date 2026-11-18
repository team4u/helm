/**
 * Real adapter binding the Hub launcher's narrow update port to the shared `@helm/update`
 * engine. The port (`UpdateCore`) exists so tests can fake the registry/npm seams without a
 * network; production always uses `defaultUpdateCore()`, which delegates every generic
 * mechanism — registry manifest fetch with SHA512 SRI verification, the shell-free npm runner,
 * immutable staging with `.complete` markers and cache revalidation — to the engine. Nothing
 * generic is reimplemented here.
 */
import {
  computeSri,
  downloadTarball,
  fetchExactManifest,
  fetchLatestVersion,
  resolveRegistryUrl,
  runNpm,
  stageRelease as engineStageRelease,
  type StageExtractor,
} from '@helm/update';

export interface UpdateCoreFetchOptions {
  registryUrl?: string;
  fetchFn?: typeof fetch;
}

/**
 * Narrow update port consumed by `staging.ts` / `update.ts`; `defaultUpdateCore()` is the only
 * production implementation. `stageRelease` keeps the extractor channel (download + install run
 * inside the consumer's extractor) so registry and local-tarball installs share one code path.
 */
export interface UpdateCore {
  fetchLatestVersion(pkgName: string, options?: UpdateCoreFetchOptions): Promise<string>;
  /** Download `<registry>/<pkg>/<version>`'s tarball after verifying its `dist.integrity` sha512 SRI. */
  downloadVerifiedTarball(
    registryUrl: string,
    pkgName: string,
    version: string,
    destPath: string,
    fetchImpl?: typeof fetch,
  ): Promise<void>;
  runNpm(args: readonly string[], cwd: string, timeoutMs: number): Promise<void>;
  /** Immutable staging under `<root>/releases/<version>/` with `.complete` cache semantics. */
  stageRelease(
    root: string,
    version: string,
    extractor: (stagingDir: string) => Promise<Record<string, string>>,
    options?: { force?: boolean },
  ): Promise<{ version: string; releaseDir: string; entries: Record<string, string> }>;
}

export function defaultUpdateCore(): UpdateCore {
  return {
    async fetchLatestVersion(pkgName, options) {
      return await fetchLatestVersion(resolveRegistryUrl(options?.registryUrl), pkgName, options?.fetchFn ?? fetch);
    },
    async downloadVerifiedTarball(registryUrl, pkgName, version, destPath, fetchImpl) {
      const fetchFn = fetchImpl ?? fetch;
      const manifest = await fetchExactManifest(registryUrl, pkgName, version, fetchFn);
      await downloadTarball(manifest.tarball, destPath, { fetchFn });
      const actual = await computeSri(destPath);
      if (actual !== manifest.integrity) {
        throw new Error(
          `${pkgName}@${version} tarball sha512 integrity check failed: expected ${manifest.integrity}, got ${actual}`,
        );
      }
    },
    runNpm(args, cwd, timeoutMs) {
      return runNpm([...args], cwd, timeoutMs);
    },
    async stageRelease(root, version, extractor, options) {
      const adapted: StageExtractor = async (stagingDir) => await extractor(stagingDir);
      return await engineStageRelease(root, version, undefined, {
        stageExtractor: adapted,
        ...(options?.force ? { force: true } : {}),
      });
    },
  };
}
