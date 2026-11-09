import * as React from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'

export interface PopoverPortalProps extends PopoverPrimitive.PopoverPortalProps {}

/**
 * SSR 容错 Portal：在服务端渲染 (typeof window === 'undefined') 阶段直接渲染 children，
 * 避免 createPortal 依赖 document.body 导致渲染降级或抛错。
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
>(({ className = '', align = 'center', sideOffset = 6, portalled = false, children, ...props }, ref) => {
  const content = (
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={`helm-popover-content ${className}`.trim()}
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
    className={`helm-popover-arrow ${className}`.trim()}
    {...props}
  />
))
PopoverArrow.displayName = 'PopoverArrow'

/**
 * 通用 Radix Popover 封装组件
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
