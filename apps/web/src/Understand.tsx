import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, call, type Answer, type Hit, type Understanding } from './api'
import { clock as mmss } from './format'
import { Check } from './icons'


type Tab = 'chapters' | 'search' | 'ask'

export function Understand({ id, owner, now, seek }: { id: string; owner: boolean; now: number; seek: (t: number) => void }) {
  const [info, setInfo] = useState<Understanding>()
  const [tab, setTab] = useState<Tab>('chapters')
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[]>()
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<Answer>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // poll while the transcript is still being made
  useEffect(() => {
    let stop = false
    let timer: ReturnType<typeof setTimeout>
    const load = () =>
      call<Understanding>(`/api/videos/${id}/understanding`).then((i) => {
        if (stop) return
        setInfo(i)
        if (i.status === 'pending' || i.status === 'running') timer = setTimeout(load, 4000)
      }, () => {})
    void load()
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [id])

  // no chapters means the first useful tab is search
  useEffect(() => {
    if (info?.status === 'done' && !info.chapters.length) setTab('search')
  }, [info])

  const fail = (e: unknown) => setError(e instanceof ApiError ? e.message : 'Something went wrong.')

  async function search(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      setHits(await call<Hit[]>(`/api/search?q=${encodeURIComponent(q)}&video=${id}`))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function ask(e: FormEvent) {
    e.preventDefault()
    setError('')
    setAnswer(undefined)
    setBusy(true)
    try {
      setAnswer(await call<Answer>(`/api/videos/${id}/ask`, 'POST', { question }))
    } catch (err) {
      fail(err)
    } finally {
      setBusy(false)
    }
  }

  async function retry() {
    await call(`/api/videos/${id}/understanding/retry`, 'POST', {}).catch(fail)
    setInfo(await call<Understanding>(`/api/videos/${id}/understanding`).catch(() => info))
  }

  if (!info || info.status === 'off') return null
  if (info.status === 'pending' || info.status === 'running')
    return (
      <p className="panel-note muted">
        <span className="spinner" aria-hidden /> Making the transcript. You can watch meanwhile.
      </p>
    )
  if (info.status === 'failed') {
    return (
      <p className="panel-note error">
        Transcript failed: {info.error}
        {owner && (
          <button className="link" onClick={retry}>
            Try again
          </button>
        )}
      </p>
    )
  }
  if (!info.hasCaptions) return <p className="panel-note muted">No speech found in this video.</p>

  const chapters = info.chapters
  const current = chapters.reduce((at, c, i) => (now >= c.start ? i : at), -1)

  return (
    <div className="panel">
      <div className="tabs-row panel-tabs" role="tablist">
        {(['chapters', 'search', 'ask'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className="tab" onClick={() => setTab(t)}>
            {t === 'chapters' ? 'Chapters' : t === 'search' ? 'Search' : 'Ask'}
          </button>
        ))}
      </div>

      {tab === 'chapters' &&
        (chapters.length ? (
          <ol className="curriculum" aria-label="Chapters">
            {chapters.map((c, i) => (
              <li key={c.start} className={i === current ? 'now' : i < current ? 'passed' : ''}>
                <button onClick={() => seek(c.start)}>
                  <span className="step" aria-hidden>
                    {i < current ? <Check /> : i + 1}
                  </span>
                  <span className="ctitle">{c.title}</span>
                  <span className="at">{mmss(c.start)}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted pad">No chapters for this video. Use search or ask.</p>
        ))}

      {tab === 'search' && (
        <div className="pad">
          <form onSubmit={search} className="find">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the transcript" aria-label="Search this video" minLength={2} required />
            <button className="ghost" disabled={busy}>
              Search
            </button>
          </form>
          {hits && (hits.length ? <HitList hits={hits} seek={seek} /> : <p className="meta">Nothing found.</p>)}
        </div>
      )}

      {tab === 'ask' && (
        <div className="pad">
          <form onSubmit={ask} className="find">
            <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask a question about this video" aria-label="Ask a question" minLength={3} maxLength={300} required />
            <button className="ghost" disabled={busy}>
              {busy ? 'Thinking' : 'Ask'}
            </button>
          </form>
          {answer &&
            (answer.found ? (
              <div className="answer">
                <p>{answer.answer}</p>
                <HitList hits={answer.citations} seek={seek} />
              </div>
            ) : (
              <p className="meta">This video does not seem to answer that.</p>
            ))}
        </div>
      )}

      {error && (
        <p className="error pad" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function HitList({ hits, seek }: { hits: { start: number; snippet: string; title?: string }[]; seek: (t: number) => void }) {
  return (
    <ul className="hits">
      {hits.map((h, i) => (
        <li key={i}>
          <button onClick={() => seek(h.start)}>
            <span className="at">{mmss(h.start)}</span> {h.snippet}
          </button>
        </li>
      ))}
    </ul>
  )
}
