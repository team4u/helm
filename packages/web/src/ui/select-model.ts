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

/**
 * 在可用选项中按步长寻找下一个未禁用的索引（支持上下环绕/边界截断）。
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
