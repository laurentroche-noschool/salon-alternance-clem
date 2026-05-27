-- ============================================================
-- SCHÉMA SUPABASE — Jobs Dating (à coller dans SQL Editor)
-- ============================================================

-- TABLE: companies
create table if not exists public.companies (
  id                serial primary key,
  nom               text not null,
  "nomAffichage"    text,
  filiere           text,
  "logoFile"        text,
  website           text,
  domain            text,
  secteur           text,
  tagline           text,
  description       text,
  histoire          text,
  valeurs           jsonb,
  missions          jsonb,
  concurrents       jsonb,
  chiffres_cles     text,
  recrutement       text,
  questions_rh      jsonb,
  questions_op      jsonb,
  contact           text,
  cre               text,
  salle             text,
  etage             text,
  "addedLive"       boolean default false,
  created_at        timestamptz default now()
);

-- TABLE: students (candidats positionnés par entreprise)
create table if not exists public.students (
  id          text primary key,
  company_id  integer references public.companies(id) on delete cascade,
  nom         text not null,
  prenom      text,
  formation   text,
  email       text,
  phone       text,
  cre         text,
  spontaneous boolean default false,
  created_at  timestamptz default now()
);

-- TABLE: ratings (décisions entreprises sur candidats)
create table if not exists public.ratings (
  student_id  text references public.students(id) on delete cascade,
  company_id  integer references public.companies(id) on delete cascade,
  met         boolean default false,
  rating      text,
  comment     text default '',
  updated_at  timestamptz default now(),
  primary key (student_id, company_id)
);

-- TABLE: presence (présence entreprises le jour J)
create table if not exists public.presence (
  id          integer primary key references public.companies(id) on delete cascade,
  present     boolean default false,
  nb_personnes integer default 0,
  updated_at  timestamptz default now()
);

-- TABLE: sheet_local (données locales : check-in, notes CRE, postes alternance…)
create table if not exists public.sheet_local (
  key             text primary key,
  checked_in      boolean default false,
  checkin_at      text,
  formation_ciblee text,
  notes_cre       text,
  self_registered boolean default false,
  updated_at      timestamptz default now()
);

-- TABLE: self_registrations (candidatures auto-enregistrées sur place)
create table if not exists public.self_registrations (
  id          text primary key,
  nom         text not null,
  prenom      text,
  email       text,
  telephone   text,
  diplome     text,
  "domainesInteret" text,
  situation   text,
  status      text default 'pending',
  created_at  timestamptz default now()
);

-- ============================================================
-- POLICIES RLS (Row Level Security) — autoriser tout depuis service key
-- ============================================================
alter table public.companies        enable row level security;
alter table public.students         enable row level security;
alter table public.ratings          enable row level security;
alter table public.presence         enable row level security;
alter table public.sheet_local      enable row level security;
alter table public.self_registrations enable row level security;

-- Autoriser toutes les opérations via la service key (backend Node.js)
create policy "allow_all_companies"          on public.companies          for all using (true) with check (true);
create policy "allow_all_students"           on public.students           for all using (true) with check (true);
create policy "allow_all_ratings"            on public.ratings            for all using (true) with check (true);
create policy "allow_all_presence"           on public.presence           for all using (true) with check (true);
create policy "allow_all_sheet_local"        on public.sheet_local        for all using (true) with check (true);
create policy "allow_all_self_registrations" on public.self_registrations for all using (true) with check (true);
