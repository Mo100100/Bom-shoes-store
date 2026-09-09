-- Switches on the two homepage sections that were built, filled in and then
-- left disabled.
--
-- Flags only. No owner-authored copy is touched: the hero already holds the
-- store's own headline, subtitle and CTAs, and the brand bar draws its 22
-- brands from the `brands` table rather than from site_content.

-- Hero: the page had no <h1>, no value proposition and no entry point above
-- the fold while this was false.
-- Brand bar (`categories_strip` is its historic key): brand is the primary
-- shopping axis for a multi-brand shoe store, and its row holds nothing but
-- this flag.
update public.site_content
set value = value || '{"enabled": true}'::jsonb
where key in ('hero', 'categories_strip');
