-- ============================================================
--  BB Brands CRM — Datenbank-Schema (Supabase Postgres)
--  Sauberes Entitäten-Modell: Person / Funnel-Interaktion / Sales getrennt.
--
--  Einmal im Supabase SQL-Editor ausführen (idempotent).
--  Zugriff NUR server-seitig über den Service-Role-Key (RLS an, kein Public-Policy
--  → anon/Client kommt nicht ran). Die Vercel-Functions nutzen den Service-Key.
-- ============================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists citext;      -- case-insensitive E-Mail

-- ---------- updated_at-Trigger ----------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

-- ============================================================
--  contacts — die Person (Dedup-Anker, eine Zeile pro E-Mail)
-- ============================================================
create table if not exists contacts (
  id            uuid primary key default gen_random_uuid(),
  email         citext unique not null,
  name          text,
  phone         text,                 -- normalisiert (E.164) beim Schreiben
  company       text,
  website       text,
  first_seen_at timestamptz not null default now(),
  first_touch   jsonb not null default '{}'::jsonb,  -- utm/referrer der ERSTEN Submission
  consent       jsonb not null default '{}'::jsonb,  -- {contact:bool, newsletter:bool, tracking:bool, ts...}
  tags          text[] not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
drop trigger if exists trg_contacts_updated on contacts;
create trigger trg_contacts_updated before update on contacts
  for each row execute function set_updated_at();

-- ============================================================
--  submissions — append-only, EINE Zeile pro Funnel-Interaktion.
--  Wird NIE überschrieben. Hier liegt die Wahrheit "wer hat wann was
--  in welchem Funnel gemacht" (Profit-Zahlen, Quiz-Antworten, Case-Bewerbung …).
-- ============================================================
create table if not exists submissions (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null references contacts(id) on delete cascade,
  funnel      text not null,          -- profit-rechner | quiz-diagnose | youtube-case
                                       -- | whatsapp-chat | erstgespraech | style-guide
                                       -- | ai-readiness-check | contact-import
  payload     jsonb not null default '{}'::jsonb,   -- funnel-spezifische Daten
  attribution jsonb not null default '{}'::jsonb,   -- utm/referrer/fbc/sid SNAPSHOT zum Zeitpunkt
  ip          text,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_sub_contact on submissions(contact_id, created_at desc);
create index if not exists idx_sub_funnel  on submissions(funnel, created_at desc);

-- ============================================================
--  deals — Sales-Status. Pipeline operiert hierauf, nicht auf Submissions.
--  Ein offener Deal pro Contact (mehrere möglich, aber max. 1 aktiv).
-- ============================================================
create table if not exists deals (
  id             uuid primary key default gen_random_uuid(),
  contact_id     uuid not null references contacts(id) on delete cascade,
  stage          text not null default 'new'
                   check (stage in ('new','qualified','call-booked','call-done',
                                    'proposal','negotiation','won','lost','nurture')),
  value_eur      integer check (value_eur is null or value_eur >= 0),
  next_action    text,
  next_follow_up date,
  disposition    text check (disposition is null or disposition in
                   ('','connected','no-answer','showed','no-show','rescheduled',
                    'interested','not-interested','proposal-sent','closed')),
  lost_reason    text,
  owner          text default 'moritz',
  last_contact   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_deal_contact on deals(contact_id);
create index if not exists idx_deal_stage   on deals(stage);
create index if not exists idx_deal_follow  on deals(next_follow_up);
-- max. ein AKTIVER (nicht won/lost) Deal pro Contact
create unique index if not exists uniq_active_deal_per_contact
  on deals(contact_id) where (stage not in ('won','lost'));
drop trigger if exists trg_deals_updated on deals;
create trigger trg_deals_updated before update on deals
  for each row execute function set_updated_at();

-- ============================================================
--  activities — Timeline (Notizen, Calls, Stage-Wechsel, Dispositions)
-- ============================================================
create table if not exists activities (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid not null references contacts(id) on delete cascade,
  deal_id     uuid references deals(id) on delete set null,
  type        text not null default 'note'
                check (type in ('note','call','stage_change','disposition','system')),
  text        text,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_act_contact on activities(contact_id, created_at desc);

-- ============================================================
--  RLS: an, ohne Public-Policy. Service-Role-Key (server-only) bypasst RLS,
--  anon/Client kommt damit NICHT an die Daten.
-- ============================================================
alter table contacts    enable row level security;
alter table submissions enable row level security;
alter table deals       enable row level security;
alter table activities  enable row level security;
