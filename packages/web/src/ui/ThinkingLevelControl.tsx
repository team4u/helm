import React from 'react'
import { Tabs, TabsList, TabsTrigger } from './Tabs.js'

export interface ThinkingLevelControlProps {
  /** 选中值：'' 表示跟随默认（Profile / 全局继承），否则为具体档位。 */
  value: string
  /** 目标模型支持的思考档位列表（空或仅 off 时不渲染，由调用方决定）。 */
  levels: ReadonlyArray<string>
  /** 选中档位变化；'' 表示清除跟随默认。 */
  onPick: (level: string) => void
  disabled?: boolean
  /** 「跟随默认」项的悬浮说明（会话=跟随模型/Profile；角色=跟随全局缺省）。 */
  defaultTitle?: string
  defaultLabel?: string
  className?: string
  'aria-label'?: string
}

/**
 * 思考档位分段按钮组（会话模型浮层与角色卡抽屉共用）：
 * - 基于 Radix Tabs 原语的 segmented-control，首项恒为「默认」（value: ''）；
 * - value 语义：'' = 跟随默认继承链；具体档位 = 显式指定；
 * - 严格遵循零 Emoji 铁律。
 */
export function ThinkingLevelControl({
  value,
  levels,
  onPick,
  disabled = false,
  defaultTitle = '跟随模型 / Profile 默认档位',
  defaultLabel = '默认',
  className = 'composer-thinking-row',
  'aria-label': ariaLabel = '思考档位',
}: ThinkingLevelControlProps): React.JSX.Element | null {
  if (levels.length === 0) return null
  return (
    <Tabs value={value} onValueChange={onPick} variant="segmented" style={{ width: '100%' }}>
      <TabsList className={`segmented-control ${className}`.trim()} aria-label={ariaLabel}>
        <TabsTrigger value="" disabled={disabled} title={defaultTitle} onClick={() => onPick('')}>
          {defaultLabel}
        </TabsTrigger>
        {levels.map((level) => (
          <TabsTrigger key={level} value={level} disabled={disabled} onClick={() => onPick(level)}>
            {level}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
