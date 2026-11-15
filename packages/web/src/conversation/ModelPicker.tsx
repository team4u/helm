import { useState } from 'react'
import type { ConversationSummary } from '@helm/protocol'
import { assetsApi, conversationsApi } from '../lib/api.js'
import { HelmIcon, Popover, PopoverContent, PopoverPortal, PopoverTrigger } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import { ThinkingLevelControl } from '../ui/ThinkingLevelControl.js'
import { Tooltip } from '../ui/Tooltip.js'

// ---------------------------------------------------------------------------
// ModelPicker（自 Composer.tsx 拆出）：模型与思考档位选择，Radix Popover 浮层。
// ---------------------------------------------------------------------------

export function ModelPicker({ conversation }: { conversation: ConversationSummary }) {
  const store = useHelmStore()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')

  const refreshCatalog = async (): Promise<void> => {
    setRefreshing(true)
    try {
      const res = await assetsApi.refreshModels()
      await store.refreshAssets()
      const errors = Object.entries(res.errors ?? {})
      if (errors.length > 0) {
        store.pushNotice({
          type: 'notification',
          level: 'warning',
          title: '部分供应商目录刷新失败',
          body: errors.map(([p, err]) => `${p}: ${err}`).join('; '),
          conversationId: conversation.id,
        })
      } else {
        store.pushNotice({
          type: 'notification',
          level: 'info',
          title: '已刷新模型目录',
          body: `共 ${store.models.length} 个可用模型`,
          conversationId: conversation.id,
        })
      }
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '刷新模型目录失败',
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    } finally {
      setRefreshing(false)
    }
  }

  const pick = async (model: string): Promise<void> => {
    setOpen(false)
    if (model === conversation.model) return
    setPending(true)
    try {
      await conversationsApi.patch(conversation.id, { model })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '切换模型失败',
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    } finally {
      setPending(false)
    }
  }

  const pickThinking = async (level: string): Promise<void> => {
    setPending(true)
    try {
      await conversationsApi.patch(conversation.id, { thinkingLevel: level })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '切换思考等级失败',
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    } finally {
      setPending(false)
    }
  }

  const resetToProfileDefault = async (): Promise<void> => {
    setOpen(false)
    setPending(true)
    try {
      await conversationsApi.patch(conversation.id, { model: '', thinkingLevel: '' })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: '恢复默认配置失败',
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    } finally {
      setPending(false)
    }
  }

  const rawShortName = conversation.model.split('/').pop() ?? conversation.model
  const shortName = rawShortName.trim() !== '' ? rawShortName : '默认模型'
  const currentModel = store.models.find((model) => model.id === conversation.model)
  const currentLevels = currentModel?.thinkingLevels ?? ['off']
  const supportsThinking = currentLevels.some((level) => level !== 'off')
  // 生效档位与展示：优先取当前会话实际生效档位；若不在当前模型支持列表中，则回退至 off 或首项支持档位。
  const activeLevel = conversation.thinkingLevel
  const fallbackLevel = currentLevels.includes('off') ? 'off' : (currentLevels[0] ?? '')
  const effectiveLevel = currentLevels.includes(activeLevel) ? activeLevel : fallbackLevel
  const showLevel = supportsThinking && effectiveLevel !== '' && effectiveLevel !== 'off'

  return (
    <span className="composer-picker-root">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="btn btn-ghost btn-sm composer-model-button"
            disabled={pending}
            aria-expanded={open}
            aria-label={`模型与思考档位：${shortName}${showLevel ? ` · ${effectiveLevel}` : ''}`}
            title={`当前模型：${conversation.model}${showLevel ? ` · 思考 ${effectiveLevel}` : ''}`}
          >
            {pending ? <HelmIcon name="loader" size={12} className="spin-slow" /> : null}
            <span className="composer-model-label">{shortName}</span>
            {showLevel ? <span className="composer-model-level">· {effectiveLevel}</span> : null}
            <HelmIcon name="chevron-down" size={12} />
          </button>
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={8}
            className="composer-popover composer-model-popover"
          >
            <button
              type="button"
              className="popover-item"
              onClick={() => void resetToProfileDefault()}
              title="清除显式覆盖，重算 Profile/全局继承链"
            >
              跟随 Profile 默认（清除覆盖）
            </button>
            <div className="composer-model-search-bar" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div className="search-box" style={{ flex: 1, minWidth: 0 }}>
                <HelmIcon name="search" size={13} />
                <input
                  aria-label="搜索模型"
                  placeholder="搜索模型…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <Tooltip content="刷新动态模型目录" side="top">
                <button
                  type="button"
                  className="btn btn-ghost btn-icon-sm composer-model-refresh-btn"
                  disabled={refreshing}
                  title="刷新动态模型目录"
                  aria-label="刷新动态模型目录"
                  onClick={(e) => {
                    e.stopPropagation()
                    void refreshCatalog()
                  }}
                >
                  <HelmIcon name="rotate-cw" size={13} className={refreshing ? 'spin-slow' : undefined} />
                </button>
              </Tooltip>
            </div>
            {store.models.filter((model) => model.available && model.disabled !== true && model.id.toLowerCase().includes(query.toLowerCase())).map((m) => (
              <button
                key={m.id}
                title={m.id}
                type="button"
                className={`popover-item${m.id === conversation.model ? ' popover-item-active' : ''}`}
                onClick={() => void pick(m.id)}
              >
                <span className="mono">{m.modelId}</span>
                <span className="popover-item-meta">{m.provider}</span>
              </button>
            ))}
            {store.models.every((model) => !model.available || model.disabled === true) && (
              <div className="popover-item" style={{ cursor: 'default', color: 'var(--fg-subtle)' }}>暂无可用模型；请先在「模型与凭据」配置供应商密钥</div>
            )}
            {supportsThinking ? (
              <>
                <div className="popover-header">
                  思考档位
                  <span style={{ color: 'var(--fg-subtle)' }}>{shortName}</span>
                </div>
                <ThinkingLevelControl
                  value={effectiveLevel}
                  levels={currentLevels}
                  disabled={pending}
                  onPick={(level) => void pickThinking(level)}
                />
              </>
            ) : null}
          </PopoverContent>
        </PopoverPortal>
      </Popover>
    </span>
  )
}
