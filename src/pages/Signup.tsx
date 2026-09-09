import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useT, useLanguage } from '@/contexts/LanguageContext'
import { useSeo } from '@/hooks/useSeo'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

export default function Signup() {
  const { signUp } = useAuth()
  const navigate = useNavigate()
  const t = useT()
  const { lang } = useLanguage()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  useSeo({
    title: 'Create Account · BOM Store',
    description: 'Create a BOM Store account to shop authentic luxury sneakers, delivered across Egypt.',
  })

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (password.length < 6) {
      toast.error(t.signupErrorShort)
      return
    }
    setLoading(true)
    const { error, profileFailed } = await signUp(email, password, fullName)
    setLoading(false)
    if (error) {
      toast.error(error.message || t.signupError)
      return
    }
    // The auth account exists at this point even when its profile row does not,
    // so "signup failed" would be a lie that sends them back to a form which
    // now rejects their email as taken. Say what is true and what to do next,
    // and still let them in: readProfile retries the insert on every load.
    if (profileFailed) toast.warning(t.signupProfileFailed, { duration: 12000 })
    else toast.success(t.signupSuccess)
    navigate('/account')
  }

  return (
    <div className="min-h-[80vh] flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-md">
        <div className="text-center mb-10">
          <p className="text-zen text-muted-foreground mb-4">{t.signupEyebrow}</p>
          <h1 className="font-display text-4xl md:text-5xl">{t.signupTitle}</h1>
        </div>
        <form onSubmit={handleSubmit} className="space-y-6">
          <label className="block">
            <span className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{t.signupName}</span>
            <input
              type="text"
              required
              value={fullName}
              onChange={e => setFullName(e.target.value)}
              dir={lang === 'ar' ? 'rtl' : 'ltr'}
              className="w-full bg-transparent border-b border-foreground/30 focus:border-foreground outline-none py-2 text-sm transition-colors"
              placeholder={lang === 'ar' ? 'اسمك' : 'Your name'}
            />
          </label>
            {/* Email addresses and passwords are always read left-to-right,
                even on an Arabic page: forcing them RTL put the leading
                characters and the domain on the wrong end. rtl:text-right
                follows the PAGE direction, not the input's own, so the field
                still sits on the start edge of an Arabic form. */}
          <label className="block">
            <span className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{t.signupEmail}</span>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              dir="ltr"
              className="w-full bg-transparent border-b border-foreground/30 focus:border-foreground outline-none py-2 text-sm transition-colors rtl:text-right"
              placeholder="you@example.com"
            />
          </label>
          <label className="block">
            <span className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{t.signupPassword}</span>
            <input
              type="password"
              required
              minLength={6}
              value={password}
              onChange={e => setPassword(e.target.value)}
              dir="ltr"
              className="w-full bg-transparent border-b border-foreground/30 focus:border-foreground outline-none py-2 text-sm transition-colors rtl:text-right"
              placeholder={t.signupPasswordHint}
            />
          </label>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-primary text-primary-foreground py-3.5 text-sm tracking-widest uppercase hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : t.signupCta}
          </button>
        </form>
        <p className="mt-10 text-center text-sm text-muted-foreground">
          {t.signupHave}{' '}
          <Link to="/login" className="text-foreground underline-offset-2 hover:underline">
            {t.signupSignIn}
          </Link>
        </p>
      </div>
    </div>
  )
}
