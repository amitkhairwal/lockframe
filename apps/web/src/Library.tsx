import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { call, type VideoEvent, type VideoRow } from './api'
import { clock, day } from './format'
import { Chart, Check, Dots, Film, Play, Search, Share, Trash, UploadIcon } from './icons'
import { remove, ShareDialog, StatsDialog } from './Manage'

type Filter = 'all' | 'progress' | 'done' | 'shared' | 'mine'

// how far this person got, 0 to 1
export const watched = (v: VideoRow) => (v.completed ? 1 : v.duration && v.position ? Math.min(1, v.position / v.duration) : 0)
const started = (v: VideoRow) => v.status === 'ready' && !v.completed && (v.position ?? 0) >= 5
const busy = (v: VideoRow) => v.status === 'processing' || v.status === 'uploaded'

const FILTERS: { id: Filter; label: string; test: (v: VideoRow) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'progress', label: 'In progress', test: started },
  { id: 'done', label: 'Completed', test: (v) => !!v.completed },
  { id: 'mine', label: 'My uploads', test: (v) => v.role === 'owner' },
  { id: 'shared', label: 'Shared with me', test: (v) => v.role === 'viewer' },
]

export function Library() {
  const [rows, setRows] = useState<VideoRow[]>()
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [dialog, setDialog] = useState<{ kind: 'share' | 'stats'; v: VideoRow }>()

  const load = useCallback(() => call<VideoRow[]>('/api/videos').then(setRows, (e: Error) => setError(e.message)), [])
  useEffect(() => void load(), [load])

  // live progress: patch the row in place, reload when something finishes or a new video shows up
  useEffect(() => {
    const socket = io()
    socket.on('video', (e: VideoEvent) => {
      setRows((rs) => {
        if (!rs?.some((r) => r.id === e.id)) {
          void load()
          return rs
        }
        return rs.map((r) => (r.id === e.id ? { ...r, status: e.status, progress: e.progress, failure: e.failure, retryable: e.retryable } : r))
      })
      if (e.status === 'ready' || e.status === 'failed') void load()
    })
    return () => void socket.close()
  }, [load])

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase()
    const test = FILTERS.find((f) => f.id === filter)!.test
    return (rows ?? []).filter((v) => test(v) && (!term || v.title.toLowerCase().includes(term)))
  }, [rows, filter, q])

  const resume = (rows ?? []).filter(started).slice(0, 4)

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Library</h1>
          <p className="muted num">{rows ? `${rows.length} ${rows.length === 1 ? 'video' : 'videos'}` : ' '}</p>
        </div>
        <div className="head-actions">
          <label className="search">
            <Search />
            <input type="search" placeholder="Search videos" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search videos" />
          </label>
          <a className="btn primary" href="#/upload">
            <UploadIcon /> Upload
          </a>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      {rows && !rows.length ? (
        <div className="empty">
          <span className="empty-icon">
            <Film />
          </span>
          <h2>No videos yet</h2>
          <p className="muted">Upload a video, then invite people by email. Only they can watch it.</p>
          <a className="btn primary" href="#/upload">
            <UploadIcon /> Upload a video
          </a>
        </div>
      ) : (
        <>
          {resume.length > 0 && !q && filter === 'all' && (
            <section className="section">
              <h2 className="section-title">Continue watching</h2>
              <ul className="resume">
                {resume.map((v) => (
                  <li key={v.id}>
                    <a href={`#/watch/${v.id}`} className="resume-item">
                      <Thumb v={v} />
                      <div className="resume-text">
                        <span className="title truncate">{v.title}</span>
                        <span className="muted num">
                          {clock(v.position ?? 0)} of {clock(v.duration ?? 0)}
                        </span>
                      </div>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="section">
            <div className="tabs-row" role="tablist" aria-label="Filter videos">
              {FILTERS.map((f) => (
                <button key={f.id} role="tab" aria-selected={filter === f.id} className="tab" onClick={() => setFilter(f.id)}>
                  {f.label}
                  {rows && <span className="count num">{rows.filter(f.test).length}</span>}
                </button>
              ))}
            </div>

            {!rows ? (
              <ul className="grid" aria-busy>
                {[0, 1, 2, 3].map((i) => (
                  <li key={i} className="card">
                    <div className="thumb skeleton" />
                    <div className="skeleton line" />
                    <div className="skeleton line short" />
                  </li>
                ))}
              </ul>
            ) : shown.length ? (
              <ul className="grid">
                {shown.map((v) => (
                  <Card key={v.id} v={v} reload={load} open={(kind) => setDialog({ kind, v })} />
                ))}
              </ul>
            ) : (
              <p className="muted nothing">No videos match.</p>
            )}
          </section>
        </>
      )}

      {dialog?.kind === 'share' && <ShareDialog v={dialog.v} onClose={() => setDialog(undefined)} onChange={() => void load()} />}
      {dialog?.kind === 'stats' && <StatsDialog v={dialog.v} onClose={() => setDialog(undefined)} />}
    </div>
  )
}

// the real first-frame still, with a plain placeholder until the worker has made one
export function Thumb({ v }: { v: VideoRow }) {
  const [failed, setFailed] = useState(false)
  const frac = watched(v)
  return (
    <span className="thumb">
      {!failed && v.status !== 'uploading' && <img src={`/api/videos/${v.id}/thumb`} alt="" loading="lazy" onError={() => setFailed(true)} />}
      {(failed || v.status === 'uploading') && (
        <span className="thumb-empty">
          <Film />
        </span>
      )}
      {v.status === 'ready' && v.duration ? <span className="duration num">{clock(v.duration)}</span> : null}
      {v.status === 'ready' && frac > 0 && (
        <span className="watched" aria-label={`${Math.round(frac * 100)}% watched`}>
          <span style={{ width: `${frac * 100}%` }} />
        </span>
      )}
    </span>
  )
}

const STATUS: Record<string, string> = { uploaded: 'Queued', uploading: 'Uploading', failed: 'Failed' }

function Card({ v, reload, open }: { v: VideoRow; reload: () => void; open: (kind: 'share' | 'stats') => void }) {
  const [menu, setMenu] = useState(false)
  const [error, setError] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const off = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false)
    addEventListener('mousedown', off)
    addEventListener('keydown', esc)
    return () => {
      removeEventListener('mousedown', off)
      removeEventListener('keydown', esc)
    }
  }, [menu])

  const ready = v.status === 'ready'
  const pick = (fn: () => void) => () => {
    setMenu(false)
    fn()
  }

  return (
    <li className="card">
      <a className={`card-media${ready ? '' : ' disabled'}`} href={ready ? `#/watch/${v.id}` : undefined} aria-label={ready ? `Watch ${v.title}` : undefined}>
        <Thumb v={v} />
        {ready && (
          <span className="play-hint" aria-hidden>
            <Play size={18} />
          </span>
        )}
        {busy(v) && (
          <span className="overlay">
            <span className="overlay-text num">{v.status === 'uploaded' ? 'Queued' : `Processing ${v.progress}%`}</span>
            <span className="overlay-bar">
              <span style={{ width: `${v.progress}%` }} />
            </span>
          </span>
        )}
        {v.status === 'failed' && <span className="overlay failed">Processing failed</span>}
      </a>

      <div className="card-body">
        <div className="card-title">
          <h3 className="truncate" title={v.title}>
            {v.title}
          </h3>
          {v.role === 'owner' && (
            <div className="menu-wrap" ref={menuRef}>
              <button className="icon" aria-label={`Options for ${v.title}`} aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(!menu)}>
                <Dots />
              </button>
              {menu && (
                <div className="menu" role="menu">
                  <button role="menuitem" disabled={!ready} onClick={pick(() => open('share'))}>
                    <Share /> Share
                  </button>
                  <button role="menuitem" disabled={!ready} onClick={pick(() => open('stats'))}>
                    <Chart /> Analytics
                  </button>
                  <hr />
                  <button role="menuitem" className="danger" onClick={pick(() => void remove(v).then((gone) => gone && reload(), (e: Error) => setError(e.message)))}>
                    <Trash /> Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <p className="meta num">
          {v.role === 'viewer' ? 'Shared with you' : v.viewers?.length ? `Shared with ${v.viewers.length}` : 'Only you'}
          <span className="dot">·</span>
          {day(v.createdAt)}
          {v.completed && (
            <>
              <span className="dot">·</span>
              <span className="done">
                <Check /> Watched
              </span>
            </>
          )}
          {!ready && STATUS[v.status] && !busy(v) && (
            <>
              <span className="dot">·</span>
              {STATUS[v.status]}
            </>
          )}
        </p>
        {v.status === 'failed' && (
          <p className="error small">
            {v.failure}
            {v.role === 'owner' && v.retryable && (
              <button className="text-btn" onClick={() => call(`/api/videos/${v.id}/retry`, 'POST').then(reload, (e: Error) => setError(e.message))}>
                Retry
              </button>
            )}
          </p>
        )}
        {error && <p className="error small">{error}</p>}
      </div>
    </li>
  )
}
