import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToString } from 'react-dom/server'
import {
  Popover,
  PopoverRoot,
  PopoverTrigger,
  PopoverPortal,
  PopoverContent,
  PopoverArrow,
} from '../src/ui/Popover.js'
import {
  DropdownMenu,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '../src/ui/DropdownMenu.js'
import {
  Tooltip,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  TooltipPortal,
  TooltipContent,
  TooltipArrow,
} from '../src/ui/Tooltip.js'

const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u

const popoverSource = readFileSync(new URL('../src/ui/Popover.tsx', import.meta.url), 'utf8')
const dropdownSource = readFileSync(new URL('../src/ui/DropdownMenu.tsx', import.meta.url), 'utf8')
const tooltipSource = readFileSync(new URL('../src/ui/Tooltip.tsx', import.meta.url), 'utf8')
const composerSource = readFileSync(new URL('../src/conversation/Composer.tsx', import.meta.url), 'utf8')
const paneSource = readFileSync(new URL('../src/conversation/ConversationPane.tsx', import.meta.url), 'utf8')
const sidebarSource = readFileSync(new URL('../src/shell/Sidebar.tsx', import.meta.url), 'utf8')
const workbenchSource = readFileSync(new URL('../src/conversation/WorkbenchDrawer.tsx', import.meta.url), 'utf8')
const stylesCss = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('Popover 原语挂载、数据属性与无障碍属性（SSR）', { timeout: 60_000 }, () => {
  const openHtml = renderToString(
    React.createElement(
      PopoverRoot,
      { open: true },
      React.createElement(
        PopoverTrigger,
        { asChild: true },
        React.createElement('button', { type: 'button' }, '触发器'),
      ),
      React.createElement(
        PopoverPortal,
        null,
        React.createElement(
          PopoverContent,
          { className: 'custom-popover' },
          React.createElement(PopoverArrow, null),
          React.createElement('div', null, '浮层正文'),
        ),
      ),
    ),
  )

  // 触发器携带 WAI-ARIA 与 Radix 状态属性
  assert.match(openHtml, /aria-haspopup="dialog"/)
  assert.match(openHtml, /aria-expanded="true"/)
  assert.match(openHtml, /data-state="open"/)

  // 浮层内容携带 role="dialog" 与样式类
  assert.match(openHtml, /role="dialog"/)
  assert.match(openHtml, /helm-popover-content/)
  assert.match(openHtml, /custom-popover/)
  assert.match(openHtml, /helm-popover-arrow/)
  assert.match(openHtml, /浮层正文/)

  // 关闭状态
  const closedHtml = renderToString(
    React.createElement(
      PopoverRoot,
      { open: false },
      React.createElement(
        PopoverTrigger,
        { asChild: true },
        React.createElement('button', { type: 'button' }, '触发器'),
      ),
      React.createElement(
        PopoverPortal,
        null,
        React.createElement(PopoverContent, null, '不渲染内容'),
      ),
    ),
  )
  assert.match(closedHtml, /aria-expanded="false"/)
  assert.match(closedHtml, /data-state="closed"/)
  assert.doesNotMatch(closedHtml, /不渲染内容/)
})

test('DropdownMenu 原语挂载、数据属性与角色属性（SSR）', { timeout: 60_000 }, () => {
  const menuHtml = renderToString(
    React.createElement(
      DropdownMenuRoot,
      { open: true },
      React.createElement(
        DropdownMenuTrigger,
        { asChild: true },
        React.createElement('button', { type: 'button', 'aria-label': '操作菜单' }, '菜单'),
      ),
      React.createElement(
        DropdownMenuPortal,
        null,
        React.createElement(
          DropdownMenuContent,
          { className: 'pane-more-popover' },
          React.createElement(DropdownMenuLabel, null, '会话操作'),
          React.createElement(
            DropdownMenuItem,
            { onSelect: () => {} },
            '重命名会话',
          ),
          React.createElement(DropdownMenuSeparator, null),
          React.createElement(
            DropdownMenuItem,
            { danger: true, onSelect: () => {} },
            '重置上下文',
          ),
        ),
      ),
    ),
  )

  // 菜单触发器语义
  assert.match(menuHtml, /aria-haspopup="menu"/)
  assert.match(menuHtml, /aria-expanded="true"/)
  assert.match(menuHtml, /data-state="open"/)

  // 菜单主体 WAI-ARIA 语义
  assert.match(menuHtml, /role="menu"/)
  assert.match(menuHtml, /data-radix-menu-content/)
  assert.match(menuHtml, /helm-dropdown-content/)
  assert.match(menuHtml, /pane-more-popover/)

  // 菜单项 role="menuitem"
  assert.match(menuHtml, /role="menuitem"/)
  assert.match(menuHtml, /重命名会话/)

  // 分隔线 role="separator"
  assert.match(menuHtml, /role="separator"/)
  assert.match(menuHtml, /helm-dropdown-separator/)
  assert.match(menuHtml, /popover-separator/)

  // 危险菜单项样式契约
  assert.match(menuHtml, /helm-dropdown-item-danger/)
  assert.match(menuHtml, /popover-item-danger/)
})

test('Tooltip 原语挂载、无障碍属性与独立使用能力（SSR）', { timeout: 60_000 }, () => {
  // 原语组合形式
  const primitiveHtml = renderToString(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(
        TooltipRoot,
        { open: true },
        React.createElement(
          TooltipTrigger,
          { asChild: true },
          React.createElement('button', { type: 'button', 'aria-label': '关闭' }, 'X'),
        ),
        React.createElement(
          TooltipPortal,
          null,
          React.createElement(
            TooltipContent,
            null,
            '关闭弹窗',
            React.createElement(TooltipArrow, null),
          ),
        ),
      ),
    ),
  )

  assert.match(primitiveHtml, /aria-describedby=/)
  assert.match(primitiveHtml, /role="tooltip"/)
  assert.match(primitiveHtml, /helm-tooltip-content/)
  assert.match(primitiveHtml, /helm-tooltip-arrow/)
  assert.match(primitiveHtml, /关闭弹窗/)

  // Tooltip 便捷包装器（无需外层 Provider 即可独立安全渲染）
  const wrapperHtml = renderToString(
    React.createElement(
      Tooltip,
      { content: '提示文本', open: true },
      React.createElement('button', { type: 'button', 'aria-label': '设置' }, 'S'),
    ),
  )
  assert.match(wrapperHtml, /role="tooltip"/)
  assert.match(wrapperHtml, /提示文本/)

  // disabled 时直接透传触发器子元素
  const disabledHtml = renderToString(
    React.createElement(
      Tooltip,
      { content: '提示文本', disabled: true },
      React.createElement('button', { type: 'button', className: 'raw-btn' }, 'Raw'),
    ),
  )
  assert.match(disabledHtml, /class="raw-btn"/)
  assert.doesNotMatch(disabledHtml, /role="tooltip"/)
})

test('Composer ModelPicker 接入 Radix Popover 替代手写绝对定位与事件监听', { timeout: 60_000 }, () => {
  // 提取 ModelPicker 源码片段进行精准断言
  const modelPickerSlice = composerSource.slice(
    composerSource.indexOf('function ModelPicker'),
    composerSource.indexOf('// ---------------------------------------------------------------------------', composerSource.indexOf('function ModelPicker')),
  )
  // 引入 Popover 原语
  assert.match(composerSource, /import\s*\{[^}]*Popover[^}]*\}\s*from\s*'\.\.\/ui\/Popover\.js'/)
  assert.match(modelPickerSlice, /<Popover open=\{open\} onOpenChange=\{setOpen\}>/)
  assert.match(modelPickerSlice, /<PopoverTrigger asChild>/)
  assert.match(modelPickerSlice, /<PopoverPortal>/)
  assert.match(modelPickerSlice, /<PopoverContent[^>]*composer-model-popover/)

  // 移除了 ModelPicker 中手写的 window/document 事件监听
  assert.doesNotMatch(modelPickerSlice, /addEventListener/)
})

test('ConversationPane 会话更多操作菜单接入 Radix DropdownMenu', { timeout: 60_000 }, () => {
  // 引入 DropdownMenu 原语
  assert.match(paneSource, /import\s*\{[^}]*DropdownMenu[^}]*\}\s*from\s*'\.\.\/ui\/DropdownMenu\.js'/)
  assert.match(paneSource, /<DropdownMenu open=\{moreOpen\} onOpenChange=\{setMoreOpen\}>/)
  assert.match(paneSource, /<DropdownMenuTrigger asChild>/)
  assert.match(paneSource, /<DropdownMenuPortal>/)
  assert.match(paneSource, /<DropdownMenuContent[^>]*pane-more-popover/)
  assert.match(paneSource, /<DropdownMenuItem[\s\S]*?重命名会话/)
  assert.match(paneSource, /<DropdownMenuSeparator/)
  assert.match(paneSource, /<DropdownMenuItem[\s\S]*?重置上下文/)

  // 移除了手写的 window 事件监听并由 onCloseAutoFocus 回传焦点
  assert.doesNotMatch(paneSource, /document\.addEventListener\('pointerdown', onDocClick\)/)
  assert.match(paneSource, /onCloseAutoFocus=/)
  assert.match(paneSource, /moreButtonRef\.current\?\.focus\(\)/)
})

test('Sidebar 与 Workbench 纯图标按钮接入 Tooltip 规范悬浮提示', { timeout: 60_000 }, () => {
  // Sidebar 接入 Tooltip
  assert.match(sidebarSource, /import\s*\{[^}]*Tooltip[^}]*\}\s*from\s*'\.\.\/ui\/Tooltip\.js'/)
  assert.match(sidebarSource, /<Tooltip content="角色 Profiles"/)
  assert.match(sidebarSource, /<Tooltip content="模型与凭据"/)
  assert.match(sidebarSource, /<Tooltip content="技能库 Skills"/)
  assert.match(sidebarSource, /<Tooltip content="计算节点 Nodes"/)
  assert.match(sidebarSource, /<Tooltip content="插件与设置"/)
  assert.match(sidebarSource, /<Tooltip content="打开 Cmd K 全局搜索与命令面板"/)

  // HoverIconButton 封装了 Tooltip
  assert.match(sidebarSource, /function HoverIconButton[\s\S]*?<Tooltip content=\{title\}/)

  // Workbench 接入 Tooltip
  assert.match(workbenchSource, /import\s*\{[^}]*Tooltip[^}]*\}\s*from\s*'\.\.\/ui\/Tooltip\.js'/)
  assert.match(workbenchSource, /<Tooltip content="关闭工作台"/)
})

test('样式规范契约：发丝边框、--bg-elevated 背景与 7px 微圆角', { timeout: 60_000 }, () => {
  // Popover 样式
  assert.match(stylesCss, /\.helm-popover-content\s*\{[^}]*background:\s*var\(--bg-elevated\)/)
  assert.match(stylesCss, /\.helm-popover-content\s*\{[^}]*border:\s*1px solid var\(--border-strong\)/)
  assert.match(stylesCss, /\.helm-popover-content\s*\{[^}]*border-radius:\s*var\(--radius-sm,\s*7px\)/)

  // DropdownMenu 样式
  assert.match(stylesCss, /\.helm-dropdown-content\s*\{[^}]*background:\s*var\(--bg-elevated\)/)
  assert.match(stylesCss, /\.helm-dropdown-content\s*\{[^}]*border:\s*1px solid var\(--border-strong\)/)
  assert.match(stylesCss, /\.helm-dropdown-content\s*\{[^}]*border-radius:\s*var\(--radius-sm,\s*7px\)/)

  // Tooltip 样式
  assert.match(stylesCss, /\.helm-tooltip-content\s*\{[^}]*background:\s*var\(--bg-elevated\)/)
  assert.match(stylesCss, /\.helm-tooltip-content\s*\{[^}]*border:\s*1px solid var\(--border-strong\)/)
  assert.match(stylesCss, /\.helm-tooltip-content\s*\{[^}]*border-radius:\s*var\(--radius-sm,\s*7px\)/)
})

test('UI 极简无 Emoji 铁律：原语与源码中绝无任何 Emoji 表情', { timeout: 60_000 }, () => {
  assert.ok(!EMOJI_RE.test(popoverSource), 'Popover.tsx 不得含有 Emoji')
  assert.ok(!EMOJI_RE.test(dropdownSource), 'DropdownMenu.tsx 不得含有 Emoji')
  assert.ok(!EMOJI_RE.test(tooltipSource), 'Tooltip.tsx 不得含有 Emoji')
})
