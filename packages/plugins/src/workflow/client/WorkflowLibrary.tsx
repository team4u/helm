/**
 * Workflow library fullscreen view component (screen extension point):
 * first-level main-stage card grid + right detail drawer; read-only browsing
 * / source viewing / running / deleting / refreshing, no source editing.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helmx/protocol'
import { formatBytes, formatTime, resolveLocalizedText, usePluginLocale } from '@helmx/plugin-client'
import { useWorkflowLibrary } from './hooks.ts'
import { Icon } from './WorkflowIcon.tsx'
import { WorkflowLibraryDrawer } from './WorkflowLibraryDrawer.tsx'
import { firstLineOf } from './model-format.ts'
import { filterSavedWorkflows, type SavedWorkflowView } from './model-library.ts'
import {
  LIB_CARD_NO_DESCRIPTION,
  libCardAria,
  libDefinitionFileTitle,
  LIB_EMPTY,
  LIB_LOAD_FAILED,
  LIB_LOADING,
  libMetadataError,
  LIB_NO_MATCH,
  libPhases,
  LIB_REFRESH,
  LIB_REFRESH_TITLE,
  LIB_RETRY,
  LIB_SCREEN_SUBTITLE,
  LIB_SCREEN_TITLE,
  LIB_SEARCH_ARIA,
  LIB_SEARCH_CLEAR_ARIA,
  LIB_SEARCH_CLEAR_TITLE,
  LIB_SEARCH_PLACEHOLDER,
  SPIN,
} from './copy.ts'

export interface WorkflowLibraryScreenProps extends ScreenProps {
  inlineDrawer?: boolean
}

function WorkflowLibraryCard(props: { item: SavedWorkflowView; onShowDetail: () => void }): ReactNode {
  const { item } = props
  const locale = usePluginLocale()
  const description = item.metadataError !== undefined ? undefined : item.description
  return (
    <div
      className={`workflow-lib-card${item.metadataError !== undefined ? ' workflow-lib-card-warn' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={libCardAria(item.name, locale)}
      onClick={props.onShowDetail}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          props.onShowDetail()
        }
      }}
    >
      <div className="workflow-lib-card-head">
        <Icon name="terminal" size={14} />
        <strong className="workflow-lib-card-name" title={item.path ?? item.name}>{item.name}</strong>
      </div>
      {item.metadataError !== undefined ? (
        <div className="callout callout--warning workflow-lib-card-meta-error">{libMetadataError(firstLineOf(item.metadataError, 120), locale)}</div>
      ) : (
        <>
          {description !== undefined ? (
            <div className="workflow-lib-card-desc" title={description}>{firstLineOf(description, 140)}</div>
          ) : (
            <div className="workflow-lib-card-desc workflow-lib-card-desc-empty">{resolveLocalizedText(LIB_CARD_NO_DESCRIPTION, locale)}</div>
          )}
          {item.phases !== undefined ? (
            <div className="workflow-lib-card-phases" title={item.phases.map((p) => p.title).join(' → ')}>
              {libPhases(item.phases.length, item.phases.map((p) => p.title).join(' / '), locale)}
            </div>
          ) : null}
        </>
      )}
      <div className="workflow-lib-card-footer">
        <span className="workflow-lib-card-facts tabular-nums" title={libDefinitionFileTitle(`${item.path ?? item.name}.js`, locale)}>
          {formatTime(item.updatedAt)} · {formatBytes(item.size)}
        </span>
        <Icon name="chevron-right" size={12} className="workflow-lib-card-entry" />
      </div>
    </div>
  )
}

export function WorkflowLibraryScreen(props: WorkflowLibraryScreenProps): ReactNode {
  const { items, error, loading, reload } = useWorkflowLibrary()
  const locale = usePluginLocale()
  const queryParam = props.params['q'] ?? ''
  const [queryDraft, setQueryDraft] = useState(queryParam)
  useEffect(() => {
    setQueryDraft(queryParam)
  }, [queryParam])
  const query = queryDraft.trim().toLowerCase()
  const selectedName = props.params['wf']
  const selectedItem = selectedName !== undefined ? items?.find((i) => i.name === selectedName) : undefined

  const filtered = useMemo(
    () => (items === undefined ? undefined : filterSavedWorkflows(items, query)),
    [items, query],
  )

  return (
    <div className="screen-container workflow-lib-screen">
      <div className="screen-header">
        <div className="screen-title">
          <Icon name="terminal" size={15} />
          <span>{resolveLocalizedText(LIB_SCREEN_TITLE, locale)}</span>
        </div>
        <span className="screen-subtitle">
          {LIB_SCREEN_SUBTITLE(items?.length ?? 0, props.isSplit, locale)}
        </span>
        <div className="stack-row">
          <button type="button" className="btn btn-sm" disabled={loading} onClick={() => void reload()} title={resolveLocalizedText(LIB_REFRESH_TITLE, locale)}>
            <Icon name="rotate-cw" size={12} className={loading ? SPIN : undefined} />
            {resolveLocalizedText(LIB_REFRESH, locale)}
          </button>
        </div>
      </div>

      <div className="screen-section">
        <div className="workflow-lib-toolbar">
          <div className="workflow-lib-search">
            <Icon name="search" size={13} />
            <input
              type="text"
              className="input"
              placeholder={resolveLocalizedText(LIB_SEARCH_PLACEHOLDER, locale)}
              value={queryDraft}
              onChange={(e) => {
                const value = e.target.value
                setQueryDraft(value)
                props.setParams({ q: value === '' ? undefined : value })
              }}
              aria-label={resolveLocalizedText(LIB_SEARCH_ARIA, locale)}
            />
            {queryDraft !== '' ? (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                title={resolveLocalizedText(LIB_SEARCH_CLEAR_TITLE, locale)}
                aria-label={resolveLocalizedText(LIB_SEARCH_CLEAR_ARIA, locale)}
                onClick={() => {
                  setQueryDraft('')
                  props.setParams({ q: undefined })
                }}
              >
                <Icon name="x" size={11} />
              </button>
            ) : null}
          </div>
        </div>

        {loading && items === undefined ? <div className="workflow-phase-empty">{resolveLocalizedText(LIB_LOADING, locale)}</div> : null}
        {error !== undefined ? (
          <div className="callout callout--error">
            <div>{LIB_LOAD_FAILED(error, locale)}</div>
            <button type="button" className="btn btn-xs" onClick={() => void reload()}>{resolveLocalizedText(LIB_RETRY, locale)}</button>
          </div>
        ) : null}
        {items !== undefined && items.length === 0 && error === undefined ? (
          <div className="workflow-phase-empty">
            {resolveLocalizedText(LIB_EMPTY, locale)}
          </div>
        ) : null}
        {filtered !== undefined && filtered.length === 0 && query !== '' ? (
          <div className="workflow-phase-empty">{LIB_NO_MATCH(queryDraft.trim(), locale)}</div>
        ) : null}

        {filtered !== undefined && filtered.length > 0 ? (
          <div className="workflow-lib-grid">
            {filtered.map((item) => (
              <WorkflowLibraryCard
                key={item.name}
                item={item}
                onShowDetail={() => props.setParams({ wf: item.name })}
              />
            ))}
          </div>
        ) : null}
      </div>

      {selectedItem !== undefined ? (
        <WorkflowLibraryDrawer
          item={selectedItem}
          inline={props.inlineDrawer}
          onClose={() => props.setParams({ wf: undefined })}
          onDeleted={() => {
            void reload()
            props.setParams({ wf: undefined })
          }}
        />
      ) : null}
    </div>
  )
}
