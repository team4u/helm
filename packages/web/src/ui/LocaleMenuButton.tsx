import { useState, type ReactNode } from 'react'
import { HelmIcon } from '@helm/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useHelmStore } from '../lib/store-context.js'
import { resolveBrowserLocale } from '../lib/theme-preferences.js'
import type { LocalePreference } from '../lib/types.js'
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from './DropdownMenu.js'
import { Tooltip } from './Tooltip.js'

export interface LocaleMenuButtonProps {
  className?: string
  iconSize?: number
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  menuSide?: 'top' | 'right' | 'bottom' | 'left'
  menuAlign?: 'start' | 'center' | 'end'
}

/**
 * Compact icon-only language switcher backed by Radix DropdownMenu:
 * offers Auto (follow browser) / English / 简体中文 right alongside the theme toggle.
 */
export function LocaleMenuButton({
  className = 'btn btn-ghost btn-sm sidebar-locale-toggle',
  iconSize = 16,
  tooltipSide = 'right',
  menuSide = 'right',
  menuAlign = 'end',
}: LocaleMenuButtonProps): ReactNode {
  const store = useHelmStore()
  const { t } = useWebLocale()
  const [open, setOpen] = useState(false)
  const pref = store.localePreference ?? 'auto'

  const options: ReadonlyArray<{ value: LocalePreference; label: string }> = [
    { value: 'auto', label: t('shell.locale.auto') },
    { value: 'en', label: 'English' },
    { value: 'zh-CN', label: '简体中文' },
  ]

  const currentLabel = options.find((item) => item.value === pref)?.label ?? t('shell.locale.auto')
  const triggerLabel = t('shell.locale.label')
  const tooltipText = `${triggerLabel} (${currentLabel})`

  const selectPreference = (next: LocalePreference): void => {
    if (store.setLocalePreference) {
      store.setLocalePreference(next)
    } else {
      store.setLocale(next === 'auto' ? resolveBrowserLocale() : next)
    }
    setOpen(false)
  }

  return (
    <DropdownMenuRoot open={open} onOpenChange={setOpen}>
      <Tooltip content={tooltipText} side={tooltipSide}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={className}
            title={tooltipText}
            aria-label={triggerLabel}
            aria-expanded={open}
          >
            <HelmIcon name="globe" size={iconSize} />
          </button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuPortal>
        <DropdownMenuContent
          className="locale-menu-popover"
          side={menuSide}
          align={menuAlign}
          sideOffset={6}
        >
          {options.map((item) => {
            const selected = pref === item.value
            return (
              <DropdownMenuItem
                key={item.value}
                className="locale-menu-item"
                data-locale-option={item.value}
                data-active={selected ? 'true' : undefined}
                aria-checked={selected}
                onSelect={() => selectPreference(item.value)}
              >
                <span>{item.label}</span>
                {selected && <HelmIcon name="check" size={12} />}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenuRoot>
  )
}
