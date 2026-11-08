import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getComposerPlaceholder } from '../src/conversation/composer-model.js'

const composerSource = readFileSync(new URL('../src/conversation/Composer.tsx', import.meta.url), 'utf8')
const paneSource = readFileSync(new URL('../src/conversation/ConversationPane.tsx', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new URL('../src/shell/Sidebar.tsx', import.meta.url), 'utf8')
const timelineSource = readFileSync(new URL('../src/conversation/ConversationTimeline.tsx', import.meta.url), 'utf8')
const stylesCss = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const responsiveCss = readFileSync(new URL('../src/responsive.css', import.meta.url), 'utf8')

test('移动端 Placeholder 文案优化：小屏/移动端极短防折行', { timeout: 60_000 }, () => {
  // 移动端/小屏幕模式
  const mobileDefault = getComposerPlaceholder(false, true)
  assert.equal(mobileDefault, '输入消息…')
  assert.doesNotMatch(mobileDefault, /⌘/)
  assert.doesNotMatch(mobileDefault, /[；;]/)

  const mobileWorking = getComposerPlaceholder(true, true)
  assert.equal(mobileWorking, '补充说明或排队指令…')
  assert.doesNotMatch(mobileWorking, /⌘/)

  // 桌面端全功能模式
  const desktopDefault = getComposerPlaceholder(false, false)
  assert.equal(desktopDefault, '输入消息；/ 命令与技能，@ 引用产物，⌘V 粘贴附件')
  assert.match(desktopDefault, /⌘V 粘贴附件/)

  const desktopWorking = getComposerPlaceholder(true, false)
  assert.match(desktopWorking, /⌘\/Ctrl\+Enter/)

  // Composer.tsx 源码中接入了动态 placeholder
  assert.match(composerSource, /getComposerPlaceholder\(working,\s*isMobile\)/)
})

test('移动端输入框字号防 iOS 自动放大：有效字号不小于 16px', { timeout: 60_000 }, () => {
  // @container (max-width: 680px) 保护
  const containerSlice = responsiveCss.slice(
    responsiveCss.indexOf('@container (max-width: 680px)'),
    responsiveCss.indexOf('@container (max-width: 450px)'),
  )
  assert.match(containerSlice, /\.composer-textarea\s*\{[^}]*font-size:\s*16px/)

  // @media (max-width: 680px) 视口兜底保护，杜绝 iOS WebKit 输入放大
  const mediaSlice = responsiveCss.slice(responsiveCss.indexOf('@media (max-width: 680px)'))
  assert.match(mediaSlice, /font-size:\s*16px/)
})

test('横屏模式（高度 < 450px）适配：工具栏完整显示且不被挤压', { timeout: 60_000 }, () => {
  // styles.css 中模型按钮限定最大宽度，窄屏不再需要固定最小宽度
  assert.match(stylesCss, /\.composer-model-button\s*\{[^}]*max-width:\s*240px/)

  // responsive.css 声明 @media (max-height: 450px) 针对横屏视口
  assert.match(responsiveCss, /@media\s*\(max-height:\s*450px\)/)
  const landscapeSlice = responsiveCss.slice(
    responsiveCss.indexOf('@media (max-height: 450px)'),
    responsiveCss.indexOf('@media (max-width: 1200px)'),
  )
  assert.match(landscapeSlice, /\.composer-toolbar\s*\{[^}]*min-height:\s*30px/)
  assert.match(landscapeSlice, /\.composer-toolbar\s*\{[^}]*overflow:\s*visible/)
  assert.match(landscapeSlice, /\.composer-toolbar\s*\{[^}]*line-height:\s*normal/)
})

test('移动端窄屏（<860px）下隐藏顶部与侧栏中的分屏入口', { timeout: 60_000 }, () => {
  // ConversationPane.tsx 顶部并排按钮携带 .split-toggle-btn
  assert.match(paneSource, /className=\{`[^`]*split-toggle-btn/)

  // Sidebar.tsx 会话行分屏按钮携带 split-toggle-btn / sidebar-split-btn
  assert.match(sidebarSource, /sidebar-split-btn|sidebar-split-action/)

  // responsive.css 在 @media (max-width: 860px) 下 display: none
  const media860 = responsiveCss.slice(responsiveCss.indexOf('@media (max-width: 860px)'))
  assert.match(media860, /\.split-toggle-btn[^{]*\{[^}]*display:\s*none/)
})

test('移动端触屏与聚焦优化：消息操作栏支持轻点唤起并提供可见性', { timeout: 60_000 }, () => {
  // ConversationTimeline.tsx 中的用户消息与 AI 回复行添加 tabIndex 聚焦唤起
  assert.match(timelineSource, /className="msg-human-row"\s+tabIndex=\{0\}/)
  assert.match(timelineSource, /className="msg-ai-block"\s+tabIndex=\{0\}/)

  // responsive.css 提供 focus-within 与 focus 触发
  assert.match(responsiveCss, /\.msg-human-row:focus-within\s+\.msg-hover-bar/)
  assert.match(responsiveCss, /\.msg-human-row:focus\s+\.msg-hover-bar/)

  // 触屏设备 (@media (hover: none)) 下操作栏保持良好可见度
  assert.match(responsiveCss, /@media\s*\(hover:\s*none\)/)
  const hoverNoneSlice = responsiveCss.slice(
    responsiveCss.indexOf('@media (hover: none)'),
    responsiveCss.indexOf('@media (max-width: 680px)'),
  )
  assert.match(hoverNoneSlice, /\.msg-hover-bar\s*\{[^}]*opacity:\s*0\.85/)
})
