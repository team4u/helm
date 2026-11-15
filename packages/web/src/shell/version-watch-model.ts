/**
 * Web 前端版本感知与自动刷新纯逻辑（无 React、无 DOM 副作用）：
 *
 * - 版本指纹 = 生产构建入口 module script 的 `/assets/<name>` 带 hash 路径。
 *   不改 Vite 配置、不生成 version.json、不改内核 HTTP：静态托管对
 *   index.html 恒回 no-cache，直接以 `cache: 'no-store'` 重新拉取当前页面
 *   入口（/index.html）即可获得最新指纹；
 * - 当前页面指纹只在启动时读取一次 document（`/assets/` module script 唯一
 *   才视为生产入口）；Vite dev 的 `/src/main.tsx`、单测/SSR 无生产入口时
 *   探测器整体休眠（返回 null，永不误判）；
 * - 探测失败（网络错误 / 非 2xx / 非 HTML / 结构无效 / 入口多义）只是本次
 *   无结论，绝不把失败当作版本变更，也不改变既有判定；
 * - bootId 变化只是「快速触发探测」的信号，不等于产物一定更新：是否刷新
 *   一律由入口指纹比对决定（见 use-version-watcher.ts）。
 */
export const INDEX_PROBE_URL = '/index.html'

/** 生产入口指纹：同源绝对路径 `/assets/<name>.js`（Vite 默认 base '/' 构建形态）。 */
const PRODUCTION_ENTRY_PATTERN = /^\/assets\/[A-Za-z0-9_.@-]+\.js$/

/**
 * 收集文档中的生产入口候选：`<script type="module" src="/assets/…">` 去重列表。
 * 严格限定 type=module + 同源 `/assets/` 绝对路径：插件 client 走 Blob URL 动态
 * import（不产生 script 标签）、Vite 预加载只注入 link 标签，真实构建形态中
 * 候选唯一；任何内联主题脚本（无 type=module）天然排除。
 */
export function productionEntryCandidates(doc: Document): string[] {
  const sources: string[] = []
  let scripts: NodeListOf<HTMLScriptElement>
  try {
    scripts = doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')
  } catch {
    return []
  }
  for (const script of Array.from(scripts)) {
    const src = script.getAttribute('src')
    if (src === null || !PRODUCTION_ENTRY_PATTERN.test(src)) continue
    if (!sources.includes(src)) sources.push(src)
  }
  return sources
}

/**
 * 识别当前 document 的生产入口指纹。
 * 候选唯一才返回该指纹；0 个（dev `/src/main.tsx`、单测、SSR）或多个（结构
 * 无法确认宿主入口）一律返回 null——探测器休眠，绝不猜测。
 */
export function detectDocumentProductionEntry(doc: Document): string | null {
  const candidates = productionEntryCandidates(doc)
  return candidates.length === 1 ? candidates[0]! : null
}

/**
 * 解析探测响应正文中的生产入口指纹。
 * 使用结构化 DOMParser（无 DOMParser 的环境如实返回 null，不降级为字符串
 * 猜测）；候选唯一才有效，0 个或多个均视为结构无效。
 */
export function parseIndexHtmlProductionEntry(html: string): string | null {
  if (typeof DOMParser === 'undefined') return null
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return null
  }
  return detectDocumentProductionEntry(doc)
}

/** 探测依赖（fetch 注入；生产为 window.fetch，测试可替换）。 */
export interface IndexEntryProbeDeps {
  fetchHtml: (url: string, init: RequestInit) => Promise<Response>
}

/**
 * 探测最新生产入口指纹：`cache: 'no-store'` 拉取 /index.html，逐层校验
 * 响应成功（2xx）、HTML content-type、能解析出唯一生产入口。
 * 任一环节失败返回 null（本次探测无结论），不抛错、不误判。
 */
export async function probeLatestIndexEntry(deps: IndexEntryProbeDeps): Promise<string | null> {
  let response: Response
  try {
    response = await deps.fetchHtml(INDEX_PROBE_URL, { cache: 'no-store' })
  } catch {
    return null
  }
  if (!response.ok) return null
  const contentType = response.headers.get('content-type') ?? ''
  if (!/^\s*text\/html\b/i.test(contentType)) return null
  let html: string
  try {
    html = await response.text()
  } catch {
    return null
  }
  return parseIndexHtmlProductionEntry(html)
}

// ---------------------------------------------------------------------------
// 版本判定状态机
// ---------------------------------------------------------------------------

/** 版本感知状态：currentEntry 为页面加载时指纹（启用前提），latestEntry 为最近一次成功探测。 */
export interface VersionWatchState {
  currentEntry: string
  latestEntry: string | null
}

export function initialVersionWatchState(currentEntry: string): VersionWatchState {
  return { currentEntry, latestEntry: currentEntry }
}

/** 探测结果入状态：失败（null）原样返回，成功则推进 latestEntry（支持部署回滚复原）。 */
export function applyProbeResult(state: VersionWatchState, entry: string | null): VersionWatchState {
  if (entry === null) return state
  return { ...state, latestEntry: entry }
}

/** 是否存在待刷新的新版本（最新入口 ≠ 当前页面入口）。 */
export function versionUpdatePending(state: VersionWatchState): boolean {
  return state.latestEntry !== null && state.latestEntry !== state.currentEntry
}

/**
 * 刷新触发判定：待刷新（指纹比对或 vite:preloadError 资产失效兜底得出）、本地
 * 无未提交现场、尚未触发过刷新三者同时成立。reloadTriggered 防止 reload 循环
 * 与重复触发。
 */
export function shouldReloadNow(input: { pending: boolean; dirty: boolean; reloadTriggered: boolean }): boolean {
  return input.pending && !input.dirty && !input.reloadTriggered
}

/** visibilitychange / focus 触发探测的节流判定（now 与上次探测时刻同源时钟）。 */
export function probeAllowed(now: number, lastProbeAt: number | null, throttleMs: number): boolean {
  if (lastProbeAt === null) return true
  return now - lastProbeAt >= throttleMs
}

/** 保守表单编辑保护：当前焦点元素是否为文本输入（input/textarea）。 */
export function isTextInputElement(el: Element | null): boolean {
  return el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
}

/** 自动刷新挂起原因（null = 未挂起；版本横幅文案依据）。 */
export type VersionDeferReason = 'draft' | 'modal' | 'draft-and-modal' | null

/** 挂起原因 → 横幅补充文案（「未提交内容」同时覆盖草稿事实与焦点保护）。 */
export function versionDeferHint(reason: VersionDeferReason): string {
  switch (reason) {
    case 'draft':
      return '当前有未提交的输入内容，已暂缓自动刷新'
    case 'modal':
      return '当前有打开的窗口，已暂缓自动刷新'
    case 'draft-and-modal':
      return '当前有未提交的输入内容和打开的窗口，已暂缓自动刷新'
    default:
      return ''
  }
}

// ---------------------------------------------------------------------------
// preloadError 自动刷新防环（跨 reload 一次性名额）
// ---------------------------------------------------------------------------

/** sessionStorage 标记键：本 tab 已用完 preloadError 证据驱动的自动重试名额。 */
export const PRELOAD_RELOAD_GUARD_KEY = 'helm:version-preload-reload'

/**
 * 尝试占用 preloadError 证据驱动的自动刷新名额（每 tab 一次）。
 * 指纹变化驱动的正常自动刷新不经此守卫。storage 不可用（读写任一抛错）或
 * 名额已用完一律拒绝：保留提示仅允许用户手动刷新，绝不在跨 reload 后循环。
 */
export function claimPreloadAutoReload(storage: Storage | null): boolean {
  if (storage === null) return false
  try {
    if (storage.getItem(PRELOAD_RELOAD_GUARD_KEY) !== null) return false
    storage.setItem(PRELOAD_RELOAD_GUARD_KEY, '1')
    return true
  } catch {
    return false
  }
}
