-- Spotlight Quiz: run this once in Supabase (SQL Editor > New query > Run).
-- One table holds everything the game saves: leaderboards, today's questions and player profiles.
create table if not exists public.kv (
  path text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
-- Lock it down: only the game server (using the secret/service_role key) can read or write it.
alter table public.kv enable row level security;
