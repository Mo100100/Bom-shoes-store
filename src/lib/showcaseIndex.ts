// Scroll-to-slide mapping for the homepage showcase (`ShoeShowcase3D`).
//
// Lives here, pure and tested, because the component used to derive the copy
// index and the image position from two different formulas half a slide out of
// phase: `Math.floor(progress * itemCount)` for the title, price and CTA, and
// `|progress * itemCount - i| < 0.5` for the shoe. For roughly half of every
// slide's scroll range the price belonged to a different pair than the shoe on
// screen, the tappable slide was not the visible one, and the last half slide
// of scroll showed nothing at all because `progress * itemCount` runs one full
// slide past the last shoe.

export type ShowcasePosition = {
  /** Continuous position between the first and last slide, 0..itemCount - 1. */
  rawPos: number
  /** The one slide the shopper is looking at. Everything reads this. */
  active: number
}

/**
 * Where the showcase sits for a scroll progress of 0..1. Progress 0 centres
 * the first slide, progress 1 the last, so there is no dead scroll at either
 * end. `itemCount` of 1 (or 0) has nowhere to travel and would divide by zero.
 */
export function showcasePosition(progress: number, itemCount: number): ShowcasePosition {
  if (itemCount <= 1) return { rawPos: 0, active: 0 }
  const clamped = Math.min(1, Math.max(0, progress))
  const rawPos = clamped * (itemCount - 1)
  return { rawPos, active: Math.round(rawPos) }
}

/** Inverse of the above: the scroll progress that centres slide `index`. */
export function showcaseProgressFor(index: number, itemCount: number): number {
  return itemCount <= 1 ? 0 : index / (itemCount - 1)
}
