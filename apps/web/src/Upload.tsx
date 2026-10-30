import { useRef, useState } from 'react'
import { UploadIcon } from './icons'
import { mb } from './format'
import { upload, type KV } from '../../../shared/uploader.js'

// remembers the upload id per file so a reload can pick the same upload back up
const store: KV = {
  get: (k) => localStorage.getItem(k),
  set: (k, v) => localStorage.setItem(k, v),
  delete: (k) => localStorage.removeItem(k),
}

type State = 'idle' | 'uploading' | 'paused' | 'done' | 'error'

export function Upload({ onDone }: { onDone?: () => void }) {
  const [file, setFile] = useState<File>()
  const [state, setState] = useState<State>('idle')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [message, setMessage] = useState('')
  const abort = useRef<AbortController>(undefined)

  async function start(f: File) {
    abort.current = new AbortController()
    setState('uploading')
    setMessage('')
    try {
      const r = await upload(f, {
        api: '',
        store,
        signal: abort.current.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      })
      setState('done')
      onDone?.()
      setMessage(r.partsSkipped ? `Done. ${r.partsSkipped} parts were already uploaded.` : 'Done.')
    } catch (err) {
      if (abort.current.signal.aborted) return setState('paused')
      setState('error')
      setMessage(err instanceof Error ? err.message : 'Upload failed')
    }
  }

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0
  const busy = state === 'uploading'

  function pick(f?: File) {
    if (busy || !f) return
    setFile(f)
    setState('idle')
    setProgress({ done: 0, total: 0 })
    setMessage('')
  }

  const [over, setOver] = useState(false)

  return (
    <div className="page narrow">
      <header className="page-head">
        <div>
          <h1>Upload</h1>
          <p className="muted">Large files go up in parts. If the connection drops, pick the same file again and it continues.</p>
        </div>
      </header>

      <label
        className={`drop${over ? ' over' : ''}${busy ? ' disabled' : ''}`}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => (e.preventDefault(), setOver(false), pick(e.dataTransfer.files[0]))}
      >
        <span className="drop-icon">
          <UploadIcon />
        </span>
        <strong>{file ? 'Choose a different file' : 'Drag a video here, or click to browse'}</strong>
        <span className="muted">MP4, MOV, MKV or WebM</span>
        <input type="file" accept="video/*" disabled={busy} onChange={(e) => pick(e.target.files?.[0])} />
      </label>

      {file && (
        <section className="file-row">
          <div className="file-top">
            <span className="truncate title">{file.name}</span>
            <span className="muted num">
              {state === 'idle' ? `${mb(file.size)} MB` : `${mb(progress.done)} / ${mb(progress.total || file.size)} MB`}
            </span>
          </div>
          <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${pct}%` }} />
          </div>
          <div className="file-bottom">
            <span className={state === 'error' ? 'error small' : 'muted small'}>
              {message || (busy ? `Uploading, ${pct}%` : state === 'paused' ? `Paused at ${pct}%` : 'Ready to upload')}
            </span>
            <span className="actions">
              {(state === 'idle' || state === 'error') && (
                <button className="primary" onClick={() => start(file)}>
                  Upload
                </button>
              )}
              {state === 'paused' && (
                <button className="primary" onClick={() => start(file)}>
                  Resume
                </button>
              )}
              {busy && <button onClick={() => abort.current?.abort()}>Pause</button>}
            </span>
          </div>
          {state === 'error' && <p className="muted small">Pick the same file again and press Upload to continue where it stopped.</p>}
        </section>
      )}
    </div>
  )
}
