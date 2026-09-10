import { useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useT } from '@/contexts/LanguageContext'
import { useSeo } from '@/hooks/useSeo'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

export default function Login() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const redirectTo = (location.state as any)?.from || '/account'
  const t = useT()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  useSeo({
    title: 'Sign In · BOM Store',
    description: 'Sign in to your BOM Store account to track orders and manage your wishlist.',
  })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    const { error } = await signIn(email, password)
    setLoading(false)
    if (error) {
      toast.error(error.message || t.loginError)
    } else {
      toast.success(t.loginWelcome)
      navigate(redirectTo)
    }
  }

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <p className="text-zen text-muted-foreground mb-4">{t.loginEyebrow}</p>
          <h1 className="font-display text-4xl md:text-5xl">{t.loginTitle}</h1>
        </div>
        <form onSubmit={handleSubmit} className="space-y-6">
            {/* Email addresses and passwords are always read left-to-right,
                even on an Arabic page: forcing them RTL put the leading
                characters and the domain on the wrong end. rtl:text-right
                follows the PAGE direction, not the input's own, so the field
                still sits on the start edge of an Arabic form. */}
          <label className="block">
            <span className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{t.loginEmail}</span>
            {/* name + autoComplete: a returning customer signs in from the
                browser's saved credentials in one tap, and the password
                manager knows to offer the stored one rather than a new one. */}
            <input
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              dir="ltr"
              className="w-full bg-transparent border-b border-foreground/30 focus:border-foreground outline-none py-2 text-sm transition-colors rtl:text-right"
              placeholder="you@example.com"
            />
          </label>
          <label className="block">
            <span className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{t.loginPassword}</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              dir="ltr"
              className="w-full bg-transparent border-b border-foreground/30 focus:border-foreground outline-none py-2 text-sm transition-colors rtl:text-right"
              placeholder="••••••••"
            />
          </label>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary text-primary-foreground py-3.5 text-sm tracking-widest uppercase hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : t.loginCta}
          </button>
        </form>
        <p className="mt-10 text-center text-sm text-muted-foreground">
          {t.loginNew}{' '}
          <Link to="/signup" className="text-foreground underline-offset-2 hover:underline">
            {t.loginCreate}
          </Link>
        </p>
      </div>
    </div>
  )
}
