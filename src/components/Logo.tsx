import { useState } from 'react'
import { cn } from '@/lib/utils'
import { useStoreSettings } from '@/contexts/StoreSettingsContext'

interface LogoProps {
  size?: number
  className?: string
  showText?: boolean
  /**
   * Also cap the uploaded logo's width at a share of the viewport. For the
   * sticky header only, where the logo shares a 375px row with the menu button
   * and the icon group. The footer and the mobile drawer have the width to
   * spare, so they leave it off and show the mark at full size.
   */
  capToViewport?: boolean
}

// An uploaded logo is constrained by HEIGHT and keeps its natural width, which
// is what a real (wide) logo needs -- forcing it into a square box drew a
// 600x200 mark at 56x19 in a 56px header slot. The width is capped at this
// multiple of the height so a very wide mark cannot push the header nav out of
// place; object-contain letterboxes anything wider than the cap.
const MAX_LOGO_ASPECT = 3
// The extra cap capToViewport asks for: a 375px header has about 110px to
// spare next to the menu button and the icon group.
const MAX_LOGO_VIEWPORT_WIDTH = '30vw'

/**
 * BOM Store monogram logo.
 * "B" inside a thin gold circle, with "BOM STORE" underneath (Latin, in both languages).
 * Renders the admin-uploaded logo (store_settings.logo_url) if one is set,
 * otherwise falls back to this hardcoded SVG monogram.
 */
export default function Logo({ size = 64, className, showText = true, capToViewport = false }: LogoProps) {
  const { logoUrl: fetchedLogoUrl } = useStoreSettings()
  // Keyed by URL, not a bare boolean: the admin can now replace the logo
  // without a page reload, so a broken upload must not keep the monogram
  // showing once a working one lands.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const logoUrl = fetchedLogoUrl === failedUrl ? null : fetchedLogoUrl
  const aspectCap = `${size * MAX_LOGO_ASPECT}px`
  const maxLogoWidth = capToViewport ? `min(${aspectCap}, ${MAX_LOGO_VIEWPORT_WIDTH})` : aspectCap
  const r = size * 0.45
  const cx = size / 2
  const cy = size / 2

  const text = showText && (
    <div
      className="latin-text mt-1 text-center font-display tracking-[0.35em] text-[10px] font-light"
      style={{ color: '#B8860B' }}
    >
      BOM STORE
    </div>
  )

  if (logoUrl) {
    return (
      // No fixed width here, unlike the monogram below: the box is as wide as
      // the logo actually is, so the flex header (and its RTL mirror) lays out
      // around the real mark instead of around 54% of empty space.
      <div className={cn('flex flex-col items-center select-none', className)}>
        <img
          src={logoUrl}
          alt="BOM Store logo"
          style={{ height: size, maxWidth: maxLogoWidth }}
          className="w-auto object-contain"
          onError={() => setFailedUrl(logoUrl)}
        />
        {text}
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col items-center select-none', className)} style={{ width: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        xmlns="http://www.w3.org/2000/svg"
        aria-label="BOM Store logo"
      >
        <defs>
          <linearGradient id="goldGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#D4AF37" />
            <stop offset="50%" stopColor="#F1D27A" />
            <stop offset="100%" stopColor="#B8860B" />
          </linearGradient>
        </defs>
        {/* Outer thin ring */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="url(#goldGradient)"
          strokeWidth={size * 0.012}
        />
        {/* Inner thin ring */}
        <circle
          cx={cx}
          cy={cy}
          r={r - size * 0.04}
          fill="none"
          stroke="url(#goldGradient)"
          strokeWidth={size * 0.006}
          opacity="0.5"
        />
        {/* Monogram letter */}
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="'Cairo', 'Amiri', Georgia, serif"
          fontSize={size * 0.5}
          fontWeight={600}
          fill="url(#goldGradient)"
        >
          B
        </text>
      </svg>
      {text}
    </div>
  )
}
