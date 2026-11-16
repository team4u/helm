/**
 * 移动端侧栏滑动手势（方案 A）测试：
 * - 纯函数：阈值/轴主导触发条件、环境门禁、禁入目标（输入框/按钮/可选中文本/
 *   横向滚动容器）、意图分类、touchstart/touchend 轨迹状态步骤；
 * - hook：事件委托 handlers 的开/关/取消/多指状态流转（真实 React 渲染）；
 * - 结构契约：App.tsx 保留汉堡兜底并在壳根挂手势委托，responsive.css 移动端
 *   Rail 空间切换沉底拇指区 + 主题按钮分组区隔。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
const win = globalThis as unknown as Window & {
  happyDOM?: { setViewport: (viewport: { width?: number; height?: number }) => void }
}
win.happyDOM?.setViewport({ width: 480, height: 900 })
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
// happy-dom 全局就绪后再加载被测模块与 react-dom（模块仅在函数调用时访问 window）
const {
  SWIPE_TRIGGER_PX,
  SWIPE_AXIS_RATIO,
  isSidebarSwipeEnvironment,
  isSidebarSwipeBlockedTarget,
  sidebarSwipeIntentFor,
  qualifiesSidebarSwipe,
  beginSidebarSwipeTrack,
  finishSidebarSwipeTrack,
} = await import('../src/shell/sidebar-swipe-model.js')

test('手势常量契约：阈值约 56px，水平位移须明显大于垂直位移', { timeout: 60_000 }, () => {
  assert.equal(SWIPE_TRIGGER_PX, 56)
  assert.ok(SWIPE_AXIS_RATIO >= 2, '水平位移至少 2 倍于垂直位移才算明显主导')
})

test('qualifiesSidebarSwipe 关键触发条件（阈值边界 + 轴主导 + 方向）', { timeout: 60_000 }, () => {
  // 打开：右滑过阈值、垂直位移不超过水平一半
  assert.equal(qualifiesSidebarSwipe(56, 0, 'open'), true, '56px 恰好达阈值')
  assert.equal(qualifiesSidebarSwipe(55, 0, 'open'), false, '55px 未达阈值')
  assert.equal(qualifiesSidebarSwipe(120, 30, 'open'), true, '60 <= 120 满足 2 倍主导')
  assert.equal(qualifiesSidebarSwipe(120, 61, 'open'), false, '122 > 120 垂直过大')
  assert.equal(qualifiesSidebarSwipe(56, 28, 'open'), true, '28*2 = 56 恰好满足主导比')
  assert.equal(qualifiesSidebarSwipe(56, 29, 'open'), false, '29*2 = 58 超出主导比')
  assert.equal(qualifiesSidebarSwipe(-80, 0, 'open'), false, '左滑不构成打开手势')
  // 关闭：方向镜像为左滑
  assert.equal(qualifiesSidebarSwipe(-56, 10, 'close'), true)
  assert.equal(qualifiesSidebarSwipe(-55, 0, 'close'), false)
  assert.equal(qualifiesSidebarSwipe(80, 0, 'close'), false, '右滑不构成关闭手势')
  assert.equal(qualifiesSidebarSwipe(-120, 70, 'close'), false)
})

test('isSidebarSwipeEnvironment：粗指针或抽屉断点才启用，查询拆两条 OR', { timeout: 60_000 }, () => {
  // 视口 480px：落入抽屉断点（<=860px）即视为移动端环境
  assert.equal(isSidebarSwipeEnvironment(), true)
  const probes: string[] = []
  const stub = (queries: Record<string, boolean>) =>
    (query: string): { matches: boolean } => {
      probes.push(query)
      return { matches: queries[query] ?? false }
    }
  assert.equal(
    isSidebarSwipeEnvironment({ matchMedia: stub({ '(pointer: coarse)': true }) }),
    true,
    '粗指针启用',
  )
  assert.equal(
    isSidebarSwipeEnvironment({ matchMedia: stub({ '(max-width: 860px)': true }) }),
    true,
    '抽屉断点启用',
  )
  assert.equal(
    isSidebarSwipeEnvironment({ matchMedia: stub({}) }),
    false,
    '桌面宽视口 + 精确指针不启用',
  )
  assert.ok(
    probes.includes('(pointer: coarse)') && probes.includes('(max-width: 860px)'),
    '门禁须同时探测粗指针与抽屉断点两条查询',
  )
})

/** 构造手势 DOM 夹具：壳根(侧栏/遮罩/主舞台) + 主舞台内 composer-shell。 */
function buildGestureFixture(): {
  railButton: HTMLElement
  backdrop: HTMLElement
  stage: HTMLElement
  composerShell: HTMLElement
  composerBox: HTMLElement
  textarea: HTMLElement
  toolbarButton: HTMLElement
  bannerText: HTMLElement
  scrollChild: HTMLElement
} {
  document.body.innerHTML = ''
  const shell = document.createElement('div')
  shell.className = 'helm-shell'
  const rail = document.createElement('aside')
  rail.className = 'helm-sidebar'
  const railButton = document.createElement('button')
  railButton.className = 'rail-btn'
  rail.appendChild(railButton)
  const backdrop = document.createElement('button')
  backdrop.className = 'sidebar-backdrop'
  const stage = document.createElement('main')
  stage.className = 'helm-main-stage'
  const composerShell = document.createElement('div')
  composerShell.className = 'composer-shell'
  const composerInner = document.createElement('div')
  composerInner.className = 'composer-inner'
  const composerBox = document.createElement('div')
  composerBox.className = 'composer-box'
  const textarea = document.createElement('textarea')
  textarea.className = 'composer-textarea selectable'
  const toolbarButton = document.createElement('button')
  toolbarButton.className = 'btn'
  const bannerText = document.createElement('span')
  bannerText.className = 'composer-edit-banner-text'
  bannerText.textContent = '正在编辑历史消息'
  const scrollable = document.createElement('div')
  scrollable.setAttribute('style', 'overflow-x: auto')
  const scrollChild = document.createElement('span')
  scrollChild.textContent = ''
  scrollable.appendChild(scrollChild)
  composerBox.appendChild(textarea)
  composerBox.appendChild(toolbarButton)
  composerBox.appendChild(bannerText)
  composerBox.appendChild(scrollable)
  composerInner.appendChild(composerBox)
  composerShell.appendChild(composerInner)
  stage.appendChild(composerShell)
  shell.appendChild(rail)
  shell.appendChild(backdrop)
  shell.appendChild(stage)
  document.body.appendChild(shell)
  return { railButton, backdrop, stage, composerShell, composerBox, textarea, toolbarButton, bannerText, scrollChild }
}

test('isSidebarSwipeBlockedTarget：输入框/按钮/文本让位，容器骨架不拦', { timeout: 60_000 }, () => {
  const fixture = buildGestureFixture()
  assert.equal(isSidebarSwipeBlockedTarget(null), true, '无目标按禁入处理')
  assert.equal(isSidebarSwipeBlockedTarget(fixture.textarea), true, '输入框（textarea + .selectable）让位')
  assert.equal(isSidebarSwipeBlockedTarget(fixture.toolbarButton), true, '按钮让位')
  assert.equal(isSidebarSwipeBlockedTarget(fixture.bannerText), true, '直接持有文本的元素让位（文本选择）')
  assert.equal(isSidebarSwipeBlockedTarget(fixture.scrollChild), true, '横向滚动容器内让位')
  assert.equal(isSidebarSwipeBlockedTarget(fixture.composerBox), false, 'composer-box 骨架可起手势')
  assert.equal(isSidebarSwipeBlockedTarget(fixture.composerShell), false, 'composer-shell 骨架可起手势')
  // overflow-x 非 auto/scroll 的祖先不拦
  const clip = document.createElement('div')
  clip.setAttribute('style', 'overflow-x: hidden')
  const clipChild = document.createElement('span')
  clip.appendChild(clipChild)
  fixture.composerBox.appendChild(clip)
  assert.equal(isSidebarSwipeBlockedTarget(clipChild), false, 'overflow-x: hidden 不算横向滚动容器')
})

test('sidebarSwipeIntentFor：开/关意图分类与门禁', { timeout: 60_000 }, () => {
  const fixture = buildGestureFixture()
  const enabled = { sidebarOpen: false, environmentEnabled: true }
  assert.equal(sidebarSwipeIntentFor(fixture.composerBox, enabled), 'open', '侧栏关：composer-box 起点可开')
  assert.equal(sidebarSwipeIntentFor(fixture.textarea, enabled), null, '输入框起点不开')
  assert.equal(sidebarSwipeIntentFor(fixture.toolbarButton, enabled), null, '按钮起点不开')
  assert.equal(sidebarSwipeIntentFor(fixture.stage, enabled), null, '时间线区域不是手势面')
  assert.equal(
    sidebarSwipeIntentFor(fixture.composerBox, { sidebarOpen: false, environmentEnabled: false }),
    null,
    '非移动端/粗指针环境不启用',
  )
  assert.equal(sidebarSwipeIntentFor(null, enabled), null)
  assert.equal(sidebarSwipeIntentFor({} as EventTarget, enabled), null, '非 Element 目标不构成手势')

  const open = { sidebarOpen: true, environmentEnabled: true }
  assert.equal(sidebarSwipeIntentFor(fixture.railButton, open), 'close', '侧栏开：抽屉内（含行按钮）起点可关')
  assert.equal(sidebarSwipeIntentFor(fixture.backdrop, open), 'close', '遮罩起点可关')
  assert.equal(sidebarSwipeIntentFor(fixture.composerBox, open), null, '侧栏开时 composer 不再响应开手势')
})

test('begin/finishSidebarSwipeTrack：轨迹状态步骤（多指、跟踪指、阈值）', { timeout: 60_000 }, () => {
  const fixture = buildGestureFixture()
  const touch = (id: number, x: number, y: number) => ({ identifier: id, clientX: x, clientY: y })
  // 多指不建轨迹
  assert.equal(
    beginSidebarSwipeTrack([touch(1, 0, 0), touch(2, 10, 10)], fixture.composerBox, {
      sidebarOpen: false,
      environmentEnabled: true,
    }),
    null,
  )
  // 禁入目标不建轨迹
  assert.equal(
    beginSidebarSwipeTrack([touch(1, 0, 0)], fixture.textarea, { sidebarOpen: false, environmentEnabled: true }),
    null,
  )
  // 右滑打开：跟踪指位移达标
  const openTrack = beginSidebarSwipeTrack([touch(7, 10, 300)], fixture.composerBox, {
    sidebarOpen: false,
    environmentEnabled: true,
  })
  assert.equal(openTrack?.intent, 'open')
  assert.equal(finishSidebarSwipeTrack(openTrack, [touch(7, 80, 306)]), 'open', 'dx=70 dy=6 达标开')
  assert.equal(finishSidebarSwipeTrack(openTrack, [touch(7, 16, 300)]), null, 'dx=6 未达阈值')
  assert.equal(finishSidebarSwipeTrack(openTrack, [touch(8, 80, 300)]), null, '非跟踪指抬不起手势')
  assert.equal(finishSidebarSwipeTrack(null, [touch(7, 80, 300)]), null, '无轨迹不动作')
  // 左滑关闭：侧栏打开时从抽屉内起点
  const closeTrack = beginSidebarSwipeTrack([touch(3, 200, 50)], fixture.railButton, {
    sidebarOpen: true,
    environmentEnabled: true,
  })
  assert.equal(closeTrack?.intent, 'close')
  assert.equal(finishSidebarSwipeTrack(closeTrack, [touch(3, 120, 54)]), 'close', 'dx=-80 dy=4 达标关')
  assert.equal(finishSidebarSwipeTrack(closeTrack, [touch(3, 155, 50)]), null, 'dx=-45 未达阈值不动作')
})

// ---------------------------------------------------------------------------
// hook 级：真实 React 渲染捕获委托 handlers，直接以事件对象驱动状态流转。
// ---------------------------------------------------------------------------
const React = await import('react')
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useSidebarSwipeGesture } = await import('../src/shell/sidebar-swipe-model.js')
const e = React.createElement

interface CapturedHandlers {
  onTouchStart: (event: { touches: Array<{ identifier: number; clientX: number; clientY: number }>; target: EventTarget | null }) => void
  onTouchEnd: (event: { changedTouches: Array<{ identifier: number; clientX: number; clientY: number }> }) => void
  onTouchCancel: (event: Record<string, unknown>) => void
}

let captured: CapturedHandlers | null = null
function GestureHarness(props: { sidebarOpen: boolean; onOpenChange: (open: boolean) => void }): null {
  captured = useSidebarSwipeGesture(props) as unknown as CapturedHandlers
  return null
}

function fakeStart(target: EventTarget | null, touches: Array<{ identifier: number; clientX: number; clientY: number }>): void {
  captured!.onTouchStart({ touches, target })
}

function fakeEnd(changedTouches: Array<{ identifier: number; clientX: number; clientY: number }>): void {
  captured!.onTouchEnd({ changedTouches })
}

test('useSidebarSwipeGesture：composer-shell 右滑开、侧栏左滑关、取消与多指不动作', { timeout: 60_000 }, async () => {
  const fixture = buildGestureFixture()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const openChanges: boolean[] = []
  await act(() => {
    root.render(e(GestureHarness, { sidebarOpen: false, onOpenChange: (open) => openChanges.push(open) }))
  })

  // 右滑打开：起点 composer-box，位移 72px 水平 / 4px 垂直
  fakeStart(fixture.composerBox, [{ identifier: 9, clientX: 12, clientY: 400 }])
  fakeEnd([{ identifier: 9, clientX: 84, clientY: 404 }])
  assert.deepEqual(openChanges, [true], '达标右滑触发打开')

  // 位移不足不动作
  fakeStart(fixture.composerBox, [{ identifier: 9, clientX: 12, clientY: 400 }])
  fakeEnd([{ identifier: 9, clientX: 40, clientY: 402 }])
  assert.deepEqual(openChanges, [true], '未达阈值不触发')

  // 输入框起点不动作
  fakeStart(fixture.textarea, [{ identifier: 9, clientX: 12, clientY: 400 }])
  fakeEnd([{ identifier: 9, clientX: 120, clientY: 402 }])
  assert.deepEqual(openChanges, [true], '禁入起点不触发')

  // touchcancel 清轨迹：随后的 touchend 不动作
  fakeStart(fixture.composerBox, [{ identifier: 9, clientX: 12, clientY: 400 }])
  captured!.onTouchCancel({})
  fakeEnd([{ identifier: 9, clientX: 120, clientY: 402 }])
  assert.deepEqual(openChanges, [true], '取消后残余 touchend 不触发')

  // 多指不建轨迹
  fakeStart(fixture.composerBox, [
    { identifier: 9, clientX: 12, clientY: 400 },
    { identifier: 10, clientX: 20, clientY: 420 },
  ])
  fakeEnd([{ identifier: 9, clientX: 120, clientY: 402 }])
  assert.deepEqual(openChanges, [true], '多指序列不触发')

  // 侧栏打开态：抽屉内左滑关闭
  await act(() => {
    root.render(e(GestureHarness, { sidebarOpen: true, onOpenChange: (open) => openChanges.push(open) }))
  })
  fakeStart(fixture.railButton, [{ identifier: 4, clientX: 260, clientY: 600 }])
  fakeEnd([{ identifier: 4, clientX: 170, clientY: 604 }])
  assert.deepEqual(openChanges, [true, false], '抽屉内左滑触发关闭')

  // 遮罩左滑关闭
  fakeStart(fixture.backdrop, [{ identifier: 5, clientX: 300, clientY: 500 }])
  fakeEnd([{ identifier: 5, clientX: 220, clientY: 502 }])
  assert.deepEqual(openChanges, [true, false, false], '遮罩左滑同样触发关闭')

  await act(() => {
    root.unmount()
  })
})

// ---------------------------------------------------------------------------
// 结构契约：App.tsx 委托挂载与汉堡兜底、responsive.css 移动端 Rail 布局。
// ---------------------------------------------------------------------------
const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const responsiveCss = readFileSync(new URL('../src/responsive.css', import.meta.url), 'utf8')

test('App.tsx 保留汉堡兜底并在壳根挂载侧栏滑动手势委托', { timeout: 60_000 }, () => {
  assert.match(appSource, /className="btn btn-ghost mobile-nav-toggle"/, '左上角汉堡按钮保留为显式兜底')
  assert.match(appSource, /aria-label="切换导航栏"/)
  assert.match(
    appSource,
    /useSidebarSwipeGesture\(\{\s*sidebarOpen,\s*onOpenChange: setSidebarOpen,?\s*\}\)/,
    '手势开合必须复用唯一 sidebarOpen 状态，不得新建平行导航状态',
  )
  assert.match(appSource, /onTouchStart=\{sidebarSwipe\.onTouchStart\}/, '壳根挂 onTouchStart 委托')
  assert.match(appSource, /onTouchEnd=\{sidebarSwipe\.onTouchEnd\}/, '壳根挂 onTouchEnd 委托')
  assert.match(appSource, /onTouchCancel=\{sidebarSwipe\.onTouchCancel\}/, '壳根挂 onTouchCancel 委托')
})

test('responsive.css 移动端 Rail：空间切换沉底拇指区，主题沉底分组区隔', { timeout: 60_000 }, () => {
  const start = responsiveCss.indexOf('@media (max-width: 860px)')
  assert.ok(start >= 0, 'responsive.css 必须保留 860px 抽屉断点')
  const next = responsiveCss.indexOf('@media', start + 1)
  const drawerBlock = responsiveCss.slice(start, next === -1 ? undefined : next)
  assert.match(
    drawerBlock,
    /\.activity-rail-spaces\s*\{[^}]*margin-top:\s*auto/,
    '移动端空间切换按钮沉底（margin-top: auto）进入拇指区',
  )
  assert.match(
    drawerBlock,
    /\.activity-rail-footer\s*\{[^}]*margin-top:\s*0[^}]*border-top:\s*1px solid var\(--border\)/,
    '主题按钮维持沉底并以分隔线与空间按钮分组区隔',
  )
  // 桌面布局不受影响：分片样式里 footer 仍由 margin-top: auto 沉底、spaces 不沉底
  const shellCss = readFileSync(new URL('../src/styles/shell.css', import.meta.url), 'utf8')
  assert.match(shellCss, /\.activity-rail-footer\s*\{[^}]*margin-top:\s*auto/, '桌面端主题按钮沉底规则保持')
  assert.doesNotMatch(shellCss, /\.activity-rail-spaces\s*\{[^}]*margin-top:\s*auto/, '桌面端空间按钮不沉底')
})
