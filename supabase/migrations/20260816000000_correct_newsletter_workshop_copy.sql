-- The footer newsletter block renders site_content.newsletter on EVERY page,
-- and its subtitle still carries the seeded line from 20260709000000:
-- "the occasional letter from the workshop" / "ورسائل بين الحين والآخر من الورشة".
--
-- BOM Store is a multi-brand reseller of Nike, Adidas, Prada and Balenciaga.
-- There is no workshop. The same manufacturing fiction was already removed
-- from the translation defaults; this row overrides those defaults, so the
-- customer still reads it. The Arabic seed also used "وصولات جديدة، إعادة
-- تخزين", which reads as a literal translation rather than as the Egyptian
-- copy the rest of the storefront is written in.
--
-- The new values are byte-identical to the homeNewsletterDesc defaults in
-- src/lib/translations.ts, so the footer reads the same whether the row is
-- present or not.
--
-- Guarded, not unconditional: the `where` requires BOTH subtitles to still be
-- exactly the seeded text. If the owner has edited either one in the admin
-- between now and deploy, no row matches and their wording is left alone. It
-- is also what makes this idempotent -- after the first run the subtitles no
-- longer equal the seed, so a re-run matches zero rows and writes nothing.
--
-- `value || jsonb_build_object(...)` replaces only these two keys and carries
-- every other key in the blob through untouched, including title_en, title_ar
-- and the `enabled` flag the admin added after the seed.
update public.site_content
set
  value = value || jsonb_build_object(
    'subtitle_en', 'New arrivals and restocks, straight to your inbox. Nothing else.',
    'subtitle_ar', 'المنتجات الجديدة والمقاسات اللي بترجع، على بريدك مباشرة. ولا حاجة تانية.'
  ),
  updated_at = now()
where key = 'newsletter'
  and value->>'subtitle_en' = 'New arrivals, restocks, and the occasional letter from the workshop.'
  and value->>'subtitle_ar' = 'وصولات جديدة، إعادة تخزين، ورسائل بين الحين والآخر من الورشة.';
