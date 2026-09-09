import { ReactNode, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useT } from '@/contexts/LanguageContext'

export default function ProtectedRoute({
  children,
  requireAdmin = false,
}: {
  children: ReactNode
  requireAdmin?: boolean
}) {
  const { user, isAdmin, loading, profileError, reloadProfile } = useAuth()
  const [retrying, setRetrying] = useState(false)
  const t = useT()

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="w-8 h-8 border border-foreground/20 border-t-foreground rounded-full animate-spin" />
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  // "Could not read your profile" is not "you are not an admin". Redirecting
  // on the first is how a network blip threw the owner back to the shop with
  // no explanation, so say what happened and let him retry. Only the admin
  // gate depends on the profile: /account renders fine without one.
  if (requireAdmin && profileError) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-6">
        <p className="text-terracotta">{t.authProfileLoadError}</p>
        {/* Disabled while the retry is in flight: during an outage the read
            can take seconds, and a button that does nothing visible reads as
            broken. Same reason BrandsContext puts `loading` back to true. */}
        <button
          onClick={async () => { setRetrying(true); await reloadProfile(); setRetrying(false) }}
          disabled={retrying}
          className="mt-4 text-sm border-b border-foreground pb-0.5 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {t.failedTryAgain}
        </button>
      </div>
    )
  }

  if (requireAdmin && !isAdmin) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}
