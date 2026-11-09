import React from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'

const DialogInlineContext = React.createContext<boolean>(false)

export interface DialogProps extends RadixDialog.DialogProps {
  /**
   * 是否强制内联渲染（跳过 DOM portal）。
   * 在 SSR 或 node 环境测试 (renderToString) 下，默认即采用内联渲染避免返回空串。
   */
  inline?: boolean
}

/**
 * Radix UI Dialog 根组件封装：
 * - 提供 WAI-ARIA 规范对话框状态管理；
 * - 自带 Escape 键监听、DismissableLayer 防穿透与焦点圈定；
 * - 支持 inline 参数与 SSR / renderToString 兼容。
 */
export function Dialog({ inline = false, children, ...props }: DialogProps) {
  return (
    <DialogInlineContext.Provider value={inline}>
      <RadixDialog.Root {...props}>{children}</RadixDialog.Root>
    </DialogInlineContext.Provider>
  )
}

export interface DialogPortalProps extends RadixDialog.DialogPortalProps {
  /** 显式指定是否内联渲染（不挂载至 document.body） */
  inline?: boolean
}

/**
 * 对话框 Portal 封装：
 * 兼顾浏览器 DOM 与 SSR / node:test (renderToString) 环境。
 * 在 SSR 或纯 Node 环境（typeof window === 'undefined'）或者设置 inline 时，
 * 直接输出 children，确保 renderToString 可以顺利断言内部 HTML 内容。
 */
export function DialogPortal({ inline, children, ...props }: DialogPortalProps) {
  const contextInline = React.useContext(DialogInlineContext)
  if (inline || contextInline || typeof window === 'undefined') {
    return <>{children}</>
  }
  return <RadixDialog.Portal {...props}>{children}</RadixDialog.Portal>
}

export interface DialogOverlayProps extends React.ComponentPropsWithoutRef<typeof RadixDialog.Overlay> {}

/**
 * 对话框遮罩层：
 * 默认绑定 .modal-backdrop 样式，支持自定义类名与全屏样式覆盖。
 */
export const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof RadixDialog.Overlay>,
  DialogOverlayProps
>(function DialogOverlay({ className, ...props }, ref) {
  return (
    <RadixDialog.Overlay
      ref={ref}
      className={className ?? 'modal-backdrop'}
      {...props}
    />
  )
})

export interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof RadixDialog.Content> {}

/**
 * 对话框主体内容容器：
 * 默认绑定 .modal 样式，支持 .modal-lg / .modal-fullscreen 等变体，
 * 原生具备 role="dialog" 与 aria-modal="true" 语义。
 */
export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof RadixDialog.Content>,
  DialogContentProps
>(function DialogContent({ className, ...props }, ref) {
  return (
    <RadixDialog.Content
      ref={ref}
      className={className ?? 'modal'}
      {...props}
    />
  )
})

export interface DialogTitleProps extends React.ComponentPropsWithoutRef<typeof RadixDialog.Title> {}

/**
 * 对话框标题：
 * 默认绑定 .modal-title，清除默认 h2 外边距，自动关联 aria-labelledby。
 */
export const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof RadixDialog.Title>,
  DialogTitleProps
>(function DialogTitle({ className, style, ...props }, ref) {
  return (
    <RadixDialog.Title
      ref={ref}
      className={className ?? 'modal-title'}
      style={{ margin: 0, ...style }}
      {...props}
    />
  )
})

export interface DialogDescriptionProps extends React.ComponentPropsWithoutRef<typeof RadixDialog.Description> {}

/**
 * 对话框描述文本：
 * 自动关联 aria-describedby，供屏幕阅读器发音。
 */
export const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof RadixDialog.Description>,
  DialogDescriptionProps
>(function DialogDescription({ className, style, ...props }, ref) {
  return (
    <RadixDialog.Description
      ref={ref}
      className={className}
      style={{ margin: 0, ...style }}
      {...props}
    />
  )
})

export interface DialogCloseProps extends React.ComponentPropsWithoutRef<typeof RadixDialog.Close> {}

/**
 * 对话框关闭触发按钮：
 * 可配合 asChild 将关闭交互委派给具体按钮元素。
 */
export const DialogClose = React.forwardRef<
  React.ComponentRef<typeof RadixDialog.Close>,
  DialogCloseProps
>(function DialogClose(props, ref) {
  return <RadixDialog.Close ref={ref} {...props} />
})

export interface DialogTriggerProps extends React.ComponentPropsWithoutRef<typeof RadixDialog.Trigger> {}

/**
 * 对话框唤起触发按钮。
 */
export const DialogTrigger = React.forwardRef<
  React.ComponentRef<typeof RadixDialog.Trigger>,
  DialogTriggerProps
>(function DialogTrigger(props, ref) {
  return <RadixDialog.Trigger ref={ref} {...props} />
})

// 复合属性挂载，便于 Dialog.Content 风格使用
Dialog.Root = RadixDialog.Root
Dialog.Portal = DialogPortal
Dialog.Overlay = DialogOverlay
Dialog.Content = DialogContent
Dialog.Title = DialogTitle
Dialog.Description = DialogDescription
Dialog.Close = DialogClose
Dialog.Trigger = DialogTrigger
