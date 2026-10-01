import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isSupabaseConfigured, supabase } from '../lib/supabase'

interface AuthGateProps {
  children: (userId: string) => ReactNode
}

export function AuthGate({ children }: AuthGateProps) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [authError, setAuthError] = useState('')
  const [passwordRecovery, setPasswordRecovery] = useState(false)

  useEffect(() => {
    if (!supabase) return

    let active = true
    void supabase.auth.getSession()
      .then(({ data, error }) => {
        if (!active) return
        if (error) setAuthError(error.message)
        setSession(data.session)
        setLoading(false)
      })
      .catch((error: unknown) => {
        if (!active) return
        setAuthError(error instanceof Error ? error.message : 'Không thể khôi phục phiên đăng nhập.')
        setLoading(false)
      })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession)
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true)
      if (event === 'SIGNED_OUT') setPasswordRecovery(false)
      setAuthError('')
      setLoading(false)
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  if (!isSupabaseConfigured || !supabase) {
    return (
      <main className="auth-page">
        <section className="auth-panel">
          <p className="eyebrow">THIẾT LẬP HỆ THỐNG</p>
          <h1>Chưa kết nối cơ sở dữ liệu</h1>
          <p>Hãy tạo dự án Supabase, chạy schema trong thư mục <code>supabase</code>, rồi cấu hình VITE_SUPABASE_URL và VITE_SUPABASE_ANON_KEY trên môi trường deploy.</p>
          <p className="auth-note">Không nhập service-role key vào ứng dụng hoặc biến môi trường có tiền tố VITE_.</p>
        </section>
      </main>
    )
  }

  if (loading) {
    return <main className="auth-page"><p className="auth-loading">Đang khôi phục phiên đăng nhập...</p></main>
  }

  if (session?.user.id) {
    if (passwordRecovery) return <PasswordRecovery onComplete={() => setPasswordRecovery(false)} />
    return <>{children(session.user.id)}</>
  }

  return <EmailAuthForm initialError={authError} />
}

function EmailAuthForm({ initialError }: { initialError: string }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState(initialError)
  const [submitting, setSubmitting] = useState(false)

  const handlePasswordReset = async () => {
    if (!supabase) return
    if (!email.trim()) {
      setError('Nhập email để nhận liên kết đặt lại mật khẩu.')
      return
    }

    setSubmitting(true)
    setError('')
    setMessage('')
    const { error: requestError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin,
    })
    if (requestError) setError(requestError.message)
    else setMessage('Nếu email tồn tại, hướng dẫn đặt lại mật khẩu sẽ được gửi tới hộp thư của bạn.')
    setSubmitting(false)
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase) return

    setSubmitting(true)
    setError('')
    setMessage('')

    try {
      if (mode === 'signup') {
        const { data, error: requestError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: window.location.origin },
        })
        if (requestError) throw requestError
        if (!data.session) {
          setMessage('Tài khoản đã được tạo. Hãy xác nhận email rồi đăng nhập.')
        }
      } else {
        const { error: requestError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        })
        if (requestError) throw requestError
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Không thể xác thực tài khoản.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="brand-mark">CL</div>
        <p className="eyebrow">CONTAINER LOAD OPTIMIZER</p>
        <h1>{mode === 'signin' ? 'Đăng nhập' : 'Tạo tài khoản'}</h1>
        <p className="auth-subtitle">Dữ liệu dự án được lưu riêng trong tài khoản của bạn.</p>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label>Email
            <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <label>Mật khẩu
            <input type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          {message && <p className="auth-note" role="status">{message}</p>}
          <button type="submit" className="primary" disabled={submitting}>
            {submitting ? 'Đang xử lý...' : mode === 'signin' ? 'Đăng nhập' : 'Tạo tài khoản'}
          </button>
        </form>
        {mode === 'signin' && <button type="button" className="auth-switch" onClick={() => void handlePasswordReset()} disabled={submitting}>Quên mật khẩu?</button>}
        <button type="button" className="auth-switch" onClick={() => {
          setMode((current) => current === 'signin' ? 'signup' : 'signin')
          setError('')
          setMessage('')
        }}>
          {mode === 'signin' ? 'Chưa có tài khoản? Đăng ký' : 'Đã có tài khoản? Đăng nhập'}
        </button>
      </section>
    </main>
  )
}

function PasswordRecovery({ onComplete }: { onComplete: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!supabase) return
    setSubmitting(true)
    setError('')
    const { error: requestError } = await supabase.auth.updateUser({ password })
    if (requestError) {
      setError(requestError.message)
      setSubmitting(false)
      return
    }
    onComplete()
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <p className="eyebrow">BẢO MẬT TÀI KHOẢN</p>
        <h1>Đặt mật khẩu mới</h1>
        <form className="auth-form" onSubmit={handleSubmit}>
          <label>Mật khẩu mới
            <input type="password" autoComplete="new-password" minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button type="submit" className="primary" disabled={submitting}>{submitting ? 'Đang cập nhật...' : 'Cập nhật mật khẩu'}</button>
        </form>
      </section>
    </main>
  )
}