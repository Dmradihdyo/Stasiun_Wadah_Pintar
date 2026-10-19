-- Stasiun Wadah Pintar: skema database (Supabase PostgreSQL)
-- Tabel mengikuti rancangan di rangkuman final: profiles, containers, loans, transactions,
-- stations, station_sessions, device_events (+ app_config dan devices untuk autentikasi alat).

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- pengaturan
create table public.app_config (
  id               boolean primary key default true check (id),   -- hanya satu baris
  max_loan         int     not null default 2   check (max_loan >= 1),
  weight_min       numeric not null default 180 check (weight_min >= 0),
  weight_max       numeric not null default 220,
  loan_days        int     not null default 3   check (loan_days >= 1),
  session_seconds  int     not null default 60  check (session_seconds between 20 and 600),
  allowed_domains  text[]  not null default array['trisakti.ac.id', 'std.trisakti.ac.id'],
  constraint weight_range check (weight_min <= weight_max)
);
insert into public.app_config default values;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text not null default '',
  nim         text check (nim is null or nim ~ '^[A-Za-z0-9]{5,20}$'),
  role        text not null default 'user' check (role in ('user', 'admin')),
  locked      boolean not null default false,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- containers
create table public.containers (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,           -- kode unik, hanya terlihat admin
  rfid_uid    text not null unique,           -- UID tag RFID
  status      text not null default 'available' check (status in ('available', 'borrowed', 'maintenance')),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- stations
create table public.stations (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,           -- mis. ST-01 (isi QR)
  name        text not null,
  status      text not null default 'active' check (status in ('active', 'maintenance')),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- devices (autentikasi ESP32)
create table public.devices (
  id          uuid primary key default gen_random_uuid(),
  station_id  uuid not null unique references public.stations (id) on delete cascade,
  key_hash    text not null,                  -- SHA-256 dari kunci alat; kunci asli tidak disimpan
  last_seen   timestamptz,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- station_sessions
create table public.station_sessions (
  id          uuid primary key default gen_random_uuid(),
  station_id  uuid not null references public.stations (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  status      text not null default 'active' check (status in ('active', 'completed', 'cancelled', 'expired')),
  started_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  ended_at    timestamptz
);
-- Jaminan atomik: satu stasiun hanya boleh punya satu sesi aktif.
create unique index station_sessions_one_active on public.station_sessions (station_id) where status = 'active';
create index station_sessions_user on public.station_sessions (user_id);

-- ---------------------------------------------------------------- transactions
create table public.transactions (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null unique,         -- ID transaksi unik: permintaan ulang tidak tercatat dua kali
  session_id    uuid references public.station_sessions (id) on delete set null,
  station_id    uuid references public.stations (id) on delete set null,
  user_id       uuid not null references public.profiles (id),
  container_id  uuid references public.containers (id),
  type          text not null check (type in ('borrow', 'return')),
  status        text not null default 'pending' check (status in ('pending', 'success', 'failed', 'cancelled', 'expired')),
  reason        text,
  weight        numeric,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);
create index transactions_user on public.transactions (user_id, created_at desc);
create index transactions_station_pending on public.transactions (station_id) where status = 'pending';
create index transactions_created on public.transactions (created_at desc);

-- ---------------------------------------------------------------- loans
create table public.loans (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles (id),
  container_id   uuid not null references public.containers (id),
  borrow_tx_id   uuid references public.transactions (id),
  return_tx_id   uuid references public.transactions (id),
  borrowed_at    timestamptz not null default now(),
  due_at         timestamptz not null,
  returned_at    timestamptz,
  reminded_at    timestamptz,
  late_mailed_at timestamptz
);
-- Satu wadah hanya boleh punya satu pinjaman aktif.
create unique index loans_one_active_per_container on public.loans (container_id) where returned_at is null;
create index loans_active_user on public.loans (user_id) where returned_at is null;

-- ---------------------------------------------------------------- device_events
create table public.device_events (
  id          bigint generated always as identity primary key,
  station_id  uuid references public.stations (id) on delete cascade,
  tx_id       uuid references public.transactions (id) on delete set null,
  event       text not null,
  payload     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index device_events_station on public.device_events (station_id, created_at desc);

-- ---------------------------------------------------------------- pembatasan akun kampus (di database)
create or replace function public.email_allowed(p_email text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.app_config c
    where lower(split_part(coalesce(p_email, ''), '@', 2)) in (select lower(d) from unnest(c.allowed_domains) d)
  );
$$;

-- Menolak pendaftaran akun di luar domain kampus (login Google dengan akun lain akan gagal).
create or replace function public.enforce_campus_email()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.email_allowed(new.email) then
    raise exception 'Hanya akun email kampus yang diizinkan' using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email,
          coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger a_enforce_campus_email before insert on auth.users
  for each row execute function public.enforce_campus_email();
create trigger b_create_profile after insert on auth.users
  for each row execute function public.handle_new_user();
