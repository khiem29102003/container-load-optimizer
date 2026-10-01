create table if not exists public.loading_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null default 'Dự án mới' check (char_length(name) between 1 and 120),
  container jsonb not null check (jsonb_typeof(container) = 'object'),
  cargo jsonb not null default '[]'::jsonb check (jsonb_typeof(cargo) = 'array'),
  plan jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists loading_projects_owner_updated_idx
  on public.loading_projects (owner_id, updated_at desc);

alter table public.loading_projects enable row level security;

drop policy if exists "Owners can manage their loading projects" on public.loading_projects;
create policy "Owners can manage their loading projects"
  on public.loading_projects
  for all
  to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.loading_projects to authenticated;

create or replace function public.set_loading_project_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_loading_project_updated_at on public.loading_projects;
create trigger set_loading_project_updated_at
  before update on public.loading_projects
  for each row
  execute function public.set_loading_project_updated_at();