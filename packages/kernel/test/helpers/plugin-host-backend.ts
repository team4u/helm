/**
 * PluginHostBackend test fixture bottom seat (new contract:isClosing archive one is zero reference function,
 * profiles/skills/secrets/getConversationDetail etc. port must choose).
 *
 * convention:
 * - default only provide two class together default:isClosing constant false,redact constant etc. return;
 * - the rest not use host operation one rule explicit throw unsupported(501), never with succeeded empty response cover wrong;
 * - need to profile/skills true file behavior when use profile-file-host override for should port;
 * - class fixture inherit PluginHostBackendFixtureBase(construct must super());
 *   object literal fixture use createPluginHostBackendFixture() field spread after override
 *   (return object all is self has can enumeration property,spread do not lose method).
 * - method signature one rule Parameters/ReturnType derive self PluginHostBackend this body,
 *   sub- class override (contains more specific return type) day however compatibility, does not introduce never narrow.
 */
import { HelmError } from '@helm/protocol'
import type { PluginHostBackend } from '../../src/plugins/index.js'

function unsupported(what: string): never {
  throw new HelmError('unsupported', `test fixture not implemented host capability:${what}(must in specific fixture override)`, 501)
}

type Port<K extends keyof PluginHostBackend> = PluginHostBackend[K]

/**
 * class fixture base class: by default implement all away prototype method (sub- class override do not by obscure).
 * not override i.e. by real invoke operation will explicit throw unsupported, test such as failed.
 */
export class PluginHostBackendFixtureBase implements PluginHostBackend {
  isClosing(): boolean {
    return false
  }

  redact(text: string): string {
    return text
  }

  profiles: Port<'profiles'> = {
    list: () => unsupported('host.profiles.list'),
    get: () => unsupported('host.profiles.get'),
    getSystem: () => unsupported('host.profiles.getSystem'),
    save: () => unsupported('host.profiles.save'),
    directory: () => unsupported('host.profiles.directory'),
  }

  skills: Port<'skills'> = {
    list: () => unsupported('host.skills.list'),
    readFile: () => unsupported('host.skills.readFile'),
    directory: () => unsupported('host.skills.directory'),
    ensureSkill: () => unsupported('host.skills.ensureSkill'),
  }

  secrets: Port<'secrets'> = {
    get: () => unsupported('host.secrets.get'),
    set: () => unsupported('host.secrets.set'),
    delete: () => unsupported('host.secrets.delete'),
    addRedaction: () => unsupported('host.secrets.addRedaction'),
  }

  plugins: Port<'plugins'> = {
    doctorPlugin: () => unsupported('host.plugins.doctor'),
    installPlugin: () => unsupported('host.plugins.install'),
    updatePlugin: () => unsupported('host.plugins.update'),
    removePlugin: () => unsupported('host.plugins.remove'),
    enablePlugin: () => unsupported('host.plugins.enable'),
    disablePlugin: () => unsupported('host.plugins.disable'),
  }!

  setPluginConfig(...args: Parameters<Port<'setPluginConfig'>>): ReturnType<Port<'setPluginConfig'>> {
    void args
    unsupported('host.setPluginConfig')
  }

  dispatchTrigger(...args: Parameters<Port<'dispatchTrigger'>>): ReturnType<Port<'dispatchTrigger'>> {
    void args
    unsupported('host.dispatchTrigger')
  }

  submitInput(...args: Parameters<Port<'submitInput'>>): ReturnType<Port<'submitInput'>> {
    void args
    unsupported('host.submitInput')
  }

  createConversation(
    ...args: Parameters<Port<'createConversation'>>
  ): ReturnType<Port<'createConversation'>> {
    void args
    unsupported('host.createConversation')
  }

  forkConversation(
    ...args: Parameters<Port<'forkConversation'>>
  ): ReturnType<Port<'forkConversation'>> {
    void args
    unsupported('host.forkConversation')
  }

  listConversations(
    ...args: Parameters<Port<'listConversations'>>
  ): ReturnType<Port<'listConversations'>> {
    void args
    unsupported('host.listConversations')
  }

  getConversation(...args: Parameters<Port<'getConversation'>>): ReturnType<Port<'getConversation'>> {
    void args
    unsupported('host.getConversation')
  }

  getConversationDetail(
    ...args: Parameters<Port<'getConversationDetail'>>
  ): ReturnType<Port<'getConversationDetail'>> {
    void args
    unsupported('host.getConversationDetail')
  }

  updateConversation(
    ...args: Parameters<Port<'updateConversation'>>
  ): ReturnType<Port<'updateConversation'>> {
    void args
    unsupported('host.updateConversation')
  }

  abortConversation(
    ...args: Parameters<Port<'abortConversation'>>
  ): ReturnType<Port<'abortConversation'>> {
    void args
    unsupported('host.abortConversation')
  }

  abortConversationGuarded(
    ...args: Parameters<NonNullable<Port<'abortConversationGuarded'>>>
  ): ReturnType<NonNullable<Port<'abortConversationGuarded'>>> {
    void args
    unsupported('host.abortConversationGuarded')
  }

  submitInputGuarded(
    ...args: Parameters<NonNullable<Port<'submitInputGuarded'>>>
  ): ReturnType<NonNullable<Port<'submitInputGuarded'>>> {
    void args
    unsupported('host.submitInputGuarded')
  }

  getConversationOwnership(
    ...args: Parameters<Port<'getConversationOwnership'>>
  ): ReturnType<Port<'getConversationOwnership'>> {
    void args
    unsupported('host.getConversationOwnership')
  }

  listArtifacts(...args: Parameters<Port<'listArtifacts'>>): ReturnType<Port<'listArtifacts'>> {
    void args
    unsupported('host.listArtifacts')
  }

  getArtifact(...args: Parameters<Port<'getArtifact'>>): ReturnType<Port<'getArtifact'>> {
    void args
    unsupported('host.getArtifact')
  }

  completeText(...args: Parameters<Port<'completeText'>>): ReturnType<Port<'completeText'>> {
    void args
    unsupported('host.completeText')
  }

  executionEnv(...args: Parameters<Port<'executionEnv'>>): ReturnType<Port<'executionEnv'>> {
    void args
    unsupported('host.executionEnv')
  }

  withFileLock<T>(
    _path: string,
    _fn: () => Promise<T>,
    _opts?: { signal?: AbortSignal },
  ): Promise<T> {
    unsupported('host.withFileLock')
  }

  atomicWriteFile(
    ...args: Parameters<Port<'atomicWriteFile'>>
  ): ReturnType<Port<'atomicWriteFile'>> {
    void args
    unsupported('host.atomicWriteFile')
  }

  buildSpawnEnv(...args: Parameters<Port<'buildSpawnEnv'>>): ReturnType<Port<'buildSpawnEnv'>> {
    void args
    unsupported('host.buildSpawnEnv')
  }

  manageConversation(
    ...args: Parameters<Port<'manageConversation'>>
  ): ReturnType<Port<'manageConversation'>> {
    void args
    unsupported('host.manageConversation')
  }

  markConversationOwnership(
    ...args: Parameters<Port<'markConversationOwnership'>>
  ): ReturnType<Port<'markConversationOwnership'>> {
    void args
    unsupported('host.markConversationOwnership')
  }

  spawnAgent(...args: Parameters<Port<'spawnAgent'>>): ReturnType<Port<'spawnAgent'>> {
    void args
    unsupported('host.spawnAgent')
  }

  runGate(...args: Parameters<Port<'runGate'>>): ReturnType<Port<'runGate'>> {
    void args
    unsupported('host.runGate')
  }

  execEnv(...args: Parameters<Port<'execEnv'>>): ReturnType<Port<'execEnv'>> {
    void args
    throw new HelmError('unsupported', 'this fixture do not execute node command', 501)
  }

  withFileMutationQueue<T>(
    _target: { nodeId: string; cwd: string; path: string },
    _fn: () => Promise<T>,
    _opts?: { signal?: AbortSignal },
  ): Promise<T> {
    throw new HelmError('unsupported', 'this fixture do not bear load file mutual exclusion queue', 501)
  }

  resolveSpawnTarget(
    ...args: Parameters<Port<'resolveSpawnTarget'>>
  ): ReturnType<Port<'resolveSpawnTarget'>> {
    void args
    unsupported('host.resolveSpawnTarget')
  }

  listActiveSpawnExecutions(
    ...args: Parameters<Port<'listActiveSpawnExecutions'>>
  ): ReturnType<Port<'listActiveSpawnExecutions'>> {
    void args
    unsupported('host.listActiveSpawnExecutions')
  }

  inspectNodePathUsage(
    ...args: Parameters<Port<'inspectNodePathUsage'>>
  ): ReturnType<Port<'inspectNodePathUsage'>> {
    void args
    unsupported('host.inspectNodePathUsage')
  }

  refreshModels(...args: Parameters<Port<'refreshModels'>>): ReturnType<Port<'refreshModels'>> {
    void args
    unsupported('host.refreshModels')
  }

  createAsk(...args: Parameters<Port<'createAsk'>>): ReturnType<Port<'createAsk'>> {
    void args
    unsupported('host.createAsk')
  }

  cancelAsk(...args: Parameters<Port<'cancelAsk'>>): ReturnType<Port<'cancelAsk'>> {
    void args
    unsupported('host.cancelAsk')
  }

  registerAskSeqResolver(
    ...args: Parameters<Port<'registerAskSeqResolver'>>
  ): ReturnType<Port<'registerAskSeqResolver'>> {
    void args
    unsupported('host.registerAskSeqResolver')
  }

  onEvent(...args: Parameters<Port<'onEvent'>>): ReturnType<Port<'onEvent'>> {
    void args
    unsupported('host.onEvent')
  }

  emitEvent(...args: Parameters<Port<'emitEvent'>>): ReturnType<Port<'emitEvent'>> {
    void args
    unsupported('host.emitEvent')
  }
}

/**
 * object literal fixture by default backend: and PluginHostBackendFixtureBase the same by default semantics,
 * all member is self has can enumeration property (can directly spread combine after override).
 */
export function createPluginHostBackendFixture(): PluginHostBackend {
  const d = new PluginHostBackendFixtureBase()
  const f = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => fn(...a)
  return {
    isClosing: () => d.isClosing(),
    redact: (text: string) => d.redact(text),
    profiles: {
      list: d.profiles.list,
      get: d.profiles.get,
      getSystem: d.profiles.getSystem,
      save: d.profiles.save,
      directory: d.profiles.directory,
    },
    skills: {
      list: d.skills.list,
      readFile: d.skills.readFile,
      directory: d.skills.directory,
      ensureSkill: d.skills.ensureSkill,
    },
    secrets: {
      get: d.secrets.get,
      set: d.secrets.set,
      delete: d.secrets.delete,
      addRedaction: d.secrets.addRedaction,
    },
    plugins: {
      doctorPlugin: d.plugins!.doctorPlugin,
      installPlugin: d.plugins!.installPlugin,
      updatePlugin: d.plugins!.updatePlugin,
      removePlugin: d.plugins!.removePlugin,
      enablePlugin: d.plugins!.enablePlugin,
      disablePlugin: d.plugins!.disablePlugin,
    },
    setPluginConfig: f(d.setPluginConfig),
    dispatchTrigger: f(d.dispatchTrigger),
    submitInput: f(d.submitInput),
    submitInputGuarded: f(d.submitInputGuarded),
    createConversation: f(d.createConversation),
    forkConversation: f(d.forkConversation),
    listConversations: f(d.listConversations),
    getConversation: f(d.getConversation),
    getConversationDetail: f(d.getConversationDetail),
    updateConversation: f(d.updateConversation),
    abortConversation: f(d.abortConversation),
    abortConversationGuarded: f(d.abortConversationGuarded),
    getConversationOwnership: f(d.getConversationOwnership),
    listArtifacts: f(d.listArtifacts),
    getArtifact: f(d.getArtifact),
    completeText: f(d.completeText),
    executionEnv: f(d.executionEnv),
    withFileLock: <T,>(...args: Parameters<PluginHostBackend['withFileLock']>) =>
      d.withFileLock(...(args as [string, () => Promise<T>, { signal?: AbortSignal }?])) as Promise<T>,
    atomicWriteFile: f(d.atomicWriteFile),
    buildSpawnEnv: f(d.buildSpawnEnv),
    manageConversation: f(d.manageConversation),
    markConversationOwnership: f(d.markConversationOwnership),
    spawnAgent: f(d.spawnAgent),
    runGate: f(d.runGate),
    execEnv: f(d.execEnv),
    withFileMutationQueue: <T,>(...args: Parameters<PluginHostBackend['withFileMutationQueue']>) =>
      d.withFileMutationQueue(
        ...(args as unknown as [
          { nodeId: string; cwd: string; path: string },
          () => Promise<T>,
          { signal?: AbortSignal }?,
        ]),
      ),
    resolveSpawnTarget: f(d.resolveSpawnTarget),
    listActiveSpawnExecutions: f(d.listActiveSpawnExecutions),
    inspectNodePathUsage: f(d.inspectNodePathUsage),
    refreshModels: f(d.refreshModels),
    createAsk: f(d.createAsk),
    cancelAsk: f(d.cancelAsk),
    registerAskSeqResolver: f(d.registerAskSeqResolver),
    onEvent: f(d.onEvent),
    emitEvent: f(d.emitEvent),
  }
}
