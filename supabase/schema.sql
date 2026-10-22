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

-- DEPRECADA: catálogo de videos por usuario (v1). Ver exercise_catalog.
-- Los rechazos de videos van en logs con item_id '_video:<id>' (así funcionan sin señal).
create table catalogs (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table catalogs enable row level security;
create policy "solo dueño" on catalogs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Catálogo de ejercicios compartido (v2, una sola fila). Todos los usuarios lo leen; nadie lo escribe desde la app:
-- lo amplía el agente por MCP. Reemplaza a "catalogs" (deprecada, sin uso en la app).
create table exercise_catalog (
  id smallint primary key default 1 check (id = 1),
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table exercise_catalog enable row level security;
create policy "leer" on exercise_catalog for select to authenticated using (true);
