import { useState } from 'react'
import { call, type User } from './api'
import { Logo } from './icons'

export function AuthForm({ onUser }: { onUser: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true)
    setError('')
    try {
      onUser(await call<User>(`/api/auth/${mode}`, 'POST', { email: form.get('email'), password: form.get('password') }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const login = mode === 'login'
  return (
    <main className="auth">
      <div className="auth-box">
        <span className="auth-logo">
          <Logo />
        </span>
        <h1>{login ? 'Sign in to lockframe' : 'Create your account'}</h1>
        <p className="muted">{login ? 'Private video for the people you choose.' : 'Upload a video and decide exactly who can watch it.'}</p>
        <form onSubmit={submit} className="form">
          <label>
            Email
            <input name="email" type="email" autoComplete="email" placeholder="name@company.com" required autoFocus />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete={login ? 'current-password' : 'new-password'} minLength={login ? undefined : 8} placeholder={login ? '' : 'At least 8 characters'} required />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary block" disabled={busy}>
            {busy ? 'Please wait' : login ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <p className="auth-switch muted">
          {login ? 'No account yet?' : 'Already have an account?'}{' '}
          <button type="button" className="text-btn" onClick={() => (setMode(login ? 'signup' : 'login'), setError(''))}>
            {login ? 'Create one' : 'Sign in'}
          </button>
        </p>
      </div>
    </main>
  )
}
