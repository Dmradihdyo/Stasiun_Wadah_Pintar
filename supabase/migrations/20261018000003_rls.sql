-- Row Level Security, hak akses tabel, dan Realtime.
-- RLS membatasi pembacaan; semua perubahan data transaksi hanya lewat fungsi di migrasi 2.

alter table public.app_config       enable row level security;
alter table public.profiles         enable row level security;
alter table public.containers       enable row level security;
alter table public.stations         enable row level security;
alter table public.devices          enable row level security;
alter table public.station_sessions enable row level security;
alter table public.transactions     enable row level security;
alter table public.loans            enable row level security;
alter table public.device_events    enable row level security;

-- Mulai dari nol: tidak ada hak apa pun untuk anon dan authenticated, lalu diberikan satu per satu.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ---------------------------------------------------------------- app_config
grant select on public.app_config to authenticated;
grant update (max_loan, weight_min, weight_max, loan_days, session_seconds, allowed_domains) on public.app_config to authenticated;
create policy config_read  on public.app_config for select to authenticated using (true);
create policy config_admin on public.app_config for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------- profiles
-- Pengguna hanya boleh mengubah nim dan nama. role/locked hanya lewat SQL admin atau fungsi admin.
grant select on public.profiles to authenticated;
grant update (nim, full_name) on public.profiles to authenticated;
create policy profiles_read   on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------- containers (kode wadah hanya untuk admin)
grant select, insert, update, delete on public.containers to authenticated;
create policy containers_admin on public.containers for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------- stations
grant select, insert, update on public.stations to authenticated;
create policy stations_read  on public.stations for select to authenticated using (true);
create policy stations_admin_i on public.stations for insert to authenticated with check (public.is_admin());
create policy stations_admin_u on public.stations for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------- devices (key_hash tidak pernah terbaca dari browser)
grant select (id, station_id, last_seen, created_at) on public.devices to authenticated;
create policy devices_admin on public.devices for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------- station_sessions, transactions, loans, device_events
grant select on public.station_sessions to authenticated;
create policy sessions_read on public.station_sessions for select to authenticated using (user_id = auth.uid() or public.is_admin());

grant select on public.transactions to authenticated;
create policy tx_read on public.transactions for select to authenticated using (user_id = auth.uid() or public.is_admin());

grant select on public.loans to authenticated;
create policy loans_read on public.loans for select to authenticated using (user_id = auth.uid() or public.is_admin());

grant select on public.device_events to authenticated;
create policy events_admin on public.device_events for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------- hak eksekusi fungsi
-- dipakai oleh kebijakan RLS
grant execute on function public.is_admin()       to authenticated;
-- dipanggil browser pengguna
grant execute on function public.start_session(text)                    to authenticated;
grant execute on function public.touch_session(uuid)                    to authenticated;
grant execute on function public.end_session(uuid)                      to authenticated;
grant execute on function public.request_transaction(uuid, text, uuid)  to authenticated;
grant execute on function public.cancel_transaction(uuid)               to authenticated;
-- dipanggil panel admin (pemeriksaan is_admin() ada di dalam fungsi)
grant execute on function public.admin_set_locked(uuid, boolean)  to authenticated;
grant execute on function public.admin_release_station(text)      to authenticated;
grant execute on function public.admin_force_return(uuid)         to authenticated;
grant execute on function public.admin_create_device(text)        to authenticated;
-- hanya Edge Function (service_role); ESP32 tidak pernah memegang kunci ini
grant execute on function public.expire_stale()                                          to service_role;
grant execute on function public.device_poll(uuid)                                       to service_role;
grant execute on function public.device_report(uuid, uuid, text, numeric, boolean)       to service_role;

-- ---------------------------------------------------------------- Realtime
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.profiles, public.loans, public.transactions, public.station_sessions;
  end if;
end $$;
