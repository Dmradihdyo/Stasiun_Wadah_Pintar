-- Fungsi transaksi atomik. Semua aturan bisnis ada di sini (backend), bukan di browser maupun ESP32.
-- Sensor hanya melaporkan; status berhasil/gagal selalu ditetapkan oleh fungsi-fungsi ini.

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false);
$$;

-- Menandai sesi yang lewat masa berlaku dan transaksi yang menggantung.
create or replace function public.expire_stale()
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.station_sessions set status = 'expired', ended_at = now()
   where status = 'active' and expires_at < now();
  update public.transactions t set status = 'expired', reason = 'session_expired', completed_at = now()
   where t.status = 'pending'
     and exists (select 1 from public.station_sessions s where s.id = t.session_id and s.status <> 'active');
end $$;

-- ------------------------------------------------------------ sesi stasiun (pengguna)
create or replace function public.start_session(p_station text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_st  public.stations;
  v_cfg public.app_config;
  v_s   public.station_sessions;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'unauthenticated'); end if;
  if not exists (select 1 from public.profiles where id = v_uid) then
    return jsonb_build_object('ok', false, 'reason', 'no_profile');
  end if;

  -- Kunci baris stasiun: dua permintaan bersamaan diproses berurutan.
  select * into v_st from public.stations where code = upper(trim(p_station)) for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_st.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'unavailable'); end if;

  select * into v_cfg from public.app_config;
  perform public.expire_stale();

  select * into v_s from public.station_sessions where station_id = v_st.id and status = 'active';
  if found and v_s.user_id <> v_uid then
    return jsonb_build_object('ok', false, 'reason', 'busy');
  end if;

  if found then
    update public.station_sessions set expires_at = now() + make_interval(secs => v_cfg.session_seconds)
     where id = v_s.id returning * into v_s;
  else
    insert into public.station_sessions (station_id, user_id, expires_at)
    values (v_st.id, v_uid, now() + make_interval(secs => v_cfg.session_seconds))
    returning * into v_s;
  end if;
  return jsonb_build_object('ok', true, 'session_id', v_s.id, 'expires_at', v_s.expires_at);
end $$;

-- Denyut dari browser. false = sesi sudah berakhir.
create or replace function public.touch_session(p_session uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_secs int;
begin
  select session_seconds into v_secs from public.app_config;
  update public.station_sessions set expires_at = now() + make_interval(secs => v_secs)
   where id = p_session and user_id = auth.uid() and status = 'active' and expires_at > now();
  return found;
end $$;

create or replace function public.end_session(p_session uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.transactions set status = 'cancelled', reason = 'session_ended', completed_at = now()
   where session_id = p_session and user_id = auth.uid() and status = 'pending';
  update public.station_sessions set status = 'completed', ended_at = now()
   where id = p_session and user_id = auth.uid() and status = 'active';
end $$;

-- ------------------------------------------------------------ permintaan transaksi (pengguna)
-- Idempoten: request_id yang sama mengembalikan transaksi yang sama.
create or replace function public.request_transaction(p_session uuid, p_type text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_s       public.station_sessions;
  v_p       public.profiles;
  v_cfg     public.app_config;
  v_t       public.transactions;
  v_count   int;
  v_overdue boolean;
  v_reason  text;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'unauthenticated'); end if;
  if p_type not in ('borrow', 'return') then return jsonb_build_object('ok', false, 'reason', 'bad_type'); end if;

  select * into v_t from public.transactions where request_id = p_request_id and user_id = v_uid;
  if found then
    return jsonb_build_object('ok', v_t.status in ('pending', 'success'), 'transaction_id', v_t.id,
                              'status', v_t.status, 'reason', v_t.reason);
  end if;

  select * into v_s from public.station_sessions where id = p_session and user_id = v_uid for update;
  if not found or v_s.status <> 'active' or v_s.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'session_invalid');
  end if;

  select * into v_p from public.profiles where id = v_uid for update;
  select * into v_cfg from public.app_config;
  if v_p.nim is null then return jsonb_build_object('ok', false, 'reason', 'profile_incomplete'); end if;

  select count(*), coalesce(bool_or(due_at < now()), false) into v_count, v_overdue
    from public.loans where user_id = v_uid and returned_at is null;

  v_reason := null;
  if p_type = 'borrow' then
    if v_p.locked or v_overdue then v_reason := 'locked';
    elsif v_count >= v_cfg.max_loan then v_reason := 'quota_full';
    elsif not exists (select 1 from public.containers where status = 'available') then v_reason := 'no_stock';
    end if;
  elsif v_count = 0 then
    v_reason := 'no_loan';
  end if;

  -- hanya satu perintah menunggu per sesi
  update public.transactions set status = 'cancelled', reason = 'superseded', completed_at = now()
   where session_id = p_session and status = 'pending';

  insert into public.transactions (request_id, session_id, station_id, user_id, type, status, reason, completed_at)
  values (p_request_id, p_session, v_s.station_id, v_uid, p_type,
          case when v_reason is null then 'pending' else 'failed' end, v_reason,
          case when v_reason is null then null else now() end)
  returning * into v_t;

  update public.station_sessions set expires_at = now() + make_interval(secs => v_cfg.session_seconds) where id = p_session;

  return jsonb_build_object('ok', v_reason is null, 'transaction_id', v_t.id, 'status', v_t.status, 'reason', v_reason);
end $$;

create or replace function public.cancel_transaction(p_tx uuid)
returns void language sql security definer set search_path = public as $$
  update public.transactions set status = 'cancelled', reason = 'user_cancelled', completed_at = now()
   where id = p_tx and user_id = auth.uid() and status = 'pending';
$$;

-- ------------------------------------------------------------ perangkat ESP32 (hanya dipanggil Edge Function)
create or replace function public.device_poll(p_station uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_t public.transactions; v_cfg public.app_config;
begin
  perform public.expire_stale();
  select * into v_cfg from public.app_config;
  select t.* into v_t
    from public.transactions t
    join public.station_sessions s on s.id = t.session_id
   where t.station_id = p_station and t.status = 'pending' and s.status = 'active' and s.expires_at > now()
   order by t.created_at limit 1;
  if not found then
    return jsonb_build_object('has_command', false);
  end if;
  return jsonb_build_object('has_command', true, 'type', v_t.type, 'request_id', v_t.request_id,
                            'weight_min', v_cfg.weight_min, 'weight_max', v_cfg.weight_max);
end $$;

-- Laporan hasil pembacaan sensor. Backend yang memutuskan berhasil atau tidak, dalam satu transaksi database.
create or replace function public.device_report(p_station uuid, p_request_id uuid, p_rfid text, p_weight numeric, p_sensor_ok boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_t       public.transactions;
  v_p       public.profiles;
  v_c       public.containers;
  v_l       public.loans;
  v_cfg     public.app_config;
  v_count   int;
  v_overdue boolean;
  v_reason  text;
  v_ok      boolean;
  v_rfid    text := nullif(trim(coalesce(p_rfid, '')), '');
begin
  select * into v_t from public.transactions where request_id = p_request_id and station_id = p_station for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_request'); end if;

  -- permintaan ulang dari alat (mis. koneksi putus): kembalikan hasil yang sama, jangan proses lagi
  if v_t.status <> 'pending' then
    return jsonb_build_object('ok', v_t.status = 'success', 'status', v_t.status, 'reason', v_t.reason,
                              'weight', v_t.weight, 'duplicate', true);
  end if;

  if not exists (select 1 from public.station_sessions s
                  where s.id = v_t.session_id and s.status = 'active' and s.expires_at > now()) then
    update public.transactions set status = 'expired', reason = 'session_expired', completed_at = now() where id = v_t.id;
    return jsonb_build_object('ok', false, 'status', 'expired', 'reason', 'session_expired');
  end if;

  select * into v_cfg from public.app_config;
  select * into v_p from public.profiles where id = v_t.user_id for update;
  select count(*), coalesce(bool_or(due_at < now()), false) into v_count, v_overdue
    from public.loans where user_id = v_t.user_id and returned_at is null;

  v_reason := null;
  if not coalesce(p_sensor_ok, false) or v_rfid is null then
    v_reason := 'sensor';
  else
    select * into v_c from public.containers where rfid_uid = v_rfid for update;
    if not found then
      v_reason := 'not_registered';
    elsif v_t.type = 'borrow' then
      if v_c.status <> 'available' then v_reason := 'not_available';
      elsif v_p.locked or v_overdue then v_reason := 'locked';
      elsif v_count >= v_cfg.max_loan then v_reason := 'quota_full';
      end if;
    else
      select * into v_l from public.loans where container_id = v_c.id and returned_at is null for update;
      if not found or v_l.user_id <> v_t.user_id then v_reason := 'not_owner';
      elsif p_weight is null then v_reason := 'sensor';
      elsif p_weight < v_cfg.weight_min or p_weight > v_cfg.weight_max then v_reason := 'weight';
      end if;
    end if;
  end if;

  v_ok := v_reason is null;

  if v_ok and v_t.type = 'borrow' then
    insert into public.loans (user_id, container_id, borrow_tx_id, due_at)
    values (v_t.user_id, v_c.id, v_t.id, now() + make_interval(days => v_cfg.loan_days));
    update public.containers set status = 'borrowed' where id = v_c.id;
  elsif v_ok then
    update public.loans set returned_at = now(), return_tx_id = v_t.id, reminded_at = null where id = v_l.id;
    update public.containers set status = 'available' where id = v_c.id;
  end if;

  update public.transactions
     set status = case when v_ok then 'success' else 'failed' end, reason = v_reason,
         container_id = v_c.id, weight = p_weight, completed_at = now()
   where id = v_t.id;

  insert into public.device_events (station_id, tx_id, event, payload)
  values (p_station, v_t.id, 'report',
          jsonb_build_object('rfid', v_rfid, 'weight', p_weight, 'sensor_ok', p_sensor_ok, 'result', coalesce(v_reason, 'ok')));

  return jsonb_build_object('ok', v_ok, 'status', case when v_ok then 'success' else 'failed' end,
                            'reason', v_reason, 'weight', p_weight);
end $$;

-- ------------------------------------------------------------ aksi admin
create or replace function public.admin_set_locked(p_user uuid, p_locked boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.profiles set locked = p_locked where id = p_user;
end $$;

create or replace function public.admin_release_station(p_station text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.transactions set status = 'cancelled', reason = 'admin_release', completed_at = now()
   where status = 'pending' and station_id = (select id from public.stations where code = upper(trim(p_station)));
  update public.station_sessions set status = 'cancelled', ended_at = now()
   where status = 'active' and station_id = (select id from public.stations where code = upper(trim(p_station)));
end $$;

create or replace function public.admin_force_return(p_container uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_l public.loans;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_l from public.loans where container_id = p_container and returned_at is null for update;
  if not found then raise exception 'Wadah tidak sedang dipinjam'; end if;
  insert into public.transactions (request_id, user_id, container_id, type, status, reason, completed_at)
  values (gen_random_uuid(), v_l.user_id, p_container, 'return', 'success', 'admin_force', now());
  update public.loans set returned_at = now() where id = v_l.id;
  update public.containers set status = 'available' where id = p_container;
end $$;

-- Membuat (atau mengganti) kunci alat untuk satu stasiun. Kunci asli hanya dikembalikan sekali.
create or replace function public.admin_create_device(p_station text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_st uuid; v_key text;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  select id into v_st from public.stations where code = upper(trim(p_station));
  if v_st is null then raise exception 'Stasiun tidak ditemukan'; end if;
  v_key := encode(gen_random_bytes(24), 'hex');
  insert into public.devices (station_id, key_hash)
  values (v_st, encode(digest(v_key, 'sha256'), 'hex'))
  on conflict (station_id) do update set key_hash = excluded.key_hash, last_seen = null;
  return v_key;
end $$;
