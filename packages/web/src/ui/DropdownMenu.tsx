import * as React from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { useOverlayChildStyle } from './overlay-stack.js'

export interface DropdownMenuPortalProps extends DropdownMenuPrimitive.DropdownMenuPortalProps {}

/**
 * SSR 容错 Portal：在服务端渲染 (typeof window === 'undefined') 阶段直接渲染 children。
 */
export function DropdownMenuPortal({ children, container }: DropdownMenuPortalProps) {
  if (typeof window === 'undefined') {
    return <>{children}</>
  }
  return (
    <DropdownMenuPrimitive.Portal container={container}>
      {children}
    </DropdownMenuPrimitive.Portal>
  )
}

export function DropdownMenuRoot(props: DropdownMenuPrimitive.DropdownMenuProps) {
  return <DropdownMenuPrimitive.Root {...props} />
}

export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
export const DropdownMenuGroup = DropdownMenuPrimitive.Group
export const DropdownMenuSub = DropdownMenuPrimitive.Sub
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

export interface DropdownMenuContentProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> {
  portalled?: boolean
}

export const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Content>,
  DropdownMenuContentProps
>(({ className = '', sideOffset = 4, align = 'end', portalled = false, children, style, ...props }, ref) => {
  const layeredStyle = useOverlayChildStyle(style)
  const content = (
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      align={align}
      className={`helm-dropdown-content ${className}`.trim()}
      style={layeredStyle}
      {...props}
    >
      {children}
    </DropdownMenuPrimitive.Content>
  )

  if (portalled) {
    return <DropdownMenuPortal>{content}</DropdownMenuPortal>
  }

  return content
})
DropdownMenuContent.displayName = 'DropdownMenuContent'

export interface DropdownMenuItemProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> {
  danger?: boolean
}

export const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Item>,
  DropdownMenuItemProps
>(({ className = '', danger = false, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={`helm-dropdown-item popover-item ${danger ? 'helm-dropdown-item-danger popover-item-danger' : ''} ${className}`.trim()}
    {...props}
  />
))
DropdownMenuItem.displayName = 'DropdownMenuItem'

export interface DropdownMenuSeparatorProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator> {}

export const DropdownMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  DropdownMenuSeparatorProps
>(({ className = '', ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={`helm-dropdown-separator popover-separator ${className}`.trim()}
    {...props}
  />
))
DropdownMenuSeparator.displayName = 'DropdownMenuSeparator'

export interface DropdownMenuLabelProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> {}

export const DropdownMenuLabel = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Label>,
  DropdownMenuLabelProps
>(({ className = '', ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={`helm-dropdown-label ${className}`.trim()}
    {...props}
  />
))
DropdownMenuLabel.displayName = 'DropdownMenuLabel'

export interface DropdownMenuSubTriggerProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> {
  inset?: boolean
}

export const DropdownMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubTrigger>,
  DropdownMenuSubTriggerProps
>(({ className = '', inset, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={`helm-dropdown-item popover-item helm-dropdown-sub-trigger ${inset ? 'is-inset' : ''} ${className}`.trim()}
    {...props}
  >
    {children}
  </DropdownMenuPrimitive.SubTrigger>
))
DropdownMenuSubTrigger.displayName = 'DropdownMenuSubTrigger'

export interface DropdownMenuSubContentProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent> {}

export const DropdownMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.SubContent>,
  DropdownMenuSubContentProps
>(({ className = '', ...props }, ref) => (
  <DropdownMenuPrimitive.SubContent
    ref={ref}
    className={`helm-dropdown-content helm-dropdown-sub-content ${className}`.trim()}
    {...props}
  />
))
DropdownMenuSubContent.displayName = 'DropdownMenuSubContent'

export interface DropdownMenuArrowProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Arrow> {}

export const DropdownMenuArrow = React.forwardRef<
  React.ComponentRef<typeof DropdownMenuPrimitive.Arrow>,
  DropdownMenuArrowProps
>(({ className = '', width = 10, height = 5, ...props }, ref) => (
  <DropdownMenuPrimitive.Arrow
    ref={ref}
    width={width}
    height={height}
    className={`helm-dropdown-arrow ${className}`.trim()}
    {...props}
  />
))
DropdownMenuArrow.displayName = 'DropdownMenuArrow'

/**
 * 通用 Radix DropdownMenu 封装组件
 */
export function DropdownMenu(props: DropdownMenuPrimitive.DropdownMenuProps) {
  return <DropdownMenuPrimitive.Root {...props} />
}

DropdownMenu.Root = DropdownMenuRoot
DropdownMenu.Trigger = DropdownMenuTrigger
DropdownMenu.Portal = DropdownMenuPortal
DropdownMenu.Content = DropdownMenuContent
DropdownMenu.Item = DropdownMenuItem
DropdownMenu.Separator = DropdownMenuSeparator
DropdownMenu.Label = DropdownMenuLabel
DropdownMenu.Group = DropdownMenuGroup
DropdownMenu.Sub = DropdownMenuSub
DropdownMenu.SubTrigger = DropdownMenuSubTrigger
DropdownMenu.SubContent = DropdownMenuSubContent
DropdownMenu.RadioGroup = DropdownMenuRadioGroup
DropdownMenu.Arrow = DropdownMenuArrow
