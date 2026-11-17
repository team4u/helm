/**
 * Shared test harness for `builtin:workflow` client tests inside `@helm/plugins/test`:
 * - Registers happy-dom and bridges React / ReactDOM / Lucide / @helm/plugin-client
 *   onto `CLIENT_SHARED_GLOBALS` so real esbuild-compiled client modules share the host
 *   React & SDK instances without importing `@helm/web`;
 * - Supports both stub mode (`mountSharedPluginNamespaces()` + `setWorkflowClientStub`)
 *   and real SDK hook mode (`mountSharedPluginNamespaces({ realHooks: true })` +
 *   `createWorkflowHostHarness`), forwarding `useConversation(id, { includeDetail })`
 *   options in both modes.
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as ReactTypes from 'react'
import type * as SDKTypes from '@helm/plugin-client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type {
  AskSpec,
  ConversationDetail,
  ConversationLive,
  ConversationSummary,
} from '@helm/protocol'
import type { WorkflowRunSummary } from '../../src/contracts.js'

if (typeof window === 'undefined' || typeof document === 'undefined') {
  try {
    GlobalRegistrator.register()
  } catch {
    // Already registered in this test process.
  }
}

// Import React / ReactDOM / Radix-backed @helm/plugin-client only AFTER
// GlobalRegistrator registers window & document so Radix Popover's layout/DOM hooks see a real browser environment.
const { CLIENT_SHARED_GLOBALS, compilePluginClientModule } = await import('@helm/plugin-build')
const SDK = await import('@helm/plugin-client')

const req = createRequire(new URL('../../../plugin-client/package.json', import.meta.url))
export const React = req('react') as typeof ReactTypes
export const ReactDOM = req('react-dom') as unknown
export const ReactDOMClient = req('react-dom/client') as {
  createRoot: (container: Element) => { render(node: ReactTypes.ReactNode): void; unmount(): void }
}
export const ReactDOMServer = req('react-dom/server') as {
  renderToString: (element: ReactTypes.ReactElement) => string
}
export const ReactJsxRuntime = req('react/jsx-runtime') as Record<string, unknown>
export const LucideReact = req('lucide-react') as Record<string, unknown>

export const { act } = React
export const { createRoot } = ReactDOMClient
export const { renderToString } = ReactDOMServer
export { SDK }

const HERE = dirname(fileURLToPath(import.meta.url))
export const WORKFLOW_CLIENT_ROOT = resolve(HERE, '../../src/workflow/client')
export const WORKFLOW_CLIENT_CACHE_DIR = resolve(HERE, '../../../../node_modules/.cache/helm-test-workflow-clients')
mkdirSync(WORKFLOW_CLIENT_CACHE_DIR, { recursive: true })

export interface WorkflowClientStubOptions {
  docValue?: unknown
  conversations?: unknown[]
  conversation?: (id: number | undefined, options?: { includeDetail?: boolean }) => Record<string, unknown>
}

let stub: WorkflowClientStubOptions = {}
let currentHookMode: 'stub' | 'real' = 'stub'

export function setWorkflowClientStub(options: WorkflowClientStubOptions = {}): void {
  stub = options
}

const stubPluginClientNamespace = {
  ...SDK,
  usePluginDoc: () => stub.docValue,
  usePluginSessionDoc: () => stub.docValue,
  useConversations: () => stub.conversations ?? [],
  useConversation: (id: number | undefined, options?: { includeDetail?: boolean }) =>
    stub.conversation?.(id, options) ?? {
      summary: undefined,
      detail: undefined,
      live: undefined,
      pendingAsks: [],
      loadError: undefined,
      reload: () => {},
    },
}

export function mountSharedPluginNamespaces(options: { realHooks?: boolean } = {}): void {
  currentHookMode = options.realHooks === true ? 'real' : 'stub'
  const g = globalThis as Record<string, unknown>
  g.React = React
  g.IS_REACT_ACT_ENVIRONMENT = true
  g[CLIENT_SHARED_GLOBALS['react']!] = React
  g[CLIENT_SHARED_GLOBALS['react-dom']!] = ReactDOM
  g[CLIENT_SHARED_GLOBALS['react-dom/client']!] = ReactDOMClient
  g[CLIENT_SHARED_GLOBALS['react/jsx-runtime']!] = ReactJsxRuntime
  g[CLIENT_SHARED_GLOBALS['lucide-react']!] = LucideReact
  g[CLIENT_SHARED_GLOBALS['@helm/plugin-client']!] =
    options.realHooks === true ? SDK : stubPluginClientNamespace
}

export async function importWorkflowClientModule(
  moduleRef = 'index.tsx',
  cacheDir = WORKFLOW_CLIENT_CACHE_DIR,
): Promise<Record<string, unknown>> {
  const { code } = await compilePluginClientModule('builtin:workflow', WORKFLOW_CLIENT_ROOT, moduleRef, cacheDir)
  // Keep #stub and #real module instances distinct in Node's ESM cache because
  // compiled bundles destructure @helm/plugin-client hooks at module load time.
  return (await import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}#${currentHookMode}`)) as Record<
    string,
    unknown
  >
}

export async function importWorkflowModels(
  cacheDir = WORKFLOW_CLIENT_CACHE_DIR,
): Promise<typeof import('../../src/workflow/client/models.ts')> {
  return (await importWorkflowClientModule('models.ts', cacheDir)) as unknown as typeof import('../../src/workflow/client/models.ts')
}

export function makeConvSummary(
  id: number,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary {
  return {
    id,
    title: `子会话 ${id}`,
    profileId: 'coder',
    tags: [],
    cwd: '/tmp',
    model: '',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

export interface WorkflowHostLog {
  actions: Array<{ pluginId: string; actionId: string; input: unknown }>
  drawers: number[]
  workbenchTabs: string[]
  workbenchOpens: boolean[]
  screens: string[]
  notices: Array<{ message: string; tone: string }>
  loadDetailCalls: number[]
  activeToolCallIds: Set<string>
}

export function createWorkflowHostHarness(init: {
  conversationId: number
  conversations?: ConversationSummary[]
  conversationDetails?: Record<number, ConversationDetail>
  conversationLives?: Record<number, ConversationLive>
  pendingAsks?: AskSpec[]
  loadErrors?: Record<string, string>
  runsByConversation?: Record<number, WorkflowRunSummary[]>
  pluginDocs?: Record<string, unknown>
  locale?: SDKTypes.HelmLocale
  onAction?: (pluginId: string, actionId: string, input: unknown) => Promise<unknown> | unknown
}) {
  const activeToolCallIds = new Set<string>()
  const log: WorkflowHostLog = {
    actions: [],
    drawers: [],
    workbenchTabs: [],
    workbenchOpens: [],
    screens: [],
    notices: [],
    loadDetailCalls: [],
    activeToolCallIds,
  }
  let currentConversations = init.conversations ?? [makeConvSummary(init.conversationId, { ownedBy: 'human' })]
  const emptyRuns: WorkflowRunSummary[] = []
  const sessionRuns = new Map<number, WorkflowRunSummary[]>()
  for (const [k, v] of Object.entries(init.runsByConversation ?? {})) {
    sessionRuns.set(Number(k), v)
  }
  const sessionStates = new Map<string, { hasValue: boolean; deleted: boolean; connected: boolean; value: unknown }>()
  const listeners = new Set<() => void>()
  const hostListeners = new Set<() => void>()

  const getState = (key: { pluginId: string; docName: string; conversationId: number }) => {
    const cacheKey = `${key.pluginId}/${key.docName}/${key.conversationId}`
    let cur = sessionStates.get(cacheKey)
    if (key.docName === 'runs') {
      const runs = sessionRuns.get(key.conversationId) ?? emptyRuns
      if (cur === undefined || (cur.value as { runs: WorkflowRunSummary[] }).runs !== runs) {
        cur = { hasValue: true, deleted: false, connected: true, value: { runs } }
        sessionStates.set(cacheKey, cur)
      }
      return cur
    }
    if (cur === undefined) {
      cur = { hasValue: true, deleted: false, connected: true, value: undefined }
      sessionStates.set(cacheKey, cur)
    }
    return cur
  }

  const basePort: SDKTypes.PluginClientHostPort = {
    authenticated: true,
    theme: 'dark',
    locale: init.locale,
    conversations: currentConversations,
    conversationDetails: init.conversationDetails ?? {},
    conversationLives: init.conversationLives ?? {},
    pendingAsks: init.pendingAsks ?? [],
    loadErrors: init.loadErrors ?? {},
    plugins: [],
    screens: [],
    pluginDocs: init.pluginDocs ?? {},
    ensurePluginDoc: async () => undefined,
    getPluginSessionDoc: async (_p, _d, convId) => ({ runs: sessionRuns.get(convId) ?? emptyRuns }),
    subscribeSessionDoc: (_key, listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSessionDocState: getState,
    invokePluginAction: async (pluginId, actionId, input) => {
      log.actions.push({ pluginId, actionId, input })
      if (init.onAction !== undefined) {
        return await init.onAction(pluginId, actionId, input)
      }
      return { ok: true }
    },
    submitConversationInput: async () => undefined,
    openTarget: (target) => {
      log.screens.push(target)
    },
    openConversationDrawer: (id) => {
      log.drawers.push(id)
    },
    openArtifactPreview: () => undefined,
    setWorkbenchOpen: (open) => {
      log.workbenchOpens.push(open)
    },
    setWorkbenchTab: (tab) => {
      log.workbenchTabs.push(tab)
    },
    notify: (message, tone) => {
      log.notices.push({ message, tone })
    },
    loadConversationDetail: (convId) => {
      log.loadDetailCalls.push(convId)
    },
    slots: {
      collectItems: () => [],
      renderItem: () => null,
    },
    markdown: {
      view: ({ text }) => React.createElement('div', { 'data-testid': 'markdown-view' }, text),
      codeBlock: ({ code }) => React.createElement('pre', null, code),
    },
  }

  const ctx = SDK.createPluginClientContext(basePort, 'builtin:workflow', init.conversationId)
  const toolActivityRegistry: SDKTypes.ToolActivityRegistry = {
    activeToolCallIds,
    registerActivity: (callId) => {
      activeToolCallIds.add(callId)
      return () => {
        activeToolCallIds.delete(callId)
      }
    },
  }

  function HarnessProvider({ children }: { children?: ReactTypes.ReactNode }) {
    const [, setTick] = React.useState(0)
    React.useEffect(() => {
      const fn = () => setTick((t) => t + 1)
      hostListeners.add(fn)
      return () => {
        hostListeners.delete(fn)
      }
    }, [])
    const activePort = React.useMemo(
      () => ({ ...basePort, conversations: currentConversations }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [currentConversations],
    )
    return React.createElement(
      SDK.PluginClientHostContext.Provider,
      { value: activePort },
      React.createElement(
        SDK.PluginClientContext.Provider,
        { value: ctx },
        React.createElement(SDK.ToolActivityContext.Provider, { value: toolActivityRegistry }, children),
      ),
    )
  }

  const wrap = (node: ReactTypes.ReactNode): ReactTypes.ReactElement =>
    React.createElement(HarnessProvider, null, node)

  const mountNode = (node: ReactTypes.ReactNode) => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(wrap(node))
    })
    return {
      container,
      rerender: (next: ReactTypes.ReactNode) => {
        act(() => {
          root.render(wrap(next))
        })
      },
      unmount: () => {
        act(() => {
          root.unmount()
        })
        container.remove()
      },
    }
  }

  const renderSsr = (node: ReactTypes.ReactNode): string => renderToString(wrap(node))

  const setRuns = (conversationId: number, runs: WorkflowRunSummary[]) => {
    sessionRuns.set(conversationId, runs)
    act(() => {
      for (const listener of [...listeners]) listener()
    })
  }

  const setConversations = (conversations: ConversationSummary[]) => {
    currentConversations = conversations
    basePort.conversations = conversations
    act(() => {
      for (const listener of [...hostListeners]) listener()
    })
  }

  return { log, port: basePort, ctx, mountNode, renderSsr, setRuns, setConversations }
}
