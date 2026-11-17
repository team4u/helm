/**
 * Shared state hooks for file/artifact preview modals (pure .ts, Fast Refresh safe).
 */
import { useEffect, useMemo, useState, type RefObject } from 'react'
import { decodePreviewText, shouldDecodeText } from './artifact-preview-text.js'
import { buildMarkdownOutline, resolveActiveOutlineEntryId, type OutlineHeadingNode } from './outline-model.js'

export type FilePreviewLoadState =
  | { phase: 'loading' }
  | { phase: 'loaded'; blob: Blob; blobUrl: string }
  | { phase: 'error'; message: string }

export type FilePreviewTextState = 'idle' | 'decoding' | 'exceeded' | 'binary'

export function useFilePreviewText(
  loadedBlob: Blob | undefined,
  meta: { name?: string } | undefined,
  mime: string,
): { text: string | null; textState: FilePreviewTextState } {
  const [text, setText] = useState<string | null>(null)
  const [textState, setTextState] = useState<FilePreviewTextState>('idle')

  useEffect(() => {
    if (loadedBlob === undefined) {
      setText(null)
      setTextState('idle')
      return
    }
    if (!shouldDecodeText(meta, mime)) {
      setText(null)
      setTextState('binary')
      return
    }
    let cancelled = false
    setText(null)
    setTextState('decoding')
    void decodePreviewText(loadedBlob)
      .then((value) => {
        if (cancelled) return
        if (value === null) {
          setTextState('exceeded')
        } else {
          setText(value)
          setTextState('idle')
        }
      })
      .catch(() => {
        if (!cancelled) setTextState('binary')
      })
    return () => {
      cancelled = true
    }
  }, [loadedBlob, mime, meta])

  return { text, textState }
}

export function useMarkdownOutlineSync(opts: {
  markdown: boolean
  active: boolean
  text: string | null
  modalBodyRef: RefObject<HTMLDivElement | null>
  markdownPreviewRef: RefObject<HTMLDivElement | null>
  resetKey: string
}): {
  markdownOutline: OutlineHeadingNode[]
  activeMarkdownHeading: number | undefined
  jumpToMarkdownHeading: (headingIndex: number) => void
} {
  const { markdown, active, text, modalBodyRef, markdownPreviewRef, resetKey } = opts
  const [activeMarkdownHeading, setActiveMarkdownHeading] = useState<number | undefined>(undefined)

  const markdownOutline = useMemo(
    () => (markdown && text !== null ? buildMarkdownOutline(text) : []),
    [markdown, text],
  )

  useEffect(() => {
    setActiveMarkdownHeading(undefined)
  }, [resetKey, text])

  useEffect(() => {
    if (!markdown || !active || markdownOutline.length === 0) return
    const scrollContainer = modalBodyRef.current
    const content = markdownPreviewRef.current
    if (scrollContainer === null || content === null) return

    const syncActiveHeading = (): void => {
      const containerTop = scrollContainer.getBoundingClientRect().top
      const offsets: Array<{ entryId: string; top: number }> = []
      for (const heading of content.querySelectorAll<HTMLElement>('[data-heading-index]')) {
        const index = heading.dataset.headingIndex
        if (index !== undefined) {
          offsets.push({ entryId: index, top: heading.getBoundingClientRect().top - containerTop })
        }
      }
      const activeId = resolveActiveOutlineEntryId(offsets, 48)
      setActiveMarkdownHeading(activeId !== undefined ? Number(activeId) : undefined)
    }

    syncActiveHeading()
    scrollContainer.addEventListener('scroll', syncActiveHeading, { passive: true })
    return () => scrollContainer.removeEventListener('scroll', syncActiveHeading)
  }, [markdown, active, markdownOutline.length, text, modalBodyRef, markdownPreviewRef])

  const jumpToMarkdownHeading = (headingIndex: number): void => {
    const target = markdownPreviewRef.current?.querySelector<HTMLElement>(`[data-heading-index="${headingIndex}"]`)
    if (target === null || target === undefined) return
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveMarkdownHeading(headingIndex)
  }

  return { markdownOutline, activeMarkdownHeading, jumpToMarkdownHeading }
}
