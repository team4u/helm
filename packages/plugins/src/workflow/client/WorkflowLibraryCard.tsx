/** Workflow library card component: name/description/phases/file facts; click opens the right detail drawer. */
import type { ReactNode } from 'react'
import { formatBytes, formatTime, resolveLocalizedText, usePluginLocale } from '@helm/plugin-client'
import { Icon } from './WorkflowIcon.tsx'
import { firstLineOf } from './model-format.ts'
import {
  LIB_CARD_NO_DESCRIPTION,
  LIB_CARD_VIEW_DETAILS,
  libCardAria,
  libDefinitionFileTitle,
  libMetadataError,
  libPhases,
} from './copy.ts'
import type { SavedWorkflowView } from './model-library.ts'

export function WorkflowLibraryCard(props: { item: SavedWorkflowView; onShowDetail: () => void }): ReactNode {
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
        <span className="badge badge-neutral">{resolveLocalizedText(LIB_CARD_VIEW_DETAILS, locale)}</span>
      </div>
    </div>
  )
}
