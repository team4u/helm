/**
 * managed environment together into (unique right threat in env/scoped-env.ts  ScopedExecutionEnv of outside
 * tool side group install layer):local inherit process.env(real PATH/HOME) and strip except managed HELM_*
 * variable (large small write do not sensitive), managed variable (HELM_ENV / HELM_HUB_URL /
 * HELM_CONVERSATION_ID / HELM_CWD / HELM_DATA_DIR / HELM_NODE_ID /
 * HELM_EXECUTION_SCOPE / managed HELM_TOKEN) by buildManagedEnv live together into fixed
 * override,deps.cliBinDir pre- inject PATH; remote node never carry Hub host environment, also never
 * together into by default PATH(node daemon itself merge node PATH/HOME and strip except node host
 * HELM_TOKEN); remote HELM_HUB_URL only take node register when on report real hubUrl(not on report
 * then omit the key, never fallback Hub local machine address). this where do not another establish second set together into rule.
 */
import { createHash } from 'node:crypto'
import { composeExecutionEnv, MANAGED_EXEC_ENV_VARS } from '../../env/scoped-env.js'
import type { HelmToolDeps } from '../tool-deps.js'

/** group install tool environment:process.env < options.env < managed variable (fixed override, see buildManagedEnv). */
export function buildToolEnv(
  deps: HelmToolDeps,
  cwd: string,
  conversationId?: number,
  extraEnv?: Record<string, string>,
  nodeId: string = 'local',
): Record<string, string> {
  return composeExecutionEnv(nodeId, buildManagedEnv(deps, cwd, conversationId, nodeId), extraEnv, {
    cliBinDir: deps.cliBinDir,
  })
}

/**
 * execute effect domain anchor:HELM_EXECUTION_SCOPE = `helm-<sha256 before 24 hex>`.
 * input only contains non- secret execute fact (Helm instance identifier dataDir, conversation ID, node ID, actual
 * cwd, array JSON serialization guard against isolate symbol ambiguity); same conversation same target many command constant identical, across
 * conversation/node/worktree/Helm instance different. it is supply tool explicit adopt stable asset naming hint
 * (lock file/temp directory/cache prefix etc.), is not OS sandbox, does not promise automatically isolated third way
 * daemon; never contains any secret.
 */
export function executionScopeHash(
  dataDir: string,
  conversationId: number | undefined,
  nodeId: string,
  cwd: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([dataDir, conversationId ?? 0, nodeId, cwd]))
    .digest('hex')
  return `helm-${digest.slice(0, 24)}`
}

/** managed identity variable name large write collection:stash/profile everything large small write change body all must not provide (Windows
 *  env name large small write do not sensitive,lowercase alias can in child process read when hijack canonical value). */
const MANAGED_ENV_UPPER = new Set<string>(MANAGED_EXEC_ENV_VARS.map((name) => name.toUpperCase()))

/**
 * host managed environment variable (excludes process.env): conversation SecretStash inject + fixed override
 * HELM_ENV / HELM_HUB_URL / HELM_CONVERSATION_ID / HELM_CWD / HELM_EXECUTION_SCOPE /
 * (only local)HELM_DATA_DIR, and managed HELM_TOKEN(without managed token when never pass-through same name inherit value).
 * stash key hit managed identity variable (contains large small write change body) when one rule strip except (Windows env name large small write
 * do not sensitive, alias hijack back connect/identity/effect domain variable); managed value only in this together into canonical name.
 * local(inherit process.env) and remote (does not carry host process environment) shared use this construct.
 * options.stashEnv can override by default all leap secret (external spawn most small authorization use:
 * pass {} i.e. does not carry any conversation secret, only keep managed HELM_*).
 * remote dedicated use semantics:
 * - HELM_HUB_URL only take node register when on report real back connect address (guard constant); node not on report
 *   when omit the key (daemon side keep its shellEnv real hubUrl), never fallback
 *   deps.hubUrl(that may is Hub local machine 127.0.0.1, remote cannot reach);
 * - HELM_DATA_DIR is Hub local machine path, do not inject remote (guard against node mistakenly use Hub disk path);
 * - HELM_TOKEN is Hub process managed token: remote child process rely on it via HTTP back connect Hub authentication
 *  (verifyToken recognize process inside summary; honest boundary:token will appear in remote machine memory/environment,
 *   and local machine child process same right, does not promise for remote machine zero leak leak).
 */
export function buildManagedEnv(
  deps: HelmToolDeps,
  cwd: string,
  conversationId?: number,
  nodeId: string = 'local',
  options: { stashEnv?: Record<string, string> } = {},
): Record<string, string> {
  const stashEnv =
    options.stashEnv !== undefined
      ? options.stashEnv
      : conversationId === undefined
        ? {}
        : deps.stashEnvFor(conversationId)
  // stash one rule must not carry managed identity variable (contains large small write change body): managed value only by under way fixed override
  // together into canonical name;secret hit helm_execution_scope / Helm_Cwd etc. alias when
  // directly strip except (Windows env name large small write do not sensitive, alias can hijack child process read). copy use
  // expand semantics (DefineOwnProperty) keep __proto__ etc. self has key, strip except use delete.
  const safeStashEnv: Record<string, string> = { ...stashEnv }
  for (const key of Object.keys(stashEnv)) {
    if (MANAGED_ENV_UPPER.has(key.toUpperCase())) delete safeStashEnv[key]
  }
  const managedToken = deps.processToken?.()
  // remote back connect address guard constant: only use node register when on report real hubUrl; not on report then omit the key,
  // never fallback deps.hubUrl(Hub local machine address for remote cannot reach).
  const nodeHubUrl = nodeId !== 'local' ? deps.envFabric?.getNodeHubUrl(nodeId) : undefined
  const hubUrl = nodeId === 'local' ? deps.hubUrl : nodeHubUrl
  const env: Record<string, string> = {
    ...safeStashEnv,
    HELM_ENV: '1',
    ...(hubUrl !== undefined ? { HELM_HUB_URL: hubUrl } : {}),
    HELM_CONVERSATION_ID: String(conversationId ?? 0),
    HELM_CWD: cwd,
    ...(nodeId === 'local' ? { HELM_DATA_DIR: deps.dataDir } : {}),
    HELM_NODE_ID: nodeId,
    HELM_EXECUTION_SCOPE: executionScopeHash(deps.dataDir, conversationId, nodeId, cwd),
  }
  if (managedToken === undefined) delete env['HELM_TOKEN']
  else env['HELM_TOKEN'] = managedToken
  return env
}
