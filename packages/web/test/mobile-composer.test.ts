import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { busyEnterMode, getComposerPlaceholder } from '../src/conversation/composer-model.js'

const composerSource = readFileSync(new URL('../src/conversation/Composer.tsx', import.meta.url), 'utf8')
const paneSource = readFileSync(new URL('../src/conversation/ConversationPane.tsx', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new URL('../src/shell/Sidebar.tsx', import.meta.url), 'utf8')
const timelineSource = readFileSync(new URL('../src/conversation/ConversationTimeline.tsx', import.meta.url), 'utf8')
const stylesCss = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const responsiveCss = readFileSync(new URL('../src/responsive.css', import.meta.url), 'utf8')
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

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
  assert.equal(desktopDefault, '输入消息；/ 命令与技能，⌘V 粘贴附件')
  assert.match(desktopDefault, /⌘V 粘贴附件/)

  const desktopWorking = getComposerPlaceholder(true, false)
  assert.match(desktopWorking, /⌘\/Ctrl\+Enter/)
  // 默认插话模式：Enter 在前插话引导，⌘/Ctrl+Enter 排队发送。
  assert.match(desktopWorking, /Enter 插话引导 · ⌘\/Ctrl\+Enter 排队发送/)

  // Composer.tsx 源码中接入了动态 placeholder
  assert.match(composerSource, /getComposerPlaceholder\(working,\s*isMobile\)/)
})

test('移动端与桌面端输入框字号保持统一：全屏/窄屏/分屏均不强行放大到 16px，由 viewport 防缩放', { timeout: 60_000 }, () => {
  // 容器查询保护：@container (max-width: 680px) 绝不能硬编码 16px，避免桌面分屏或移动端输入框文字突兀变大
  const containerSlice = responsiveCss.slice(
    responsiveCss.indexOf('@container (max-width: 680px)'),
    responsiveCss.indexOf('@container (max-width: 450px)'),
  )
  assert.doesNotMatch(containerSlice, /font-size:\s*16px/, '容器查询不得强行放大字号')

  // 全局响应式 CSS 彻底清除对输入类控件的 16px 暴力放大，保持与全局正文 13.5px 协调
  assert.doesNotMatch(responsiveCss, /\.composer-textarea[^{]*\{[^}]*font-size:\s*16px/)
  assert.doesNotMatch(responsiveCss, /textarea\s*\{[^}]*font-size:\s*16px/)

  // 移动端通过 index.html 中的 viewport 契约实现杜绝失控缩放
  assert.match(indexHtml, /name="viewport"/)
  assert.match(indexHtml, /maximum-scale=1\.0/)
  assert.match(indexHtml, /user-scalable=no/)
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

test('消息悬停条紧凑包裹与对齐规则：人类消息靠右对齐、AI 回复靠左自适应宽度防拉伸', { timeout: 60_000 }, () => {
  // 必须声明 width: fit-content 防 Flex stretch 拉伸全宽
  assert.match(stylesCss, /\.msg-hover-bar\s*\{[^}]*width:\s*fit-content/)
  // 人类消息靠右
  assert.match(stylesCss, /\.msg-human-row\s+\.msg-hover-bar\s*\{[^}]*align-self:\s*flex-end/)
  // AI 回复靠左紧凑
  assert.match(stylesCss, /\.msg-ai-block\s+\.msg-hover-bar\s*\{[^}]*align-self:\s*flex-start/)
})

test('正忙时默认插话模式：Enter steer，⌘/Ctrl+Enter 排队发送（纯函数）', { timeout: 60_000 }, () => {
  // Enter（无修饰键）默认插话引导。
  assert.equal(busyEnterMode(false), 'steer')
  // ⌘/Ctrl+Enter 显式排队发送。
  assert.equal(busyEnterMode(true), 'followUp')
  // Composer 消费同一纯函数（组件与单测不分裂）。
  assert.match(composerSource, /busyEnterMode\(e\.metaKey \|\| e\.ctrlKey\)/)
})

test('正忙且有输入时按钮策略：主发送为插话引导，ghost 按钮为排队发送', { timeout: 60_000 }, () => {
  // 主发送按钮：steer + 步骤边界注入提示（不谎称立即打断工具）。
  assert.match(composerSource, /onClick=\{\(\) => void send\('steer'\)\}/)
  assert.match(composerSource, /下一个步骤边界注入（Enter）/)
  assert.match(composerSource, /aria-label=\{uploading > 0 \? `上传中 \(\$\{uploading\}\)` : editingEntryId !== null \? '更新并重新生成' : '插话引导'\}/)
  // 编辑历史消息时主发送切换为「更新并重新生成」语义
  assert.match(composerSource, /aria-label=\{editingEntryId !== null \? '更新并重新生成'/)
  // ghost 按钮改为显式排队发送（clock 图标 + 当前回合结束后处理）。
  assert.match(composerSource, /composer-queue-button/)
  assert.match(composerSource, /onClick=\{\(\) => void send\('followUp'\)\}/)
  assert.match(composerSource, /当前回合结束后处理（⌘\/Ctrl\+Enter）/)
  // 旧 steer ghost 类名不再存在；responsive.css 同步 queue 类名。
  assert.doesNotMatch(composerSource, /composer-steer-button/)
  assert.match(responsiveCss, /\.composer-queue-button/)
  assert.doesNotMatch(responsiveCss, /composer-steer-button/)
  // 停止按钮与空闲普通发送不受影响。
  assert.match(composerSource, /aria-label="停止当前执行"/)
})
