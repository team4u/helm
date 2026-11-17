/**
 * Version-awareness pure-logic tests (version-watch-model.ts + the dirty-state
 * bridges): production/dev entry detection, valid-HTML parsing, probe failures
 * never misreport, version-change verdicts, throttle verdicts, WebView-safe
 * refresh-URL construction and loop-guard budgets, standby-draft and Composer
 * dirty-state aggregation (the pure fact sources of the auto-refresh defer
 * conditions).
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

import {
  applyProbeResult,
  buildIndexProbeUrl,
  buildVersionReloadUrl,
  claimFingerprintAutoReload,
  claimPreloadAutoReload,
  detectDocumentProductionEntry,
  FINGERPRINT_RELOAD_GUARD_KEY,
  initialVersionWatchState,
  isTextInputElement,
  parseIndexHtmlProductionEntry,
  PRELOAD_RELOAD_GUARD_KEY,
  probeAllowed,
  probeLatestIndexEntry,
  RELOAD_CACHE_BUSTER_PARAM,
  shouldReloadNow,
  versionDeferHint,
  versionUpdatePending,
  type IndexEntryProbeDeps,
} from '../src/shell/version-watch-model.js'
import {
  clearComposerDirty,
  composerDirty,
  isComposerDirtySnapshot,
  setComposerDirty,
  subscribeComposerDirty,
  type ComposerDirtySnapshot,
} from '../src/conversation/composer-dirty.js'
import {
  resetStandbyDrafts,
  standbyDraftKey,
  standbyDraftsDirty,
  subscribeStandbyDrafts,
  updateStandbyDraft,
} from '../src/conversation/standby-model.js'

afterEach(() => {
  resetStandbyDrafts()
  for (const key of usedComposerKeys) clearComposerDirty(key)
  usedComposerKeys.length = 0
})

/** Test isolation: record the Composer report keys registered by this file; afterEach clears them all. */
const usedComposerKeys: string[] = []
function reportComposerDirty(key: string, snapshot: ComposerDirtySnapshot): void {
  if (!usedComposerKeys.includes(key)) usedComposerKeys.push(key)
  setComposerDirty(key, snapshot)
}

/** An index.html in the real Vite build shape (a unique module script in head + an inline theme script + a css link). */
const builtIndexHtml = (src: string): string =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8" /><title>Helm</title>` +
  `<script>(function () { try { localStorage.getItem('x') } catch (_) {} })()</script>` +
  `<script type="module" crossorigin src="${src}"></script>` +
  `<link rel="stylesheet" crossorigin href="/assets/index-CssHash.css" /></head>` +
  `<body><div id="root"></div></body></html>`

const docOf = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')

const CLEAN_COMPOSER: ComposerDirtySnapshot = { hasDraftText: false, editingEntry: false, hasAttachments: false, busy: false }

// ---------------------------------------------------------------------------
// Entry detection (current document)
// ---------------------------------------------------------------------------

test('production entry detection: a unique /assets/ module script (crossorigin build shape included) is the fingerprint', { timeout: 60_000 }, () => {
  const doc = docOf(builtIndexHtml('/assets/index-BE2B9fA8.js'))
  assert.equal(detectDocumentProductionEntry(doc), '/assets/index-BE2B9fA8.js')
})

test('the entry fingerprint ignores src query/fragment params: deploy-pipeline cache-busters never change the fingerprint', { timeout: 60_000 }, () => {
  const doc = docOf(builtIndexHtml('/assets/index-Q.js?v=2&x=1#frag'))
  assert.equal(detectDocumentProductionEntry(doc), '/assets/index-Q.js', 'the fingerprint takes only the path part')
  // the same path with or without params is the same build: no second candidate (ambiguity sleeps)
  const two = docOf(
    '<html><head>' +
      '<script type="module" src="/assets/index-Q.js?v=1"></script>' +
      '<script type="module" src="/assets/index-Q.js?v=2"></script>' +
      '</head></html>',
  )
  assert.equal(detectDocumentProductionEntry(two), '/assets/index-Q.js', 'same-path scripts differing only in query params dedupe into one candidate')
})

test('a Vite dev entry (/src/main.tsx) sleeps: returns null, never guesses', { timeout: 60_000 }, () => {
  const dev = docOf(
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  )
  assert.equal(detectDocumentProductionEntry(dev), null)
})

test('no module script (unit-test/SSR shapes) and blank documents return null', { timeout: 60_000 }, () => {
  assert.equal(detectDocumentProductionEntry(docOf('<!doctype html><html><body><div id="root"></div></body></html>')), null)
})

test('ambiguous entry candidates are never guessed: two distinct /assets/ module scripts return null', { timeout: 60_000 }, () => {
  const ambiguous = docOf(
    '<html><head>' +
      '<script type="module" src="/assets/index-one.js"></script>' +
      '<script type="module" src="/assets/other-two.js"></script>' +
      '</head></html>',
  )
  assert.equal(detectDocumentProductionEntry(ambiguous), null)
  assert.equal(parseIndexHtmlProductionEntry(builtIndexHtml('/assets/a.js').replace('</head>', '<script type="module" src="/assets/b.js"></script></head>')), null)
})

test('non-/assets/ same-origin paths (CDN absolute URLs, relative paths) and inline scripts never count as candidates', { timeout: 60_000 }, () => {
  const doc = docOf(
    '<html><head>' +
      '<script>inline()</script>' +
      '<script type="module" src="https://cdn.example.com/assets/index-x.js"></script>' +
      '<script type="module" src="assets/relative.js"></script>' +
      '<script type="module" src="/assets/index-only.js"></script>' +
      '</head></html>',
  )
  assert.equal(detectDocumentProductionEntry(doc), '/assets/index-only.js')
})

// ---------------------------------------------------------------------------
// Probing (no-store /index.html fetch and boundary validation)
// ---------------------------------------------------------------------------

interface ProbeStub {
  calls: Array<{ url: string; init: RequestInit }>
  deps: IndexEntryProbeDeps
  respond: (response: () => Response | Promise<Response>) => void
}

function makeProbeStub(initial: () => Response | Promise<Response>): ProbeStub {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let respond = initial
  return {
    calls,
    deps: {
      fetchHtml: async (url, init) => {
        calls.push({ url, init })
        return respond()
      },
    },
    respond: (next) => {
      respond = next
    },
  }
}

const htmlResponse = (html: string, contentType = 'text/html; charset=utf-8'): Response =>
  new Response(html, { status: 200, headers: { 'content-type': contentType } })

test('probe success: fetches /index.html with a uniquified URL, no-store + Accept: text/html + a unique production entry', { timeout: 60_000 }, async () => {
  const stub = makeProbeStub(() => htmlResponse(builtIndexHtml('/assets/index-NEW.js')))
  const entry = await probeLatestIndexEntry({ ...stub.deps, nonce: () => 'n-1' })
  assert.equal(entry, '/assets/index-NEW.js')
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0]!.url, '/index.html?helmv=n-1', 'the URL carries a cache-busting unique param (for cache layers that may ignore no-store)')
  assert.equal(stub.calls[0]!.init.cache, 'no-store')
  assert.deepEqual(stub.calls[0]!.init.headers, { accept: 'text/html' })
  assert.equal(buildIndexProbeUrl('zzz'), '/index.html?helmv=zzz')
})

test('the default probe nonce auto-increments: two probes within the same millisecond still differ', { timeout: 60_000 }, async () => {
  const stub = makeProbeStub(() => htmlResponse(builtIndexHtml('/assets/index-A.js')))
  await probeLatestIndexEntry(stub.deps)
  await probeLatestIndexEntry(stub.deps)
  assert.equal(stub.calls.length, 2)
  assert.notEqual(stub.calls[0]!.url, stub.calls[1]!.url, 'the default nonce includes a sequence number and is necessarily unique')
})

test('probe failure matrix: network error / non-2xx / non-HTML / invalid structure / dev shape all return null without throwing', { timeout: 60_000 }, async () => {
  const networkError = makeProbeStub(() => {
    throw new TypeError('network down')
  })
  assert.equal(await probeLatestIndexEntry(networkError.deps), null)

  const http500 = makeProbeStub(() => new Response('boom', { status: 500 }))
  assert.equal(await probeLatestIndexEntry(http500.deps), null)

  const notHtml = makeProbeStub(() => htmlResponse('plain', 'text/plain; charset=utf-8'))
  assert.equal(await probeLatestIndexEntry(notHtml.deps), null)

  const jsonBody = makeProbeStub(() => htmlResponse('{"error":"x"}', 'application/json'))
  assert.equal(await probeLatestIndexEntry(jsonBody.deps), null)

  const noEntry = makeProbeStub(() => htmlResponse('<!doctype html><html><body>no scripts</body></html>'))
  assert.equal(await probeLatestIndexEntry(noEntry.deps), null)

  const devShape = makeProbeStub(() =>
    htmlResponse('<!doctype html><html><body><script type="module" src="/src/main.tsx"></script></body></html>'),
  )
  assert.equal(await probeLatestIndexEntry(devShape.deps), null)
})

// ---------------------------------------------------------------------------
// Version verdict state machine and throttling
// ---------------------------------------------------------------------------

test('version verdict: initially not pending; a change pends; a deploy rollback restores; a probe failure keeps the verdict', { timeout: 60_000 }, () => {
  let state = initialVersionWatchState('/assets/index-A.js')
  assert.equal(versionUpdatePending(state), false)

  state = applyProbeResult(state, '/assets/index-A.js')
  assert.equal(versionUpdatePending(state), false)

  state = applyProbeResult(state, '/assets/index-B.js')
  assert.equal(versionUpdatePending(state), true)

  // probe failure: keeps the B verdict — no misjudge, no rollback
  state = applyProbeResult(state, null)
  assert.equal(versionUpdatePending(state), true)

  // deploy rollback (B back to A): the pending-refresh state clears
  state = applyProbeResult(state, '/assets/index-A.js')
  assert.equal(versionUpdatePending(state), false)
})

test('refresh trigger verdict: reloads only when pending + clean + not yet triggered; dirty / already triggered / not pending never trigger', { timeout: 60_000 }, () => {
  const base = initialVersionWatchState('/assets/index-A.js')
  const pending = applyProbeResult(base, '/assets/index-B.js')
  assert.equal(versionUpdatePending(pending), true)
  assert.equal(shouldReloadNow({ pending: true, dirty: false, reloadTriggered: false }), true)
  assert.equal(shouldReloadNow({ pending: true, dirty: true, reloadTriggered: false }), false)
  assert.equal(shouldReloadNow({ pending: true, dirty: false, reloadTriggered: true }), false)
  assert.equal(shouldReloadNow({ pending: false, dirty: false, reloadTriggered: false }), false)
  assert.equal(versionUpdatePending(base), false)
})

test('throttle verdict: no history passes immediately; inside the window denies; after the window passes', { timeout: 60_000 }, () => {
  const now = 1_000_000
  assert.equal(probeAllowed(now, null, 5_000), true)
  assert.equal(probeAllowed(now, now - 4_999, 5_000), false)
  assert.equal(probeAllowed(now, now - 5_000, 5_000), true)
})

test('focus-protection verdict: only input/textarea count as text input', { timeout: 60_000 }, () => {
  const input = docOf('<html><body><input id="a" /></body></html>').querySelector('input')
  const textarea = docOf('<html><body><textarea></textarea></body></html>').querySelector('textarea')
  const div = docOf('<html><body><div></div></body></html>').querySelector('div')
  assert.equal(isTextInputElement(input), true)
  assert.equal(isTextInputElement(textarea), true)
  assert.equal(isTextInputElement(div), false)
  assert.equal(isTextInputElement(null), false)
})

test('defer-reason copy: draft/modal/combination each describe accurately; null has no copy', { timeout: 60_000 }, () => {
  assert.ok(versionDeferHint('draft').includes('Unsubmitted input'))
  assert.ok(!versionDeferHint('draft').includes('window'), 'a pure draft never mentions a window')
  assert.ok(versionDeferHint('modal').includes('window is open'))
  assert.ok(!versionDeferHint('modal').includes('input'), 'a pure modal never mentions input')
  assert.ok(versionDeferHint('draft-and-modal').includes('Unsubmitted input'))
  assert.ok(versionDeferHint('draft-and-modal').includes('an open window'))
  assert.equal(versionDeferHint(null), '')
  for (const reason of ['draft', 'modal', 'draft-and-modal'] as const) {
    assert.ok(versionDeferHint(reason).endsWith('auto refresh deferred'))
  }
})

/** In-memory Storage stand-in (faults injectable). */
function memoryStorage(failures: { getItem?: boolean; setItem?: boolean } = {}): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => {
      if (failures.getItem) throw new DOMException('read failed', 'SecurityError')
      return map.get(key) ?? null
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key)
    },
    setItem: (key: string, value: string) => {
      if (failures.setItem) throw new DOMException('write failed', 'QuotaExceededError')
      map.set(key, value)
    },
  }
}

test('preloadError auto-retry budget: the first claim succeeds and writes the marker, later ones are denied; unavailable storage always denies', { timeout: 60_000 }, () => {
  const storage = memoryStorage()
  assert.equal(claimPreloadAutoReload(storage), true, 'the first claim succeeds')
  assert.equal(storage.getItem(PRELOAD_RELOAD_GUARD_KEY), '1', 'the cross-reload marker is written')
  assert.equal(claimPreloadAutoReload(storage), false, 'an exhausted budget is denied')
  assert.equal(claimPreloadAutoReload(null), false, 'no storage denies')
  assert.equal(claimPreloadAutoReload(memoryStorage({ getItem: true })), false, 'a throwing read denies')
  assert.equal(claimPreloadAutoReload(memoryStorage({ setItem: true })), false, 'a throwing write denies (never mistakenly allows auto refresh)')
})

// ---------------------------------------------------------------------------
// WebView-safe refresh URL construction
// ---------------------------------------------------------------------------

test('refresh URL: nonce=null keeps pathname/query/hash for a clean same-URL navigation, introducing no parameters', { timeout: 60_000 }, () => {
  assert.equal(buildVersionReloadUrl({ pathname: '/', search: '', hash: '' }, null), '/')
  assert.equal(buildVersionReloadUrl({ pathname: '/', search: '', hash: '#/c/7' }, null), '/#/c/7')
  assert.equal(buildVersionReloadUrl({ pathname: '/', search: '?x=1&y=2', hash: '#/a/p1' }, null), '/?x=1&y=2#/a/p1')
})

test('refresh URL cache-buster: appends a unique param replacing the old value each time, never accumulating; the hash stays untouched at the end', { timeout: 60_000 }, () => {
  const loc = { pathname: '/', search: '', hash: '#/a/p1' }
  assert.equal(buildVersionReloadUrl(loc, 'aaa'), `/?${RELOAD_CACHE_BUSTER_PARAM}=aaa#/a/p1`)
  // building again on an address already carrying an old buster: replaced, not stacked
  assert.equal(
    buildVersionReloadUrl({ ...loc, search: `?${RELOAD_CACHE_BUSTER_PARAM}=aaa` }, 'bbb'),
    `/?${RELOAD_CACHE_BUSTER_PARAM}=bbb#/a/p1`,
    'the old buster is replaced, not accumulated',
  )
  // nonce=null strips historical busters; all other existing params stay untouched
  assert.equal(
    buildVersionReloadUrl({ ...loc, search: `?x=1&${RELOAD_CACHE_BUSTER_PARAM}=aaa&y=2` }, null),
    '/?x=1&y=2#/a/p1',
  )
  // even after multiple consecutive upgrades, at most one buster param exists
  const first = buildVersionReloadUrl(loc, 'n1')
  const second = buildVersionReloadUrl({ ...loc, search: first.slice(first.indexOf('?')) }, 'n2')
  assert.equal(second.match(new RegExp(`${RELOAD_CACHE_BUSTER_PARAM}=`, 'g'))?.length, 1, 'at most one buster in the address')
})

// ---------------------------------------------------------------------------
// Fingerprint auto-refresh cross-page loop guard
// ---------------------------------------------------------------------------

test('fingerprint auto-refresh cross-page loop guard: the same target entry auto-fires once; different entries pass', { timeout: 60_000 }, () => {
  const storage = memoryStorage()
  assert.equal(claimFingerprintAutoReload(storage, '/assets/index-B.js'), true, 'first attempt at B: allowed and recorded')
  assert.equal(storage.getItem(FINGERPRINT_RELOAD_GUARD_KEY), '/assets/index-B.js')
  assert.equal(claimFingerprintAutoReload(storage, '/assets/index-B.js'), false, 'auto-firing again at the same entry: denied (the last one never landed; loop guard)')
  assert.equal(claimFingerprintAutoReload(storage, '/assets/index-C.js'), true, 'a new deploy (different entry): normally allowed')
  assert.equal(claimFingerprintAutoReload(storage, null), true, 'no fingerprint evidence (unreachable defensive branch): passes')
})

test('fingerprint loop guard fail-closed: unavailable storage always denies auto refresh (a storage-disabled WebView + stale cache = infinite loop)', { timeout: 60_000 }, () => {
  assert.equal(claimFingerprintAutoReload(null, '/assets/index-B.js'), false, 'no storage denies')
  assert.equal(claimFingerprintAutoReload(memoryStorage({ getItem: true }), '/assets/index-B.js'), false, 'a throwing read denies')
  assert.equal(claimFingerprintAutoReload(memoryStorage({ setItem: true }), '/assets/index-D.js'), false, 'a throwing write denies (never passes without landing the marker)')
})

// ---------------------------------------------------------------------------
// Standby-draft dirtiness (defer condition one of version refresh)
// ---------------------------------------------------------------------------

test('standby-draft dirtiness: an empty draft is clean; any of text/localFiles/uploaded/sending makes it dirty', { timeout: 60_000 }, () => {
  const key = standbyDraftKey({ panel: 'primary', profileId: 'p1' })
  assert.equal(standbyDraftsDirty(), false)

  updateStandbyDraft(key, { text: '  ' })
  assert.equal(standbyDraftsDirty(), false, 'a purely blank body is no unsubmitted content')

  updateStandbyDraft(key, { text: 'hello' })
  assert.equal(standbyDraftsDirty(), true)
  updateStandbyDraft(key, { text: '' })
  assert.equal(standbyDraftsDirty(), false)

  updateStandbyDraft(key, { sending: true })
  assert.equal(standbyDraftsDirty(), true)
  updateStandbyDraft(key, { sending: false })

  updateStandbyDraft(key, { localFiles: [{ key: 'f', file: new File(['x'], 'a.txt'), name: 'a.txt', size: 1, mimeType: 'text/plain' }] })
  assert.equal(standbyDraftsDirty(), true)
  updateStandbyDraft(key, { localFiles: [] })

  updateStandbyDraft(key, { uploaded: [{ artifactId: 'a1', name: 'a', size: 1, mimeType: 'text/plain' }] })
  assert.equal(standbyDraftsDirty(), true)
})

test('standby-draft subscription: notified when the aggregate dirty flag flips', { timeout: 60_000 }, () => {
  const key = standbyDraftKey({ panel: 'split', profileId: 'p2' })
  let notified = 0
  const off = subscribeStandbyDrafts(() => {
    notified += 1
  })
  updateStandbyDraft(key, { text: 'draft' })
  assert.equal(standbyDraftsDirty(), true)
  assert.ok(notified >= 1)
  off()
})

// ---------------------------------------------------------------------------
// Composer dirty-state bridge (defer condition two of version refresh)
// ---------------------------------------------------------------------------

test('Composer dirty-state bridge: instance-key isolation, aggregation, unmount clearing and subscription', { timeout: 60_000 }, () => {
  assert.equal(composerDirty(), false)
  assert.equal(isComposerDirtySnapshot(CLEAN_COMPOSER), false)
  assert.equal(isComposerDirtySnapshot({ ...CLEAN_COMPOSER, hasDraftText: true }), true)
  assert.equal(isComposerDirtySnapshot({ ...CLEAN_COMPOSER, editingEntry: true }), true)
  assert.equal(isComposerDirtySnapshot({ ...CLEAN_COMPOSER, hasAttachments: true }), true)
  assert.equal(isComposerDirtySnapshot({ ...CLEAN_COMPOSER, busy: true }), true)

  let notified = 0
  const off = subscribeComposerDirty(() => {
    notified += 1
  })

  // the same conversation rendered on main and split screens simultaneously: two instance keys never overwrite each other
  reportComposerDirty('composer-primary', { ...CLEAN_COMPOSER, hasDraftText: true })
  reportComposerDirty('composer-split', CLEAN_COMPOSER)
  assert.equal(composerDirty(), true, 'any dirty instance makes the aggregate dirty')

  clearComposerDirty('composer-primary')
  assert.equal(composerDirty(), false, 'after the dirty instance unmounts, the aggregate restores')
  assert.ok(notified >= 2, 'aggregate boolean flips trigger the subscription')

  // repeated clean-snapshot reports do not trigger the subscription (aggregate unchanged)
  const before = notified
  reportComposerDirty('composer-split', CLEAN_COMPOSER)
  assert.equal(notified, before)

  clearComposerDirty('composer-split')
  off()
})

test('Composer dirty-state bridge: busy (in-flight send/upload) also constitutes an unsubmitted scene', { timeout: 60_000 }, () => {
  reportComposerDirty('composer-busy', { ...CLEAN_COMPOSER, busy: true })
  assert.equal(composerDirty(), true)
})
