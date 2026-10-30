import { useEffect, useState } from 'react'
import { ApiError, call, type User } from './api'
import { AuthForm } from './AuthForm'
import { Flags } from './Flags'
import { FlagIcon, Grid, Logo, LogOut, Monitor, Moon, Sun, UploadIcon } from './icons'
import { Library } from './Library'
import { Upload } from './Upload'
import { Watch } from './Watch'

// pages live in the hash, so reload and the back button work without a router
export const go = (path: string) => void (location.hash = path)
function useRoute() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = () => {
      setHash(location.hash)
      scrollTo(0, 0)
    }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return hash.replace(/^#/, '') || '/'
}

type Theme = 'system' | 'light' | 'dark'
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem('sv_theme') as Theme) || 'system'
    } catch {
      return 'system'
    }
  })
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('sv_theme', theme)
    } catch {}
  }, [theme])
  return [theme, setTheme] as const
}

const NAV = [
  { path: '/', label: 'Library', icon: Grid },
  { path: '/upload', label: 'Upload', icon: UploadIcon },
  { path: '/flags', label: 'Flags', icon: FlagIcon },
]
const THEMES = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
] as const

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined) // undefined: still asking
  const [theme, setTheme] = useTheme()
  const route = useRoute()

  useEffect(() => {
    call<User>('/api/auth/me').then(setUser, (e) => {
      if (e instanceof ApiError && e.status === 401) setUser(null)
    })
  }, [])

  if (user === undefined) return null
  if (!user) return <AuthForm onUser={setUser} />

  const watching = route.match(/^\/watch\/([\w-]+)$/)?.[1]
  const section = watching ? '/' : route

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#/">
          <Logo />
          <span>lockframe</span>
        </a>
        <nav aria-label="Main">
          {NAV.map(({ path, label, icon: Icon }) => (
            <a key={path} href={`#${path}`} className="nav" aria-current={section === path ? 'page' : undefined}>
              <Icon />
              <span>{label}</span>
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {THEMES.map(({ id, label, icon: Icon }) => (
              <button key={id} role="radio" aria-checked={theme === id} title={label} aria-label={label} onClick={() => setTheme(id)}>
                <Icon />
              </button>
            ))}
          </div>
          <div className="me">
            <span className="avatar" aria-hidden>
              {user.email[0]?.toUpperCase()}
            </span>
            <span className="me-email" title={user.email}>
              {user.email}
            </span>
            <button className="icon" title="Log out" aria-label="Log out" onClick={() => call('/api/auth/logout', 'POST').then(() => setUser(null))}>
              <LogOut />
            </button>
          </div>
        </div>
      </aside>
      <main className="main">
        {watching ? (
          <Watch key={watching} id={watching} />
        ) : route === '/upload' ? (
          <Upload onDone={() => go('/')} />
        ) : route === '/flags' ? (
          <Flags />
        ) : (
          <Library />
        )}
      </main>
    </div>
  )
}
