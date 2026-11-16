/**
 * external plugin source code static self inspect (doctor): real load + real register assertion, does not second set approximate validate.
 *
 * check chain (by execute order, after continue check dependency before drive succeeded):
 * 1. manifest/entry parse (resolvePluginEntry:plugin.json legal,main exceeds, entry store in);
 * 2. backend proxy boundary import (importPluginDefinition:TS transpile, module initialize,default export shape);
 * 3. register real register (temporary PluginHost + memory doc store:definePlugin all declaration boundary
 *    validate - -action/tool/ui/doc/service/provider shape, duplicate,scope etc. and real host the same
 *    code path, do not maintain second set approximate validate); register via ctx.ui proxy smooth carries collect client module reference;
 * 4. client compile (for collect to all client.tsx module reference use real compiler compile).
 *
 * honest discipline: any one step failed all produce structure PluginDoctorCheck(code/message/details),
 * never static default fall back is roughly available; succeeded report attach real register obtain to PluginSummary.
 *
 * isolated and side effect:
 * - doctor use independent proxy boundary number import plugin module (?helmgen=N): new proxy count module diagram independent initialize,
 *   does not affect when before registered instance is now use old proxy count module; bare note symbol dependency still and host same instance;
 * - register in temporary PluginHost on enter row (temporary dataDir, memory doc store,doctor dedicated use backend:
 *   ctx.host.* invoke one rule 501 explicit reject) - -definePlugin top-level dependency host invoke plugin in
 *   doctor where such as failed (report to act), is not doctor defect;
 * - temporary host register i.e. dispose(enabled: false, service do not start, no side effects can leak leak).
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  HelmError,
  clientNpmRootsOf,
  type PluginBuildProvider,
  type PluginDefinition,
  type PluginDoctorCheck,
  type PluginDoctorReport,
  type PluginSummary,
} from '@helm/protocol';
import { PluginHost, type PluginHostBackend } from './plugin-host.js';
import { nextPluginGeneration, registerPluginTsRoot } from './backend-ts-loader.js';
import {
  importPluginDefinition,
  normalizeDefinition,
  resolvePluginEntry,
} from './external-loader.js';

/** doctor real register which must temporary doc store(memory mirror, do not trigger touch host durable layer). */
class DoctorDocStore {
  private values = new Map<string, unknown>();
  get<T>(key: string, initial: T): T {
    return this.values.has(key) ? (structuredClone(this.values.get(key)) as T) : initial;
  }
  set<T>(key: string, value: T): void {
    this.values.set(key, structuredClone(value));
  }
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}:`;
    for (const key of [...this.values.keys()]) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) this.values.delete(key);
    }
  }
  async flush(): Promise<void> {}
}

/**
 * doctor backend:ctx.host.* all real host invoke one rule 501 explicit reject (not silently return fabricate
 * data). only provide PluginHost construct/register chain must must security only read bottom seat:isClosing constant false,
 * text redaction constant etc..definePlugin top-level dependency host invoke plugin in doctor where such as failed.
 */
function doctorBackend(): PluginHostBackend {
  const unavailable = (what: string): never => {
    throw new HelmError(
      'unsupported',
      `doctor static self inspect do not provide host runtime capability:${what}(plugin must not in definePlugin top-level dependency host invoke)`,
      501,
    );
  };
  const port = new Proxy({} as Record<string, never>, {
    get: (_t, prop) => unavailable(`host.<port>.${String(prop)}`),
  });
  return {
    isClosing: () => false,
    redact: (text: string) => text,
    profiles: port as never,
    skills: port as never,
    nodeIpc: undefined,
  nodeFetch: undefined,
  openTunnel: undefined,
    secrets: port as never,
    setPluginConfig: () => unavailable('host.setConfig'),
    dispatchTrigger: () => unavailable('host.dispatchTrigger'),
    submitInput: () => unavailable('host.submitInput'),
    submitInputGuarded: () => unavailable('host.submitInputGuarded') as never as Promise<void>,
    createConversation: () => unavailable('host.createConversation'),
    forkConversation: () => unavailable('host.forkConversation'),
    listConversations: () => unavailable('host.listConversations'),
    getConversation: () => unavailable('host.getConversation'),
    getConversationDetail: () => unavailable('host.getConversationDetail'),
    updateConversation: () => unavailable('host.updateConversation'),
    abortConversation: () => unavailable('host.abortConversation'),
    abortConversationGuarded: () => unavailable('host.abortConversationGuarded') as never as Promise<void>,
    getConversationOwnership: () => unavailable('host.getConversationOwnership'),
    markConversationOwnership: () => unavailable('host.markConversationOwnership'),
    listArtifacts: () => unavailable('host.listArtifacts'),
    getArtifact: () => unavailable('host.getArtifact'),
    completeText: () => unavailable('host.completeText'),
    executionEnv: () => unavailable('host.executionEnv'),
    buildSpawnEnv: () => unavailable('host.buildSpawnEnv'),
    spawnAgent: () => unavailable('host.spawnAgent'),
    runGate: () => unavailable('host.runGate'),
    resolveSpawnTarget: () => unavailable('host.resolveSpawnTarget'),
    listActiveSpawnExecutions: () => [],
    inspectNodePathUsage: () => unavailable('host.inspectNodePathUsage'),
    refreshModels: () => unavailable('host.refreshModels'),
    createAsk: () => unavailable('host.createAsk'),
    cancelAsk: () => unavailable('host.cancelAsk'),
    registerAskSeqResolver: () => unavailable('host.registerAskSeqResolver'),
    onEvent: () => unavailable('host.onEvent'),
    // event publish in register complete chain on must however occur (plugin.changed):doctor without SSE consumer,
    // static default discard is security no-op(is not capability missing static default fall back: event itself without return value can fabricate).
    emitEvent: () => {},
    manageConversation: () => unavailable('host.manageConversation'),
    execEnv: () => unavailable('host.execEnv'),
    withFileLock: <T,>(_path: string, fn: () => Promise<T>): Promise<T> => fn(),
    atomicWriteFile: () => unavailable('host.atomicWriteFile'),
    withFileMutationQueue: <T,>(_target: never, fn: () => Promise<T>): Promise<T> => fn(),
  };
}

/** HelmError -> can serial diagnose shape. */
function toErrorInfo(err: unknown): { code: string; message: string; details?: unknown } {
  if (err instanceof HelmError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
  }
  return {
    code: 'doctor_check_failed',
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * for external plugin directory execute static self inspect (real load + real register + real client compile).
 * dir by caller validate is store in directory; return report object (plugin itself defect with checks present),
 * only doctor base seat fault (temp directory failed to create etc.) only then reject.
 *
 * options.buildProvider by caller (PluginHost.doctorExternalPlugin / reload preflight
 * / managed package install) pass-through: and produce the same build port. missing when TS transpile and client compile
 * related check such as failed (unsupported_backend_ts_build / unsupported_client_build),
 * not silently skip.
 */
export async function doctorPluginDir(
  dir: string,
  options: { buildProvider?: PluginBuildProvider } = {},
): Promise<PluginDoctorReport> {
  let releaseTsRoot: (() => void) | undefined;
  try {
    if (statSync(dir).isDirectory()) {
      releaseTsRoot = registerPluginTsRoot(dir, {
        transform: options.buildProvider?.transformBackendTs,
      });
    }
  } catch {
    // entry check negative duty missing/cannot read directory convert is structure doctor report;
    // cannot register TS when continue execute, backend check will such as expose real import error.
  }
  try {
    return await doctorPluginDirInternal(dir, options);
  } finally {
    releaseTsRoot?.();
  }
}

async function doctorPluginDirInternal(
  dir: string,
  options: { buildProvider?: PluginBuildProvider },
): Promise<PluginDoctorReport> {
  const checks: PluginDoctorCheck[] = [];
  const push = (id: string, label: string, run: () => void | Promise<void>): Promise<boolean> =>
    (async () => {
      try {
        await run();
        checks.push({ id, label });
        return true;
      } catch (err) {
        checks.push({ id, label, error: toErrorInfo(err) });
        return false;
      }
    })();

  let entryPath: string | undefined;
  const entryOk = await push('manifest', 'manifest and entry parse', async () => {
    entryPath = await resolvePluginEntry(dir);
    if (entryPath === undefined) {
      throw new HelmError(
        'plugin_entry_missing',
        `directory ${dir} excludes plugin entry mark record (without plugin.json and without convention entry file)`,
        404,
        { dir },
      );
    }
  });

  let definition: PluginDefinition | undefined;
  if (!entryOk) return report(dir, undefined, checks, undefined);

  const backendOk = await push('backend', 'backend module proxy boundary import', async () => {
    const generation = nextPluginGeneration(dir);
    definition = normalizeDefinition(await importPluginDefinition(dir, entryPath!, { generation }), dir);
  });
  if (!backendOk || definition === undefined) return report(dir, undefined, checks, undefined);

  const clientRefs: Array<{ module: string; export: string }> = [];
  const screenIds: string[] = [];
  let summary: PluginSummary | undefined;
  // real register + client compile shared use a scratch directory (temporary dataDir and compile cache),
  // doctor after end unify clean up; does not use host produce directory, avoid write competition.
  const registerOk = await withDoctorScratch(async (scratch) =>
    push('register', 'real register assertion', async () => {
      let host: PluginHost | undefined;
      try {
        host = new PluginHost({
          dataDir: scratch,
          host: doctorBackend(),
          docs: new DoctorDocStore(),
          deferServices: true,
          buildProvider: options.buildProvider,
        });
        await host.register(withClientCapture(definition!, clientRefs, screenIds), { enabled: false });
        const found = host.list().find((s) => s.id === definition!.id);
        if (!found) {
          throw new HelmError(
            'invalid_plugin_definition',
            `register after not in host manifest in discover plugin ${definition!.id}(doctor internal state inconsistent)`,
            500,
            { dir, pluginId: definition!.id },
          );
        }
        summary = found;
      } finally {
        await host?.dispose().catch(() => {});
      }
    }),
  );
  if (!registerOk) return report(dir, definition.id, checks, undefined);

  const clientOk = await withDoctorScratch(async (scratch) =>
    push('client', 'frontend module real compile and export validate', async () => {
      // without client reference plugin no need to build port (check empty); has reference but port not inject when
      // such as failed (and produce register boundary the same reject semantics), never static default skip or fabricate artifact.
      if (clientRefs.length > 0 && options.buildProvider === undefined) {
        throw new HelmError(
          'unsupported_client_build',
          'plugin declaration client reference but host not inject plugin build port (buildProvider): cannot execute client module compile check',
          501,
          { dir },
        );
      }
      if (options.buildProvider === undefined) return;
      // and produce getClientModule the same subject to control npm mapping: manifest clientDependencies archive one
      // enter definition.npmDependencies after in this takes effect (doctor/run chain the same compile opening path).
      const npmRoots = clientNpmRootsOf(definition!.npmDependencies);
      const seen = new Set<string>();
      for (const ref of clientRefs) {
        const key = `${ref.module}#${ref.export}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const compiled = await options.buildProvider.compileClientModule({
          pluginId: definition!.id,
          clientRoot: definition!.clientRoot!,
          moduleRef: ref.module,
          cacheDir: scratch,
          npmRoots,
        });
        // dangling export validate: compile artifact real tool name export must contains declaration reference name,
        // otherwise UI declaration will in run phase render whitespace (dangling reference). such as report, not silently.
        if (!compiled.exports.includes(ref.export)) {
          throw new HelmError(
            'invalid_client_export',
            `plugin ${definition!.id}  client reference ${ref.module}#${ref.export} dangling: module tool name export is [${compiled.exports.join(', ') || 'without'}]`,
            422,
            { pluginId: definition!.id, module: ref.module, export: ref.export, exports: compiled.exports },
          );
        }
      }
    }),
  );
  void clientOk;

  return report(dir, definition.id, checks, summary, screenIds);
}

function report(
  dir: string,
  pluginId: string | undefined,
  checks: PluginDoctorCheck[],
  summary: PluginSummary | undefined,
  screenIds?: string[],
): PluginDoctorReport {
  return {
    dir,
    ...(pluginId !== undefined ? { pluginId } : {}),
    ok: checks.every((c) => c.error === undefined),
    checks,
    ...(summary !== undefined ? { summary } : {}),
    ...(screenIds !== undefined ? { screens: [...screenIds] } : {}),
  };
}

/**
 * wrap definePlugin: in real ctx.ui.* register method execute of outside, smooth carries collect client.tsx module
 * reference (supply client compile check) and ctx.ui.screen declaration view id(supply PluginDoctorReport.
 * screens). proxy only read do not change write - - register boundary validate still by real PluginHost original method execute,
 * this in zero approximate, zero second set validate: only catch via real ui.screen invoke declaration, does not static scan.
 */
function withClientCapture(
  definition: PluginDefinition,
  sink: Array<{ module: string; export: string }>,
  screenIds: string[],
): PluginDefinition {
  const original = definition.definePlugin;
  return {
    ...definition,
    async definePlugin(ctx) {
      const uiProxy = new Proxy(ctx.ui, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            const spec = args[0] as { client?: { module?: unknown; export?: unknown } } | undefined;
            const client = spec?.client;
            if (
              client !== undefined &&
              typeof client === 'object' &&
              typeof (client as { module?: unknown }).module === 'string' &&
              typeof (client as { export?: unknown }).export === 'string'
            ) {
              sink.push({
                module: (client as { module: string }).module,
                export: (client as { export: string }).export,
              });
            }
            // only record via real ui.screen invoke and eventually register succeeded (original method not throws) view id;
            // spec.id shape validate by original registerUi execute, this in only matter after record, do not pre- judge.
            if (prop === 'screen' && spec !== undefined && typeof (spec as { id?: unknown }).id === 'string') {
              screenIds.push((spec as { id: string }).id);
            }
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      }) as typeof ctx.ui;
      return original({ ...ctx, ui: uiProxy });
    },
  };
}

/**
 * doctor all chain dedicated use temp directory: real register temporary dataDir and client compile cache shared use a
 * scratch directory,doctor return before unify clean up (does not use host cache directory: avoid and produce cache
 * directory write competition; cache hash semantics consistent, does not affect produce compile correct).
 */
async function withDoctorScratch<T>(fn: (scratch: string) => Promise<T>): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), 'helm-doctor-'));
  try {
    return await fn(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
