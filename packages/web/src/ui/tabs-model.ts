import type React from 'react'

export type TabsVariant = 'underline' | 'segmented' | 'default'
export type TabsSize = 'sm' | 'md'

export interface SegmentedControlItem<T extends string = string> {
  value: T
  label: React.ReactNode
  disabled?: boolean
  title?: string
  ariaLabel?: string
  badge?: React.ReactNode
  icon?: React.ReactNode
  className?: string
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
}

export interface SegmentedControlProps<T extends string = string> {
  value?: T
  defaultValue?: T
  onValueChange?: (value: T) => void
  items: ReadonlyArray<SegmentedControlItem<T>>
  size?: TabsSize
  disabled?: boolean
  className?: string
  rootClassName?: string
  style?: React.CSSProperties
  'aria-label'?: string
  name?: string
}

export interface TabsContextValue {
  value?: string
  onValueChange?: (value: string) => void
  variant: TabsVariant
  size?: TabsSize
}
