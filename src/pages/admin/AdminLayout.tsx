import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAuth } from '@/contexts/AuthContext'
import { useT } from '@/contexts/LanguageContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { useSeo } from '@/hooks/useSeo'
import { supabase, Order } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { Package, LayoutDashboard, ListOrdered, Tag, LogOut, Image, Users, History, Settings, Gift, PanelTop, Menu, X } from 'lucide-react'

// Shared chrome (header + nav tabs) for every /admin/* screen. Nested under
// a single <Route path="/admin"> in App.tsx so this renders once and each
// tab swaps only the <Outlet/> content -- previously this bar only existed
// inside AdminDashboard, so it vanished on /admin/products and /admin/orders.
export default function AdminLayout() {
  const { profile, signOut } = useAuth()
  const t = useT()
  const { formatPrice } = useCurrency()
  const location = useLocation()
  const [unreadOrders, setUnreadOrders] = useState(0)
  // Mobile sidebar drawer -- same open/close mechanics as Layout.tsx's
  // `mobileOpen` site nav drawer (fixed overlay + slide-in animation),
  // closed on every navigation so it doesn't stay open across route changes.
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  // Read inside the realtime callback below so an INSERT while already on
  // /admin/orders doesn't bump the badge (a ref avoids re-subscribing the
  // channel effect on every navigation).
  const pathRef = useRef(location.pathname)
  useEffect(() => { pathRef.current = location.pathname }, [location.pathname])
  // Same reason as pathRef: the realtime channel below subscribes once, so a
  // callback that closed over `t`/`formatPrice` would keep announcing orders
  // in whichever language the tab was opened in, forever. Re-subscribing on
  // every language change would tear the socket down and rebuild it instead.
  const toastRef = useRef({ t, formatPrice })
  useEffect(() => { toastRef.current = { t, formatPrice } }, [t, formatPrice])

  // Set once here rather than in every admin child page -- every /admin/*
  // route renders through this layout's <Outlet/>, so one noindex'd title
  // covers all of them (dashboard, products, orders, coupons, banners,
  // users, activity log) with no per-page repetition.
  useSeo({
    title: 'Admin · BOM Store',
    description: 'BOM Store admin console.',
    noindex: true,
  })

  // Live new-order feed for the whole admin section. INSERT (not the later
  // payment_status -> 'paid' UPDATE) is the signal here: it fires the moment
  // a customer starts checkout, which is more useful for an admin watching
  // the console live than waiting for payment confirmation.
  useEffect(() => {
    const channel = supabase
      // Unique topic per mount -- a static topic string collides with the
      // still-leaving channel from a StrictMode/Fast-Refresh remount, since
      // removeChannel() only unsubscribes after a server round trip.
      .channel(`admin-new-orders-${crypto.randomUUID()}`)
      .on<Order>(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'orders' },
        payload => {
          const o = payload.new
          const { t: tr, formatPrice: price } = toastRef.current
          setUnreadOrders(n => (pathRef.current === '/admin/orders' ? n : n + 1))
          toast.info(
            tr.adminNewOrderToast(
              o.kashier_order_id || o.id.slice(0, 8),
              o.customer_name || o.customer_email || tr.dash,
              price(Number(o.total_amount || 0))
            )
          )
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [])

  // Visiting the Orders tab clears its unread badge.
  useEffect(() => {
    if (location.pathname === '/admin/orders') setUnreadOrders(0)
  }, [location.pathname])

  // Close the mobile drawer on every navigation (mirrors Layout.tsx, which
  // closes its drawer via each link's own onClick -- here the nav items are
  // shared between the persistent sidebar and the drawer, so it's simpler
  // to just close on route change).
  useEffect(() => { setMobileNavOpen(false) }, [location.pathname])

  const navItems = [
    { to: '/admin', label: t.adminNavOverview, icon: LayoutDashboard, end: true },
    { to: '/admin/products', label: t.adminNavProducts, icon: Package },
    { to: '/admin/orders', label: t.adminNavOrders, icon: ListOrdered, badge: unreadOrders },
    { to: '/admin/coupons', label: t.adminNavCoupons, icon: Tag },
    { to: '/admin/bundles', label: t.adminNavBundles, icon: Gift },
    { to: '/admin/banners', label: t.adminNavBanners, icon: Image },
    { to: '/admin/homepage', label: t.adminNavHomepage, icon: PanelTop },
    { to: '/admin/users', label: t.adminNavUsers, icon: Users },
    { to: '/admin/activity', label: t.adminNavActivity, icon: History },
    { to: '/admin/settings', label: t.adminNavSettings, icon: Settings },
  ]

  // The section name for the current route, shown as the page heading so
  // every admin screen states where you are (previously they rendered
  // straight into a table with no title).
  const activeNav = navItems.find(item =>
    item.end ? location.pathname === item.to : location.pathname === item.to || location.pathname.startsWith(item.to + '/')
  )

  // Shared between the persistent desktop sidebar and the mobile drawer so
  // the active-state/badge treatment never drifts between the two.
  function renderNavItems(onNavigate?: () => void) {
    return navItems.map(item => (
      <NavLink
        key={item.to}
        to={item.to}
        end={item.end}
        onClick={onNavigate}
        className={({ isActive }) =>
          cn(
            'flex items-center gap-3 px-4 py-3 text-sm border-s-2 transition-colors',
            isActive
              ? 'border-foreground bg-foreground text-background'
              : 'border-transparent text-muted-foreground hover:bg-card hover:text-foreground'
          )
        }
      >
        {({ isActive }) => (
          <>
            <item.icon className="w-4 h-4 shrink-0" />
            <span className="flex-1">{item.label}</span>
            {!!item.badge && (
              <span
                className={cn(
                  'min-w-[1.1rem] h-[1.1rem] px-1 rounded-full text-[10px] flex items-center justify-center leading-none',
                  isActive ? 'bg-background text-foreground' : 'bg-foreground text-background'
                )}
              >
                {item.badge > 99 ? '99+' : item.badge}
              </span>
            )}
          </>
        )}
      </NavLink>
    ))
  }

  return (
    <div className="min-h-screen bg-muted/20 flex">
      {/* Persistent sidebar -- visible from lg upward */}
      <aside className="hidden lg:flex flex-col w-64 shrink-0 border-e border-border bg-background sticky top-0 h-screen overflow-y-auto">
        <div className="px-6 py-8">
          <p className="text-zen text-muted-foreground mb-1">{t.adminEyebrow}</p>
          <h1 className="font-display text-2xl">{t.adminTitle}</h1>
        </div>
        <nav className="flex flex-col gap-1 px-2">{renderNavItems()}</nav>
      </aside>

      {/* Mobile drawer -- same fixed-overlay + slide-in mechanics as
          Layout.tsx's site-wide mobile nav. */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 bg-background lg:hidden overflow-y-auto slide-in-right">
          <div className="flex items-center justify-between h-20 px-6 border-b border-border/60">
            <h1 className="font-display text-xl">{t.adminTitle}</h1>
            <button
              onClick={() => setMobileNavOpen(false)}
              className="p-2 cursor-pointer"
              aria-label={t.navCloseMenu}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <nav className="flex flex-col gap-1 p-2">{renderNavItems(() => setMobileNavOpen(false))}</nav>
        </div>
      )}

      <div className="flex-1 min-w-0 px-6 lg:px-10 py-10">
        <div className="max-w-[1400px] mx-auto">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-8">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setMobileNavOpen(true)}
                className="lg:hidden p-2 -ms-2 border border-border hover:bg-card transition-colors cursor-pointer"
                aria-label={t.navOpenMenu}
              >
                <Menu className="w-5 h-5" />
              </button>
              <div>
                <p className="text-zen text-muted-foreground mb-2">{t.adminEyebrow}</p>
                <h1 className="font-display text-3xl">{activeNav?.label ?? t.adminTitle}</h1>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden sm:inline text-sm text-muted-foreground">{profile?.email}</span>
              <button
                onClick={signOut}
                className="p-2 border border-border hover:bg-card transition-colors cursor-pointer"
                aria-label={t.adminSignOut}
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>

          <Outlet />
        </div>
      </div>
    </div>
  )
}
