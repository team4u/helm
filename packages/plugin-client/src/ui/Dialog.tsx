import React from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { OverlayLayerContext, useOverlayLayer } from './overlay-stack.js'

const DialogInlineContext = React.createContext<boolean>(false)

export interface DialogProps extends RadixDialog.DialogProps {
  /**
   * Whether to force inline rendering (skipping the DOM portal).
   * Under SSR or node-environment tests (renderToString), inline rendering is
   * the default so an empty string is never returned.
   */
  inline?: boolean
}

/**
 * Radix UI Dialog root wrapper:
 * - Provides WAI-ARIA compliant dialog state management;
 * - Ships Escape-key listening, DismissableLayer passthrough protection and focus trapping;
 * - Supports the inline parameter for SSR / renderToString compatibility.
 */
export function Dialog({ inline = false, children, open, defaultOpen, onOpenChange, ...props }: DialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const isOpen = open ?? uncontrolledOpen
  const layer = useOverlayLayer(isOpen)
  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (open === undefined) setUncontrolledOpen(nextOpen)
    onOpenChange?.(nextOpen)
  }, [open, onOpenChange])

  return (
    <DialogInlineContext.Provider value={inline}>
      <RadixDialog.Root
        {...props}
        {...(open === undefined ? { defaultOpen } : { open })}
        onOpenChange={handleOpenChange}
      >
        <OverlayLayerContext.Provider value={layer}>{children}</OverlayLayerContext.Provider>
      </RadixDialog.Root>
    </DialogInlineContext.Provider>
  )
}

export interface DialogPortalProps extends RadixDialog.DialogPortalProps {
  /** Explicitly request inline rendering (not mounted to document.body). */
  inline?: boolean
}

/**
 * Dialog Portal wrapper:
 * serves both the browser DOM and SSR / node:test (renderToString) environments.
 * Under SSR or a pure Node environment (typeof window === 'undefined'), or when
 * inline is set, children are emitted directly so renderToString can assert the
 * inner HTML content.
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
 * Dialog overlay layer:
 * binds the .modal-backdrop style by default; supports custom class names and
 * fullscreen style overrides.
 */
export const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof RadixDialog.Overlay>,
  DialogOverlayProps
>(function DialogOverlay({ className, style, ...props }, ref) {
  const layer = React.useContext(OverlayLayerContext)
  const layeredStyle = layer === null
    ? style
    : ({ ...style, zIndex: layer.overlayZIndex, '--dialog-layer-z': layer.overlayZIndex } as React.CSSProperties)
  return (
    <RadixDialog.Overlay
      ref={ref}
      className={className ?? 'modal-backdrop'}
      style={layeredStyle}
      {...props}
    />
  )
})

export interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof RadixDialog.Content> {}

/**
 * Dialog main content container:
 * binds the .modal style by default; supports the .modal-lg / .modal-fullscreen
 * variants, natively carrying role="dialog" and aria-modal="true" semantics.
 */
export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof RadixDialog.Content>,
  DialogContentProps
>(function DialogContent({ className, style, ...props }, ref) {
  const layer = React.useContext(OverlayLayerContext)
  const layeredStyle = layer === null
    ? style
    : ({ ...style, zIndex: layer.contentZIndex, '--dialog-layer-z': layer.contentZIndex } as React.CSSProperties)
  return (
    <RadixDialog.Content
      ref={ref}
      className={className ?? 'modal'}
      style={layeredStyle}
      {...props}
    />
  )
})

export interface DialogTitleProps extends React.ComponentPropsWithoutRef<typeof RadixDialog.Title> {}

/**
 * Dialog title:
 * binds .modal-title by default, clears default h2 margins and is associated
 * automatically via aria-labelledby.
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
 * Dialog description text:
 * associated automatically via aria-describedby, announced by screen readers.
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
 * Dialog close trigger button:
 * pair with asChild to delegate the close interaction to a concrete button element.
 */
export const DialogClose = React.forwardRef<
  React.ComponentRef<typeof RadixDialog.Close>,
  DialogCloseProps
>(function DialogClose(props, ref) {
  return <RadixDialog.Close ref={ref} {...props} />
})

export interface DialogTriggerProps extends React.ComponentPropsWithoutRef<typeof RadixDialog.Trigger> {}

/**
 * Dialog opening trigger button.
 */
export const DialogTrigger = React.forwardRef<
  React.ComponentRef<typeof RadixDialog.Trigger>,
  DialogTriggerProps
>(function DialogTrigger(props, ref) {
  return <RadixDialog.Trigger ref={ref} {...props} />
})

// Compound property mounting, for Dialog.Content-style usage
Dialog.Root = RadixDialog.Root
Dialog.Portal = DialogPortal
Dialog.Overlay = DialogOverlay
Dialog.Content = DialogContent
Dialog.Title = DialogTitle
Dialog.Description = DialogDescription
Dialog.Close = DialogClose
Dialog.Trigger = DialogTrigger
