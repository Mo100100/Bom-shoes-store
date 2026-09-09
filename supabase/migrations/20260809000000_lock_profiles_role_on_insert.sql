-- Close the admin privilege-escalation hole on profiles INSERT.
--
-- 20260703235959_base_schema.sql grants every signed-in user
-- `for insert with check (id = auth.uid())` on public.profiles, with NO
-- restriction on the role column, and 20260704006000_prevent_self_role_change
-- only guards UPDATE. AuthContext.tsx creates the profile row from the browser
-- on signup, so any customer could sign up and then
-- POST /rest/v1/profiles {"id":"<own uid>","email":"...","role":"admin"}
-- and pass every admin-gated RLS policy in the schema plus is_admin() and
-- admin_update_order_status(): all orders, every customer name, phone and
-- address, price changes, order cancellation.
--
-- Two layers close it, because a policy alone is easy for a later migration to
-- widen by accident:
--   1. The existing prevent_self_role_change() trigger function is extended to
--      cover INSERT and forces the role. Extending it rather than adding a
--      sibling keeps one function answering one question: "a user never picks
--      their own role." Its UPDATE behavior is unchanged.
--   2. The INSERT policy's WITH CHECK is tightened to match. Postgres applies
--      WITH CHECK to the row as rewritten by BEFORE ROW triggers, so layer 1
--      always satisfies layer 2 and a normal signup cannot be refused by it.
--
-- Existing admins are audited and printed at the end, never demoted. The
-- owner's own account is an admin and this migration cannot tell it apart from
-- an intruder.

-- Both statements below that touch the profiles table itself (create trigger,
-- drop/create policy) take ACCESS EXCLUSIVE on it, and profiles is read on
-- every page load. Fail fast rather than queueing behind a long reader and
-- stalling the site while every later query piles up on the lock.
set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. Extend the role guard to INSERT.
--
-- INSERT forces the role instead of raising: a signup must never fail. Client
-- bundles already sitting in customers' browsers still send role: 'customer',
-- and forcing normalizes those silently, while a hand-crafted role: 'admin'
-- is written as 'customer' rather than blowing up mid-signup.
--
-- The INSERT branch forces the role in exactly one case: a caller with a user
-- JWT inserting a row whose id is their own. Every other insert is a
-- pass-through, deliberately:
--   * auth.uid() is null for service-role/backend calls that carry no user JWT
--     (edge functions, admin scripts, the SQL editor). Those stay unrestricted,
--     exactly as the UPDATE branch has always treated them, so the owner can
--     still create or promote an admin from the Supabase dashboard.
--   * A signed-in caller inserting a row for a DIFFERENT id is left to the
--     policy, which refuses it outright (id = auth.uid()). Forcing the role
--     there would silently rewrite a row that should not exist at all, and
--     would pre-empt any future admin-creates-a-user flow that is added with
--     its own policy. There is no such flow today.
-- ---------------------------------------------------------------------------
create or replace function public.prevent_self_role_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return NEW;
  end if;

  if TG_OP = 'INSERT' then
    -- 'customer' is the profiles.role column default and one of the two values
    -- its check constraint allows.
    if auth.uid() = NEW.id then
      NEW.role := 'customer';
    end if;
    return NEW;
  end if;

  if auth.uid() = OLD.id and NEW.role is distinct from OLD.role then
    raise exception 'You cannot change your own role.';
  end if;
  return NEW;
end;
$$;

comment on function public.prevent_self_role_change() is
  'On UPDATE: blocks a profiles.role change where the caller is changing their own row. On INSERT: forces role to ''customer'' when the caller is creating their own row, so the browser-side signup insert cannot self-promote to admin. Service-role calls (auth.uid() is null) are not restricted.';

-- `create or replace function` keeps the ACL from
-- 20260704009002_harden_function_grants.sql, but re-revoking is idempotent and
-- keeps this file correct on a from-scratch run. The trigger fires regardless
-- of EXECUTE grants, so this only closes the /rest/v1/rpc surface.
revoke execute on function public.prevent_self_role_change() from public, anon, authenticated;

drop trigger if exists prevent_self_role_insert on public.profiles;
create trigger prevent_self_role_insert
  before insert on public.profiles
  for each row execute function public.prevent_self_role_change();

-- ---------------------------------------------------------------------------
-- 2. Tighten the INSERT policy to match.
--
-- Same rule stated declaratively, so the hole stays shut even if the trigger
-- is ever dropped. All of it happens inside this migration's transaction, so
-- there is no window where profiles has no INSERT policy.
--
-- The old policy is found by ENUMERATION, not by name. 20260703235959 is a
-- reconstruction of tables that already existed in the original project
-- (see its header), so the live policy's name is an assumption, and
-- `drop policy if exists "<guessed name>"` would drop nothing, raise nothing,
-- and leave the permissive old policy OR'd alongside the new one: layer 2
-- silently defeated, with no diagnostic. Dropping whatever is actually there
-- removes the assumption.
--
-- Policies with cmd = 'ALL' also admit INSERT but carry SELECT/UPDATE/DELETE
-- rules too, so dropping one would be destructive. None exists on profiles
-- today; the post-condition below counts them and fails the migration loudly
-- if that ever changes, rather than shipping a false sense of safety.
-- ---------------------------------------------------------------------------
do $insert_policy$
declare
  v_name text;
  v_dropped text;
  v_admitting int;
begin
  for v_name in
    select policyname
    from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and cmd = 'INSERT'
    order by policyname
  loop
    execute format('drop policy %I on public.profiles', v_name);
    v_dropped := concat_ws(', ', v_dropped, v_name);
  end loop;

  raise notice 'profiles INSERT policies replaced: %', coalesce(v_dropped, '(none existed)');

  create policy "Users can insert their own profile"
    on public.profiles for insert
    with check (id = auth.uid() and role = 'customer');

  select count(*)
  into v_admitting
  from pg_policies
  where schemaname = 'public' and tablename = 'profiles' and cmd in ('INSERT', 'ALL');

  if v_admitting <> 1 then
    raise exception 'expected exactly 1 policy admitting INSERT on public.profiles, found %. Permissive policies are OR''d, so a second one would re-open the role hole. Inspect pg_policies and re-run.', v_admitting;
  end if;
end;
$insert_policy$;

-- ---------------------------------------------------------------------------
-- 3. Audit the live data. Report only, never demote.
--
-- Anyone who already exploited the hole holds a real admin row that looks
-- exactly like the owner's. Print the count and the emails so the owner can
-- check the list by eye and revoke by hand from the Supabase dashboard.
-- ---------------------------------------------------------------------------
do $audit$
declare
  v_count int;
  v_admins text;
begin
  select count(*), string_agg(coalesce(p.email, '(no email) ' || p.id::text), ', ' order by p.created_at)
  into v_count, v_admins
  from public.profiles p
  where p.role = 'admin';

  raise notice 'profiles holding role = admin: %', v_count;

  if v_count > 0 then
    raise notice 'admin accounts (review by eye, nothing was demoted): %', v_admins;
    raise notice 'any account here that is not yours was able to self-promote through the hole this migration just closed. Demote it by hand with: update public.profiles set role = ''customer'' where email = ''...'';';
  end if;
end;
$audit$;
