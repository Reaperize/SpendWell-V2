-- SpendWell — Supabase schema.
-- Run this once in your Supabase project: Dashboard -> SQL Editor -> New query -> paste -> Run.
--
-- One row per user holding their full app state as JSONB. Row Level Security
-- guarantees a user can only ever read/write their own row — even with the
-- public anon key, the database enforces isolation server-side.

create table if not exists public.user_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  state      jsonb not null,
  rev        bigint not null default 1,          -- optimistic concurrency counter
  updated_at timestamptz not null default now()
);

alter table public.user_state enable row level security;

create policy "users can read own state"
  on public.user_state for select
  using (auth.uid() = user_id);

create policy "users can insert own state"
  on public.user_state for insert
  with check (auth.uid() = user_id);

create policy "users can update own state"
  on public.user_state for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "users can delete own state"
  on public.user_state for delete
  using (auth.uid() = user_id);

-- Defense in depth: anonymous (signed-out) clients get no access at all.
revoke all on public.user_state from anon;
