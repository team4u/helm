import React from 'react'
import { Tabs, TabsList, TabsTrigger } from '@helm/plugin-client'

export interface ThinkingLevelControlProps {
  /** 选中值：实际生效的具体档位。 */
  value: string
  /** 目标模型支持的思考档位列表（空或仅 off 时不渲染，由调用方决定）。 */
  levels: ReadonlyArray<string>
  /** 选中档位变化。 */
  onPick: (level: string) => void
  disabled?: boolean
  className?: string
  'aria-label'?: string
}

/**
 * 思考档位分段按钮组（会话模型浮层、待命卡与角色卡抽屉共用）：
 * - 基于 Radix Tabs 原语的 segmented-control；
 * - 纯实体档位展示（对齐 Pi Agent，移除「默认」伪档位），所见即所得；
 * - 外部传入空串或无效值时，安全回退至模型支持的有效档位；
 * - 严格遵循零 Emoji 铁律。
 */
export function ThinkingLevelControl({
  value,
  levels,
  onPick,
  disabled = false,
  className = 'composer-thinking-row',
  'aria-label': ariaLabel = '思考档位',
}: ThinkingLevelControlProps): React.JSX.Element | null {
  if (levels.length === 0) return null
  const safeValue = levels.includes(value) ? value : (levels[0] ?? '')
  return (
    <Tabs value={safeValue} onValueChange={onPick} variant="segmented" style={{ width: '100%' }}>
      <TabsList className={`segmented-control ${className}`.trim()} aria-label={ariaLabel}>
        {levels.map((level) => (
          <TabsTrigger key={level} value={level} disabled={disabled} onClick={() => onPick(level)}>
            {level}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
