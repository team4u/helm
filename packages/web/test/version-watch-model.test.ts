/**
 * 版本感知纯逻辑测试（version-watch-model.ts + 脏状态桥接）：
 * 生产/dev 入口识别、合法 HTML 解析、探测失败不误报、版本变化判定、节流判定、
 * WebView-safe 刷新 URL 构造与防环名额、待命草稿与 Composer 脏状态聚合
 * （自动刷新挂起条件的纯事实源）。
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

/** 测试隔离：记录本文件注册过的 Composer 上报键，afterEach 统一清除。 */
const usedComposerKeys: string[] = []
function reportComposerDirty(key: string, snapshot: ComposerDirtySnapshot): void {
  if (!usedComposerKeys.includes(key)) usedComposerKeys.push(key)
  setComposerDirty(key, snapshot)
}

/** 真实 Vite 构建形态的 index.html（head 内唯一 module script + 内联主题脚本 + css link）。 */
const builtIndexHtml = (src: string): string =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8" /><title>Helm</title>` +
  `<script>(function () { try { localStorage.getItem('x') } catch (_) {} })()</script>` +
  `<script type="module" crossorigin src="${src}"></script>` +
  `<link rel="stylesheet" crossorigin href="/assets/index-CssHash.css" /></head>` +
  `<body><div id="root"></div></body></html>`

const docOf = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')

const CLEAN_COMPOSER: ComposerDirtySnapshot = { hasDraftText: false, editingEntry: false, hasAttachments: false, busy: false }

// ---------------------------------------------------------------------------
// 入口识别（当前 document）
// ---------------------------------------------------------------------------

test('生产入口识别：唯一 /assets/ module script（含 crossorigin 构建形态）即指纹', { timeout: 60_000 }, () => {
  const doc = docOf(builtIndexHtml('/assets/index-BE2B9fA8.js'))
  assert.equal(detectDocumentProductionEntry(doc), '/assets/index-BE2B9fA8.js')
})

test('入口指纹忽略 src 查询/片段参数：部署通道附加的防缓存参数不改变指纹', { timeout: 60_000 }, () => {
  const doc = docOf(builtIndexHtml('/assets/index-Q.js?v=2&x=1#frag'))
  assert.equal(detectDocumentProductionEntry(doc), '/assets/index-Q.js', '指纹只取路径部分')
  // 同一路径带不带参数是同一构建：不产生第二个候选（多义即休眠）
  const two = docOf(
    '<html><head>' +
      '<script type="module" src="/assets/index-Q.js?v=1"></script>' +
      '<script type="module" src="/assets/index-Q.js?v=2"></script>' +
      '</head></html>',
  )
  assert.equal(detectDocumentProductionEntry(two), '/assets/index-Q.js', '查询参数不同的同路径脚本去重为唯一候选')
})

test('Vite dev 入口（/src/main.tsx）休眠：返回 null，不猜测', { timeout: 60_000 }, () => {
  const dev = docOf(
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
  )
  assert.equal(detectDocumentProductionEntry(dev), null)
})

test('无 module script（单测/SSR 形态）与空白文档返回 null', { timeout: 60_000 }, () => {
  assert.equal(detectDocumentProductionEntry(docOf('<!doctype html><html><body><div id="root"></div></body></html>')), null)
})

test('入口候选多义不猜：两个不同 /assets/ module script 返回 null', { timeout: 60_000 }, () => {
  const ambiguous = docOf(
    '<html><head>' +
      '<script type="module" src="/assets/index-one.js"></script>' +
      '<script type="module" src="/assets/other-two.js"></script>' +
      '</head></html>',
  )
  assert.equal(detectDocumentProductionEntry(ambiguous), null)
  assert.equal(parseIndexHtmlProductionEntry(builtIndexHtml('/assets/a.js').replace('</head>', '<script type="module" src="/assets/b.js"></script></head>')), null)
})

test('非 /assets/ 同源路径（CDN 绝对地址、相对路径）与内联脚本不计入候选', { timeout: 60_000 }, () => {
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
// 探测（/index.html no-store 拉取与边界校验）
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

test('探测成功：唯一化 URL 拉取 /index.html，no-store + Accept: text/html + 唯一生产入口', { timeout: 60_000 }, async () => {
  const stub = makeProbeStub(() => htmlResponse(builtIndexHtml('/assets/index-NEW.js')))
  const entry = await probeLatestIndexEntry({ ...stub.deps, nonce: () => 'n-1' })
  assert.equal(entry, '/assets/index-NEW.js')
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0]!.url, '/index.html?helmv=n-1', 'URL 携带防缓存唯一参数（穿透忽略 no-store 的 WebView 缓存层）')
  assert.equal(stub.calls[0]!.init.cache, 'no-store')
  assert.deepEqual(stub.calls[0]!.init.headers, { accept: 'text/html' })
  assert.equal(buildIndexProbeUrl('zzz'), '/index.html?helmv=zzz')
})

test('探测 URL 随机数默认自增：同毫秒内两次探测的 URL 也互不相同', { timeout: 60_000 }, async () => {
  const stub = makeProbeStub(() => htmlResponse(builtIndexHtml('/assets/index-A.js')))
  await probeLatestIndexEntry(stub.deps)
  await probeLatestIndexEntry(stub.deps)
  assert.equal(stub.calls.length, 2)
  assert.notEqual(stub.calls[0]!.url, stub.calls[1]!.url, '缺省随机数含自增序号，必然唯一')
})

test('探测失败矩阵：网络错误 / 非 2xx / 非 HTML / 结构无效 / dev 形态均返回 null 且不抛错', { timeout: 60_000 }, async () => {
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
// 版本判定状态机与节流
// ---------------------------------------------------------------------------

test('版本判定：初始不 pending；变化 pending；部署回滚复原；探测失败保持原判定', { timeout: 60_000 }, () => {
  let state = initialVersionWatchState('/assets/index-A.js')
  assert.equal(versionUpdatePending(state), false)

  state = applyProbeResult(state, '/assets/index-A.js')
  assert.equal(versionUpdatePending(state), false)

  state = applyProbeResult(state, '/assets/index-B.js')
  assert.equal(versionUpdatePending(state), true)

  // 探测失败：维持 B 的判定，不误判也不回退
  state = applyProbeResult(state, null)
  assert.equal(versionUpdatePending(state), true)

  // 部署回滚（B 又回到 A）：待刷新状态解除
  state = applyProbeResult(state, '/assets/index-A.js')
  assert.equal(versionUpdatePending(state), false)
})

test('刷新触发判定：pending + clean + 未触发才 reload；dirty / 已触发 / 未 pending 均不触发', { timeout: 60_000 }, () => {
  const base = initialVersionWatchState('/assets/index-A.js')
  const pending = applyProbeResult(base, '/assets/index-B.js')
  assert.equal(versionUpdatePending(pending), true)
  assert.equal(shouldReloadNow({ pending: true, dirty: false, reloadTriggered: false }), true)
  assert.equal(shouldReloadNow({ pending: true, dirty: true, reloadTriggered: false }), false)
  assert.equal(shouldReloadNow({ pending: true, dirty: false, reloadTriggered: true }), false)
  assert.equal(shouldReloadNow({ pending: false, dirty: false, reloadTriggered: false }), false)
  assert.equal(versionUpdatePending(base), false)
})

test('节流判定：无历史立即放行；窗口内拒绝；窗口过后放行', { timeout: 60_000 }, () => {
  const now = 1_000_000
  assert.equal(probeAllowed(now, null, 5_000), true)
  assert.equal(probeAllowed(now, now - 4_999, 5_000), false)
  assert.equal(probeAllowed(now, now - 5_000, 5_000), true)
})

test('焦点保护判定：仅 input/textarea 视为文本输入', { timeout: 60_000 }, () => {
  const input = docOf('<html><body><input id="a" /></body></html>').querySelector('input')
  const textarea = docOf('<html><body><textarea></textarea></body></html>').querySelector('textarea')
  const div = docOf('<html><body><div></div></body></html>').querySelector('div')
  assert.equal(isTextInputElement(input), true)
  assert.equal(isTextInputElement(textarea), true)
  assert.equal(isTextInputElement(div), false)
  assert.equal(isTextInputElement(null), false)
})

test('挂起原因文案：draft/modal/组合各有准确描述，null 无文案', { timeout: 60_000 }, () => {
  assert.ok(versionDeferHint('draft').includes('未提交的输入内容'))
  assert.ok(!versionDeferHint('draft').includes('窗口'), '纯草稿不提窗口')
  assert.ok(versionDeferHint('modal').includes('打开的窗口'))
  assert.ok(!versionDeferHint('modal').includes('输入内容'), '纯弹窗不提输入内容')
  assert.ok(versionDeferHint('draft-and-modal').includes('未提交的输入内容'))
  assert.ok(versionDeferHint('draft-and-modal').includes('打开的窗口'))
  assert.equal(versionDeferHint(null), '')
  for (const reason of ['draft', 'modal', 'draft-and-modal'] as const) {
    assert.ok(versionDeferHint(reason).endsWith('已暂缓自动刷新'))
  }
})

/** 内存 Storage 替身（可注入故障）。 */
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

test('preloadError 自动重试名额：首次占用成功并落标记，之后拒绝；storage 不可用一律拒绝', { timeout: 60_000 }, () => {
  const storage = memoryStorage()
  assert.equal(claimPreloadAutoReload(storage), true, '首次占用成功')
  assert.equal(storage.getItem(PRELOAD_RELOAD_GUARD_KEY), '1', '跨 reload 标记已写入')
  assert.equal(claimPreloadAutoReload(storage), false, '名额已用完拒绝')
  assert.equal(claimPreloadAutoReload(null), false, '无 storage 拒绝')
  assert.equal(claimPreloadAutoReload(memoryStorage({ getItem: true })), false, '读取抛错拒绝')
  assert.equal(claimPreloadAutoReload(memoryStorage({ setItem: true })), false, '写入抛错拒绝（不误允自动刷新）')
})

// ---------------------------------------------------------------------------
// WebView-safe 刷新 URL 构造
// ---------------------------------------------------------------------------

test('刷新 URL：nonce=null 保留 pathname/query/hash 的干净同址导航，不引入任何参数', { timeout: 60_000 }, () => {
  assert.equal(buildVersionReloadUrl({ pathname: '/', search: '', hash: '' }, null), '/')
  assert.equal(buildVersionReloadUrl({ pathname: '/', search: '', hash: '#/c/7' }, null), '/#/c/7')
  assert.equal(buildVersionReloadUrl({ pathname: '/', search: '?x=1&y=2', hash: '#/a/p1' }, null), '/?x=1&y=2#/a/p1')
})

test('刷新 URL cache-buster：追加唯一参数且每次替换旧值，绝不累积；hash 原样保留在末尾', { timeout: 60_000 }, () => {
  const loc = { pathname: '/', search: '', hash: '#/a/p1' }
  assert.equal(buildVersionReloadUrl(loc, 'aaa'), `/?${RELOAD_CACHE_BUSTER_PARAM}=aaa#/a/p1`)
  // 已带旧 buster 的地址再次构造：替换而非叠加
  assert.equal(
    buildVersionReloadUrl({ ...loc, search: `?${RELOAD_CACHE_BUSTER_PARAM}=aaa` }, 'bbb'),
    `/?${RELOAD_CACHE_BUSTER_PARAM}=bbb#/a/p1`,
    '旧 buster 被替换，不累积',
  )
  // nonce=null 清理历史 buster，其余既有参数原样保留
  assert.equal(
    buildVersionReloadUrl({ ...loc, search: `?x=1&${RELOAD_CACHE_BUSTER_PARAM}=aaa&y=2` }, null),
    '/?x=1&y=2#/a/p1',
  )
  // 连续升级多次也只存在一个 buster 参数
  const first = buildVersionReloadUrl(loc, 'n1')
  const second = buildVersionReloadUrl({ ...loc, search: first.slice(first.indexOf('?')) }, 'n2')
  assert.equal(second.match(new RegExp(`${RELOAD_CACHE_BUSTER_PARAM}=`, 'g'))?.length, 1, '地址中至多一个 buster')
})

// ---------------------------------------------------------------------------
// 指纹自动刷新跨页防环
// ---------------------------------------------------------------------------

test('指纹自动刷新跨页防环：同一目标入口只自动发起一次；不同入口/无证据放行', { timeout: 60_000 }, () => {
  const storage = memoryStorage()
  assert.equal(claimFingerprintAutoReload(storage, '/assets/index-B.js'), true, '首次对 B 发起：允许并记录')
  assert.equal(storage.getItem(FINGERPRINT_RELOAD_GUARD_KEY), '/assets/index-B.js')
  assert.equal(claimFingerprintAutoReload(storage, '/assets/index-B.js'), false, '同入口再次自动发起：拒绝（上次未落地，防环）')
  assert.equal(claimFingerprintAutoReload(storage, '/assets/index-C.js'), true, '新部署（不同入口）：正常允许')
  assert.equal(claimFingerprintAutoReload(storage, null), true, '无指纹证据（不应发生）：放行，不拦截')
  assert.equal(claimFingerprintAutoReload(null, '/assets/index-B.js'), true, 'storage 不可用（隐私模式）：放行')
  assert.equal(claimFingerprintAutoReload(memoryStorage({ getItem: true }), '/assets/index-B.js'), true, '读取抛错放行')
  assert.equal(claimFingerprintAutoReload(memoryStorage({ setItem: true }), '/assets/index-D.js'), true, '写入抛错放行（fail-open）')
})

// ---------------------------------------------------------------------------
// 待命草稿脏状态（版本刷新挂起条件之一）
// ---------------------------------------------------------------------------

test('待命草稿脏状态：空草稿干净；text/localFiles/uploaded/sending 任一即脏', { timeout: 60_000 }, () => {
  const key = standbyDraftKey({ panel: 'primary', profileId: 'p1' })
  assert.equal(standbyDraftsDirty(), false)

  updateStandbyDraft(key, { text: '  ' })
  assert.equal(standbyDraftsDirty(), false, '纯空白正文不算未提交内容')

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

test('待命草稿订阅：聚合脏状态翻转时收到通知', { timeout: 60_000 }, () => {
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
// Composer 脏状态桥接（版本刷新挂起条件之二）
// ---------------------------------------------------------------------------

test('Composer 脏状态桥接：实例键隔离、聚合、卸载清除与订阅', { timeout: 60_000 }, () => {
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

  // 主屏与分屏同屏渲染同一会话：两个实例键互不覆盖
  reportComposerDirty('composer-primary', { ...CLEAN_COMPOSER, hasDraftText: true })
  reportComposerDirty('composer-split', CLEAN_COMPOSER)
  assert.equal(composerDirty(), true, '任一实例脏即聚合脏')

  clearComposerDirty('composer-primary')
  assert.equal(composerDirty(), false, '脏实例卸载后聚合复原')
  assert.ok(notified >= 2, '聚合布尔翻转触发订阅')

  // clean 快照重复上报不触发订阅（聚合值未变）
  const before = notified
  reportComposerDirty('composer-split', CLEAN_COMPOSER)
  assert.equal(notified, before)

  clearComposerDirty('composer-split')
  off()
})

test('Composer 脏状态桥接：busy（发送/上传在途）也构成未提交现场', { timeout: 60_000 }, () => {
  reportComposerDirty('composer-busy', { ...CLEAN_COMPOSER, busy: true })
  assert.equal(composerDirty(), true)
})
