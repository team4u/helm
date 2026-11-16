import type { ReactNode } from 'react'

export interface SelectOption<T extends string = string> {
  value: T
  label: ReactNode
  description?: string
  icon?: string
  disabled?: boolean
  meta?: ReactNode
}

export interface SelectChangeEvent<T extends string = string> {
  target: {
    value: T
    name?: string
  }
}

export interface MultiSelectChangeEvent<T extends string = string> {
  target: {
    value: T[]
    name?: string
  }
}

/**
 * Find the next non-disabled index by stepping through the available options
 * (wrap-around up/down and boundary clamping supported).
 */
export function findNextSelectableIndex<T extends string>(
  options: ReadonlyArray<SelectOption<T>>,
  currentIndex: number,
  step: 1 | -1,
): number {
  if (options.length === 0) return -1
  let idx = currentIndex + step
  while (idx >= 0 && idx < options.length) {
    if (!options[idx]?.disabled) return idx
    idx += step
  }
  return currentIndex
}
