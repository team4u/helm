import React from 'react'
import * as RadixAlertDialog from '@radix-ui/react-alert-dialog'
import { OverlayLayerContext, useOverlayLayer } from './overlay-stack.js'

const AlertDialogInlineContext = React.createContext<boolean>(false)

export interface AlertDialogProps extends RadixAlertDialog.AlertDialogProps {
  /**
   * 是否强制内联渲染（跳过 DOM portal）。
   * 在 SSR 或 node 环境测试 (renderToString) 下，默认即采用内联渲染避免返回空串。
   */
  inline?: boolean
}

/**
 * Radix UI AlertDialog 根组件封装：
 * - 提供 WAI-ARIA 规范警告/确认对话框状态管理（role="alertdialog"）；
 * - 阻断外部交互，自带 Escape 键监听与焦点圈定；
 * - 支持 inline 参数与 SSR / renderToString 兼容。
 */
export function AlertDialog({ inline = false, children, open, defaultOpen, onOpenChange, ...props }: AlertDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const isOpen = open ?? uncontrolledOpen
  const layer = useOverlayLayer(isOpen)
  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (open === undefined) setUncontrolledOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }, [open, onOpenChange])

  return (
    <AlertDialogInlineContext.Provider value={inline}>
      <RadixAlertDialog.Root
        {...props}
        {...(open === undefined ? { defaultOpen } : { open })}
        onOpenChange={handleOpenChange}
      >
        <OverlayLayerContext.Provider value={layer}>{children}</OverlayLayerContext.Provider>
      </RadixAlertDialog.Root>
    </AlertDialogInlineContext.Provider>
  )
}

export interface AlertDialogPortalProps extends RadixAlertDialog.AlertDialogPortalProps {
  /** 显式指定是否内联渲染（不挂载至 document.body） */
  inline?: boolean
}

/**
 * 确认对话框 Portal 封装：
 * 兼顾浏览器 DOM 与 SSR / node:test (renderToString) 环境。
 * 在 SSR 或纯 Node 环境（typeof window === 'undefined'）或者设置 inline 时，
 * 直接输出 children，确保 renderToString 可以顺利断言内部 HTML 内容。
 */
export function AlertDialogPortal({ inline, children, ...props }: AlertDialogPortalProps) {
  const contextInline = React.useContext(AlertDialogInlineContext)
  if (inline || contextInline || typeof window === 'undefined') {
    return <>{children}</>
  }
  return <RadixAlertDialog.Portal {...props}>{children}</RadixAlertDialog.Portal>
}

export interface AlertDialogOverlayProps extends React.ComponentPropsWithoutRef<typeof RadixAlertDialog.Overlay> {}

/**
 * 确认对话框遮罩层：
 * 默认绑定 .modal-backdrop 样式，支持自定义类名与全屏样式覆盖。
 */
export const AlertDialogOverlay = React.forwardRef<
  React.ComponentRef<typeof RadixAlertDialog.Overlay>,
  AlertDialogOverlayProps
>(function AlertDialogOverlay({ className, style, ...props }, ref) {
  const layer = React.useContext(OverlayLayerContext)
  const layeredStyle = layer === null
    ? style
    : ({ ...style, zIndex: layer.overlayZIndex, '--dialog-layer-z': layer.overlayZIndex } as React.CSSProperties)
  return (
    <RadixAlertDialog.Overlay
      ref={ref}
      className={className ?? 'modal-backdrop'}
      style={layeredStyle}
      {...props}
    />
  )
})

export interface AlertDialogContentProps extends React.ComponentPropsWithoutRef<typeof RadixAlertDialog.Content> {}

/**
 * 确认对话框主体内容容器：
 * 默认绑定 .modal 样式，原生具备 role="alertdialog" 与 aria-modal="true" 语义。
 */
export const AlertDialogContent = React.forwardRef<
  React.ComponentRef<typeof RadixAlertDialog.Content>,
  AlertDialogContentProps
>(function AlertDialogContent({ className, style, ...props }, ref) {
  const layer = React.useContext(OverlayLayerContext)
  const layeredStyle = layer === null
    ? style
    : ({ ...style, zIndex: layer.contentZIndex, '--dialog-layer-z': layer.contentZIndex } as React.CSSProperties)
  return (
    <RadixAlertDialog.Content
      ref={ref}
      className={className ?? 'modal'}
      style={layeredStyle}
      {...props}
    />
  )
})

export interface AlertDialogTitleProps extends React.ComponentPropsWithoutRef<typeof RadixAlertDialog.Title> {}

/**
 * 确认对话框标题：
 * 默认绑定 .modal-title，清除默认外边距，自动关联 aria-labelledby。
 */
export const AlertDialogTitle = React.forwardRef<
  React.ComponentRef<typeof RadixAlertDialog.Title>,
  AlertDialogTitleProps
>(function AlertDialogTitle({ className, style, ...props }, ref) {
  return (
    <RadixAlertDialog.Title
      ref={ref}
      className={className ?? 'modal-title'}
      style={{ margin: 0, ...style }}
      {...props}
    />
  )
})

export interface AlertDialogDescriptionProps extends React.ComponentPropsWithoutRef<typeof RadixAlertDialog.Description> {}

/**
 * 确认对话框描述文本：
 * 自动关联 aria-describedby，供屏幕阅读器发音。
 */
export const AlertDialogDescription = React.forwardRef<
  React.ComponentRef<typeof RadixAlertDialog.Description>,
  AlertDialogDescriptionProps
>(function AlertDialogDescription({ className, style, ...props }, ref) {
  return (
    <RadixAlertDialog.Description
      ref={ref}
      className={className}
      style={{ margin: 0, ...style }}
      {...props}
    />
  )
})

export interface AlertDialogActionProps extends React.ComponentPropsWithoutRef<typeof RadixAlertDialog.Action> {}

/**
 * 确认对话框动作按钮：
 * 可配合 asChild 将确认交互委派给具体按钮元素。
 */
export const AlertDialogAction = React.forwardRef<
  React.ComponentRef<typeof RadixAlertDialog.Action>,
  AlertDialogActionProps
>(function AlertDialogAction(props, ref) {
  return <RadixAlertDialog.Action ref={ref} {...props} />
})

export interface AlertDialogCancelProps extends React.ComponentPropsWithoutRef<typeof RadixAlertDialog.Cancel> {}

/**
 * 确认对话框取消按钮：
 * 可配合 asChild 将取消交互委派给具体按钮元素。
 */
export const AlertDialogCancel = React.forwardRef<
  React.ComponentRef<typeof RadixAlertDialog.Cancel>,
  AlertDialogCancelProps
>(function AlertDialogCancel(props, ref) {
  return <RadixAlertDialog.Cancel ref={ref} {...props} />
})

export interface AlertDialogTriggerProps extends React.ComponentPropsWithoutRef<typeof RadixAlertDialog.Trigger> {}

/**
 * 确认对话框唤起触发按钮。
 */
export const AlertDialogTrigger = React.forwardRef<
  React.ComponentRef<typeof RadixAlertDialog.Trigger>,
  AlertDialogTriggerProps
>(function AlertDialogTrigger(props, ref) {
  return <RadixAlertDialog.Trigger ref={ref} {...props} />
})

// 复合属性挂载，便于 AlertDialog.Content / AlertDialog.Root 风格使用
AlertDialog.Root = RadixAlertDialog.Root
AlertDialog.Portal = AlertDialogPortal
AlertDialog.Overlay = AlertDialogOverlay
AlertDialog.Content = AlertDialogContent
AlertDialog.Title = AlertDialogTitle
AlertDialog.Description = AlertDialogDescription
AlertDialog.Action = AlertDialogAction
AlertDialog.Cancel = AlertDialogCancel
AlertDialog.Trigger = AlertDialogTrigger

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel?: () => void
  inline?: boolean
}

/**
 * 极简高阶二次确认组件：
 * 采用微内核极简 Quiet Surface 样式：.modal-backdrop、.modal (max-width: 440px)、
 * 发丝边框 1px solid var(--border)、--bg-elevated 背景；
 * 危险确认时按钮使用 .btn.btn-danger，取消按钮使用 .btn.btn-ghost。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel,
  inline,
}: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange} inline={inline}>
      <AlertDialogPortal inline={inline}>
        <AlertDialogOverlay className="modal-backdrop">
          <AlertDialogContent
            className="modal"
            style={{
              maxWidth: 440,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
            }}
            onEscapeKeyDown={() => {
              onCancel?.()
            }}
          >
            <div className="modal-header">
              <AlertDialogTitle className="modal-title">{title}</AlertDialogTitle>
            </div>
            {description ? (
              <div
                className="modal-body"
                style={{
                  color: 'var(--fg-muted)',
                  fontSize: 13,
                  lineHeight: 1.5,
                  padding: '14px 16px',
                }}
              >
                <AlertDialogDescription>{description}</AlertDialogDescription>
              </div>
            ) : null}
            <div className="modal-footer">
              <AlertDialogCancel asChild>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    onCancel?.()
                  }}
                >
                  {cancelText}
                </button>
              </AlertDialogCancel>
              <AlertDialogAction asChild>
                <button
                  type="button"
                  className={`btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`}
                  onClick={() => {
                    onConfirm()
                  }}
                >
                  {confirmText}
                </button>
              </AlertDialogAction>
            </div>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialogPortal>
    </AlertDialog>
  )
}
