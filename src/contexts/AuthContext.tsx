import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react'
import { User } from '@supabase/supabase-js'
import { supabase, Profile } from '@/lib/supabase'

type AuthContextType = {
  user: User | null
  profile: Profile | null
  isAdmin: boolean
  loading: boolean
  profileError: boolean
  reloadProfile: () => Promise<void>
  signIn: (email: string, password: string) => Promise<{ error: any }>
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: any }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  // The profile is where the admin role lives, so a read that FAILED must not
  // look like a user who simply has no profile row. Both used to leave
  // `profile` null, which makes isAdmin false, which makes ProtectedRoute send
  // the owner back to the storefront on a network blip. This flag is what lets
  // that screen say "could not check your access" and offer a retry instead.
  const [profileError, setProfileError] = useState(false)
  // The read in flight (or the last one that succeeded) and who it is for.
  // loadUser() and the INITIAL_SESSION auth event both fire on mount, and
  // every hourly token refresh fires again: without this the same profile was
  // read two or more times per session. The PROMISE is kept, not just the id,
  // because the second caller has to wait for the first one's answer before it
  // clears `loading` -- clearing it early is what would let ProtectedRoute
  // decide on a profile that has not arrived yet.
  const profileLoadRef = useRef<{ userId: string; promise: Promise<void> } | null>(null)

  function loadProfile(userId: string): Promise<void> {
    const inFlight = profileLoadRef.current
    if (inFlight && inFlight.userId === userId) return inFlight.promise
    // Cached BEFORE the read starts. readProfile runs synchronously up to its
    // first await, and its catch clears this ref, so calling it first would
    // let the line below re-cache a finished no-op on top of that clear and
    // the next auth event for this user would await the no-op instead of
    // re-reading. The microtask hop is what keeps the two in order.
    const promise = Promise.resolve().then(() => readProfile(userId))
    profileLoadRef.current = { userId, promise }
    return promise
  }

  // Never throws and never rejects: the promise it returns is the one both
  // callers await, and a rejected one cached in profileLoadRef would leave
  // every later caller awaiting the same rejection with `loading` stuck true.
  async function readProfile(userId: string) {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle()

      // Could not READ. Never fall through to the insert below: the row may
      // well exist (and hold role 'admin'), and a blind insert would fail on
      // the primary key anyway. Leave the door open for a retry.
      if (error) { failProfile(); return }

      if (data) {
        setProfile(data)
        setProfileError(false)
        return
      }

      // Read succeeded and there is genuinely no row: a user who signed up
      // before this table, or whose signup insert never landed.
      const { data: userData } = await supabase.auth.getUser()
      if (!userData.user) { failProfile(); return }
      // No role: the column defaults to 'customer' and a BEFORE INSERT
      // trigger forces it anyway (20260809000000). The client never gets a
      // say in it.
      const newProfile = {
        id: userId,
        email: userData.user.email || '',
        full_name: userData.user.user_metadata?.full_name || '',
      }
      const { data: created, error: insertError } = await supabase
        .from('profiles')
        .insert(newProfile)
        .select()
        .single()
      // An insert that wrote nothing leaves this account with no profile at
      // all, which is a broken state and not "you are not an admin".
      if (insertError || !created) { failProfile(); return }
      setProfile(created)
      setProfileError(false)
    } catch {
      // A genuine throw (an auth client rejecting, malformed JSON) lands here
      // rather than escaping into the cached promise.
      failProfile()
    }
  }

  // One exit for every way this can fail. Clearing the ref is what lets the
  // next auth event, or the Try again button, start a fresh read.
  function failProfile() {
    profileLoadRef.current = null
    setProfile(null)
    setProfileError(true)
  }

  // Retry after a failed read, from the screen that noticed it.
  async function reloadProfile() {
    try {
      const { data: { user: current } } = await supabase.auth.getUser()
      // Still signed out, or the auth call itself failed: say so rather than
      // returning silently and leaving the retry button looking dead.
      if (!current) { failProfile(); return }
      profileLoadRef.current = null
      await loadProfile(current.id)
    } catch {
      failProfile()
    }
  }

  useEffect(() => {
    async function loadUser() {
      try {
        const { data: { user } } = await supabase.auth.getUser()
        setUser(user)
        if (user) {
          await loadProfile(user.id)
        }
      } catch {
        // The last route to a permanent spinner: a throw out of getUser used
        // to skip setLoading(false) entirely, leaving the owner watching a
        // spinner with no error and no way to retry.
        failProfile()
      } finally {
        setLoading(false)
      }
    }
    loadUser()

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (_event, session) => {
        setUser(session?.user || null)
        if (session?.user) {
          await loadProfile(session.user.id)
        } else {
          profileLoadRef.current = null
          setProfile(null)
          setProfileError(false)
        }
        setLoading(false)
      }
    )

    return () => subscription.unsubscribe()
    // Mount only: loadProfile dedupes against profileLoadRef, so re-running
    // this on every render would only tear the auth subscription down and
    // build it back up. Same exemption Shop.tsx takes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error }
  }

  async function signUp(email: string, password: string, fullName: string) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } }
    })
    if (!error && data.user) {
      // Create profile. Role is never sent from the browser: the server-side
      // default plus the prevent_self_role_change INSERT trigger own it.
      await supabase.from('profiles').insert({
        id: data.user.id,
        email,
        full_name: fullName,
      })
    }
    return { error }
  }

  async function signOut() {
    await supabase.auth.signOut()
    profileLoadRef.current = null
    setUser(null)
    setProfile(null)
    setProfileError(false)
  }

  return (
    <AuthContext.Provider value={{
      user,
      profile,
      isAdmin: profile?.role === 'admin',
      loading,
      profileError,
      reloadProfile,
      signIn,
      signUp,
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
