import { useEffect, useRef, useState, type ReactNode } from 'react'
import { call, type Overview, type VideoRow } from './api'
import { clock } from './format'
import { Close } from './icons'

// the native dialog: focus trap, Escape and the backdrop come for free
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => ref.current?.showModal(), [])
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onClick={(e) => e.target === ref.current && ref.current?.close()}>
      <header>
        <h2>{title}</h2>
        <button className="icon" aria-label="Close" onClick={() => ref.current?.close()}>
          <Close />
        </button>
      </header>
      {children}
    </dialog>
  )
}

export function ShareDialog({ v, onClose, onChange }: { v: VideoRow; onClose: () => void; onChange: () => void }) {
  const [viewers, setViewers] = useState(v.viewers ?? [])
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      onChange()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title={`Share "${v.title}"`} onClose={onClose}>
      <p className="muted">Only people you add can watch. Each one sees their own email over the video.</p>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            const next = await call<VideoRow>(`/api/videos/${v.id}/viewers`, 'POST', { email })
            setViewers(next.viewers ?? [])
            setEmail('')
          })
        }}
      >
        <input type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required aria-label="Email to invite" />
        <button className="primary" disabled={busy}>
          Invite
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="label">People with access</p>
      <ul className="people">
        <li>
          <span className="avatar sm">Y</span>
          <span>You</span>
          <span className="muted">Owner</span>
        </li>
        {viewers.map((addr) => (
          <li key={addr}>
            <span className="avatar sm">{addr[0]?.toUpperCase()}</span>
            <span className="truncate">{addr}</span>
            <button
              className="text-btn"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await call(`/api/videos/${v.id}/viewers/${encodeURIComponent(addr)}`, 'DELETE')
                  setViewers((vs) => vs.filter((x) => x !== addr))
                })
              }
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  )
}

export function StatsDialog({ v, onClose }: { v: VideoRow; onClose: () => void }) {
  const [stats, setStats] = useState<Overview>()
  const [error, setError] = useState('')
  useEffect(() => void call<Overview>(`/api/videos/${v.id}/analytics`).then(setStats, (e: Error) => setError(e.message)), [v.id])

  return (
    <Dialog title="Analytics" onClose={onClose}>
      <p className="muted">{v.title}</p>
      {error && <p className="error">{error}</p>}
      {!stats && !error && <p className="muted">Loading</p>}
      {stats && (
        <>
          <dl className="kpis">
            <div>
              <dt>Plays</dt>
              <dd className="num">{stats.starts}</dd>
            </div>
            <div>
              <dt>Viewers</dt>
              <dd className="num">{stats.watchers}</dd>
            </div>
            <div>
              <dt>Finished</dt>
              <dd className="num">{stats.completed}</dd>
            </div>
          </dl>
          {stats.recent.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Viewer</th>
                  <th>Reached</th>
                  <th>Plays</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent.map((r, i) => (
                  <tr key={i}>
                    <td>{r.you ? 'You' : `Viewer ${i + 1}`}</td>
                    <td className="num">{r.completed ? 'Finished' : clock(r.position)}</td>
                    <td className="num">{r.starts}</td>
                    <td className="num">{new Date(r.lastSeen).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Dialog>
  )
}

export const remove = (v: VideoRow) => (confirm(`Delete "${v.title}"? The video and its files are removed for everyone.`) ? call(`/api/videos/${v.id}`, 'DELETE').then(() => true) : Promise.resolve(false))
