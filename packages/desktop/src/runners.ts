/**
 * Hub child process run choose: explicit command > designate node > Electron inside embed Node(ELECTRON_RUN_AS_NODE)
 * > host Node. choose run must via run phase capability probe (Node version >= kernel floor and node:sqlite
 * available), probe result such as record; all choose unavailable when explicit errors, never static default fall back.
 *
 * compatibility measured (Electron 45.3.1 / inside embed Node 24.22.2):
 * - ELECTRON_RUN_AS_NODE=1 under node:sqlite available,native esbuild available,
 *   kernel dist/main.js complete start and graceful exit;
 * - utilityProcess must complete Electron app context, without show environment cannot independent verify,
 *   skeleton unify use child_process(verify path),utilityProcess act after continue isolated increase strong.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DesktopError } from './errors.js';
import type { DesktopConfig } from './config.js';
import { buildHubChildEnv, resolveHubEntry } from './config.js';

/** kernel for Node most low want seek (engines.node). */
export const KERNEL_NODE_FLOOR = '24.12.0';

// ---- strictly SemVer(desktop local unique implement) ----

/**
 * desktop independent of any work zone package (independent Electron shell, see package.json), cannot directly
 * reference @helm/protocol/semver; in this keep and its same contract local implement, supply runners 
 * Node floor decide and updater version contract shared use (contract with @helm/protocol/semver is allow).
 */
const STRICT_SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** illegal version number enter need to strictly SemVer path when throw; caller explicit handle, not silently swallow. */
export class SemverFormatError extends Error {
  constructor(text: string) {
    super(`illegal strictly SemVer:"${text}"(want seek x.y.z[-pre][+build], disallows v prefix)`);
    this.name = 'SemverFormatError';
  }
}

/** is otherwise is strictly SemVer(do not throws version, supply is otherwise legal decide scenario). */
export function isStrictSemver(text: string): boolean {
  return STRICT_SEMVER_RE.test(text);
}

/**
 * strictly SemVer priority compare:-1 / 0 / 1; any one side illegal throw SemverFormatError(explicit reject).
 * pre- publish priority: formal edition > pre- publish; number identifier by count value and < character parent number identifier; character parent segment ASCII dictionary order;
 * build metadata by specification does not participate compare.
 */
export function compareStrictSemver(a: string, b: string): number {
  if (!isStrictSemver(a)) throw new SemverFormatError(a);
  if (!isStrictSemver(b)) throw new SemverFormatError(b);
  const pa = a.match(STRICT_SEMVER_RE)!;
  const pb = b.match(STRICT_SEMVER_RE)!;
  const coreA = [Number(pa[1]), Number(pa[2]), Number(pa[3])] as const;
  const coreB = [Number(pb[1]), Number(pb[2]), Number(pb[3])] as const;
  for (let i = 0; i < 3; i++) {
    if (coreA[i]! > coreB[i]!) return 1;
    if (coreA[i]! < coreB[i]!) return -1;
  }
  const preA = pa[4] === undefined ? [] : pa[4].split('.');
  const preB = pb[4] === undefined ? [] : pb[4].split('.');
  if (preA.length === 0 && preB.length === 0) return 0;
  if (preA.length === 0) return 1;
  if (preB.length === 0) return -1;
  const len = Math.max(preA.length, preB.length);
  for (let i = 0; i < len; i++) {
    const sa = preA[i];
    const sb = preB[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    if (sa === sb) continue;
    const na = /^\d+$/.test(sa) ? Number(sa) : undefined;
    const nb = /^\d+$/.test(sb) ? Number(sb) : undefined;
    if (na !== undefined && nb !== undefined) return na > nb ? 1 : -1;
    if (na !== undefined) return -1;
    if (nb !== undefined) return 1;
    return sa < sb ? -1 : 1;
  }
  return 0;
}

/**
 * choose run is otherwise satisfy kernel run need to (Node >= 24.12.0 and node:sqlite available).
 * strictly SemVer opening path: version illegal or floor same number pre- publish (such as 24.12.0-nightly) all do not reach mark,
 * by caller with hub_runner_incapable explicit reject and such as on report probe to version.
 */
export function probeMeetsFloor(probe: RunnerProbe): boolean {
  return probe.sqlite && isStrictSemver(probe.node) && compareStrictSemver(probe.node, KERNEL_NODE_FLOOR) >= 0;
}

/** capability probe script: single row JSON output (-e direct review,CJS require semantics in all Node available). */
const PROBE_SOURCE =
  "const r={node:process.versions.node,electron:process.versions.electron||null,sqlite:true};" +
  "try{require('node:sqlite')}catch(e){r.sqlite=false}" +
  'console.log(JSON.stringify(r));';

export interface RunnerProbe {
  node: string;
  electron: string | null;
  sqlite: boolean;
}

export type RunnerKind = 'custom' | 'electron-node' | 'host-node';

export interface RunnerInfo {
  kind: RunnerKind;
  /** complete command line (argv0 + parameter). */
  command: string[];
  /** child process environment (already contains Hub variable;electron-node extra contains ELECTRON_RUN_AS_NODE=1). */
  env: NodeJS.ProcessEnv;
  nodeVersion?: string;
  /** not adopt choose note (honest record decide policy chain). */
  detail?: string;
}

/**
 * run phase probe single can execute file Node capability. failed (cannot execute / output cannot parse) explicit throw
 * hub_runner_probe_failed, attach output tail part diagnose.
 */
export async function probeRunner(
  executable: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunnerProbe> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return await new Promise<RunnerProbe>((resolve, reject) => {
    const child = spawn(executable, ['-e', PROBE_SOURCE], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new DesktopError('hub_runner_probe_failed', `run probe timeout: ${executable}`, { executable, timeoutMs }));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new DesktopError('hub_runner_probe_failed', `run cannot execute: ${executable}(${error.message})`, { executable }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.trim().startsWith('{'));
      if (code === 0 && line !== undefined) {
        try {
          const parsed = JSON.parse(line) as Partial<RunnerProbe>;
          if (typeof parsed.node === 'string' && typeof parsed.sqlite === 'boolean') {
            resolve({ node: parsed.node, electron: typeof parsed.electron === 'string' ? parsed.electron : null, sqlite: parsed.sqlite });
            return;
          }
        } catch {
          // under way unify diagnose
        }
      }
      reject(
        new DesktopError('hub_runner_probe_failed', `run probe output unavailable: ${executable}`, {
          executable,
          code,
          stdoutTail: out.slice(-500),
          stderrTail: err.slice(-500),
        }),
      );
    });
  });
}

export interface SelectRunnerContext {
  /** is otherwise run in Electron main process inside. */
  isElectron: boolean;
  /** when before process can execute file (Electron under is electron two enter system). */
  execPath: string;
  env: NodeJS.ProcessEnv;
  /** bundle after via real file start IPC bridge, avoid Node directly execute ASAR inside script. */
  childWrapper?: string;
  /** probe implement (test inject opening). */
  probe?: (executable: string, options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<RunnerProbe>;
  onSkip?: (kind: RunnerKind, reason: string) => void;
}

/**
 * choose Hub child process run.custom command does not capability probe (caller self bear semantics);
 * the rest choose one by one probe, adopt a satisfy kernel floor ; all unavailable explicit errors.
 */
export async function selectRunner(config: DesktopConfig, ctx: SelectRunnerContext): Promise<RunnerInfo> {
  const entry = resolveHubEntry(config);
  const probe = ctx.probe ?? probeRunner;

  // 1) explicit all command override: original adopt (HELM_DESKTOP_HUB_CMD).
  if (config.hubCommand !== undefined) {
    return { kind: 'custom', command: [...config.hubCommand], env: buildHubChildEnv(config, ctx.env), detail: 'explicit command override' };
  }
  // resolveHubEntry  payload source can carry additional parameter (such as start.mjs need to start sub- command),
  // hub-entry source constant without parameter;custom command original whole adopt.
  const hubArgs = entry === null ? [] : [ctx.childWrapper ?? fileURLToPath(new URL('../dist/hub-child.js', import.meta.url)), entry.entry, ...entry.args];

  // 2) explicit node override: still must capability probe (guarantee can run kernel).
  if (config.hubNode !== undefined) {
    const result = await probe(config.hubNode, { env: ctx.env });
    if (!probeMeetsFloor(result)) {
      throw new DesktopError(
        'hub_runner_incapable',
        `designate run do not satisfy kernel need to (Node >= ${KERNEL_NODE_FLOOR} and node:sqlite, actual Node ${result.node},sqlite=${result.sqlite})`,
        { executable: config.hubNode },
      );
    }
    return { kind: 'host-node', command: [config.hubNode, ...hubArgs], env: buildHubChildEnv(config, ctx.env), nodeVersion: result.node, detail: 'explicit node override' };
  }

  // 3) Electron inside embed Node: self contains preferred (independent of host install Node).
  if (ctx.isElectron) {
    const electronEnv = { ...buildHubChildEnv(config, ctx.env), ELECTRON_RUN_AS_NODE: '1' };
    try {
      const result = await probe(ctx.execPath, { env: electronEnv });
      if (probeMeetsFloor(result)) {
        return {
          kind: 'electron-node',
          command: [ctx.execPath, ...hubArgs],
          env: electronEnv,
          nodeVersion: result.node,
          detail: `Electron inside embed Node ${result.node}(ELECTRON_RUN_AS_NODE)`,
        };
      }
      ctx.onSkip?.('electron-node', `inside embed Node ${result.node} do not satisfy floor(sqlite=${result.sqlite})`);
    } catch (error) {
      ctx.onSkip?.('electron-node', error instanceof Error ? error.message : String(error));
    }
  }

  // 4) host Node(Electron outside i.e. process.execPath;Electron inside retreat back PATH  node).
  const hostNode = ctx.isElectron ? 'node' : ctx.execPath;
  const result = await probe(hostNode, { env: ctx.env });
  if (!probeMeetsFloor(result)) {
    throw new DesktopError(
      'hub_runner_incapable',
      `host Node do not satisfy kernel need to (Node >= ${KERNEL_NODE_FLOOR} and node:sqlite, actual Node ${result.node},sqlite=${result.sqlite})` +
        (ctx.isElectron ? ';Electron inside embed Node also unavailable (see pre- diagnose)' : ''),
      { executable: hostNode },
    );
  }
  return {
    kind: 'host-node',
    command: [hostNode, ...hubArgs],
    env: buildHubChildEnv(config, ctx.env),
    nodeVersion: result.node,
    detail: ctx.isElectron ? 'Electron inside embed Node unavailable, fall back host node' : 'host Node',
  };
}
