-- The homepage now renders the `testimonials` table, which until today only
-- the admin dashboard read.
--
-- Seeded demo testimonials, from 20260709000000. Three invented customers
-- praising Goodyear-welted lifetime boots, for a store that resells Nike,
-- Adidas and Prada and makes nothing. They were harmless while nothing read
-- the table; the homepage reads it now, so they stop being public.
--
-- Deactivated rather than deleted, and matched on the exact seeded quote so a
-- row the owner has since rewritten keeps whatever they wrote. The section
-- renders nothing at all until real testimonials are added in the dashboard.
update public.testimonials
set active = false
where quote_en in (
  'The most comfortable pair of boots I''ve owned. Three years in and they''ve only gotten better with age.',
  'You can feel the difference the moment you put them on. Worth every pound.',
  'Ordered twice already. The Goodyear welt means these will genuinely last a lifetime.'
);
