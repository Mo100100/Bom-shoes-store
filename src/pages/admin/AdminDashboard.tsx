import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, Order, ProductCatalogEntry } from '@/lib/supabase'
import { useT } from '@/contexts/LanguageContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { Package, ShoppingBag, TrendingUp, ListOrdered, Loader2 } from 'lucide-react'
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

const DAY_MS = 86400000

// Sum of total_amount per day for the last 30 days (UTC day buckets) -- days
// with no orders are kept at 0 so the x-axis stays continuous. Parses via
// Date rather than slicing the raw string so this stays correct regardless
// of what offset Postgres happens to serialize created_at with.
function revenueByDay(orders: Order[]): { date: string; revenue: number }[] {
  const totals = new Map<string, number>()
  for (const o of orders) {
    const day = new Date(o.created_at).toISOString().slice(0, 10)
    totals.set(day, (totals.get(day) || 0) + (Number(o.total_amount) || 0))
  }
  const todayUTC = Math.floor(Date.now() / DAY_MS) * DAY_MS
  const days: { date: string; revenue: number }[] = []
  for (let i = 29; i >= 0; i--) {
    const key = new Date(todayUTC - i * DAY_MS).toISOString().slice(0, 10)
    days.push({
      date: new Date(`${key}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      revenue: totals.get(key) || 0,
    })
  }
  return days
}

// Units sold per product, summed across every order's `items` jsonb array, top 5.
function bestSellers(orders: Order[]): { name: string; units: number }[] {
  const totals = new Map<string, { name: string; units: number }>()
  for (const o of orders) {
    const items = Array.isArray(o.items) ? o.items : []
    for (const item of items) {
      const key = item?.product_id || item?.name
      if (!key) continue
      const qty = Number(item.quantity) || 0
      const existing = totals.get(key)
      if (existing) existing.units += qty
      else totals.set(key, { name: item.name || key, units: qty })
    }
  }
  return Array.from(totals.values()).sort((a, b) => b.units - a.units).slice(0, 5)
}

export default function AdminDashboard() {
  const [stats, setStats] = useState({
    revenue: 0,
    orders: 0,
    products: 0,
    pending: 0,
  })
  const [recentOrders, setRecentOrders] = useState<Order[]>([])
  const [topProducts, setTopProducts] = useState<ProductCatalogEntry[]>([])
  const [revenueChart, setRevenueChart] = useState<{ date: string; revenue: number }[]>([])
  const [sellersChart, setSellersChart] = useState<{ name: string; units: number }[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const t = useT()
  const { formatPrice } = useCurrency()

  async function load() {
    setLoading(true)
    const [orderRes, productRes] = await Promise.all([
      supabase.from('orders').select('*'),
      supabase.from('product_catalog').select('*'),
    ])
    // Zero revenue, zero orders and an empty chart are what a failed read used
    // to draw. This is the first screen of the admin: it has to be honest or
    // nothing behind it is trusted.
    if (orderRes.error || productRes.error) {
      setLoadError(true)
      setLoading(false)
      return
    }
    setLoadError(false)
    const orders = orderRes.data
    const products = productRes.data

    const paidOrders = (orders || []).filter(o => o.payment_status === 'paid')
    const revenue = paidOrders.reduce((sum, o) => sum + (Number(o.total_amount) || 0), 0)
    setStats({
      revenue,
      orders: (orders || []).length,
      products: (products || []).length,
      pending: (orders || []).filter(o => o.status === 'pending' || o.status === 'confirmed').length,
    })
    setRecentOrders((orders || []).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 5))
    // Only genuinely low-stock products (< 10) belong under "Low Stock" --
    // previously this sorted low-first but always sliced 5, so a fully-
    // stocked catalog still listed 5 items as if they were low.
    setTopProducts((products || []).filter(p => p.total_stock < 10).sort((a, b) => a.total_stock - b.total_stock).slice(0, 5))
    setRevenueChart(revenueByDay(paidOrders))
    setSellersChart(bestSellers(paidOrders))
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
      <div className="border border-terracotta bg-card p-12 text-center">
        <p className="text-terracotta">{t.adminLoadError}</p>
        <button
          onClick={() => load()}
          className="mt-4 text-sm border-b border-foreground pb-0.5 cursor-pointer"
        >
          {t.failedTryAgain}
        </button>
      </div>
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
                    <p className="text-xs text-muted-foreground">{formatPrice(Number(p.price))}</p>
                  </div>
                  <p className={`text-sm font-medium ${p.total_stock < 10 ? 'text-red-700' : 'text-foreground'}`}>
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
