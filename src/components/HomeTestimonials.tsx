import { useEffect, useState } from 'react'
import { Star } from 'lucide-react'
import { supabase, Testimonial } from '@/lib/supabase'
import { useT, useLanguage } from '@/contexts/LanguageContext'
import SectionHeading from '@/components/SectionHeading'

// The storefront half of the admin's Testimonials editor, which until now
// wrote to a table nothing read.
//
// The section hides itself when there is nothing active to show, so the owner
// can empty it from the dashboard without leaving a headed, empty box on the
// homepage. A failed read hides it the same way, deliberately: there is no
// "no testimonials yet" empty state here for a customer to misread as broken,
// and a homepage must not grow an error panel because an optional section
// could not load.
export default function HomeTestimonials() {
  const t = useT()
  const { lang } = useLanguage()
  const [rows, setRows] = useState<Testimonial[]>([])

  useEffect(() => {
    let cancelled = false
    // RLS already restricts the anonymous read to active = true.
    supabase.from('testimonials').select('*').order('position').limit(6)
      .then(({ data }) => { if (!cancelled) setRows(data || []) })
    return () => { cancelled = true }
  }, [])

  if (rows.length === 0) return null

  return (
    <section className="bg-cream px-6 lg:px-8 py-16 lg:py-20">
      <div className="max-w-[1320px] mx-auto">
        <SectionHeading eyebrow={t.homeTestimonialsEyebrow} title={t.homeTestimonialsTitle} className="mb-10" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(r => (
            <figure key={r.id} className="bg-background border border-border rounded-[14px] p-6 flex flex-col gap-4">
              {r.rating != null && (
                <div className="flex text-[#B8860B]" aria-label={t.homeTestimonialRating(r.rating)}>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} className="w-3.5 h-3.5" fill={i < r.rating! ? 'currentColor' : 'none'} strokeWidth={1.5} />
                  ))}
                </div>
              )}
              {/* The owner writes both languages in the dashboard; fall back to
                  the other one rather than dropping the quote entirely. */}
              <blockquote className="text-[15px] leading-relaxed text-foreground/90">
                {(lang === 'ar' ? r.quote_ar || r.quote_en : r.quote_en || r.quote_ar)}
              </blockquote>
              <figcaption className="flex items-center gap-3 mt-auto">
                {r.avatar_url && (
                  <img src={r.avatar_url} alt="" loading="lazy" className="w-10 h-10 rounded-full object-cover bg-muted" />
                )}
                <span className="flex flex-col">
                  <span className="text-[13px] font-semibold">{r.author_name}</span>
                  {r.author_title && <span className="text-xs text-muted-foreground">{r.author_title}</span>}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  )
}
