import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useState, useRef, useEffect } from 'react'
import { useCart } from '@/contexts/CartContext'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage, useT } from '@/contexts/LanguageContext'
import { useCatalogPrice } from '@/hooks/useCatalogPrice'
import { useCategories } from '@/contexts/CategoriesContext'
import { useWishlist } from '@/contexts/WishlistContext'
import { ShoppingBag, User, Menu, X, LogOut, LayoutDashboard, Globe, ChevronDown, Search, Instagram, Facebook, Share2, Heart, Loader2, Pause, Play } from 'lucide-react'
import { cn } from '@/lib/utils'
import { supabase, ProductCatalogEntry } from '@/lib/supabase'
import { toast } from 'sonner'
import Logo from './Logo'
import WhatsAppButton from './WhatsAppButton'

type NewsletterContent = { title_en: string; title_ar: string; subtitle_en: string; subtitle_ar: string; enabled?: boolean }
type AnnouncementContent = { enabled?: boolean; lines?: { en: string; ar: string }[] }
type FooterLink = { label_en: string; label_ar: string; url: string }
type FooterLinksContent = { items?: FooterLink[] }
type SiteVisibilityContent = { brands_page_enabled?: boolean }
type ContactContent = {
  email: string | null
  phone: string | null
  address_en: string | null
  address_ar: string | null
  map_url: string | null
  social_instagram: string | null
  social_facebook: string | null
  social_tiktok: string | null
  social_twitter: string | null
}

type SearchHit = Pick<ProductCatalogEntry, 'id' | 'slug' | 'name' | 'min_price' | 'max_price' | 'image_url'>

const SEARCH_HISTORY_KEY = 'bom-store-search-history'
const MAX_SEARCH_HISTORY = 8

function loadSearchHistory(): string[] {
  try {
    const stored = localStorage.getItem(SEARCH_HISTORY_KEY)
    return stored ? JSON.parse(stored) : []
  } catch {
    return []
  }
}

export default function Layout() {
  const { totalItems } = useCart()
  const { user, profile, isAdmin, signOut } = useAuth()
  const t = useT()
  const { lang, setLang } = useLanguage()
  const { categories } = useCategories()
  const { wishlistedIds } = useWishlist()
  const catalogPrice = useCatalogPrice()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const [langOpen, setLangOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<SearchHit[]>([])
  const [activeSuggestion, setActiveSuggestion] = useState(-1)
  const [marqueePaused, setMarqueePaused] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [history, setHistory] = useState<string[]>(() => loadSearchHistory())
  const [newsletterContent, setNewsletterContent] = useState<NewsletterContent | null>(null)
  const [contactContent, setContactContent] = useState<ContactContent | null>(null)
  const [announcement, setAnnouncement] = useState<AnnouncementContent | null>(null)
  const [footerLinks, setFooterLinks] = useState<FooterLinksContent | null>(null)
  const [siteVisibility, setSiteVisibility] = useState<SiteVisibilityContent | null>(null)
  const [subscribeEmail, setSubscribeEmail] = useState('')
  const [subscribing, setSubscribing] = useState(false)
  const navigate = useNavigate()
  const langRef = useRef<HTMLDivElement>(null)
  const userRef = useRef<HTMLDivElement>(null)
  const searchBtnRef = useRef<HTMLButtonElement>(null)
  const searchPanelRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchIdRef = useRef(0)
  const mobileMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (langRef.current && !langRef.current.contains(e.target as Node)) {
        setLangOpen(false)
      }
      if (userRef.current && !userRef.current.contains(e.target as Node)) {
        setUserOpen(false)
      }
      if (
        searchPanelRef.current && searchBtnRef.current &&
        !searchPanelRef.current.contains(e.target as Node) &&
        !searchBtnRef.current.contains(e.target as Node)
      ) {
        setSearchOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Close on Escape -- this overlay isn't a native <dialog>/Radix Dialog, so it
  // doesn't get that behavior for free.
  useEffect(() => {
    if (!searchOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSearchOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [searchOpen])

  // Same for the two header dropdowns, which otherwise only closed on an
  // outside mousedown -- a keyboard user had no way to dismiss them.
  useEffect(() => {
    if (!langOpen && !userOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      setLangOpen(false)
      setUserOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [langOpen, userOpen])

  // The mobile menu is a full-screen overlay, not a native <dialog>, so it
  // gets none of the modal behaviour for free: Escape to close, a locked
  // background, Tab kept inside the panel, and focus handed back to the
  // trigger on close. Declared above the search-focus effect below so that
  // opening search from inside the menu ends with the search input focused,
  // not the hamburger.
  useEffect(() => {
    if (!mobileOpen) return
    const panel = mobileMenuRef.current
    const trigger = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function focusable(): HTMLElement[] {
      return Array.from(panel?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [])
    }
    focusable()[0]?.focus()

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setMobileOpen(false); return }
      if (e.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      const inside = panel?.contains(document.activeElement)
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
      trigger?.focus()
    }
  }, [mobileOpen])

  // Footer newsletter heading/subtitle, contact/social info, announcement
  // ticker lines, and footer "Craft" links -- all admin-editable via
  // site_content, fetched once in a single round trip.
  useEffect(() => {
    supabase
      .from('site_content')
      .select('key, value')
      .in('key', ['newsletter', 'contact', 'announcement', 'footer_links', 'site_visibility'])
      .then(
        ({ data }) => {
          for (const row of data || []) {
            if (row.key === 'newsletter') setNewsletterContent(row.value as NewsletterContent)
            if (row.key === 'contact') setContactContent(row.value as ContactContent)
            if (row.key === 'announcement') setAnnouncement(row.value as AnnouncementContent)
            if (row.key === 'footer_links') setFooterLinks(row.value as FooterLinksContent)
            if (row.key === 'site_visibility') setSiteVisibility(row.value as SiteVisibilityContent)
          }
        },
        () => { /* keep footer/ticker fallbacks */ }
      )
  }, [])

  async function handleNewsletterSubmit(e: React.FormEvent) {
    e.preventDefault()
    const email = subscribeEmail.trim()
    if (!email || subscribing) return
    setSubscribing(true)
    supabase
      .from('newsletter_subscribers')
      .insert({ email })
      .then(
        ({ error }) => {
          setSubscribing(false)
          if (error) {
            if (error.code === '23505') {
              toast.error(t.homeNewsletterAlready)
            } else {
              toast.error(t.homeNewsletterError)
            }
            return
          }
          toast.success(t.homeNewsletterToast)
          setSubscribeEmail('')
        },
        () => {
          setSubscribing(false)
          toast.error(t.homeNewsletterError)
        }
      )
  }

  // Move focus into the panel on open, and back to the toggle button on
  // close -- however it closes (Escape, click-outside, the X, or committing
  // a search), since all of those just flip `searchOpen` to false and the
  // effect cleanup below fires right before that happens. Previously focus
  // was dropped to <body> on close, a real loss for keyboard/AT users.
  useEffect(() => {
    if (!searchOpen) return
    searchInputRef.current?.focus()
    const trigger = searchBtnRef.current
    return () => { trigger?.focus() }
  }, [searchOpen])

  // Debounced (250ms) live suggestions as the user types. searchIdRef guards
  // a stale response: if an earlier keystroke's request is still in flight
  // when a later one starts, only the response matching the latest request
  // is allowed to touch state -- otherwise a slow failure landing after a
  // fast success would paint "Could not search" over results already on
  // screen (or the reverse). Same shape of guard QuickViewModal uses.
  useEffect(() => {
    const q = query.trim()
    setActiveSuggestion(-1)
    if (!q) {
      setSuggestions([])
      setSearching(false)
      setSearchError(false)
      return
    }
    setSearching(true)
    setSearchError(false)
    const timer = setTimeout(async () => {
      const id = ++searchIdRef.current
      try {
        const { data, error } = await supabase
          .from('product_catalog')
          .select('id, slug, name, min_price, max_price, image_url')
          .textSearch('search_vector', q, { type: 'websearch' })
          .limit(5)
        if (error) throw error
        if (id !== searchIdRef.current) return
        setSuggestions(data || [])
        setSearching(false)
      } catch {
        if (id !== searchIdRef.current) return
        setSuggestions([])
        setSearchError(true)
        setSearching(false)
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  function closeSearch() {
    setSearchOpen(false)
    setQuery('')
  }

  function commitSearch(raw: string) {
    const q = raw.trim()
    if (!q) return
    setHistory(current => {
      const next = [q, ...current.filter(h => h.toLowerCase() !== q.toLowerCase())].slice(0, MAX_SEARCH_HISTORY)
      try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
      return next
    })
    navigate(`/shop?search=${encodeURIComponent(q)}`)
    closeSearch()
  }

  function goToProduct(slug: string) {
    navigate(`/product/${slug}`)
    closeSearch()
  }

  // Arrow keys walk the suggestion list (announced through
  // aria-activedescendant); Enter takes the highlighted product, or runs the
  // typed query when nothing is highlighted.
  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (suggestions.length === 0) return
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActiveSuggestion(i => {
        const next = i + step
        if (next < 0) return suggestions.length - 1
        if (next >= suggestions.length) return 0
        return next
      })
      return
    }
    if (e.key === 'Enter') {
      const hit = suggestions[activeSuggestion]
      if (hit) goToProduct(hit.slug)
      else commitSearch(query)
    }
  }

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 20)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Kept deliberately short (Shop / Brands / Sale) rather than listing every
  // category here too -- Shop already has its own category filter chips.
  // `sale` renders in the terracotta accent, matching the reference design.
  const brandsPageEnabled = siteVisibility?.brands_page_enabled !== false
  const nav = [
    { to: '/shop', label: t.navShop },
    ...(brandsPageEnabled ? [{ to: '/brands', label: t.navBrands }] : []),
    { to: '/shop?sale=1', label: t.navSale, sale: true },
  ]

  async function handleSignOut() {
    await signOut()
    setUserOpen(false)
    navigate('/')
  }

  // Admin-managed ticker lines when configured; falls back to the hardcoded
  // marqueeLine1..6 translations if the row is missing, the fetch failed, or
  // no lines were ever added.
  const announcementEnabled = announcement?.enabled !== false
  const marqueeLines = announcement?.lines?.length
    ? announcement.lines.map(l => (lang === 'ar' ? l.ar : l.en))
    : [t.marqueeLine1, t.marqueeLine2, t.marqueeLine3, t.marqueeLine4, t.marqueeLine5, t.marqueeLine6]

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* Announcement bar */}
      {announcementEnabled && (
      <div className="relative bg-foreground text-background text-[11px] tracking-[0.25em] uppercase py-2.5 px-4 text-center font-light overflow-hidden">
        {/* No gap on the track itself: the keyframe travels exactly 50% of the
            track's width, which is one copy only when the two copies sit flush. */}
        <div className="marquee-track" style={{ animationPlayState: marqueePaused ? 'paused' : 'running' }}>
          {[0, 1].map((dup) => (
            <div key={dup} className="flex gap-12 px-6 shrink-0">
              {marqueeLines.map((line, i) => (
                <span key={i}>★ {line}</span>
              ))}
            </div>
          ))}
        </div>
        {/* WCAG 2.2.2: any motion that starts on its own and runs longer than
            five seconds needs a way to stop it. */}
        <button
          onClick={() => setMarqueePaused(p => !p)}
          aria-label={marqueePaused ? t.navPlayAnnouncements : t.navPauseAnnouncements}
          className="absolute end-0 top-0 bottom-0 px-3 flex items-center bg-foreground hover:opacity-70 transition-opacity cursor-pointer"
        >
          {marqueePaused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
        </button>
      </div>
      )}

      {/* Header */}
      <header
        className={cn(
          'sticky top-0 z-30 transition-all duration-500 border-b',
          scrolled
            ? 'bg-background/95 backdrop-blur-md border-border/40 shadow-sm'
            : 'bg-background border-transparent'
        )}
      >
        <div className="relative max-w-[1400px] mx-auto px-6 lg:px-10 h-20 flex items-center justify-between gap-4">
          {/* Mobile menu */}
          <button
            onClick={() => setMobileOpen(true)}
            className="lg:hidden -ms-2 w-11 h-11 flex items-center justify-center cursor-pointer hover:text-foreground/70 transition-colors"
            aria-label={t.navOpenMenu}
            aria-expanded={mobileOpen}
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* Logo - start */}
          <Link
            to="/"
            className="flex-shrink-0 transition-transform duration-500 hover:scale-105"
            aria-label={t.navHome}
          >
            <Logo size={56} showText={false} capToViewport />
          </Link>

          {/* Centered nav (desktop) -- absolutely positioned at the bar's exact
              midpoint so it stays centered regardless of how wide the logo vs.
              icon group are, instead of splitting remaining space in half.
              In RTL `start-1/2` resolves to `right: 50%`, so the bar grows
              leftwards from the midpoint and has to be pulled back by +50% of
              its own width, not -50%. */}
          <nav className="hidden lg:flex items-center gap-10 absolute start-1/2 -translate-x-1/2 rtl:translate-x-1/2">
            {nav.map(n => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) => cn(
                  "text-[12px] tracking-[0.18em] uppercase font-medium transition-colors relative group",
                  n.sale ? "text-terracotta hover:text-terracotta/80" : "hover:text-foreground/60",
                  isActive && !n.sale && "text-foreground"
                )}
              >
                {n.label}
                <span className={cn(
                  "absolute -bottom-1 start-0 end-0 h-px scale-x-0 group-hover:scale-x-100 transition-transform duration-300 origin-left rtl:origin-right",
                  n.sale ? "bg-terracotta" : "bg-foreground"
                )} />
              </NavLink>
            ))}
          </nav>

          {/* Right icons */}
          <div className="flex items-center gap-0 md:gap-1 flex-1 justify-end">
            {/* Search */}
            <button
              ref={searchBtnRef}
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
              className="w-11 h-11 flex items-center justify-center hover:text-foreground/60 transition-colors cursor-pointer"
              aria-label={searchOpen ? t.searchClose : t.searchLabel}
              aria-expanded={searchOpen}
            >
              {searchOpen ? <X className="w-5 h-5" /> : <Search className="w-5 h-5" />}
            </button>

            {/* Language toggle */}
            <div className="relative" ref={langRef}>
              <button
                onClick={() => setLangOpen(!langOpen)}
                className="flex items-center gap-1.5 px-2 h-11 cursor-pointer hover:text-foreground/60 transition-colors text-[11px] tracking-[0.18em] uppercase font-medium"
                aria-label={t.navSwitchLanguage}
                aria-haspopup="menu"
                aria-expanded={langOpen}
              >
                <Globe className="w-4 h-4" />
                <span className="hidden sm:inline">{lang === 'ar' ? 'AR' : 'EN'}</span>
                <ChevronDown className={cn("w-3 h-3 transition-transform", langOpen && "rotate-180")} />
              </button>
              {langOpen && (
                <div className="absolute end-0 top-full mt-3 w-40 bg-card border border-border shadow-xl z-50 fade-in">
                  <button
                    onClick={() => { setLang('ar'); setLangOpen(false) }}
                    className={cn(
                      "block w-full text-start px-4 py-3 text-sm hover:bg-muted transition-colors",
                      lang === 'ar' && "bg-muted font-medium"
                    )}
                  >
                    العربية
                  </button>
                  <button
                    onClick={() => { setLang('en'); setLangOpen(false) }}
                    className={cn(
                      "block w-full text-start px-4 py-3 text-sm hover:bg-muted transition-colors border-t border-border/60",
                      lang === 'en' && "bg-muted font-medium"
                    )}
                  >
                    English
                  </button>
                </div>
              )}
            </div>

            <div className="relative" ref={userRef}>
              <button
                onClick={() => setUserOpen(!userOpen)}
                className="w-11 h-11 flex items-center justify-center cursor-pointer hover:text-foreground/60 transition-colors"
                aria-label={t.account}
                aria-haspopup="menu"
                aria-expanded={userOpen}
              >
                <User className="w-5 h-5" />
              </button>
              {userOpen && (
                <div className="absolute end-0 top-full mt-3 w-60 bg-card border border-border shadow-xl z-50 fade-in">
                  {user ? (
                    <div className="py-2">
                      <div className="px-4 py-3 border-b border-border/60">
                        <p className="text-sm font-medium">{profile?.full_name || t.guest}</p>
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{user.email}</p>
                      </div>
                      <Link
                        to="/account"
                        onClick={() => setUserOpen(false)}
                        className="block px-4 py-2.5 text-sm hover:bg-muted transition-colors"
                      >
                        {t.myAccount}
                      </Link>
                      {isAdmin && (
                        <Link
                          to="/admin"
                          onClick={() => setUserOpen(false)}
                          className="flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-muted transition-colors"
                        >
                          <LayoutDashboard className="w-4 h-4" />
                          {t.adminPanel}
                        </Link>
                      )}
                      <button
                        onClick={handleSignOut}
                        className="flex items-center gap-2 w-full text-start px-4 py-2.5 text-sm hover:bg-muted transition-colors cursor-pointer"
                      >
                        <LogOut className="w-4 h-4" />
                        {t.signOut}
                      </button>
                    </div>
                  ) : (
                    <div className="py-2">
                      <Link
                        to="/login"
                        onClick={() => setUserOpen(false)}
                        className="block px-4 py-2.5 text-sm hover:bg-muted transition-colors"
                      >
                        {t.signIn}
                      </Link>
                      <Link
                        to="/signup"
                        onClick={() => setUserOpen(false)}
                        className="block px-4 py-2.5 text-sm hover:bg-muted transition-colors"
                      >
                        {t.createAccount}
                      </Link>
                    </div>
                  )}
                </div>
              )}
            </div>
            {/* The count badge hangs off an inner wrapper, not the link itself,
                so widening the link to a 44px tap target doesn't drag the badge
                away from the icon. */}
            <Link
              to={user ? '/account#wishlist' : '/login'}
              className="hidden md:flex w-11 h-11 items-center justify-center hover:text-foreground/60 transition-colors"
              aria-label={t.wishlistNavLabel}
            >
              <span className="relative">
                <Heart className="w-5 h-5" />
                {wishlistedIds.size > 0 && (
                  <span className="absolute -top-0.5 -end-0.5 bg-foreground text-background text-[10px] w-4 h-4 rounded-full flex items-center justify-center font-medium">
                    {wishlistedIds.size}
                  </span>
                )}
              </span>
            </Link>
            <Link
              to="/cart"
              className="w-11 h-11 flex items-center justify-center hover:text-foreground/60 transition-colors"
              aria-label={t.cart}
            >
              <span className="relative">
                <ShoppingBag className="w-5 h-5" />
                {totalItems > 0 && (
                  <span className="absolute -top-0.5 -end-0.5 bg-foreground text-background text-[10px] w-4 h-4 rounded-full flex items-center justify-center font-medium">
                    {totalItems}
                  </span>
                )}
              </span>
            </Link>
          </div>
        </div>

        {/* Search overlay -- slide-down panel under the header, same fade-in
            treatment as the language/account dropdowns above. */}
        {searchOpen && (
          <div
            ref={searchPanelRef}
            className="absolute inset-x-0 top-full bg-background border-b border-border shadow-xl z-40 fade-in"
          >
            <div className="max-w-[1400px] mx-auto px-6 lg:px-10 py-6">
              <div className="relative">
                <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder={t.searchPlaceholder}
                  dir={lang === 'ar' ? 'rtl' : 'ltr'}
                  aria-label={t.searchLabel}
                  role="combobox"
                  aria-autocomplete="list"
                  aria-controls="search-suggestions"
                  aria-expanded={suggestions.length > 0}
                  aria-activedescendant={activeSuggestion >= 0 ? `search-suggestion-${activeSuggestion}` : undefined}
                  className="w-full bg-transparent border-b border-foreground/30 focus:border-foreground outline-none py-3 ps-9 text-lg font-display placeholder:text-muted-foreground placeholder:font-sans"
                />
              </div>

              <div className="mt-6 min-h-[3rem]">
                {query.trim() ? (
                  <>
                    {searching ? (
                      <div className="py-4 flex justify-center">
                        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                      </div>
                    ) : searchError ? (
                      <p className="text-sm text-terracotta py-2">{t.searchError}</p>
                    ) : suggestions.length > 0 ? (
                      <div className="space-y-1" id="search-suggestions" role="listbox" aria-label={t.searchLabel}>
                        {suggestions.map((p, i) => (
                          <button
                            key={p.id}
                            id={`search-suggestion-${i}`}
                            role="option"
                            aria-selected={activeSuggestion === i}
                            onClick={() => goToProduct(p.slug)}
                            className={cn(
                              "w-full flex items-center gap-4 p-2 hover:bg-muted transition-colors text-start cursor-pointer",
                              activeSuggestion === i && "bg-muted"
                            )}
                          >
                            <div className="w-12 h-12 bg-muted overflow-hidden shrink-0">
                              <img src={p.image_url || ''} alt={p.name} className="w-full h-full object-cover" />
                            </div>
                            <span className="flex-1 text-sm truncate">{p.name}</span>
                            <span className="text-sm text-muted-foreground shrink-0">{catalogPrice(p)}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground py-2">{t.searchNoResults}</p>
                    )}
                    <button
                      onClick={() => commitSearch(query)}
                      className="mt-4 text-xs tracking-widest uppercase border-b border-foreground pb-0.5 cursor-pointer"
                    >
                      {t.searchSeeAll(query.trim())}
                    </button>
                  </>
                ) : history.length > 0 && (
                  <div>
                    <p className="text-xs tracking-widest uppercase text-muted-foreground mb-3">{t.searchRecent}</p>
                    <div className="flex flex-wrap gap-2">
                      {history.map(h => (
                        <button
                          key={h}
                          onClick={() => commitSearch(h)}
                          className="px-3.5 py-1.5 text-sm border border-border hover:border-foreground/50 transition-colors cursor-pointer"
                        >
                          {h}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Mobile menu */}
      {mobileOpen && (
        <div
          ref={mobileMenuRef}
          role="dialog"
          aria-modal="true"
          aria-label={t.navMenu}
          className="fixed inset-0 z-50 bg-background lg:hidden overflow-y-auto slide-in-right"
        >
          <div className="flex items-center justify-between h-20 px-6 border-b border-border/60">
            <Link to="/" onClick={() => setMobileOpen(false)} aria-label={t.navHome}>
              <Logo size={48} showText={false} />
            </Link>
            <button
              onClick={() => setMobileOpen(false)}
              className="-me-2 w-11 h-11 flex items-center justify-center cursor-pointer"
              aria-label={t.navCloseMenu}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <nav className="flex flex-col p-6">
            {nav.map(n => (
              <Link
                key={n.to}
                to={n.to}
                onClick={() => setMobileOpen(false)}
                className="py-4 text-2xl font-display border-b border-border/40 hover:text-foreground/60 transition-colors"
              >
                {n.label}
              </Link>
            ))}
            <Link
              to="/cart"
              onClick={() => setMobileOpen(false)}
              className="py-4 text-2xl font-display border-b border-border/40 flex items-center justify-between"
            >
              <span>{t.cart}</span>
              {totalItems > 0 && <span className="text-base text-muted-foreground">({totalItems})</span>}
            </Link>
            <Link
              to={user ? '/account#wishlist' : '/login'}
              onClick={() => setMobileOpen(false)}
              className="py-4 text-2xl font-display border-b border-border/40 flex items-center justify-between"
            >
              <span>{t.wishlistNavLabel}</span>
              {wishlistedIds.size > 0 && <span className="text-base text-muted-foreground">({wishlistedIds.size})</span>}
            </Link>
            {user ? (
              <Link
                to="/account"
                onClick={() => setMobileOpen(false)}
                className="py-4 text-2xl font-display border-b border-border/40"
              >
                {t.myAccount}
              </Link>
            ) : (
              <Link
                to="/login"
                onClick={() => setMobileOpen(false)}
                className="py-4 text-2xl font-display border-b border-border/40"
              >
                {t.signIn}
              </Link>
            )}
            <div className="mt-6 flex gap-2">
              <button
                onClick={() => setLang('ar')}
                className={cn(
                  "flex-1 py-3 text-sm border transition-colors cursor-pointer uppercase tracking-widest",
                  lang === 'ar' ? "bg-foreground text-background" : "border-border"
                )}
              >
                AR
              </button>
              <button
                onClick={() => setLang('en')}
                className={cn(
                  "flex-1 py-3 text-sm border transition-colors cursor-pointer uppercase tracking-widest",
                  lang === 'en' ? "bg-foreground text-background" : "border-border"
                )}
              >
                EN
              </button>
            </div>
          </nav>
        </div>
      )}

      <main className="flex-1">
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="bg-foreground text-background mt-0">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-10 py-20">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-12">
            <div className="md:col-span-5">
              <div className="mb-6">
                <Logo size={72} showText={false} />
              </div>
              <p className="font-light text-base leading-relaxed max-w-sm text-background/70">
                {t.brandTagline}
              </p>
              <p className="text-sm text-background/50 mt-8 italic font-display">
                {t.footerQuote}
              </p>
            </div>
            <div className="md:col-span-2">
              <h4 className="text-[11px] tracking-[0.25em] uppercase font-medium mb-6 text-background/90">{t.footerShop}</h4>
              <ul className="space-y-3 text-sm font-light text-background/70">
                {categories.map(c => (
                  <li key={c.value}>
                    <Link to={`/shop?category=${c.value}`} className="hover:text-background transition-colors">
                      {lang === 'ar' ? c.label_ar : c.label_en}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div className="md:col-span-2">
              <h4 className="text-[11px] tracking-[0.25em] uppercase font-medium mb-6 text-background/90">{t.footerLinksTitle}</h4>
              <ul className="space-y-3 text-sm font-light text-background/70">
                {footerLinks?.items?.map((link, i) => (
                  <li key={i}>
                    <a href={link.url} className="hover:text-background transition-colors">
                      {(lang === 'ar' ? link.label_ar : link.label_en) || link.url}
                    </a>
                  </li>
                ))}
              </ul>
              <FooterContact contact={contactContent} lang={lang} label={t.footerContact} />
            </div>
            {newsletterContent?.enabled !== false && (
            <div className="md:col-span-3">
              <h4 className="text-[11px] tracking-[0.25em] uppercase font-medium mb-6 text-background/90">
                {(lang === 'ar' ? newsletterContent?.title_ar : newsletterContent?.title_en) || t.homeNewsletterTitle}
              </h4>
              <p className="text-sm font-light text-background/70 mb-4 leading-relaxed">
                {(lang === 'ar' ? newsletterContent?.subtitle_ar : newsletterContent?.subtitle_en) || t.homeNewsletterDesc}
              </p>
              <form onSubmit={handleNewsletterSubmit} className="flex gap-2">
                <input
                  type="email"
                  required
                  value={subscribeEmail}
                  onChange={(e) => setSubscribeEmail(e.target.value)}
                  placeholder={t.homeNewsletterPlaceholder}
                  aria-label={t.homeNewsletterPlaceholder}
                  // Email addresses read left-to-right in either language;
                  // rtl:text-right keeps the field on the Arabic start edge.
                  dir="ltr"
                  className="flex-1 bg-transparent border-b border-background/30 focus:border-background outline-none py-2 text-sm placeholder:text-background/40 text-background rtl:text-right"
                />
                <button
                  type="submit"
                  disabled={subscribing}
                  className="text-sm tracking-wider border-b border-background pb-1 hover:opacity-70 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {t.homeNewsletterCta}
                </button>
              </form>
            </div>
            )}
          </div>
          <div className="mt-16 pt-8 border-t border-background/10 flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-xs text-background/50 font-light">
              {t.footerCopyright}
            </p>
            <div className="flex items-center gap-6 text-xs text-background/50 font-light">
              <span>{t.footerSecure}</span>
              <span>·</span>
              <span>{t.footerReturns}</span>
              <span>·</span>
              <Link to="/policies" className="hover:text-background transition-colors">{t.navPolicies}</Link>
            </div>
          </div>
        </div>
      </footer>

      {/* Floating WhatsApp */}
      <WhatsAppButton />
    </div>
  )
}

// Renders only the contact/social fields an admin has actually filled in --
// with every field null (today's seeded state) this returns null, so no
// empty heading or broken links show up in the footer.
function FooterContact({
  contact,
  lang,
  label,
}: {
  contact: ContactContent | null
  lang: string
  label: string
}) {
  const t = useT()
  if (!contact) return null
  const address = lang === 'ar' ? contact.address_ar : contact.address_en
  const socials = [
    contact.social_instagram && { url: contact.social_instagram, Icon: Instagram, name: 'Instagram' },
    contact.social_facebook && { url: contact.social_facebook, Icon: Facebook, name: 'Facebook' },
    contact.social_tiktok && { url: contact.social_tiktok, Icon: Share2, name: 'TikTok' },
    contact.social_twitter && { url: contact.social_twitter, Icon: Share2, name: 'X' },
  ].filter(Boolean) as { url: string; Icon: typeof Instagram; name: string }[]

  const hasAnything = contact.email || contact.phone || address || contact.map_url || socials.length > 0
  if (!hasAnything) return null

  return (
    <div className="mt-8 space-y-3 text-sm font-light text-background/70">
      <h5 className="text-[11px] tracking-[0.25em] uppercase font-medium text-background/90">{label}</h5>
      {contact.email && (
        <a href={`mailto:${contact.email}`} className="block hover:text-background transition-colors">{contact.email}</a>
      )}
      {contact.phone && (
        <a href={`tel:${contact.phone}`} className="block hover:text-background transition-colors">{contact.phone}</a>
      )}
      {address && <p>{address}</p>}
      {contact.map_url && (
        <a href={contact.map_url} target="_blank" rel="noopener noreferrer" className="block underline hover:text-background transition-colors">
          {t.footerViewOnMap}
        </a>
      )}
      {socials.length > 0 && (
        <div className="flex items-center gap-3 pt-1">
          {socials.map(({ url, Icon, name }) => (
            <a key={name} href={url} target="_blank" rel="noopener noreferrer" aria-label={name} className="hover:text-background transition-colors">
              <Icon className="w-4 h-4" />
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
