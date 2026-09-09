import { Fragment, useEffect, useRef, useState } from 'react'
import { supabase, Order } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useT } from '@/contexts/LanguageContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { Loader2, ChevronDown, ChevronUp, Search } from 'lucide-react'
import LoadErrorPanel from '@/components/LoadErrorPanel'
import { toast } from 'sonner'

type SortKey = 'date' | 'total'
type SortDir = 'asc' | 'desc'

const STATUS_VALUES = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled']
const STATUS_LABEL_MAP: Record<string, string> = {
  pending: 'statusPending',
  confirmed: 'statusConfirmed',
  processing: 'statusProcessing',
  shipped: 'statusShipped',
  delivered: 'statusDelivered',
  cancelled: 'statusCancelled',
  paid: 'statusPaid',
  failed: 'statusFailed',
  refunded: 'statusRefunded',
}

// The order states an order can still be moved into. Mirrors the state machine
// in admin_update_order_status() (see 20260808000000), which is authoritative:
// this only stops the owner picking a move the database will refuse.
//
//   cancelled is terminal      -- the goods went back on the shelf and may
//                                 already be sold to someone else.
//   pending cannot be advanced -- an order that never reserved stock would be
//                                 shipped against inventory still counted as
//                                 available. Cancelling it is all that is left.
//   everything else moves freely between confirmed/processing/shipped/
//   delivered, in both directions, and can always be cancelled.
const ACTIVE_STATUSES = ['confirmed', 'processing', 'shipped', 'delivered']

// Same page size AdminActivityLog uses, and the same "load more" shape. Past
// max_rows = 1000 (supabase/config.toml) an unpaginated select('*') left the
// oldest orders unreachable from the admin entirely, and the status counts and
// the total were computed over that truncated set.
const PAGE_SIZE = 50
// admin_orders_page() caps p_limit at 500. A refetch after a status change
// re-reads everything already on screen rather than throwing the admin back to
// page one, so it has to respect the same ceiling.
const MAX_REFETCH = 500

// What admin_orders_page() returns. `total` and `status_counts` span the whole
// table, not the loaded page: counting the rows in hand is the bug.
type OrdersPage = {
  rows: Order[]
  total: number
  status_counts: Record<string, number>
}

function allowedStatuses(order: Order): string[] {
  if (order.status === 'cancelled') return []
  const holdsStock = order.payment_status === 'paid' || !!order.stock_reserved_at
  if (order.status === 'pending' && !holdsStock) return ['cancelled']
  return [...ACTIVE_STATUSES, 'cancelled']
}

export default function AdminOrders() {
  const [orders, setOrders] = useState<Order[]>([])
  const [total, setTotal] = useState(0)
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [filter, setFilter] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Only the most recent load may land. Two searches typed a moment apart can
  // come back out of order, and the loser would otherwise paint its rows next
  // to the winner's total. Same guard AdminBundles uses.
  const loadIdRef = useRef(0)
  const { isAdmin } = useAuth()
  const t = useT()
  const { formatPrice } = useCurrency()

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(dir => (dir === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  // Filtering, searching, sorting and counting all happen in the database:
  // doing any of them over the loaded page would give an answer about the page
  // rather than about the shop.
  function pageArgs(offset: number, limit: number) {
    return {
      p_status: filter === 'all' ? null : filter,
      p_search: search.trim() || null,
      p_sort: sortKey || 'date',
      p_dir: sortKey ? sortDir : 'desc',
      p_offset: offset,
      p_limit: limit,
    }
  }

  // Takes an optional page size, so every reference to it must be CALLED
  // rather than passed: an onClick handed this function directly would supply
  // React's click event as `limit` and the retry could never succeed.
  async function load(limit = PAGE_SIZE) {
    const id = ++loadIdRef.current
    setLoading(true)
    const { data, error } = await supabase.rpc('admin_orders_page', pageArgs(0, limit))
    if (id !== loadIdRef.current) return
    // "No orders yet" on a shop that has orders is the single most alarming
    // thing this dashboard can say, so a failed read never renders as one.
    setLoadError(!!error)
    const page = (error ? null : data) as OrdersPage | null
    const rows = page?.rows || []
    setOrders(rows)
    setTotal(page ? Number(page.total) || 0 : 0)
    setStatusCounts(page?.status_counts || {})
    setHasMore(rows.length < (page ? Number(page.total) || 0 : 0))
    // A "load more" this load superseded returns without clearing its own
    // flag, which would leave the button disabled for good.
    setLoadingMore(false)
    setLoading(false)
  }

  // Debounced so typing in the search box is one request per pause, not one
  // per keystroke. Changing the filter or the sort re-runs immediately.
  useEffect(() => {
    const id = setTimeout(() => { load() }, search.trim() ? 300 : 0)
    return () => clearTimeout(id)
  }, [filter, search, sortKey, sortDir])

  async function loadMore() {
    // Shares the counter with load(): a filter or search change mid-flight
    // discards this page rather than appending it under the new query's rows.
    const id = ++loadIdRef.current
    setLoadingMore(true)
    const { data, error } = await supabase.rpc('admin_orders_page', pageArgs(orders.length, PAGE_SIZE))
    if (id !== loadIdRef.current) return
    // A failed page must not read as "that was the last order": keep the
    // button and say what happened, same as AdminActivityLog.
    if (error) { toast.error(t.adminLoadError); setLoadingMore(false); return }
    const page = data as OrdersPage
    const rows = page.rows || []
    const nextTotal = Number(page.total) || 0
    setOrders(prev => [...prev, ...rows])
    setTotal(nextTotal)
    setStatusCounts(page.status_counts || {})
    setHasMore(orders.length + rows.length < nextTotal)
    setLoadingMore(false)
  }

  // After a write, re-read everything the admin already has on screen instead
  // of collapsing back to the first page.
  function reload() {
    load(Math.min(Math.max(orders.length, PAGE_SIZE), MAX_REFETCH))
  }

  // Every state change goes through admin_update_order_status(), never a plain
  // UPDATE: cancelling an order has to give its reserved stock back, and
  // advancing one that never reserved any has to be refused. A database
  // trigger rejects a direct write from the client, so this is the only path.
  // The refusal reasons come back as a `hint` and are shown in the owner's own
  // language rather than as raw SQL.
  function refusalMessage(hint: string | null | undefined, fallback: string): string {
    if (hint === 'order_cancelled') return t.adminOrderCancelledFinal
    if (hint === 'order_never_reserved') return t.adminOrderNeverReserved
    if (hint === 'payment_not_markable') return t.adminPaymentNotMarkable
    if (hint === 'fulfill_failed') return t.adminFulfillFailed
    return fallback
  }

  async function updateStatus(order: Order, newStatus: string) {
    // Cancelling is the one status change that moves inventory and cannot be
    // undone: the items go back on the shelf and the order is closed for good.
    // It sits in the same dropdown as the everyday moves, one scroll position
    // away from 'delivered', so it gets the same confirm() a product deletion
    // gets in AdminProducts.
    if (newStatus === 'cancelled' && !confirm(t.adminCancelConfirm)) return
    const { error } = await supabase.rpc('admin_update_order_status', {
      p_order_id: order.id,
      p_status: newStatus,
    })
    if (error) { toast.error(refusalMessage(error.hint, error.message)); return }
    toast.success(t.adminUpdated)
    reload()
  }

  // Two shapes, both "the money arrived":
  //   cash   -- stock was reserved at placement, so this only records the
  //             collection. Normal, everyday, no confirmation.
  //   online -- the payment landed but the webhook never did. The database
  //             runs the order through fulfill_order() here, which TAKES the
  //             stock, so it is confirmed first. Without this the owner's only
  //             answer to a dropped webhook would be cancelling an order the
  //             customer has already paid for.
  async function markPaid(order: Order) {
    const isOnlineFulfil = order.payment_method !== 'cash'
    if (isOnlineFulfil && !confirm(t.adminMarkPaidConfirm)) return
    const { error } = await supabase.rpc('admin_update_order_status', {
      p_order_id: order.id,
      p_payment_status: 'paid',
    })
    if (error) { toast.error(refusalMessage(error.hint, error.message)); return }
    // The customer of a lost webhook never got the confirmation the gateway
    // path sends, so send it here. Non-fatal exactly as it is in the webhook:
    // the order is fulfilled either way and a failed email must not read as a
    // failed fulfilment.
    if (isOnlineFulfil && order.kashier_order_id) {
      supabase.functions
        .invoke('send-order-confirmation', { body: { orderId: order.kashier_order_id } })
        .catch(err => console.error('send-order-confirmation failed', err))
    }
    toast.success(t.adminMarkedPaid)
    reload()
  }


  function statusLabel(s: string): string {
    const key = STATUS_LABEL_MAP[s]
    return key ? (t as any)[key] : s
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
          {['all', ...STATUS_VALUES].map(s => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-1.5 text-xs tracking-wider uppercase whitespace-nowrap cursor-pointer transition-colors ${
                filter === s
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {/* Counts come from the database, over every order: counting
                  the loaded page would say "3 shipped" on a shop with 400. */}
              {s === 'all' ? t.adminOrdersAll : statusLabel(s)} {s !== 'all' && `(${statusCounts[s] || 0})`}
            </button>
          ))}
        </div>
        {/* A count over a failed read would read as "you have no orders". */}
        {!loadError && <p className="text-sm text-muted-foreground">{t.adminOrdersCount(total)}</p>}
      </div>

      <div className="relative mb-4 max-w-sm">
        <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t.adminSearchOrders}
          className="w-full bg-transparent border border-border ps-9 pe-3 py-2 text-sm focus:border-foreground outline-none"
        />
      </div>

      {loading ? (
        <div className="py-24 flex justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : loadError ? (
        <LoadErrorPanel onRetry={() => load()} />
      ) : orders.length === 0 ? (
        <div className="border border-border bg-card p-12 text-center">
          <p className="text-muted-foreground">{t.adminNoOrdersFilter}</p>
        </div>
      ) : (
        <div className="border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs tracking-widest uppercase text-muted-foreground">
                <tr>
                  <th className="text-start px-4 py-3">{t.adminOrder}</th>
                  <th className="text-start px-4 py-3">{t.adminCustomer}</th>
                  <th className="text-start px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggleSort('date')}
                      className="inline-flex items-center gap-1 cursor-pointer hover:text-foreground"
                    >
                      {t.adminDate}
                      {sortKey === 'date' && (sortDir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
                    </button>
                  </th>
                  <th className="text-start px-4 py-3">{t.adminItems}</th>
                  <th className="text-start px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggleSort('total')}
                      className="inline-flex items-center gap-1 cursor-pointer hover:text-foreground"
                    >
                      {t.adminTotal}
                      {sortKey === 'total' && (sortDir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
                    </button>
                  </th>
                  <th className="text-start px-4 py-3">{t.adminPayment}</th>
                  <th className="text-start px-4 py-3">{t.adminStatus}</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(o => {
                  const allowed = allowedStatuses(o)
                  return (
                  <Fragment key={o.id}>
                  <tr
                    className="border-t border-border hover:bg-muted/20 cursor-pointer"
                    onClick={() => setExpandedId(id => (id === o.id ? null : o.id))}
                  >
                    <td className="px-4 py-4 font-mono text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        {expandedId === o.id ? <ChevronUp className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />}
                        {o.kashier_order_id || o.id.slice(0, 8)}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <p className="font-medium">{o.customer_name || t.dash}</p>
                      <p className="text-xs text-muted-foreground">{o.customer_email}</p>
                    </td>
                    <td className="px-4 py-4 text-muted-foreground whitespace-nowrap">
                      {new Date(o.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </td>
                    <td className="px-4 py-4 text-muted-foreground">
                      {Array.isArray(o.items) ? o.items.length : 0} {(o.items as any[])?.length === 1 ? t.piece : t.pieces}
                    </td>
                    <td className="px-4 py-4 font-medium">{formatPrice(Number(o.total_amount))}</td>
                    <td className="px-4 py-4">
                      <div className="flex flex-col items-start gap-1.5">
                        <span className={`text-xs px-2 py-0.5 border ${
                          o.payment_status === 'paid'
                            ? 'border-emerald-700/50 text-emerald-700'
                            : o.payment_status === 'failed'
                            ? 'border-red-700/50 text-red-700'
                            : 'border-muted-foreground/40 text-muted-foreground'
                        }`}>
                          {o.payment_method === 'cash' ? `${statusLabel(o.payment_status)} · ${t.adminCod}` : statusLabel(o.payment_status)}
                        </span>
                        {/* Cash: records the collection. Online: only offered on
                            an order still sitting at 'pending', where it means
                            the payment landed but the webhook never did, and it
                            takes the stock through fulfill_order.
                            A 'failed' payment_status is terminal either way: it
                            means place_cod_order could not reserve the stock, or
                            release_order_stock gave the stock back, and in both
                            cases those goods are on the shelf again. */}
                        {isAdmin && o.payment_status === 'pending' && o.status !== 'cancelled'
                          && (o.payment_method === 'cash' || o.status === 'pending') && (
                          <button
                            onClick={e => { e.stopPropagation(); markPaid(o) }}
                            className="text-[10px] tracking-wider uppercase border border-emerald-700/50 text-emerald-700 px-2 py-0.5 hover:bg-emerald-700 hover:text-white transition-colors cursor-pointer"
                          >
                            {t.adminMarkPaid}
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4" onClick={e => e.stopPropagation()}>
                      {isAdmin && allowed.length > 0 ? (
                        <div className="relative inline-block">
                          {/* Moves the database will refuse stay visible but
                              unpickable, so the list still reads as a full
                              status history rather than hiding states. */}
                          <select
                            value={o.status}
                            onChange={e => updateStatus(o, e.target.value)}
                            className="appearance-none bg-transparent border border-border px-2.5 py-1 pe-7 text-xs cursor-pointer focus:outline-none"
                          >
                            {STATUS_VALUES.map(s => (
                              <option key={s} value={s} disabled={s !== o.status && !allowed.includes(s)}>
                                {statusLabel(s)}
                              </option>
                            ))}
                          </select>
                          <ChevronDown className="w-3 h-3 absolute end-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                        </div>
                      ) : (
                        <div className="flex flex-col items-start gap-1">
                          <span className="text-xs">{statusLabel(o.status)}</span>
                          {/* The dropdown is gone for a cancelled order because
                              there is nothing left to pick. Say why, rather than
                              letting the control vanish unexplained. */}
                          {isAdmin && o.status === 'cancelled' && (
                            <span className="text-[10px] text-muted-foreground leading-snug max-w-[16rem]">
                              {t.adminOrderCancelledFinal}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                  {expandedId === o.id && (
                    <tr className="border-t border-border bg-muted/10">
                      <td colSpan={7} className="px-4 py-5">
                        <div className="grid gap-6 sm:grid-cols-[1.5fr_1fr]">
                          <div>
                            <p className="text-xs tracking-widest uppercase text-muted-foreground mb-3">{t.adminItems}</p>
                            <div className="space-y-3">
                              {Array.isArray(o.items) && o.items.map((item: any, i: number) => (
                                <div key={i} className="flex items-center gap-3">
                                  <div className="w-12 h-12 bg-muted overflow-hidden shrink-0">
                                    {item.image_url && <img src={item.image_url} alt="" className="w-full h-full object-cover" />}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium truncate">{item.name}</p>
                                    <p className="text-xs text-muted-foreground">
                                      {[item.color, item.size].filter(Boolean).join(' · ')} {item.quantity ? `× ${item.quantity}` : ''}
                                    </p>
                                  </div>
                                  <p className="text-sm font-medium whitespace-nowrap">
                                    {formatPrice(Number(item.price || 0) * Number(item.quantity || 1))}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </div>
                          <div className="space-y-4">
                            <div>
                              <p className="text-xs tracking-widest uppercase text-muted-foreground mb-1">{t.fieldAddress}</p>
                              <p className="text-sm">{o.shipping_address || t.dash}</p>
                            </div>
                            <div>
                              <p className="text-xs tracking-widest uppercase text-muted-foreground mb-1">{t.fieldPhone}</p>
                              {o.customer_phone ? (
                                <a href={`tel:${o.customer_phone}`} className="text-sm hover:text-muted-foreground transition-colors">{o.customer_phone}</a>
                              ) : (
                                <p className="text-sm">{t.dash}</p>
                              )}
                            </div>
                            <div>
                              <p className="text-xs tracking-widest uppercase text-muted-foreground mb-1">{t.fieldEmail}</p>
                              {o.customer_email ? (
                                <a href={`mailto:${o.customer_email}`} className="text-sm hover:text-muted-foreground transition-colors">{o.customer_email}</a>
                              ) : (
                                <p className="text-sm">{t.dash}</p>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div className="p-4 flex justify-center border-t border-border">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="text-xs underline cursor-pointer disabled:opacity-50 flex items-center gap-2"
              >
                {loadingMore && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {t.adminLoadMore}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
