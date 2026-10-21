-- Pegar en Supabase → SQL Editor → Run.

create table plans (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);

-- Un registro por (fecha, item). item_id '_day' = cierre del día, '_morning' = chequeo de la mañana.
create table logs (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  date date not null,
  item_id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, date, item_id)
);

alter table plans enable row level security;
alter table logs enable row level security;

create policy "solo dueño" on plans for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "solo dueño" on logs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
