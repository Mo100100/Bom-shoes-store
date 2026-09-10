-- The homepage now renders the `testimonials` table, which until today only
-- the admin dashboard read.
--
-- Seeded demo testimonials, from 20260709000000. Three invented customers
-- praising Goodyear-welted lifetime boots, for a store that resells Nike,
-- Adidas and Prada and makes nothing. They were harmless while nothing read
-- the table; the homepage reads it now, so they stop being public.
--
-- Deactivated rather than deleted, and matched on BOTH seeded quotes so a row
-- the owner has since rewritten keeps whatever they wrote. English alone was
-- not enough: on an Arabic-first store rewriting only the Arabic is the more
-- likely edit, and such a row still matched and still got deactivated. A row
-- whose Arabic was cleared to null does not match either, which is the same
-- conservative answer. The section renders nothing at all until real
-- testimonials are added in the dashboard.
set local lock_timeout = '3s';

update public.testimonials
set active = false
where (quote_en, quote_ar) in (
  ('The most comfortable pair of boots I''ve owned. Three years in and they''ve only gotten better with age.',
   'أفضل زوج بوت امتلكته على الإطلاق. مضى ثلاث سنوات وهو يزداد جمالا مع الوقت.'),
  ('You can feel the difference the moment you put them on. Worth every pound.',
   'تشعر بالفرق من اللحظة الأولى. تستحق كل جنيه.'),
  ('Ordered twice already. The Goodyear welt means these will genuinely last a lifetime.',
   'طلبت مرتين بالفعل. الخياطة بطريقة Goodyear تعني أنها ستدوم فعلا مدى الحياة.')
);
