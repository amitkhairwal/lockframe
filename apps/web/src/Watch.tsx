import { useCallback, useEffect, useState } from 'react'
import { call, type VideoRow } from './api'
import { go } from './App'
import { day, mb } from './format'
import { Back, Chart, Share, Trash } from './icons'
import { remove, ShareDialog, StatsDialog } from './Manage'
import { Player } from './Player'

export function Watch({ id }: { id: string }) {
  const [v, setV] = useState<VideoRow>()
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<'share' | 'stats'>()

  const load = useCallback(() => call<VideoRow>(`/api/videos/${id}`).then(setV, (e: Error) => setError(e.message)), [id])
  useEffect(() => void load(), [load])

  return (
    <div className="page watch-page">
      <a className="back" href="#/">
        <Back /> Library
      </a>
      {error && <p className="error">{error}</p>}
      {v &&
        (v.status !== 'ready' ? (
          <p className="muted">This video is not ready yet.</p>
        ) : (
          <Player id={v.id} owner={v.role === 'owner'}>
            <div className="watch-info">
              <div>
                <h1>{v.title}</h1>
                <p className="meta num">
                  {day(v.createdAt)}
                  <span className="dot">·</span>
                  {mb(v.size)} MB
                  {v.heights && (
                    <>
                      <span className="dot">·</span>
                      {v.heights.map((h) => `${h}p`).join(', ')}
                    </>
                  )}
                  <span className="dot">·</span>
                  {v.role === 'viewer' ? 'Shared with you' : v.viewers?.length ? `Shared with ${v.viewers.length}` : 'Only you'}
                </p>
              </div>
              {v.role === 'owner' && (
                <div className="watch-actions">
                  <button onClick={() => setDialog('share')}>
                    <Share /> Share
                  </button>
                  <button onClick={() => setDialog('stats')}>
                    <Chart /> Analytics
                  </button>
                  <button className="icon danger" aria-label="Delete video" title="Delete video" onClick={() => void remove(v).then((gone) => gone && go('/'), (e: Error) => setError(e.message))}>
                    <Trash />
                  </button>
                </div>
              )}
            </div>
          </Player>
        ))}
      {v && dialog === 'share' && <ShareDialog v={v} onClose={() => setDialog(undefined)} onChange={() => void load()} />}
      {v && dialog === 'stats' && <StatsDialog v={v} onClose={() => setDialog(undefined)} />}
    </div>
  )
}
