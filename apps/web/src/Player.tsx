import Hls from 'hls.js'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ApiError, call, type Playback } from './api'
import { Expand } from './icons'
import { Understand } from './Understand'

const REFRESH_MS = 60_000 // the token lives 2 minutes, the slot 90 seconds
const WATERMARK_MS = 7_000
const PROGRESS_MS = 10_000

export function Player({ id, owner, children }: { id: string; owner: boolean; children?: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const [viewer, setViewer] = useState('')
  const [spot, setSpot] = useState({ x: 8, y: 10 })
  const [now, setNow] = useState(0) // playhead in whole seconds, for the chapter list

  useEffect(() => {
    const leaseKey = `sv_lease_${id}`
    let token = ''
    let lease = sessionStorage.getItem(leaseKey) ?? undefined
    let hls: Hls | undefined
    let timer: ReturnType<typeof setInterval>
    let pings: ReturnType<typeof setInterval>
    let unlisten = () => {}
    let closed = false

    const fail = (message: string) => {
      if (closed) return
      setError(message)
      hls?.destroy()
      clearInterval(timer)
    }

    // the same call starts playback and refreshes it
    async function renew() {
      const p = await call<Playback>(`/api/videos/${id}/playback`, 'POST', { lease })
      token = p.token
      lease = p.lease
      sessionStorage.setItem(leaseKey, p.lease)
      return p
    }

    renew().then(
      (p) => {
        if (closed) return
        setViewer(p.viewer)
        if (!Hls.isSupported()) return fail('This browser cannot play protected video. Use a current Chrome, Edge or Firefox.')
        hls = new Hls({
          startPosition: p.resume > 0 ? p.resume : -1, // continue where this person stopped
          // the token goes on key requests only, never on playlists or segments
          xhrSetup: (xhr, url) => {
            if (url.includes('/api/keys/')) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
          },
        })
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (d.details === Hls.ErrorDetails.KEY_LOAD_ERROR) fail('Playback was stopped: this video is open on another device, or your access ended.')
          else if (d.fatal) fail('Playback failed. Try again.')
        })
        hls.loadSource(p.master)
        hls.attachMedia(video.current!)
        void video.current!.play().catch(() => {}) // autoplay can be blocked, the controls still work

        // tell the server where we are: it saves the resume spot and uses it to spot keys asked for far ahead
        const el = video.current!
        const send = (type: string) => void call(`/api/videos/${id}/events`, 'POST', { type, position: el.currentTime }).catch(() => {})
        const discrete = { play: () => send('play'), pause: () => send('pause'), seeked: () => send('seek'), ended: () => send('ended') }
        for (const [name, fn] of Object.entries(discrete)) el.addEventListener(name, fn)
        pings = setInterval(() => !el.paused && send('progress'), PROGRESS_MS)
        unlisten = () => {
          for (const [name, fn] of Object.entries(discrete)) el.removeEventListener(name, fn)
          clearInterval(pings)
        }
        timer = setInterval(() => renew().catch((e) => fail(e instanceof ApiError && e.status === 409 ? 'Playback was stopped: this video is open on another device.' : 'Playback was stopped.')), REFRESH_MS)
      },
      (e) => fail(e instanceof ApiError && e.status === 409 && /another device/.test(e.message) ? 'This video is playing on another device. Close it there, or wait a minute, then try again.' : e instanceof ApiError ? e.message : 'Could not start playback.'),
    )

    // free the slot when the tab goes away
    const stop = () => {
      if (!lease) return
      if (video.current) navigator.sendBeacon(`/api/videos/${id}/events`, new Blob([JSON.stringify({ type: 'progress', position: video.current.currentTime })], { type: 'application/json' }))
      navigator.sendBeacon(`/api/videos/${id}/playback/stop`, new Blob([JSON.stringify({ lease })], { type: 'application/json' }))
      sessionStorage.removeItem(leaseKey)
    }
    addEventListener('pagehide', stop)
    return () => {
      closed = true
      clearInterval(timer)
      unlisten()
      removeEventListener('pagehide', stop)
      stop()
      hls?.destroy()
    }
  }, [id])

  useEffect(() => {
    const el = video.current
    if (!el) return
    const tick = () => setNow(Math.floor(el.currentTime))
    el.addEventListener('timeupdate', tick)
    return () => el.removeEventListener('timeupdate', tick)
  }, [error])

  // the watermark is the viewer's email and it keeps moving, so cropping one corner does not remove it
  useEffect(() => {
    const move = setInterval(() => setSpot({ x: 5 + Math.random() * 60, y: 8 + Math.random() * 75 }), WATERMARK_MS)
    return () => clearInterval(move)
  }, [])

  return (
    <div className="watch">
      <div className="watch-main">
        {error ? (
          <div className="stage stage-error" role="alert">
            <p>{error}</p>
            <button onClick={() => location.reload()}>Try again</button>
          </div>
        ) : (
          <div className="stage" ref={wrap}>
            {/* our own fullscreen button, because the native one would leave the watermark behind */}
            <video ref={video} controls playsInline controlsList="nofullscreen" disablePictureInPicture onContextMenu={(e) => e.preventDefault()}>
              <track kind="subtitles" label="Transcript" src={`/api/videos/${id}/captions.vtt`} />
            </video>
            {viewer && (
              <span className="watermark" data-testid="watermark" style={{ left: `${spot.x}%`, top: `${spot.y}%` }}>
                {viewer}
              </span>
            )}
            <button className="fs" aria-label="Fullscreen" title="Fullscreen" onClick={() => void wrap.current?.requestFullscreen()}>
              <Expand />
            </button>
          </div>
        )}
        {children}
      </div>
      <aside className="watch-side">
        <Understand id={id} owner={owner} now={now} seek={(t) => void (video.current && ((video.current.currentTime = t), video.current.play().catch(() => {})))} />
      </aside>
    </div>
  )
}
