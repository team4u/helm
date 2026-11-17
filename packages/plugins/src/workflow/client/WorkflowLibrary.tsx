/**
 * Workflow library fullscreen view component (screen extension point):
 * first-level main-stage card grid + right detail drawer; read-only browsing
 * / source viewing / running / deleting / refreshing, no source editing. The
 * workbench's compact run entry lives in WorkflowLibrarySection; the card /
 * detail drawer live in WorkflowLibraryCard / WorkflowLibraryDrawer.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helm/protocol'
import { resolveLocalizedText, usePluginLocale } from '@helm/plugin-client'
import { useWorkflowLibrary } from './hooks.ts'
import { SPIN } from './presentation.ts'
import { Icon } from './WorkflowIcon.tsx'
import { WorkflowLibraryCard } from './WorkflowLibraryCard.tsx'
import { WorkflowLibraryDrawer } from './WorkflowLibraryDrawer.tsx'
import { filterSavedWorkflows } from './model-library.ts'
import {
  LIB_EMPTY,
  LIB_LOAD_FAILED,
  LIB_LOADING,
  LIB_NO_MATCH,
  LIB_REFRESH,
  LIB_REFRESH_TITLE,
  LIB_RETRY,
  LIB_SCREEN_SUBTITLE,
  LIB_SCREEN_TITLE,
  LIB_SEARCH_ARIA,
  LIB_SEARCH_CLEAR_ARIA,
  LIB_SEARCH_CLEAR_TITLE,
  LIB_SEARCH_PLACEHOLDER,
} from './copy.ts'

/**
 * Selected item and search term are written into sp.* deep-link params
 * (setParams as the sole navigation mechanism); inlineDrawer lets host-inline
 * scenarios and SSR/test environments render the drawer inline (same
 * contract as AppCenterScreen).
 */
export interface WorkflowLibraryScreenProps extends ScreenProps {
  inlineDrawer?: boolean
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
