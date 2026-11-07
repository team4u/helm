import { useCallback, useEffect, useState } from 'react'
import { assetsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'

const SKILL_MAIN_FILE = 'SKILL.md'

export function SkillViewerModal({
  initialSkillId,
  onClose,
}: {
  initialSkillId?: string
  onClose: () => void
}) {
  const store = useHelmStore()
  const [selectedId, setSelectedId] = useState<string | null>(initialSkillId ?? store.skills[0]?.id ?? null)
  const [activeFile, setActiveFile] = useState<string>(SKILL_MAIN_FILE)
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const skill = store.skills.find((s) => s.id === selectedId)
  const files = skill ? [SKILL_MAIN_FILE, ...skill.references] : []

  const loadFile = useCallback(async (skillId: string, path: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await assetsApi.readSkill(skillId, path === SKILL_MAIN_FILE ? undefined : path)
      setText(res.text)
    } catch (err) {
      setText('')
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!selectedId) return
    void loadFile(selectedId, activeFile)
  }, [selectedId, activeFile, loadFile])

  const selectSkill = (id: string) => {
    setSelectedId(id)
    setActiveFile(SKILL_MAIN_FILE)
  }

  const copyReference = async () => {
    if (!selectedId) return
    const ref = `/skill:${selectedId}`
    try {
      await navigator.clipboard.writeText(ref)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      store.pushNotice({
        type: 'notification',
        level: 'warning',
        title: '复制失败',
        body: '剪贴板不可用，请手动复制引用指令',
      })
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 900 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <HelmIcon name="sparkles" size={15} />
            技能库 Skills
            <span className="badge badge-neutral">只读</span>
          </span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            <HelmIcon name="x" size={14} />
          </button>
        </div>
        <div className="modal-body" style={{ flexDirection: 'row', gap: 14, alignItems: 'stretch' }}>
          <div style={{ width: 240, minWidth: 240, overflowY: 'auto' }} className="list">
            {store.skills.length === 0 && (
              <div className="row" style={{ color: 'var(--fg-subtle)' }}>暂无可用技能</div>
            )}
            {store.skills.map((s) => (
              <button
                key={s.id}
                className="row"
                style={{
                  width: '100%',
                  background: selectedId === s.id ? 'var(--bg-active)' : 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 3,
                }}
                onClick={() => selectSkill(s.id)}
              >
                <span style={{ display: 'flex', gap: 6, alignItems: 'center', width: '100%', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 500, fontSize: 12.5 }}>{s.name}</span>
                  {s.references.length > 0 && (
                    <span className="badge badge-neutral tabular-nums">{s.references.length} 文件</span>
                  )}
                </span>
                <span className="mono" style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{s.id}</span>
                {s.description && (
                  <span style={{ fontSize: 11, color: 'var(--fg-muted)', whiteSpace: 'normal', wordBreak: 'break-word' }}>
                    {s.description}
                  </span>
                )}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {!selectedId && (
              <div style={{ color: 'var(--fg-subtle)', fontSize: 12.5, padding: '24px 0', textAlign: 'center' }}>
                选择左侧技能查看内容
              </div>
            )}
            {selectedId && (
              <>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {files.map((f) => (
                    <button
                      key={f}
                      className={`badge${activeFile === f ? ' badge-accent' : ' badge-neutral'}`}
                      style={{ cursor: 'pointer', height: 24 }}
                      onClick={() => setActiveFile(f)}
                    >
                      <HelmIcon name="file-text" size={10} />
                      {f}
                    </button>
                  ))}
                  <span style={{ flex: 1 }} />
                  <button className="btn btn-sm" onClick={() => void copyReference()}>
                    <HelmIcon name={copied ? 'check' : 'copy'} size={12} />
                    {copied ? '已复制' : `复制 /skill:${selectedId}`}
                  </button>
                </div>
                {error ? (
                  <div className="jr-callout jr-callout-err">
                    <HelmIcon name="alert-circle" size={13} />
                    <span className="selectable">{error}</span>
                  </div>
                ) : loading ? (
                  <div style={{ color: 'var(--fg-muted)', fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <HelmIcon name="loader" size={13} />
                    正在读取文件...
                  </div>
                ) : (
                  <pre
                    className="mono selectable"
                    style={{
                      margin: 0,
                      flex: 1,
                      minHeight: 300,
                      maxHeight: '52vh',
                      overflow: 'auto',
                      padding: '12px 14px',
                      background: 'var(--bg-subtle)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 12,
                      lineHeight: 1.6,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {text}
                  </pre>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
