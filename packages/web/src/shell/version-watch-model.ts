/**
 * Pure version-awareness and auto-refresh logic for the Web frontend
 * (no React, no DOM side effects):
 *
 * - Version fingerprint = the hashed `/assets/<name>` path of the production
 *   entry module script. No Vite config change, no version.json, no kernel HTTP
 *   change: static hosting always serves index.html with no-cache, so
 *   re-fetching the page entry (/index.html) with `cache: 'no-store'` plus a
 *   uniquified URL yields the latest fingerprint;
 * - The current page fingerprint is read from the document exactly once at
 *   startup (a unique `/assets/` module script counts as a production entry);
 *   Vite dev's `/src/main.tsx`, unit-test/SSR documents have no production
 *   entry and the probe sleeps entirely (returns null, never misjudges);
 * - A failed probe (network error / non-2xx / non-HTML / invalid structure /
 *   ambiguous entry) is simply inconclusive this round: failure is never
 *   treated as a version change and never alters the existing verdict;
 * - A bootId change is only a "probe now" trigger, not proof of an update:
 *   whether to refresh is always decided by entry-fingerprint comparison
 *   (see use-version-watcher.ts).
 */
export const INDEX_PROBE_URL = '/index.html'

import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'

/** Production-entry fingerprint: same-origin absolute path `/assets/<name>.js` (the default Vite base '/' build shape). */
const PRODUCTION_ENTRY_PATTERN = /^\/assets\/[A-Za-z0-9_.@-]+\.js$/

/**
 * Collect production-entry candidates from the document: a deduplicated list of
 * `<script type="module" src="/assets/…">`. Strictly requires type=module plus a
 * same-origin `/assets/` absolute path: plugin clients are dynamically imported
 * from Blob URLs (producing no script tags) and Vite preload only injects link
 * tags, so real builds have exactly one candidate; inline theme scripts (no
 * type=module) are excluded naturally.
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
    if (src === null) continue
    // The fingerprint takes only the path: a query/fragment on src (e.g. a
    // cache-busting parameter appended by the deploy pipeline) does not change
    // the artifact identity — otherwise one build would be misjudged as new.
    const path = src.split(/[?#]/, 1)[0]!
    if (!PRODUCTION_ENTRY_PATTERN.test(path)) continue
    if (!sources.includes(path)) sources.push(path)
  }
  return sources
}

/**
 * Detect the production-entry fingerprint of the current document.
 * Returns the fingerprint only when the candidate is unique; 0 candidates
 * (dev `/src/main.tsx`, unit tests, SSR) or several (structure cannot confirm
 * the host entry) return null — the probe sleeps and never guesses.
 */
export function detectDocumentProductionEntry(doc: Document): string | null {
  const candidates = productionEntryCandidates(doc)
  return candidates.length === 1 ? candidates[0]! : null
}

/**
 * Parse the production-entry fingerprint out of a probe response body.
 * Uses the structured DOMParser (environments without DOMParser honestly
 * return null instead of degrading to string guessing); only a unique
 * candidate is valid — 0 or several are treated as an invalid structure.
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

/** Probe dependencies (injected fetch; production is window.fetch, tests may substitute). */
export interface IndexEntryProbeDeps {
  fetchHtml: (url: string, init: RequestInit) => Promise<Response>
  /** Nonce for uniquifying the probe URL (default timestamp+sequence; tests may inject a fixed value). */
  nonce?: () => string
}

/** Probe-URL cache-busting parameter name: some WebView cache layers ignore
 *  `cache: 'no-store'`, so URL-level uniquification makes every probe hit a
 *  different full URL — URL-keyed caches usually fetch a fresh document for it
 *  (per spec a different URL is a different cache entry), but custom WebView
 *  shells/proxies may still interfere; unverified on real devices, residual
 *  risk noted in the task report. */
const INDEX_PROBE_CACHE_PARAM = 'helmv'

/** Default nonce: timestamp + in-process sequence, so even two probes within the same millisecond differ. */
let probeNonceSeq = 0

/** Build the probe URL (pure exported function, reproducible in tests and diagnostics). */
export function buildIndexProbeUrl(nonce: string): string {
  const params = new URLSearchParams({ [INDEX_PROBE_CACHE_PARAM]: nonce })
  return `${INDEX_PROBE_URL}?${params.toString()}`
}

/**
 * Probe the latest production-entry fingerprint: fetch /index.html with a
 * uniquified URL + `cache: 'no-store'` + `Accept: text/html`, then validate
 * layer by layer — 2xx response, HTML content-type, and a unique production
 * entry parsed out.
 * Any failing layer returns null (inconclusive this round); no throw, no misjudgement.
 */
export async function probeLatestIndexEntry(deps: IndexEntryProbeDeps): Promise<string | null> {
  let response: Response
  const nonce = (deps.nonce ?? (() => {
    probeNonceSeq += 1
    return `${Date.now().toString(36)}-${probeNonceSeq}`
  }))()
  try {
    response = await deps.fetchHtml(buildIndexProbeUrl(nonce), {
      cache: 'no-store',
      headers: { accept: 'text/html' },
    })
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
// Version-verdict state machine
// ---------------------------------------------------------------------------

/** Version-watch state: currentEntry is the page-load fingerprint (enablement prerequisite), latestEntry the last successful probe. */
export interface VersionWatchState {
  currentEntry: string
  latestEntry: string | null
}

export function initialVersionWatchState(currentEntry: string): VersionWatchState {
  return { currentEntry, latestEntry: currentEntry }
}

/** Fold a probe result into state: failure (null) returns as-is, success advances latestEntry (deploy rollbacks recover). */
export function applyProbeResult(state: VersionWatchState, entry: string | null): VersionWatchState {
  if (entry === null) return state
  return { ...state, latestEntry: entry }
}

/** Whether a refreshable new version exists (latest entry ≠ current page entry). */
export function versionUpdatePending(state: VersionWatchState): boolean {
  return state.latestEntry !== null && state.latestEntry !== state.currentEntry
}

/**
 * Refresh-trigger verdict: all three must hold — refresh pending (from
 * fingerprint comparison or the vite:preloadError stale-assets fallback), no
 * local unsubmitted work, and no refresh triggered yet. reloadTriggered guards
 * against reload loops and duplicate triggers.
 */
export function shouldReloadNow(input: { pending: boolean; dirty: boolean; reloadTriggered: boolean }): boolean {
  return input.pending && !input.dirty && !input.reloadTriggered
}

/** Throttle verdict for visibilitychange / focus probes (now and lastProbeAt share one clock). */
export function probeAllowed(now: number, lastProbeAt: number | null, throttleMs: number): boolean {
  if (lastProbeAt === null) return true
  return now - lastProbeAt >= throttleMs
}

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

/**
 * Editable text input element check: matches enabled, non-readOnly text-like
 * `<input>` (excluding buttons/checkboxes/radios/files/etc.) and `<textarea>`.
 */
export function isTextInputElement(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el === null) return false
  if (el.tagName === 'TEXTAREA') {
    const textarea = el as HTMLTextAreaElement
    return !textarea.disabled && !textarea.readOnly
  }
  if (el.tagName === 'INPUT') {
    const input = el as HTMLInputElement
    if (input.disabled || input.readOnly) return false
    const type = (input.getAttribute('type') ?? input.type ?? 'text').trim().toLowerCase()
    return !NON_TEXT_INPUT_TYPES.has(type)
  }
  return false
}

/**
 * Whether an input element belongs to a Composer / StandbyComposer whose draft
 * state is already tracked authoritatively by `composer-dirty` / `standby-model`.
 */
export function isComposerManagedInput(el: Element | null): boolean {
  return el !== null && el.getAttribute('data-composer-draft-managed') === 'true'
}

/**
 * Whether an element is still connected and not hidden via `hidden` or
 * `display: none` on itself or any ancestor (covers React `<Activity mode="hidden">`).
 */
export function isElementVisibleInDocument(el: Element | null): boolean {
  if (el === null || !el.isConnected) return false
  const win = el.ownerDocument?.defaultView
  let cur: Element | null = el
  while (cur !== null) {
    if ((cur as HTMLElement).hidden === true) return false
    if ((cur as HTMLElement).style?.display === 'none') return false
    if (win !== null && win !== undefined) {
      try {
        if (win.getComputedStyle(cur).display === 'none') return false
      } catch {
        /* ignore detached/foreign elements */
      }
    }
    cur = cur.parentElement
  }
  return true
}

/** Auto-refresh defer reason (null = not deferred; drives the version-banner copy). */
export type VersionDeferReason =
  | 'draft'
  | 'background-draft'
  | 'modal'
  | 'draft-and-modal'
  | 'background-draft-and-modal'
  | null

/** Resolve defer reason with foreground draft taking precedence over background drafts. */
export function resolveVersionDeferReason(input: {
  foregroundDraft: boolean
  backgroundDraft: boolean
  modalOpen: boolean
}): VersionDeferReason {
  if (input.foregroundDraft) {
    return input.modalOpen ? 'draft-and-modal' : 'draft'
  }
  if (input.backgroundDraft) {
    return input.modalOpen ? 'background-draft-and-modal' : 'background-draft'
  }
  return input.modalOpen ? 'modal' : null
}

/** Defer reason → banner hint copy. */
export function versionDeferHint(
  reason: VersionDeferReason,
  t: WebMessageTranslator = englishWebTranslator,
): string {
  switch (reason) {
    case 'draft':
      return t('shell.version.deferDraft')
    case 'background-draft':
      return t('shell.version.deferBackgroundDraft')
    case 'modal':
      return t('shell.version.deferModal')
    case 'draft-and-modal':
      return t('shell.version.deferBoth')
    case 'background-draft-and-modal':
      return t('shell.version.deferBackgroundBoth')
    default:
      return ''
  }
}

// ---------------------------------------------------------------------------
// preloadError auto-refresh loop guard (one-shot budget across reloads)
// ---------------------------------------------------------------------------

/** sessionStorage marker key: this tab has consumed its preloadError-evidence auto-retry budget. */
export const PRELOAD_RELOAD_GUARD_KEY = 'helm:version-preload-reload'

/**
 * Try to claim the preloadError-evidence auto-refresh budget (once per tab).
 * Regular fingerprint-driven auto refresh does not pass through this guard.
 * Unavailable storage (read/write throwing) or an exhausted budget always
 * denies: keep the notice and allow only manual refresh, never loop across reloads.
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

// ---------------------------------------------------------------------------
// WebView-safe refresh (top-level navigation URL building) and the
// fingerprint auto-refresh cross-page loop guard
// ---------------------------------------------------------------------------

/** Read-only location facts for the refresh URL (a structural subset of Location; tests may inject a double). */
export interface VersionReloadUrlSource {
  readonly pathname: string
  readonly search: string
  readonly hash: string
}

/** Refresh execution location: `replace(url)` top-level navigation (production is window.location). */
export interface VersionReloadLocation extends VersionReloadUrlSource {
  replace(url: string): void
}

/**
 * Cache-busting parameter name for the refresh URL. Some mobile WebView shells
 * swallow `location.reload()` or serve the cached stale document for same-URL
 * navigation — `location.replace()` with a unique parameter goes through the
 * full top-level navigation pipeline and, per spec, hits a cache key that did
 * not exist before, usually forcing the cache layer to refetch the document;
 * custom shells/proxies may still interfere, so success is not promised. The
 * parameter lives only in the query (the hash is app routing and stays
 * untouched), and every build first strips the old value — never accumulating.
 */
export const RELOAD_CACHE_BUSTER_PARAM = 'helm_reload'

/**
 * Build the refresh-navigation URL: keep the current pathname, existing query
 * (historical busters stripped) and hash.
 * - nonce = null: clean same-URL navigation (true document-reload semantics;
 *   no parameter is introduced into the address);
 * - nonce non-null: append a unique cache-buster (each new value replaces the old).
 * The hash component is constant relative to the current address, so it never
 * forms a "fragment-only" pseudo-navigation (fragment deltas only scroll
 * without reloading the document) — always a real document reload.
 */
export function buildVersionReloadUrl(loc: VersionReloadUrlSource, nonce: string | null): string {
  const params = new URLSearchParams(loc.search)
  params.delete(RELOAD_CACHE_BUSTER_PARAM)
  if (nonce !== null) params.set(RELOAD_CACHE_BUSTER_PARAM, nonce)
  const search = params.toString()
  return `${loc.pathname}${search === '' ? '' : `?${search}`}${loc.hash}`
}

/** sessionStorage marker key: the target entry of the last fingerprint-driven
 *  auto refresh. It must be sessionStorage (a per-tab budget): a cross-tab
 *  shared localStorage would let concurrently open tabs eat each other's loop
 *  guard and hurt normal upgrades. */
export const FINGERPRINT_RELOAD_GUARD_KEY = 'helm:version-fingerprint-reload'

/**
 * Fingerprint-driven auto-refresh cross-page loop guard: the same target entry
 * auto-refreshes at most once per tab. When a WebView serves stale cache for
 * same-URL navigation you get "reload lands on the old document → probe sees
 * the new entry again → reload again" — from the second time on the same entry
 * no longer auto-refreshes; the banner and the manual action remain (manual is
 * unrestricted).
 * Same fail-closed discipline as the preloadError budget: unavailable storage
 * (null / read / write failing) always denies auto refresh — a WebView may
 * disable storage and keep serving stale cache at once, where allowing means
 * infinite cross-page auto refresh; keeping the banner plus manual refresh is
 * enough to complete the upgrade.
 */
export function claimFingerprintAutoReload(storage: Storage | null, latestEntry: string | null): boolean {
  if (latestEntry === null) return true
  if (storage === null) return false
  try {
    if (storage.getItem(FINGERPRINT_RELOAD_GUARD_KEY) === latestEntry) return false
    storage.setItem(FINGERPRINT_RELOAD_GUARD_KEY, latestEntry)
    return true
  } catch {
    return false
  }
}
