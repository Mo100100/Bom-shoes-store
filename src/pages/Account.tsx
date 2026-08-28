import { useEffect, useState } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { useT, useLanguage } from '@/contexts/LanguageContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { useCatalogPrice } from '@/hooks/useCatalogPrice'
import { useWishlist } from '@/contexts/WishlistContext'
import { useSeo } from '@/hooks/useSeo'
import { supabase, Order, ProductCatalogEntry } from '@/lib/supabase'
import { Loader2, Package, Heart } from 'lucide-react'
import { Link } from 'react-router-dom'
import WishlistButton from '@/components/WishlistButton'

const STATUS_MAP_EN: Record<string, string> = {
  pending: 'border-muted-foreground/40 text-muted-foreground',
  confirmed: 'border-foreground/40 text-foreground',
  processing: 'border-foreground/40 text-foreground',
  shipped: 'border-foreground/40 text-foreground',
  delivered: 'border-emerald-700/50 text-emerald-700',
  cancelled: 'border-red-700/50 text-red-700',
  paid: 'border-emerald-700/50 text-emerald-700',
  failed: 'border-red-700/50 text-red-700',
}

export default function Account() {
  const { user, profile } = useAuth()
  const { isWishlisted } = useWishlist()
  const [orders, setOrders] = useState<Order[]>([])
  const [wishlistProducts, setWishlistProducts] = useState<ProductCatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const t = useT()
  const { lang } = useLanguage()
  const { formatPrice } = useCurrency()
  const catalogPrice = useCatalogPrice()

  useSeo({
    title: 'My Account · BOM Store',
    description: 'View your order history and wishlist.',
    noindex: true,
  })

  useEffect(() => {
    if (!user) return
    async function load() {
      const [{ data: orderData }, { data: wishlistRows }] = await Promise.all([
        supabase.from('orders').select('*').eq('user_id', user.id).order('created_at', { ascending: false }),
        supabase.from('wishlist_items').select('product_id').eq('user_id', user.id),
      ])
      setOrders(orderData || [])

      const productIds = (wishlistRows || []).map(row => row.product_id)
      if (productIds.length > 0) {
        const { data: products } = await supabase.from('product_catalog').select('*').in('id', productIds)
        setWishlistProducts(products || [])
      }
      setLoading(false)
    }
    load()
  }, [user])

  // isWishlisted is the live source of truth -- filtering through it means
  // clicking WishlistButton's heart below removes the row immediately,
  // with no extra local-state bookkeeping to keep in sync.
  const wishlistItems = wishlistProducts.filter(p => isWishlisted(p.id))

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="px-6 lg:px-10 py-12 lg:py-16">
      <div className="max-w-[1100px] mx-auto">
        <p className="text-zen text-muted-foreground mb-4">{t.accountEyebrow}</p>
        <h1 className="font-display text-4xl md:text-5xl mb-3">
          {t.accountWelcome(profile?.full_name || '')}
        </h1>
        <p className="text-sm text-muted-foreground mb-12">{user?.email}</p>

        <div className="grid md:grid-cols-3 gap-4 mb-16">
          <Stat label={t.accountTotalOrders} value={orders.length} />
          <Stat label={t.accountActiveOrders} value={orders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length} />
          <Stat label={t.accountTotalSpent} value={formatPrice(orders.reduce((sum, o) => sum + (o.total_amount || 0), 0))} />
        </div>

        <div>
          <h2 className="font-display text-2xl mb-6">{t.accountHistory}</h2>
          {orders.length === 0 ? (
            <div className="border border-border p-12 text-center">
              <Package className="w-8 h-8 mx-auto text-muted-foreground/50 mb-4" />
              <p className="text-muted-foreground mb-4">{t.accountNoOrders}</p>
              <Link to="/shop" className="text-sm border-b border-foreground pb-0.5">
                {t.accountBrowse}
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {orders.map(o => (
                <div key={o.id} className="border border-border p-5 sm:p-6">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="font-mono text-xs text-muted-foreground tracking-wider">
                        {o.kashier_order_id || o.id.slice(0, 8).toUpperCase()}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {new Date(o.created_at).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-US', {
                          year: 'numeric', month: 'long', day: 'numeric'
                        })}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <StatusBadge status={o.status} t={t} />
                      <StatusBadge status={o.payment_status} t={t} />
                      <p className="font-display text-xl">{formatPrice(Number(o.total_amount))}</p>
                    </div>
                  </div>
                  {o.items && Array.isArray(o.items) && o.items.length > 0 && (
                    <div className="mt-5 pt-5 border-t border-border flex flex-wrap gap-3">
                      {o.items.slice(0, 4).map((item: any, i: number) => (
                        <div key={i} className="w-14 h-14 bg-muted overflow-hidden">
                          {item.image_url && <img src={item.image_url} alt="" className="w-full h-full object-cover" />}
                        </div>
                      ))}
                      {o.items.length > 4 && (
                        <div className="w-14 h-14 bg-muted flex items-center justify-center text-xs text-muted-foreground">
                          +{o.items.length - 4}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div id="wishlist" className="mt-16 scroll-mt-24">
          <h2 className="font-display text-2xl mb-6">{t.accountWishlist}</h2>
          {wishlistItems.length === 0 ? (
            <div className="border border-border p-12 text-center">
              <Heart className="w-8 h-8 mx-auto text-muted-foreground/50 mb-4" />
              <p className="text-muted-foreground mb-4">{t.accountWishlistEmpty}</p>
              <Link to="/shop" className="text-sm border-b border-foreground pb-0.5">
                {t.accountBrowse}
              </Link>
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-3">
              {wishlistItems.map(p => (
                <div key={p.id} className="border border-border p-4 flex items-center gap-4">
                  <Link to={`/product/${p.slug}`} className="w-16 h-16 bg-muted overflow-hidden shrink-0">
                    <img src={p.image_url || ''} alt={p.name} className="w-full h-full object-cover" />
                  </Link>
                  <div className="flex-1 min-w-0">
                    <Link
                      to={`/product/${p.slug}`}
                      className="font-display text-base block truncate hover:text-muted-foreground transition-colors"
                    >
                      {p.name}
                    </Link>
                    <p className="text-sm text-muted-foreground mt-1">{catalogPrice(p)}</p>
                  </div>
                  <WishlistButton productId={p.id} className="shrink-0" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-border p-5">
      <p className="text-xs tracking-widest uppercase text-muted-foreground mb-2">{label}</p>
      <p className="font-display text-3xl">{value}</p>
    </div>
  )
}

function StatusBadge({ status, t }: { status: string; t: any }) {
  const cls = STATUS_MAP_EN[status] || STATUS_MAP_EN.pending
  // Map status to translation
  const labelMap: Record<string, string> = {
    pending: t.statusPending,
    confirmed: t.statusConfirmed,
    processing: t.statusProcessing,
    shipped: t.statusShipped,
    delivered: t.statusDelivered,
    cancelled: t.statusCancelled,
    paid: t.statusPaid,
    failed: t.statusFailed,
  }
  return (
    <span className={`px-2.5 py-1 text-[10px] tracking-widest uppercase border ${cls}`}>
      {labelMap[status] || status}
    </span>
  )
}
