import { useEffect, useState, FormEvent } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { supabase, Product, ProductImage, ProductVariant, ProductCatalogEntry, Review, Bundle, BundleItem } from '@/lib/supabase'
import { useCart } from '@/contexts/CartContext'
import { useAuth } from '@/contexts/AuthContext'
import { useT, useLanguage } from '@/contexts/LanguageContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { useRecentlyViewed } from '@/hooks/useRecentlyViewed'
import { useSeo } from '@/hooks/useSeo'
import { compareSizes, defaultSizeForColor, firstInStockVariant } from '@/lib/sizes'
import WishlistButton from '@/components/WishlistButton'
import RatingStars from '@/components/RatingStars'
import SectionHeading from '@/components/SectionHeading'
import { ArrowLeft, Check, Loader2, ShoppingBag, Star } from 'lucide-react'
import { toast } from 'sonner'

// Filled/outline star row -- used both as a read-only rating display and,
// with a larger size + onRate, as the 1-5 star picker in the review form.
// The picker variant renders real <button>s (not bare clickable <svg>s) so
// it's reachable and operable by keyboard, and each carries its own label so
// screen readers announce something more useful than an unnamed control.
function StarRow({ rating, size = 'w-4 h-4', onRate }: { rating: number; size?: string; onRate?: (n: number) => void }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map(i => {
        const filled = i <= Math.round(rating)
        const star = <Star className={`${size} ${filled ? 'fill-foreground text-foreground' : 'text-muted-foreground/40'}`} />
        return onRate ? (
          <button
            key={i}
            type="button"
            onClick={() => onRate(i)}
            aria-label={`Rate ${i} star${i > 1 ? 's' : ''}`}
            className="cursor-pointer"
          >
            {star}
          </button>
        ) : (
          <span key={i}>{star}</span>
        )
      })}
    </div>
  )
}

// A bundle this product belongs to, plus every one of its required items
// (including this product itself) joined to their product row -- enough to
// show thumbnails/names/quantities and compute the bundle price vs buying
// separately, without a second round trip per item.
type BundleWithItems = Bundle & { items: (BundleItem & { products: Product })[] }

export default function ProductDetail() {
  const { slug } = useParams()
  const [product, setProduct] = useState<ProductCatalogEntry | null>(null)
  const [images, setImages] = useState<ProductImage[]>([])
  const [variants, setVariants] = useState<ProductVariant[]>([])
  const [related, setRelated] = useState<ProductCatalogEntry[]>([])
  const [bundles, setBundles] = useState<BundleWithItems[]>([])
  const [addingBundleId, setAddingBundleId] = useState<string | null>(null)
  const [recentlyViewed, setRecentlyViewed] = useState<ProductCatalogEntry[]>([])
  const [reviews, setReviews] = useState<Review[]>([])
  const [reviewerNames, setReviewerNames] = useState<Map<string, string | null>>(new Map())
  const [loading, setLoading] = useState(true)
  const [activeImage, setActiveImage] = useState(0)
  const [size, setSize] = useState('')
  const [color, setColor] = useState('')
  const [adding, setAdding] = useState(false)
  const { addItem } = useCart()
  const { user } = useAuth()
  const { viewedIds, addViewed } = useRecentlyViewed()
  const navigate = useNavigate()
  const t = useT()
  const { lang } = useLanguage()
  const { currency, formatPrice } = useCurrency()

  useEffect(() => {
    async function load() {
      setLoading(true)
      // product_catalog (not the bare products table) so avg_rating/review_count
      // come back in the same round trip -- it's a strict superset of Product.
      const { data } = await supabase
        .from('product_catalog')
        .select('*')
        .eq('slug', slug)
        .maybeSingle()

      if (data) {
        setProduct(data)
        setActiveImage(0)
        const [{ data: imgs }, { data: vars }, { data: rel }] = await Promise.all([
          supabase.from('product_images').select('*').eq('product_id', data.id).order('position'),
          supabase.from('product_variants').select('*').eq('product_id', data.id).order('size').order('color'),
          supabase.from('product_catalog').select('*').eq('category', data.category).neq('id', data.id).limit(4),
        ])
        setImages(imgs || [])
        setVariants(vars || [])
        setRelated(rel || [])
        loadReviews(data.id)
        loadBundles(data.id)

        // Default to a combo the customer can actually buy rather than whatever
        // row the fetch happened to return first: the colour of the first
        // in-stock variant, then that colour's smallest in-stock size. A fully
        // sold-out product still lands on its first colour and smallest size so
        // the picker is never blank. Legacy products with no variants fall back
        // to the flat sizes/colors arrays, sorted the same way.
        if (vars && vars.length > 0) {
          const defaultColor = (firstInStockVariant(vars) ?? vars[0]).color
          setColor(defaultColor)
          setSize(defaultSizeForColor(vars, defaultColor))
        } else {
          setColor(data.colors[0] ?? '')
          setSize([...data.sizes].sort(compareSizes)[0] ?? '')
        }
      }
      setLoading(false)
    }
    load()
  }, [slug])

  // Reviews + the reviewing users' display names, refetched after any
  // insert/update so the list and "already reviewed" detection stay current.
  async function loadReviews(productId: string) {
    const { data: revs } = await supabase
      .from('reviews')
      .select('*')
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
    setReviews(revs || [])

    const userIds = Array.from(new Set((revs || []).map(r => r.user_id)))
    if (userIds.length === 0) { setReviewerNames(new Map()); return }
    // Best-effort: if profiles RLS doesn't allow reading other users' rows,
    // this just comes back empty and everyone falls back to reviewsAnonymous.
    const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', userIds)
    setReviewerNames(new Map((profs || []).map(p => [p.id, p.full_name])))
  }

  // Fire-and-forget like loadReviews -- doesn't block the page's loading
  // spinner. Two round trips (not N+1): first find which active bundles
  // require this product, then fetch every item those bundles need in one
  // batched query. Leaves `bundles` empty (not an error) for the common case
  // of a product that isn't in any bundle -- the section below simply
  // doesn't render.
  async function loadBundles(productId: string) {
    const { data: matches } = await supabase
      .from('bundle_items')
      .select('bundle_id, bundles!inner(*)')
      .eq('product_id', productId)
      .eq('bundles.active', true)

    const bundleIds = Array.from(new Set((matches ?? []).map((m: any) => m.bundle_id)))
    if (bundleIds.length === 0) {
      setBundles([])
      return
    }

    const bundleById = new Map((matches ?? []).map((m: any) => [m.bundle_id, m.bundles]))
    const { data: items } = await supabase.from('bundle_items').select('*, products(*)').in('bundle_id', bundleIds)

    setBundles(bundleIds.map(id => ({
      ...bundleById.get(id),
      items: (items ?? []).filter((i: any) => i.bundle_id === id),
    })))
  }

  // Batches one product_variants query for every product in the bundle (not
  // one per item), picks the smallest in-stock size per product -- same
  // deterministic convention Shop.tsx's quickAdd uses -- and adds each bundle
  // item at its required quantity in one addItem call apiece.
  async function addBundleToBag(bundle: BundleWithItems) {
    setAddingBundleId(bundle.id)
    const { data: allVariants } = await supabase
      .from('product_variants')
      .select('*')
      .in('product_id', bundle.items.map(i => i.product_id))
      .order('size').order('color')

    const variantsByProduct = new Map<string, ProductVariant[]>()
    for (const v of allVariants || []) {
      const arr = variantsByProduct.get(v.product_id) ?? []
      arr.push(v)
      variantsByProduct.set(v.product_id, arr)
    }

    let added = 0
    for (const item of bundle.items) {
      const p = item.products
      const variant = firstInStockVariant(variantsByProduct.get(item.product_id) ?? [])
      const itemSize = variant?.size ?? [...p.sizes].sort(compareSizes)[0]
      const itemColor = variant?.color ?? p.colors[0] ?? ''
      if (!itemSize) continue // nothing sellable for this item -- skip rather than add a broken line
      // A line already holding all remaining stock adds nothing, so it doesn't
      // count toward the success toast either.
      if (addItem(p, itemSize, itemColor, item.quantity, variant)) added++
    }

    setAddingBundleId(null)
    if (added === 0) {
      toast.error(t.productOutOfStock)
      return
    }
    toast.success(t.bundleAdded, {
      description: bundle.name,
      action: { label: t.cart, onClick: () => navigate('/cart') },
    })
  }

  // Log the view and pull in the products seen before this one, once the
  // product itself has loaded. Reads viewedIds from *before* this page's
  // product gets added to it, so the current product is naturally excluded.
  useEffect(() => {
    if (!product) return
    addViewed(product.id)

    const ids = viewedIds.filter(id => id !== product.id).slice(0, 8)
    if (ids.length === 0) {
      setRecentlyViewed([])
      return
    }
    supabase.from('product_catalog').select('*').in('id', ids).then(({ data }) => {
      const byId = new Map((data || []).map(p => [p.id, p]))
      setRecentlyViewed(ids.map(id => byId.get(id)).filter((p): p is ProductCatalogEntry => !!p))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id])

  const hasVariants = variants.length > 0
  const colorOptions = hasVariants ? Array.from(new Set(variants.map(v => v.color))) : (product?.colors ?? [])
  // Sorted so 9 comes before 10 and before 40; the DB can only order sizes as
  // text, which puts 10 before 9.
  const sizeOptions = Array.from(
    new Set(hasVariants ? variants.map(v => v.size) : (product?.sizes ?? []))
  ).sort(compareSizes)
  const selectedVariant = hasVariants ? variants.find(v => v.color === color && v.size === size) : undefined
  const effectivePrice = selectedVariant ? (selectedVariant.price_override ?? product?.price ?? 0) : (product?.price ?? 0)
  const outOfStock = hasVariants ? (!selectedVariant || selectedVariant.stock === 0) : (product?.stock ?? 0) === 0

  function sizeAvailable(s: string) {
    if (!hasVariants) return true
    const v = variants.find(v => v.color === color && v.size === s)
    return !!v && v.stock > 0
  }

  // Switching colour used to strand the picker on a size that colour doesn't
  // stock, so the button read "Out of stock" while other sizes were sellable.
  // Move to that colour's first in-stock size whenever the current one isn't.
  useEffect(() => {
    if (!hasVariants || !color) return
    if (variants.some(v => v.color === color && v.size === size && v.stock > 0)) return
    setSize(defaultSizeForColor(variants, color))
  }, [variants, hasVariants, color, size])

  // ponytail: no product_images rows yet -> fall back to the legacy single image_url
  // so the gallery never renders a broken/blank image.
  const galleryImages = images.length > 0 ? images.map(i => i.url) : (product?.image_url ? [product.image_url] : [])

  // The signed-in user's own review, if any -- the reviews list is public-read
  // so it's already in `reviews` once loaded, no separate query needed. This
  // is what decides "write" vs "edit" mode for the form below.
  const myReview = user ? reviews.find(r => r.user_id === user.id) : undefined
  const [myRating, setMyRating] = useState(0)
  const [myTitle, setMyTitle] = useState('')
  const [myBody, setMyBody] = useState('')
  const [submittingReview, setSubmittingReview] = useState(false)

  useEffect(() => {
    if (myReview) {
      setMyRating(myReview.rating)
      setMyTitle(myReview.title ?? '')
      setMyBody(myReview.body ?? '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myReview?.id])

  async function submitReview(e: FormEvent) {
    e.preventDefault()
    if (!user || !product) return
    if (myRating === 0) { toast.error(t.reviewsRatingRequired); return }

    setSubmittingReview(true)
    const payload = { rating: myRating, title: myTitle.trim() || null, body: myBody.trim() || null }

    if (myReview) {
      const { error } = await supabase.from('reviews').update(payload).eq('id', myReview.id)
      setSubmittingReview(false)
      if (error) { toast.error(t.reviewsError); return }
      toast.success(t.reviewsUpdateSuccess)
      loadReviews(product.id)
      return
    }

    const { error } = await supabase.from('reviews').insert({ ...payload, product_id: product.id, user_id: user.id })
    setSubmittingReview(false)
    if (error) {
      // 23505 = unique_violation on (product_id, user_id) -- they already have
      // a review; refetch so the form flips into edit mode instead of erroring.
      if (error.code === '23505') {
        toast.info(t.reviewsAlreadyReviewed)
        loadReviews(product.id)
      } else {
        toast.error(t.reviewsError)
      }
      return
    }
    toast.success(t.reviewsSubmitSuccess)
    loadReviews(product.id)
  }

  // Back-in-stock notify: keyed to the currently selected variant, reset
  // whenever the user switches size/color to a different (in- or out-of-
  // stock) combo.
  const [notifyEmail, setNotifyEmail] = useState('')
  const [notifyStatus, setNotifyStatus] = useState<'idle' | 'submitting' | 'done' | 'already'>('idle')

  useEffect(() => {
    setNotifyEmail('')
    setNotifyStatus('idle')
  }, [selectedVariant?.id])

  async function handleNotify(e: FormEvent) {
    e.preventDefault()
    if (!selectedVariant) return
    if (!notifyEmail.trim()) { toast.error(t.notifyEmailRequired); return }

    setNotifyStatus('submitting')
    const { error } = await supabase
      .from('stock_notify_requests')
      .insert({ variant_id: selectedVariant.id, email: notifyEmail.trim() })

    if (error) {
      // 23505 = unique_violation on (variant_id, email) -- already signed up.
      if (error.code === '23505') {
        setNotifyStatus('already')
      } else {
        setNotifyStatus('idle')
        toast.error(t.notifyError)
      }
      return
    }
    setNotifyStatus('done')
  }

  async function handleAdd() {
    if (!product) return
    if (!size) { toast.error(t.productChooseSize); return }
    setAdding(true)
    const added = addItem(product, size, color, 1, selectedVariant)
    setTimeout(() => {
      setAdding(false)
      if (!added) {
        toast.error(t.productStockMaxed)
        return
      }
      toast.success(t.productAdded, {
        description: t.productAddedSize(product.name, size),
        action: { label: t.cart, onClick: () => navigate('/cart') }
      })
    }, 400)
  }

  // First gallery image (a string, not the array) -- used as both the OG
  // image below and the JSON-LD image, and kept as a primitive so it's a
  // stable effect dependency instead of the fresh `galleryImages` array
  // reference every render would produce.
  const heroImage = galleryImages[0]

  // Real product name/description/first image once loaded; the generic
  // brand fallback below is only ever seen transiently while it's fetching.
  useSeo({
    title: product ? `${product.name} · ${t.brandName}` : t.brandName,
    description: product ? (product.description || t.homeHeroSubtitle) : t.homeHeroSubtitle,
    image: heroImage,
  })

  // schema.org/Product JSON-LD, created once and updated in place by a
  // stable id (same create-or-update shape useSeo uses for its meta tags),
  // so switching between products never stacks up duplicate script tags.
  useEffect(() => {
    if (!product) return
    // total_stock (not the deprecated per-product `stock` field) is the
    // fallback when this product has no variants -- see the Product type note.
    const outOfStockForLd = hasVariants ? (!selectedVariant || selectedVariant.stock === 0) : product.total_stock === 0

    const jsonLd: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: product.name,
      image: heroImage || undefined,
      description: product.description || undefined,
      offers: {
        '@type': 'Offer',
        price: Number(effectivePrice).toFixed(2),
        priceCurrency: currency,
        availability: outOfStockForLd ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
      },
    }
    // schema.org doesn't want a fake 0/0 rating block -- omit entirely rather
    // than render aggregateRating for a product with no reviews yet.
    if (product.review_count > 0 && product.avg_rating != null) {
      jsonLd.aggregateRating = {
        '@type': 'AggregateRating',
        ratingValue: product.avg_rating,
        reviewCount: product.review_count,
      }
    }

    let script = document.getElementById('product-jsonld') as HTMLScriptElement | null
    if (!script) {
      script = document.createElement('script')
      script.id = 'product-jsonld'
      script.type = 'application/ld+json'
      document.head.appendChild(script)
    }
    script.textContent = JSON.stringify(jsonLd)
  }, [product, heroImage, effectivePrice, hasVariants, selectedVariant, currency])

  // Only strip the tag on unmount (leaving the product page entirely) -- not
  // on every dependency change above, which would just churn the same tag.
  useEffect(() => {
    return () => { document.getElementById('product-jsonld')?.remove() }
  }, [])

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center bg-cream">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!product) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-6 bg-cream">
        <p className="text-muted-foreground">{t.productNotFound}</p>
        <Link to="/shop" className="mt-4 text-sm border-b border-foreground pb-0.5">{t.productReturnShop}</Link>
      </div>
    )
  }

  return (
    <div className="px-6 lg:px-10 py-10 bg-cream min-h-screen">
      <div className="max-w-[1400px] mx-auto">
        <Link
          to="/shop"
          className="inline-flex items-center gap-2 text-xs tracking-widest uppercase text-muted-foreground hover:text-foreground mb-10"
        >
          <ArrowLeft className="w-3.5 h-3.5 flip-rtl" />
          {t.productBack}
        </Link>

        <div className="grid lg:grid-cols-2 gap-12 lg:gap-20">
          {/* Image gallery */}
          <div>
            <div className="aspect-square bg-muted overflow-hidden">
              <img
                src={galleryImages[activeImage] || ''}
                alt={product.name}
                className="w-full h-full object-cover"
              />
            </div>
            {galleryImages.length > 1 && (
              <div className="flex gap-2 mt-3">
                {galleryImages.map((url, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveImage(i)}
                    aria-label={`View photo ${i + 1} of ${product.name}`}
                    aria-pressed={activeImage === i}
                    className={`w-16 h-16 overflow-hidden bg-muted border transition-colors cursor-pointer ${
                      activeImage === i ? 'border-foreground' : 'border-border hover:border-foreground/50'
                    }`}
                  >
                    <img src={url} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Details */}
          <div className="lg:pt-8">
            <p className="text-zen text-muted-foreground mb-3">{product.category}</p>
            <h1 className="font-display text-4xl md:text-5xl mb-3 text-balance">{product.name}</h1>
            <p className="font-display text-2xl text-muted-foreground mb-3">
              {formatPrice(Number(effectivePrice))}
            </p>

            <div className="flex items-center gap-2 mb-8">
              {product.review_count > 0 && product.avg_rating != null ? (
                <>
                  <RatingStars rating={product.avg_rating} count={product.review_count} />
                  <span className="text-sm text-foreground/70">{product.avg_rating.toFixed(1)}</span>
                </>
              ) : (
                <span className="text-sm text-muted-foreground">{t.reviewsNoRatings}</span>
              )}
            </div>

            <p className="text-foreground/80 font-light leading-relaxed mb-10 max-w-md">
              {product.description}
            </p>

            {/* Color */}
            <div className="mb-8">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs tracking-widest uppercase text-muted-foreground">{t.productColor}</span>
                <span className="text-xs text-foreground/70">{color}</span>
              </div>
              <div className="flex gap-2">
                {colorOptions.map(c => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={`px-3.5 py-1.5 text-sm border transition-colors cursor-pointer ${
                      color === c
                        ? 'border-foreground bg-foreground text-background'
                        : 'border-border hover:border-foreground/50'
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>

            {/* Size */}
            <div className="mb-10">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs tracking-widest uppercase text-muted-foreground">{t.productSize}</span>
                <button className="text-xs text-muted-foreground underline-offset-2 hover:underline">
                  {t.productSizeGuide}
                </button>
              </div>
              <div className="grid grid-cols-5 sm:grid-cols-8 gap-1.5">
                {sizeOptions.map(s => {
                  const available = sizeAvailable(s)
                  return (
                    <button
                      key={s}
                      onClick={() => available && setSize(s)}
                      disabled={!available}
                      className={`py-2.5 text-sm border transition-colors ${
                        !available
                          ? 'border-border/50 text-muted-foreground/40 cursor-not-allowed'
                          : size === s
                          ? 'border-foreground bg-foreground text-background cursor-pointer'
                          : 'border-border hover:border-foreground/50 cursor-pointer'
                      }`}
                    >
                      {s}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Add */}
            <div className="flex gap-3">
              <button
                onClick={handleAdd}
                disabled={adding || outOfStock}
                className="flex-1 bg-foreground text-background py-4 text-sm tracking-widest uppercase hover:bg-foreground/90 transition-colors disabled:opacity-50 cursor-pointer flex items-center justify-center gap-2"
              >
                {adding ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : outOfStock ? (
                  t.productOutOfStock
                ) : (
                  <>
                    <ShoppingBag className="w-4 h-4" />
                    {t.productAddToBag}
                  </>
                )}
              </button>
              <WishlistButton
                productId={product.id}
                className="border border-border hover:border-foreground/50 px-5 flex items-center justify-center"
              />
            </div>

            {/* Bundle & Save -- renders nothing when this product isn't in any active bundle */}
            {bundles.length > 0 && (
              <div className="mt-8">
                <p className="text-xs tracking-widest uppercase text-muted-foreground mb-3">{t.bundleSectionTitle}</p>
                <div className="space-y-4">
                  {bundles.map(bundle => {
                    const regularTotal = bundle.items.reduce((sum, i) => sum + i.products.price * i.quantity, 0)
                    const discountedTotal = bundle.discount_type === 'percentage'
                      ? regularTotal * (1 - bundle.discount_value / 100)
                      : Math.max(0, regularTotal - bundle.discount_value)
                    const otherItems = bundle.items.filter(i => i.product_id !== product.id)

                    return (
                      <div key={bundle.id} className="border border-border p-5">
                        <h3 className="font-display text-lg mb-1">{bundle.name}</h3>
                        {bundle.description && (
                          <p className="text-sm text-foreground/70 font-light mb-4">{bundle.description}</p>
                        )}
                        {otherItems.length > 0 && (
                          <div className="flex flex-wrap gap-3 mb-4">
                            {otherItems.map(i => (
                              <Link
                                key={i.id}
                                to={`/product/${i.products.slug}`}
                                className="flex items-center gap-2 border border-border px-2 py-1.5 hover:border-foreground/50 transition-colors"
                              >
                                <div className="w-10 h-10 bg-muted overflow-hidden shrink-0">
                                  <img src={i.products.image_url || ''} alt={i.products.name} className="w-full h-full object-cover" />
                                </div>
                                <span className="text-xs">
                                  {i.products.name} <span className="text-muted-foreground">× {i.quantity}</span>
                                </span>
                              </Link>
                            ))}
                          </div>
                        )}
                        <div className="flex items-center gap-3 mb-4">
                          <span className="font-display text-xl">{formatPrice(discountedTotal)}</span>
                          {discountedTotal < regularTotal && (
                            <span className="text-sm text-muted-foreground line-through">{formatPrice(regularTotal)}</span>
                          )}
                        </div>
                        <button
                          onClick={() => addBundleToBag(bundle)}
                          disabled={addingBundleId === bundle.id}
                          className="w-full border border-foreground py-3 text-sm tracking-widest uppercase hover:bg-foreground hover:text-background transition-colors disabled:opacity-50 cursor-pointer flex items-center justify-center gap-2"
                        >
                          {addingBundleId === bundle.id ? <Loader2 className="w-4 h-4 animate-spin" /> : t.bundleAddButton}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Back in stock notify -- only when the selected combo actually maps to
                a variant_id to hang the request off; legacy no-variant products have
                nothing to notify against. */}
            {outOfStock && selectedVariant && (
              <div className="mt-4 border border-border p-4">
                {notifyStatus === 'done' ? (
                  <p className="text-sm text-foreground/80">{t.notifySuccess}</p>
                ) : notifyStatus === 'already' ? (
                  <p className="text-sm text-foreground/80">{t.notifyAlready}</p>
                ) : (
                  <form onSubmit={handleNotify} className="space-y-3">
                    <p className="text-xs tracking-widest uppercase text-muted-foreground">{t.notifyTitle}</p>
                    <div className="flex gap-2">
                      <input
                        type="email"
                        required
                        value={notifyEmail}
                        onChange={e => setNotifyEmail(e.target.value)}
                        placeholder={t.notifyEmailPlaceholder}
                        className="flex-1 min-w-0 border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:border-foreground"
                      />
                      <button
                        type="submit"
                        disabled={notifyStatus === 'submitting'}
                        className="border border-foreground px-4 text-xs tracking-widest uppercase hover:bg-foreground hover:text-background transition-colors disabled:opacity-50 cursor-pointer flex items-center justify-center"
                      >
                        {notifyStatus === 'submitting' ? <Loader2 className="w-4 h-4 animate-spin" /> : t.notifyButton}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}

            {/* Meta */}
            <div className="mt-10 pt-8 border-t border-border space-y-4 text-sm">
              <div className="flex items-center gap-3 text-foreground/80">
                <Check className="w-4 h-4 text-foreground/60" />
                <span>{t.productShip1}</span>
              </div>
              <div className="flex items-center gap-3 text-foreground/80">
                <Check className="w-4 h-4 text-foreground/60" />
                <span>{t.productShip2}</span>
              </div>
              <div className="flex items-center gap-3 text-foreground/80">
                <Check className="w-4 h-4 text-foreground/60" />
                <span>{t.productShip3}</span>
              </div>
            </div>

            {/* Description accordion */}
            <div className="mt-10 pt-8 border-t border-border">
              <details className="group">
                <summary className="flex items-center justify-between cursor-pointer list-none py-2">
                  <span className="text-xs tracking-widest uppercase">{t.productAccordion1}</span>
                  <span className="text-lg group-open:rotate-45 transition-transform">+</span>
                </summary>
                <p className="text-sm text-foreground/80 font-light leading-relaxed pt-3 pb-2">
                  {t.productAccordion1Text}
                </p>
              </details>
              <details className="group border-t border-border/60">
                <summary className="flex items-center justify-between cursor-pointer list-none py-4">
                  <span className="text-xs tracking-widest uppercase">{t.productAccordion2}</span>
                  <span className="text-lg group-open:rotate-45 transition-transform">+</span>
                </summary>
                <p className="text-sm text-foreground/80 font-light leading-relaxed pt-2 pb-4">
                  {t.productAccordion2Text}
                </p>
              </details>
              <details className="group border-t border-border/60">
                <summary className="flex items-center justify-between cursor-pointer list-none py-4">
                  <span className="text-xs tracking-widest uppercase">{t.productAccordion3}</span>
                  <span className="text-lg group-open:rotate-45 transition-transform">+</span>
                </summary>
                <p className="text-sm text-foreground/80 font-light leading-relaxed pt-2 pb-4">
                  {t.productAccordion3Text}
                </p>
              </details>
            </div>
          </div>
        </div>

        {/* Reviews */}
        <div className="mt-32">
          <SectionHeading eyebrow={t.reviewsEyebrow} title={t.reviewsTitle} align="between" className="mb-10" />

          {reviews.length === 0 ? (
            <p className="text-sm text-foreground/70 mb-12">{t.reviewsEmpty}</p>
          ) : (
            <div className="space-y-8 mb-12 max-w-2xl">
              {reviews.map(r => (
                <div key={r.id} className="border-b border-border pb-8">
                  <div className="flex items-center gap-3 mb-2">
                    <StarRow rating={r.rating} size="w-3.5 h-3.5" />
                    {r.verified_purchase && (
                      <span className="text-[10px] tracking-widest uppercase text-foreground/60 border border-border px-1.5 py-0.5">
                        {t.reviewsVerifiedBadge}
                      </span>
                    )}
                  </div>
                  {r.title && <h3 className="font-display text-lg mb-1">{r.title}</h3>}
                  {r.body && <p className="text-sm text-foreground/80 font-light leading-relaxed mb-2">{r.body}</p>}
                  <p className="text-xs text-muted-foreground">
                    {reviewerNames.get(r.user_id) || t.reviewsAnonymous}
                    {' · '}
                    {new Date(r.created_at).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-US', {
                      year: 'numeric', month: 'short', day: 'numeric'
                    })}
                  </p>
                </div>
              ))}
            </div>
          )}

          <div className="max-w-2xl">
            {!user ? (
              <p className="text-sm text-foreground/70">
                <Link to="/login" className="border-b border-foreground pb-0.5">{t.reviewsSignInPrompt}</Link>
              </p>
            ) : (
              <form onSubmit={submitReview} className="space-y-4">
                <p className="text-xs tracking-widest uppercase text-muted-foreground">
                  {myReview ? t.reviewsEditTitle : t.reviewsWriteTitle}
                </p>
                <StarRow rating={myRating} size="w-6 h-6" onRate={setMyRating} />
                <input
                  value={myTitle}
                  onChange={e => setMyTitle(e.target.value)}
                  placeholder={t.reviewsTitlePlaceholder}
                  className="w-full border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:border-foreground"
                />
                <textarea
                  value={myBody}
                  onChange={e => setMyBody(e.target.value)}
                  placeholder={t.reviewsBodyPlaceholder}
                  rows={4}
                  className="w-full border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:border-foreground"
                />
                <button
                  type="submit"
                  disabled={submittingReview}
                  className="bg-foreground text-background px-6 py-3 text-sm tracking-widest uppercase hover:bg-foreground/90 transition-colors disabled:opacity-50 cursor-pointer inline-flex items-center gap-2"
                >
                  {submittingReview && <Loader2 className="w-4 h-4 animate-spin" />}
                  {myReview ? t.reviewsUpdate : t.reviewsSubmit}
                </button>
              </form>
            )}
          </div>
        </div>

        {/* Related */}
        {related.length > 0 && (
          <div className="mt-32">
            <SectionHeading eyebrow={t.productAlsoTitle} title={t.productAlsoSubtitle} align="between" className="mb-10" />
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-10">
              {related.map(p => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          </div>
        )}

        {/* Recently viewed */}
        {recentlyViewed.length > 0 && (
          <div className="mt-32">
            <SectionHeading eyebrow={t.recentlyViewedEyebrow} title={t.recentlyViewedTitle} align="between" className="mb-10" />
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-10">
              {recentlyViewed.map(p => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Same card markup the Related and Recently Viewed grids both use.
function ProductCard({ product }: { product: ProductCatalogEntry }) {
  const { formatPrice } = useCurrency()
  return (
    <Link to={`/product/${product.slug}`} className="group block">
      <div className="aspect-square bg-muted overflow-hidden img-zoom">
        <img src={product.image_url || ''} alt={product.name} className="w-full h-full object-cover" />
      </div>
      <h3 className="mt-4 font-display text-lg group-hover:text-muted-foreground transition-colors">{product.name}</h3>
      <p className="text-sm text-muted-foreground mt-1">{formatPrice(Number(product.min_price))}</p>
    </Link>
  )
}
