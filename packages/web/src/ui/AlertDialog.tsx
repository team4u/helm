import React from 'react'
import * as RadixAlertDialog from '@radix-ui/react-alert-dialog'
import { OverlayLayerContext, useOverlayLayer } from '@helm/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'

const AlertDialogInlineContext = React.createContext<boolean>(false)

export interface AlertDialogProps extends RadixAlertDialog.AlertDialogProps {
  /**
   * Force inline rendering (skip the DOM portal). Defaults to inline output in
   * SSR / node test environments (renderToString) so the snapshot is never an
   * empty string.
   */
  inline?: boolean
}

/**
 * Radix UI AlertDialog root wrapper:
 * - WAI-ARIA confirm/alert dialog state management (role="alertdialog");
 * - blocks outside interaction, Escape handling and focus trapping included;
 * - supports the inline flag for SSR / renderToString compatibility.
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
  /** Explicitly render inline (do not mount into document.body). */
  inline?: boolean
}

/**
 * Confirm dialog Portal wrapper:
 * serves both browser DOM and SSR / node:test (renderToString) environments.
 * In SSR / pure Node (typeof window === 'undefined') or with inline set it
 * outputs children directly so renderToString can assert the inner HTML.
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
 * Confirm dialog overlay:
 * binds the .modal-backdrop style by default; custom class names and
 * full-screen overrides are supported.
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
 * Confirm dialog content container:
 * binds the .modal style by default and carries role="alertdialog" plus
 * aria-modal="true" semantics natively.
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
 * Confirm dialog title:
 * binds .modal-title by default, clears the default margin and is associated
 * automatically via aria-labelledby.
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
 * Confirm dialog description text:
 * associated automatically via aria-describedby for screen readers.
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
 * Confirm dialog action button:
 * pair with asChild to delegate the confirm interaction to a concrete button
 * element.
 */
export const AlertDialogAction = React.forwardRef<
  React.ComponentRef<typeof RadixAlertDialog.Action>,
  AlertDialogActionProps
>(function AlertDialogAction(props, ref) {
  return <RadixAlertDialog.Action ref={ref} {...props} />
})

export interface AlertDialogCancelProps extends React.ComponentPropsWithoutRef<typeof RadixAlertDialog.Cancel> {}

/**
 * Confirm dialog cancel button:
 * pair with asChild to delegate the cancel interaction to a concrete button
 * element.
 */
export const AlertDialogCancel = React.forwardRef<
  React.ComponentRef<typeof RadixAlertDialog.Cancel>,
  AlertDialogCancelProps
>(function AlertDialogCancel(props, ref) {
  return <RadixAlertDialog.Cancel ref={ref} {...props} />
})

export interface AlertDialogTriggerProps extends React.ComponentPropsWithoutRef<typeof RadixAlertDialog.Trigger> {}

/**
 * Confirm dialog trigger button.
 */
export const AlertDialogTrigger = React.forwardRef<
  React.ComponentRef<typeof RadixAlertDialog.Trigger>,
  AlertDialogTriggerProps
>(function AlertDialogTrigger(props, ref) {
  return <RadixAlertDialog.Trigger ref={ref} {...props} />
})

// Compound property mounting for AlertDialog.Content / AlertDialog.Root style usage
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
 * Minimal high-level double-confirm component:
 * Quiet Surface micro-kernel styling — .modal-backdrop, .modal (max-width:
 * 440px), hairline border 1px solid var(--border), --bg-elevated background;
 * danger confirms use .btn.btn-danger, cancel uses .btn.btn-ghost.
 * Default confirm/cancel copy resolves from the active locale (explicit
 * confirmText/cancelText props win).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  cancelText,
  danger = false,
  onConfirm,
  onCancel,
  inline,
}: ConfirmDialogProps) {
  const { t } = useWebLocale()
  const resolvedConfirmText = confirmText ?? t('ui.dialog.confirm')
  const resolvedCancelText = cancelText ?? t('common.cancel')
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
                  {resolvedCancelText}
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
                  {resolvedConfirmText}
                </button>
              </AlertDialogAction>
            </div>
          </AlertDialogContent>
        </AlertDialogOverlay>
      </AlertDialogPortal>
    </AlertDialog>
  )
}
