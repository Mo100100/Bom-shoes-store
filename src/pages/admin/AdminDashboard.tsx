import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, Order, ProductCatalogEntry } from '@/lib/supabase'
import { useLanguage, useT } from '@/contexts/LanguageContext'
import { Lang } from '@/lib/translations'
import { useCurrency } from '@/contexts/CurrencyContext'
import { useCatalogPrice } from '@/hooks/useCatalogPrice'
import { Package, ShoppingBag, TrendingUp, ListOrdered, Loader2 } from 'lucide-react'
import LoadErrorPanel from '@/components/LoadErrorPanel'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts'

const STATUS_LABEL_MAP: Record<string, string> = {
  pending: 'statusPending',
  confirmed: 'statusConfirmed',
  processing: 'statusProcessing',
  shipped: 'statusShipped',
  delivered: 'statusDelivered',
  cancelled: 'statusCancelled',
  paid: 'statusPaid',
  failed: 'statusFailed',
}

const CHART_DAYS = 30
const LOW_STOCK_BELOW = 10
const PANEL_ROWS = 5

// What admin_dashboard_summary() returns. Every figure on this screen is
// computed in SQL now: `select('*')` on orders was capped at max_rows = 1000
// (supabase/config.toml), so revenue, the order count, the chart and the best
// sellers all silently stopped growing at the thousandth order, and drawing a
// five-bar chart meant downloading every order's full `items` jsonb.
type DashboardSummary = {
  revenue: number
  orders: number
  pending: number
  products: number
  revenue_by_day: { date: string; revenue: number }[]
  best_sellers: { name: string; units: number }[]
}

// Only the columns these two panels draw. Both lists are a fixed five rows,
// and asking for the columns by name keeps an order's `items` jsonb and a
// product's description out of the response entirely.
type RecentOrder = Pick<Order, 'id' | 'kashier_order_id' | 'customer_name' | 'total_amount' | 'status'>
type LowStockProduct = Pick<ProductCatalogEntry, 'id' | 'name' | 'image_url' | 'total_stock' | 'min_price' | 'max_price'>

// The RPC buckets by Africa/Cairo calendar day and hands back 'YYYY-MM-DD'.
// Built from the parts rather than parsed as a date string so the label is the
// day the store had, whatever timezone the admin's browser is in: a bare
// `new Date('2026-09-09')` is parsed as UTC midnight and reads as the 8th west
// of Greenwich.
function dayLabel(isoDay: string, lang: Lang): string {
  const [y, m, d] = isoDay.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-US', { month: 'short', day: 'numeric' })
}

export default function AdminDashboard() {
  const [stats, setStats] = useState({
    revenue: 0,
    orders: 0,
    products: 0,
    pending: 0,
  })
  const [recentOrders, setRecentOrders] = useState<RecentOrder[]>([])
  const [topProducts, setTopProducts] = useState<LowStockProduct[]>([])
  const [revenueChart, setRevenueChart] = useState<{ date: string; revenue: number }[]>([])
  const [sellersChart, setSellersChart] = useState<{ name: string; units: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const t = useT()
  const { lang } = useLanguage()
  const { formatPrice } = useCurrency()
  const catalogPrice = useCatalogPrice()

  // Three bounded requests, none of which grows with the number of orders or
  // products: the aggregates, the five most recent orders, and the five
  // lowest-stock products. Only genuinely low-stock products (< 10) belong
  // under "Low Stock", filtered in SQL rather than over a downloaded catalog.
  async function load() {
    setLoading(true)
    const [summaryRes, recentRes, lowStockRes] = await Promise.all([
      supabase.rpc('admin_dashboard_summary', { p_days: CHART_DAYS }),
      supabase
        .from('orders')
        .select('id, kashier_order_id, customer_name, total_amount, status')
        .order('created_at', { ascending: false })
        .limit(PANEL_ROWS),
      supabase
        .from('product_catalog')
        .select('id, name, image_url, total_stock, min_price, max_price')
        .lt('total_stock', LOW_STOCK_BELOW)
        .order('total_stock')
        .limit(PANEL_ROWS),
    ])
    // Zero revenue, zero orders and an empty chart are what a failed read used
    // to draw. This is the first screen of the admin: it has to be honest or
    // nothing behind it is trusted.
    if (summaryRes.error || recentRes.error || lowStockRes.error) {
      setLoadError(true)
      setLoading(false)
      return
    }
    setLoadError(false)
    const summary = summaryRes.data as DashboardSummary

    setStats({
      revenue: Number(summary.revenue) || 0,
      orders: Number(summary.orders) || 0,
      products: Number(summary.products) || 0,
      pending: Number(summary.pending) || 0,
    })
    setRecentOrders((recentRes.data || []) as RecentOrder[])
    setTopProducts((lowStockRes.data || []) as LowStockProduct[])
    // The raw 'YYYY-MM-DD' is kept and formatted at render time: a label baked
    // in here would stay in the language the dashboard was loaded in.
    setRevenueChart((summary.revenue_by_day || []).map(d => ({
      date: d.date,
      revenue: Number(d.revenue) || 0,
    })))
    setSellersChart((summary.best_sellers || []).map(s => ({
      name: s.name,
      units: Number(s.units) || 0,
    })))
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  function statusLabel(s: string): string {
    const key = STATUS_LABEL_MAP[s]
    return key ? (t as any)[key] : s
  }

  if (loading) {
    return (
      <div className="py-24 flex justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (loadError) {
    return (
      <LoadErrorPanel onRetry={load} />
    )
  }

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
        <StatCard
          icon={TrendingUp}
          label={t.adminRevenue}
          value={formatPrice(stats.revenue)}
        />
        <StatCard
          icon={ListOrdered}
          label={t.adminOrders}
          value={stats.orders}
        />
        <StatCard
          icon={Package}
          label={t.adminProducts}
          value={stats.products}
        />
        <StatCard
          icon={ShoppingBag}
          label={t.adminActive}
          value={stats.pending}
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-6 mb-6">
        <div className="border border-border bg-card p-6">
          <h2 className="font-display text-xl mb-5">{t.adminRevenueChart}</h2>
          <div className="h-64">
            {revenueChart.every(d => d.revenue === 0) ? (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                {t.adminNoOrders}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={revenueChart} margin={{ top: 5, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={{ stroke: 'hsl(var(--border))' }}
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
                    interval={Math.ceil(revenueChart.length / 6)}
                    tickFormatter={(v: string) => dayLabel(v, lang)}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
                    tickFormatter={(v) => formatPrice(Number(v))}
                  />
                  <Tooltip
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 0, fontSize: 12 }}
                    labelStyle={{ color: 'hsl(var(--foreground))' }}
                    formatter={(v: number) => [formatPrice(v), t.adminRevenue]}
                    labelFormatter={(v: string) => dayLabel(v, lang)}
                  />
                  <Line
                    type="monotone"
                    dataKey="revenue"
                    stroke="hsl(var(--foreground))"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: 'hsl(var(--foreground))', stroke: 'hsl(var(--card))', strokeWidth: 2 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="border border-border bg-card p-6">
          <h2 className="font-display text-xl mb-5">{t.adminBestSellers}</h2>
          <div className="h-64">
            {sellersChart.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
                {t.adminNoOrders}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sellersChart} layout="vertical" margin={{ top: 5, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid horizontal={false} stroke="hsl(var(--border))" />
                  <XAxis
                    type="number"
                    allowDecimals={false}
                    tickLine={false}
                    axisLine={{ stroke: 'hsl(var(--border))' }}
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tickLine={false}
                    axisLine={false}
                    width={110}
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
                  />
                  <Tooltip
                    cursor={{ fill: 'hsl(var(--muted))' }}
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 0, fontSize: 12 }}
                    labelStyle={{ color: 'hsl(var(--foreground))' }}
                    formatter={(v: number) => [v, t.adminUnitsSold]}
                  />
                  <Bar dataKey="units" fill="hsl(var(--foreground))" barSize={18} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <div className="border border-border bg-card p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-display text-xl">{t.adminRecentOrders}</h2>
            <Link to="/admin/orders" className="text-xs text-muted-foreground hover:text-foreground">
              {t.adminViewAll}
            </Link>
          </div>
          {recentOrders.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">{t.adminNoOrders}</p>
          ) : (
            <div className="space-y-3">
              {recentOrders.map(o => (
                <div key={o.id} className="flex items-center justify-between text-sm">
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-muted-foreground truncate">
                      {o.kashier_order_id || o.id.slice(0, 8)}
                    </p>
                    <p className="truncate">{o.customer_name || t.adminGuest}</p>
                  </div>
                  <div className="text-end flex-shrink-0 ms-4">
                    <p className="font-medium">{formatPrice(Number(o.total_amount))}</p>
                    <p className="text-xs text-muted-foreground">{statusLabel(o.status)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border border-border bg-card p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-display text-xl">{t.adminLowStock}</h2>
            <Link to="/admin/products" className="text-xs text-muted-foreground hover:text-foreground">
              {t.adminViewAll}
            </Link>
          </div>
          {topProducts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">{t.adminAllStocked}</p>
          ) : (
            <div className="space-y-3">
              {topProducts.map(p => (
                <div key={p.id} className="flex items-center gap-3 text-sm">
                  <div className="w-10 h-10 bg-muted overflow-hidden flex-shrink-0">
                    <img src={p.image_url || ''} alt="" className="w-full h-full object-cover" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="truncate">{p.name}</p>
                    {/* products.price is the base price, not what the shop
                        charges: a variant price_override made this line
                        disagree with the product's own page. min_price and
                        max_price on product_catalog are the authoritative
                        pair, through the same helper the storefront uses. */}
                    <p className="text-xs text-muted-foreground">{catalogPrice(p)}</p>
                  </div>
                  <p className={`text-sm font-medium ${p.total_stock < LOW_STOCK_BELOW ? 'text-red-700' : 'text-foreground'}`}>
                    {t.shopOnlyLeft(p.total_stock)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function StatCard({ icon: Icon, label, value }: { icon: any; label: string; value: string | number }) {
  return (
    <div className="border border-border bg-card p-5">
      <div className="flex items-start justify-between mb-4">
        <p className="text-xs tracking-widest uppercase text-muted-foreground">{label}</p>
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <p className="font-display text-3xl">{value}</p>
    </div>
  )
}
