import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'

export interface TooltipProviderProps extends TooltipPrimitive.TooltipProviderProps {}

/**
 * 全局或局部 TooltipProvider 包装器
 */
export function TooltipProvider({
  delayDuration = 300,
  skipDelayDuration = 150,
  children,
  ...props
}: TooltipProviderProps) {
  return (
    <TooltipPrimitive.Provider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    >
      {children}
    </TooltipPrimitive.Provider>
  )
}

export function TooltipRoot(props: TooltipPrimitive.TooltipProps) {
  return <TooltipPrimitive.Root {...props} />
}

export const TooltipTrigger = TooltipPrimitive.Trigger

export interface TooltipPortalProps extends TooltipPrimitive.TooltipPortalProps {}

/**
 * SSR 容错 Portal：在服务端渲染 (typeof window === 'undefined') 阶段直接渲染 children。
 */
export function TooltipPortal({ children, container }: TooltipPortalProps) {
  if (typeof window === 'undefined') {
    return <>{children}</>
  }
  return <TooltipPrimitive.Portal container={container}>{children}</TooltipPrimitive.Portal>
}

export interface TooltipContentProps extends React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> {}

export const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  TooltipContentProps
>(({ className = '', sideOffset = 5, side = 'top', align = 'center', children, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    side={side}
    sideOffset={sideOffset}
    align={align}
    className={`helm-tooltip-content ${className}`.trim()}
    {...props}
  >
    {children}
  </TooltipPrimitive.Content>
))
TooltipContent.displayName = 'TooltipContent'

export interface TooltipArrowProps extends React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Arrow> {}

export const TooltipArrow = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Arrow>,
  TooltipArrowProps
>(({ className = '', width = 8, height = 4, ...props }, ref) => (
  <TooltipPrimitive.Arrow
    ref={ref}
    width={width}
    height={height}
    className={`helm-tooltip-arrow ${className}`.trim()}
    {...props}
  />
))
TooltipArrow.displayName = 'TooltipArrow'

export interface TooltipProps {
  content: React.ReactNode
  children?: React.ReactElement | null
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  delayDuration?: number
  disabled?: boolean
  className?: string
}

/**
 * 极简悬浮提示组件：
 * - 自动包装 Provider 与 Portal，在无外层 Provider 场景下依然能安全独立渲染（对 SSR/单测友好）；
 * - 纯图标按钮的悬浮提示与 aria-label 对应。
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  sideOffset = 5,
  open,
  defaultOpen,
  onOpenChange,
  delayDuration = 300,
  disabled = false,
  className = '',
}: TooltipProps) {
  if (disabled || !content || !children) {
    return children ?? null
  }
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={onOpenChange}
        delayDuration={delayDuration}
      >
        <TooltipPrimitive.Trigger asChild>
          {children}
        </TooltipPrimitive.Trigger>
        <TooltipPortal>
          <TooltipContent side={side} align={align} sideOffset={sideOffset} className={className}>
            {content}
            <TooltipArrow />
          </TooltipContent>
        </TooltipPortal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}

Tooltip.Provider = TooltipProvider
Tooltip.Root = TooltipRoot
Tooltip.Trigger = TooltipTrigger
Tooltip.Portal = TooltipPortal
Tooltip.Content = TooltipContent
Tooltip.Arrow = TooltipArrow
