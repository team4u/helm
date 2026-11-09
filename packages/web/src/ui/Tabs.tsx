import React, { createContext, useContext, useState, forwardRef } from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import type {
  TabsVariant,
  TabsSize,
  SegmentedControlItem,
  SegmentedControlProps,
  TabsContextValue,
} from './tabs-model.js'

export type {
  TabsVariant,
  TabsSize,
  SegmentedControlItem,
  SegmentedControlProps,
  TabsContextValue,
}

const TabsContext = createContext<TabsContextValue>({
  variant: 'underline',
})

const TabsListContext = createContext<{ variant: TabsVariant }>({
  variant: 'underline',
})

export interface TabsProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root> {
  variant?: TabsVariant
  size?: TabsSize
}

export const Tabs = forwardRef<React.ComponentRef<typeof TabsPrimitive.Root>, TabsProps>(
  function Tabs({ variant = 'underline', size, value, defaultValue, onValueChange, className, ...props }, ref) {
    const isControlled = value !== undefined
    const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? '')
    const activeValue = isControlled ? value : uncontrolledValue

    const handleValueChange = (newVal: string) => {
      if (!isControlled) {
        setUncontrolledValue(newVal)
      }
      onValueChange?.(newVal)
    }

    const contextValue: TabsContextValue = {
      value: activeValue,
      onValueChange: handleValueChange,
      variant,
      size,
    }

    const rootClass = [
      'helm-tabs',
      variant && `helm-tabs-${variant}`,
      size && `helm-tabs-${size}`,
      className,
    ]
      .filter(Boolean)
      .join(' ')

    return (
      <TabsContext.Provider value={contextValue}>
        <TabsPrimitive.Root
          ref={ref}
          value={value}
          defaultValue={defaultValue}
          onValueChange={handleValueChange}
          className={rootClass}
          {...props}
        />
      </TabsContext.Provider>
    )
  },
)

export interface TabsListProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
  variant?: TabsVariant
  size?: TabsSize
}

export const TabsList = forwardRef<React.ComponentRef<typeof TabsPrimitive.List>, TabsListProps>(
  function TabsList({ variant: variantProp, size: sizeProp, className = '', ...props }, ref) {
    const context = useContext(TabsContext)
    const variant = variantProp ?? context.variant
    const isSegmented = variant === 'segmented' || className.includes('segmented-control')
    const resolvedVariant: TabsVariant = isSegmented ? 'segmented' : 'underline'

    const defaultBaseClass = resolvedVariant === 'segmented' ? 'segmented-control' : 'tabs-bar'
    const listClass = className.includes(defaultBaseClass)
      ? className
      : [defaultBaseClass, className].filter(Boolean).join(' ')

    return (
      <TabsListContext.Provider value={{ variant: resolvedVariant }}>
        <TabsPrimitive.List ref={ref} className={listClass} {...props} />
      </TabsListContext.Provider>
    )
  },
)

export interface TabsTriggerProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> {
  variant?: TabsVariant
}

export const TabsTrigger = forwardRef<React.ComponentRef<typeof TabsPrimitive.Trigger>, TabsTriggerProps>(
  function TabsTrigger({ variant: variantProp, className = '', value, onClick, ...props }, ref) {
    const rootContext = useContext(TabsContext)
    const listContext = useContext(TabsListContext)
    const variant = variantProp ?? listContext.variant ?? rootContext.variant
    const isSegmented = variant === 'segmented' || className.includes('segmented-control-btn')

    const isActive = rootContext.value !== undefined && rootContext.value === value
    const defaultBaseClass = isSegmented ? 'segmented-control-btn' : 'tab-btn'
    const activeClass = isSegmented
      ? (isActive ? ' is-active' : '')
      : (isActive ? ' tab-btn-active' : '')

    const triggerClass = className.includes(defaultBaseClass)
      ? `${className}${isActive && !className.includes(activeClass.trim()) ? activeClass : ''}`
      : `${defaultBaseClass}${activeClass} ${className}`.trim()

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(e)
      if (rootContext.onValueChange && rootContext.value !== value) {
        rootContext.onValueChange(value)
      }
    }

    return (
      <TabsPrimitive.Trigger
        ref={ref}
        value={value}
        className={triggerClass}
        onClick={handleClick}
        {...props}
      />
    )
  },
)

export interface TabsContentProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content> {}

export const TabsContent = forwardRef<React.ComponentRef<typeof TabsPrimitive.Content>, TabsContentProps>(
  function TabsContent({ className = '', ...props }, ref) {
    const contentClass = ['tabs-content', className].filter(Boolean).join(' ')
    return <TabsPrimitive.Content ref={ref} className={contentClass} {...props} />
  },
)

export function SegmentedControl<T extends string = string>({
  value,
  defaultValue,
  onValueChange,
  items,
  size,
  disabled = false,
  className = '',
  rootClassName = '',
  style,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <Tabs
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange as (val: string) => void}
      variant="segmented"
      size={size}
      className={rootClassName}
      style={style}
    >
      <TabsList className={['segmented-control', className].filter(Boolean).join(' ')} aria-label={ariaLabel}>
        {items.map((item) => (
          <TabsTrigger
            key={item.value}
            value={item.value}
            disabled={disabled || item.disabled}
            title={item.title}
            aria-label={item.ariaLabel}
            className={item.className}
            onClick={item.onClick}
          >
            {item.icon}
            {item.label}
            {item.badge}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}

// Compound component attachments
type TabsCompound = typeof Tabs & {
  List: typeof TabsList
  Trigger: typeof TabsTrigger
  Content: typeof TabsContent
}

;(Tabs as TabsCompound).List = TabsList
;(Tabs as TabsCompound).Trigger = TabsTrigger
;(Tabs as TabsCompound).Content = TabsContent
