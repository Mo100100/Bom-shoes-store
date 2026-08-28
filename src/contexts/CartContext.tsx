import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react'
import { toast } from 'sonner'
import { Product, supabase } from '@/lib/supabase'
import { clampQuantity, reconcileLine, VariantSnapshot } from '@/lib/cart'
import { useT } from '@/contexts/LanguageContext'

export type CartItem = {
  product: Product
  size: string
  color: string
  quantity: number
  /** What one unit of this line actually costs: the variant's price_override,
   *  or the product's base price. Exactly the rule the server charges by (see
   *  supabase/functions/_shared/pricing.ts), so the total shown is the total
   *  billed. */
  unitPrice: number
  /** Stock the last revalidation saw for this exact variant, or null when the
   *  line hasn't been checked yet (nothing to clamp against). */
  stock: number | null
  /** The product, or this size/colour of it, is gone or sold out. The line
   *  stays visible so the customer sees what happened, but it counts toward no
   *  total and blocks checkout until it's removed. */
  unavailable?: boolean
}

type CartContextType = {
  items: CartItem[]
  addItem: (product: Product, size: string, color: string, quantity?: number, variant?: VariantSnapshot | null) => void
  removeItem: (productId: string, size: string, color: string) => void
  updateQuantity: (productId: string, size: string, color: string, quantity: number) => void
  clearCart: () => void
  revalidateCart: () => Promise<void>
  totalItems: number
  totalPrice: number
  couponCode: string | null
  setCouponCode: (code: string | null) => void
}

const CartContext = createContext<CartContextType | undefined>(undefined)

const CART_KEY = 'zen-shoes-cart'
const COUPON_KEY = 'zen-shoes-coupon'

function variantKey(productId: string, size: string, color: string): string {
  return `${productId}::${size}::${color}`
}

// A stored cart is JSON from a browser we don't control and can be months old,
// so every line is rebuilt into the current shape and anything unusable is
// dropped rather than trusted. `stock` and `unavailable` are deliberately not
// restored (see the write effect below): they start unknown and revalidateCart
// refills them from the database.
function hydrateStoredCart(): CartItem[] {
  try {
    const stored = localStorage.getItem(CART_KEY)
    const parsed = stored ? JSON.parse(stored) : []
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(i => i?.product?.id && typeof i.size === 'string' && typeof i.color === 'string')
      .map(i => ({
        product: i.product as Product,
        size: i.size as string,
        color: i.color as string,
        quantity: Math.max(1, Math.floor(Number(i.quantity)) || 1),
        unitPrice: Number(i.unitPrice ?? i.product.price) || 0,
        stock: null,
      }))
  } catch {
    return []
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const [items, setItems] = useState<CartItem[]>(hydrateStoredCart)
  const revalidating = useRef(false)

  const [couponCode, setCouponCode] = useState<string | null>(() => {
    try {
      const stored = localStorage.getItem(COUPON_KEY)
      return stored ? JSON.parse(stored) : null
    } catch {
      return null
    }
  })

  // Only the customer's own choices are persisted. Stock and availability are
  // server truth with a shelf life, so they're left out and refetched on the
  // next load instead of coming back as week-old numbers.
  useEffect(() => {
    try {
      const persistable = items.map(({ product, size, color, quantity, unitPrice }) => ({
        product, size, color, quantity, unitPrice,
      }))
      localStorage.setItem(CART_KEY, JSON.stringify(persistable))
    } catch { /* localStorage is unavailable in private mode: the cart just isn't persisted */ }
  }, [items])

  useEffect(() => {
    try { localStorage.setItem(COUPON_KEY, JSON.stringify(couponCode)) }
    catch { /* localStorage is unavailable in private mode: the coupon just isn't persisted */ }
  }, [couponCode])

  // Check the restored cart against the database once, on hydration. The Cart
  // page runs it again on mount for the customer who left the tab open.
  useEffect(() => {
    void revalidateCart()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // `variant` is the product_variants row the customer picked. It's optional so
  // no caller is forced to have one, but passing it means the line starts at
  // the price the server will charge and with a real stock cap, instead of
  // waiting for the next revalidateCart to correct it.
  function addItem(product: Product, size: string, color: string, quantity = 1, variant?: VariantSnapshot | null) {
    setItems(current => {
      const idx = current.findIndex(
        i => i.product.id === product.id && i.size === size && i.color === color
      )
      const existing = idx >= 0 ? current[idx] : null
      const stock = variant ? variant.stock : existing?.stock ?? null
      // Rebuilt from scratch rather than spread over the old line, so re-adding
      // something that had gone unavailable clears that flag.
      const line: CartItem = {
        product,
        size,
        color,
        quantity: clampQuantity(stock, (existing?.quantity ?? 0) + quantity),
        unitPrice: variant ? variant.price_override ?? product.price : existing?.unitPrice ?? product.price,
        stock,
      }
      if (idx < 0) return [...current, line]
      const copy = [...current]
      copy[idx] = line
      return copy
    })
  }

  function removeItem(productId: string, size: string, color: string) {
    setItems(current => current.filter(
      i => !(i.product.id === productId && i.size === size && i.color === color)
    ))
  }

  function updateQuantity(productId: string, size: string, color: string, quantity: number) {
    if (quantity <= 0) {
      removeItem(productId, size, color)
      return
    }
    setItems(current => current.map(i => {
      if (!(i.product.id === productId && i.size === size && i.color === color)) return i
      const capped = clampQuantity(i.stock, quantity)
      return capped === i.quantity ? i : { ...i, quantity: capped }
    }))
  }

  function clearCart() {
    setItems([])
    setCouponCode(null)
  }

  // The cart is a localStorage snapshot that nothing used to refresh, so a
  // basket left for a week still showed week-old prices, deleted products and
  // sizes that no longer exist. This refetches every line against the database.
  //
  // TWO queries, always: one for the products and one for every variant of
  // those products, both batched with `in (...)`. A 50-line cart costs the same
  // two round trips as a 1-line cart -- there is no per-line await anywhere in
  // here, and there must never be one.
  async function revalidateCart() {
    if (items.length === 0 || revalidating.current) return
    revalidating.current = true
    try {
      const productIds = [...new Set(items.map(i => i.product.id))]

      const [productsResult, variantsResult] = await Promise.all([
        supabase.from('products').select('id, name, slug, price, image_url, category').in('id', productIds),
        supabase.from('product_variants').select('product_id, size, color, stock, price_override').in('product_id', productIds),
      ])

      if (productsResult.error || variantsResult.error) {
        // A failed check must never read as a deleted product, so the cart is
        // left exactly as it was. create-order revalidates server-side anyway.
        console.error('Cart revalidation failed', productsResult.error ?? variantsResult.error)
        return
      }

      const queried = new Set(productIds)
      const productById = new Map((productsResult.data ?? []).map(p => [p.id, p]))
      const variantByKey = new Map(
        (variantsResult.data ?? []).map(v => [variantKey(v.product_id, v.size, v.color), v])
      )

      // Pure, so it can be applied to the cart as it stands when the response
      // lands rather than the copy this call started with -- a customer who
      // changed a quantity or added a line meanwhile keeps it. A line whose
      // product wasn't part of this fetch is left untouched instead of being
      // mistaken for a deleted one.
      function reconcile(item: CartItem): CartItem {
        if (!queried.has(item.product.id)) return item
        const fresh = productById.get(item.product.id)
        const variant = variantByKey.get(variantKey(item.product.id, item.size, item.color))
        const decision = reconcileLine(item.quantity, fresh?.price, variant)

        // Product deleted, or this exact size/colour is gone (which is what a
        // pre-migration '41/42/43' line hits), or sold out. Flagged rather than
        // deleted, so the cart never changes behind the customer's back.
        if (!decision.available) {
          return item.unavailable ? item : { ...item, stock: 0, unavailable: true }
        }

        const product: Product = {
          ...item.product,
          name: fresh.name,
          slug: fresh.slug,
          price: fresh.price,
          image_url: fresh.image_url,
          category: fresh.category,
        }
        const { unitPrice, quantity, stock } = decision
        return { product, size: item.size, color: item.color, quantity, unitPrice, stock }
      }

      // Only changes the customer can actually see are worth telling them
      // about; a stock number moving above their quantity is not one.
      const notify = items.some(item => {
        const next = reconcile(item)
        return next.unavailable !== item.unavailable ||
          next.unitPrice !== item.unitPrice ||
          next.quantity !== item.quantity ||
          next.product.name !== item.product.name ||
          next.product.image_url !== item.product.image_url
      })

      // Applied unconditionally: even when nothing visible moved, the refreshed
      // stock figures are what cap the quantity controls.
      setItems(current => current.map(reconcile))
      if (notify) toast.info(t.cartUpdated)
    } finally {
      revalidating.current = false
    }
  }

  // Unavailable lines are excluded from both totals: they can't be bought, and
  // the server rejects an order that still contains one.
  const sellable = items.filter(i => !i.unavailable)
  const totalItems = sellable.reduce((sum, i) => sum + i.quantity, 0)
  const totalPrice = sellable.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0)

  return (
    <CartContext.Provider value={{
      items,
      addItem,
      removeItem,
      updateQuantity,
      clearCart,
      revalidateCart,
      totalItems,
      totalPrice,
      couponCode,
      setCouponCode,
    }}>
      {children}
    </CartContext.Provider>
  )
}

export function useCart() {
  const ctx = useContext(CartContext)
  if (!ctx) throw new Error('useCart must be used within CartProvider')
  return ctx
}
