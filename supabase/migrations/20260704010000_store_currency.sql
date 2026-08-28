-- Formerly an admin-configurable DISPLAY currency for the storefront. The
-- admin selector that wrote this column was removed (checkout-audit-remediation
-- Task 9): there was no FX conversion behind it, so a non-EGP choice showed
-- shoppers one number and charged them another. Payment is always settled in
-- EGP by Kashier (see supabase/functions/create-order) and the storefront now
-- always displays EGP too, regardless of this column's value. The column is
-- left in place rather than dropped -- nothing reads or writes it anymore,
-- but dropping a column needs an explicit ask this task didn't have.
alter table public.store_settings
  add column if not exists currency text not null default 'EGP';
