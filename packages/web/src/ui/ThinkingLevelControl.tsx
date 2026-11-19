import React from 'react'
import { Tabs, TabsList, TabsTrigger } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'

export interface ThinkingLevelControlProps {
  /** Selected value: the concrete level actually in effect. */
  value: string
  /** Thinking levels the target model supports (render nothing when empty or off-only; the caller decides). */
  levels: ReadonlyArray<string>
  /** Selected level change. */
  onPick: (level: string) => void
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

/**
 * Thinking level segmented control (shared by the conversation model popover,
 * standby cards and the profile drawer):
 * - segmented-control built on the Radix Tabs primitive;
 * - plain entity levels only (aligned with Pi Agent, no fake "Default" level),
 *   what you see is what you get;
 * - an empty or invalid incoming value falls back safely to a level the model
 *   supports;
 * - strictly follows the zero-Emoji rule. The default aria-label resolves from
 *   the active locale (an explicit aria-label prop wins).
 */
export function ThinkingLevelControl({
  value,
  levels,
  onPick,
  disabled = false,
  className = 'composer-thinking-row',
  'aria-label': ariaLabel,
}: ThinkingLevelControlProps): React.JSX.Element | null {
  const { t } = useWebLocale()
  if (levels.length === 0) return null
  const safeValue = levels.includes(value) ? value : (levels[0] ?? '')
  return (
    <Tabs value={safeValue} onValueChange={onPick} variant="segmented" style={{ width: '100%' }}>
      <TabsList className={`segmented-control ${className}`.trim()} aria-label={ariaLabel ?? t('ui.thinking.levelLabel')}>
        {levels.map((level) => (
          <TabsTrigger key={level} value={level} disabled={disabled} onClick={() => onPick(level)}>
            {level}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
