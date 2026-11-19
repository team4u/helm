import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { useOverlayChildStyle } from './overlay-stack.js'

export interface PopoverPortalProps extends PopoverPrimitive.PopoverPortalProps {}

/**
 * SSR-tolerant Portal: during server rendering (typeof window === 'undefined')
 * children are rendered directly, avoiding createPortal depending on
 * document.body which would degrade rendering or throw.
 */
export function PopoverPortal({ children, container, forceMount }: PopoverPortalProps) {
  if (typeof window === 'undefined') {
    return <>{children}</>
  }
  return (
    <PopoverPrimitive.Portal container={container} forceMount={forceMount}>
      {children}
    </PopoverPrimitive.Portal>
  )
}

export function PopoverRoot(props: PopoverPrimitive.PopoverProps) {
  return <PopoverPrimitive.Root {...props} />
}

export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverAnchor = PopoverPrimitive.Anchor
export const PopoverClose = PopoverPrimitive.Close

export interface PopoverContentProps extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> {
  portalled?: boolean
}

export const PopoverContent = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Content>,
  PopoverContentProps
>(({ className = '', align = 'center', sideOffset = 6, portalled = false, children, style, ...props }, ref) => {
  const layeredStyle = useOverlayChildStyle(style)
  const content = (
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={`helmx-popover-content ${className}`.trim()}
      style={layeredStyle}
      {...props}
    >
      {children}
    </PopoverPrimitive.Content>
  )

  if (portalled) {
    return <PopoverPortal>{content}</PopoverPortal>
  }

  return content
})
PopoverContent.displayName = 'PopoverContent'

export interface PopoverArrowProps extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Arrow> {}

export const PopoverArrow = React.forwardRef<
  React.ComponentRef<typeof PopoverPrimitive.Arrow>,
  PopoverArrowProps
>(({ className = '', width = 10, height = 5, ...props }, ref) => (
  <PopoverPrimitive.Arrow
    ref={ref}
    width={width}
    height={height}
    className={`helmx-popover-arrow ${className}`.trim()}
    {...props}
  />
))
PopoverArrow.displayName = 'PopoverArrow'

/**
 * Generic Radix Popover wrapper component.
 */
export function Popover(props: PopoverPrimitive.PopoverProps) {
  return <PopoverPrimitive.Root {...props} />
}

Popover.Root = PopoverRoot
Popover.Trigger = PopoverTrigger
Popover.Anchor = PopoverAnchor
Popover.Portal = PopoverPortal
Popover.Content = PopoverContent
Popover.Arrow = PopoverArrow
Popover.Close = PopoverClose
