import { useCallback, useEffect, useState } from 'react'
import { call, type Flag } from './api'
import { FlagIcon } from './icons'

export function Flags() {
  const [flags, setFlags] = useState<Flag[]>()
  const load = useCallback(() => void call<Flag[]>('/api/flags').then(setFlags, () => setFlags([])), [])
  useEffect(load, [load])

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Flags</h1>
          <p className="muted">Playback patterns on your videos worth a look. They come from simple rules, so treat them as hints, not proof.</p>
        </div>
      </header>
      {flags && !flags.length && (
        <div className="empty">
          <span className="empty-icon">
            <FlagIcon />
          </span>
          <h2>Nothing flagged</h2>
          <p className="muted">A second device, heavy replaying, or keys requested far ahead of the playhead will show up here.</p>
        </div>
      )}
      {!!flags?.length && (
        <ul className="flag-list">
          {flags.map((f) => (
            <li key={f.id} className="flag">
              <div className="flag-main">
                <div className="flag-head">
                  <span className="tag red">{f.viewer}</span>
                  <span className="title">{f.title ?? 'Video'}</span>
                </div>
                <p>{f.text}</p>
                <p className="meta num">
                  {f.count} times within {f.windowMinutes} min<span className="dot">·</span>last {new Date(f.lastAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                </p>
                {f.summary && <p className="quote">{f.summary}</p>}
              </div>
              <button onClick={() => call(`/api/flags/${encodeURIComponent(f.id)}/dismiss`, 'POST').then(load)}>Dismiss</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
