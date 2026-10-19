# Stasiun Wadah Pintar: Web App (Supabase)

Web App untuk pinjam dan kembalikan wadah makan di kampus: login Google, scan QR stasiun, pinjam, kembalikan, status, riwayat, dan panel admin. Mengikuti **Rangkuman Final** (ESP32 + RFID + Load Cell + Supabase + Google OAuth 2.0). Firebase sudah dihapus seluruhnya.

Frontend: HTML, CSS, dan JavaScript tanpa proses build. Backend: Supabase (PostgreSQL, Auth, RLS, Realtime, Edge Functions).

## Struktur proyek

```
index.html                      halaman tunggal (SPA)
css/app.css
assets/logo.png
js/
  config.js                     URL + anon key Supabase, domain kampus   <- ISI INI
  supabase.js                   klien Supabase
  app.js                        aplikasi pengguna (login, QR, pinjam, kembali, status)
  admin.js                      panel admin
supabase/
  migrations/
    ..._schema.sql              tabel + pembatasan akun kampus
    ..._functions.sql           logika transaksi atomik (sesi, kuota, validasi sensor)
    ..._rls.sql                 RLS, hak akses, Realtime
  functions/
    device-api/                 endpoint ESP32 (autentikasi per-alat)
    send-reminders/             pengingat email harian
docs/protokol-esp32.md          kontrak API untuk firmware
tools/simulate-device.mjs       pengganti ESP32 untuk uji end-to-end
```

## Kesesuaian dengan rangkuman final

| Rangkuman | Implementasi |
|---|---|
| Google OAuth 2.0 + OIDC via Supabase Auth | `signInWithOAuth('google')`, alur PKCE |
| Akun kampus divalidasi di **backend** | trigger `enforce_campus_email` pada `auth.users` menolak domain lain; domain bisa diubah di Admin > Pengaturan |
| Tabel `profiles, containers, transactions, loans, stations, station_sessions, device_events` | persis di migrasi 1 (+ `app_config`, `devices`) |
| RLS | migrasi 3; pengguna hanya melihat data sendiri; kode wadah hanya admin; `role`/`locked` tidak bisa diubah dari browser |
| Satu stasiun, satu sesi aktif, pembuatan **atomik** | `start_session` mengunci baris stasiun + unique index parsial `station_sessions_one_active` |
| Kuota, pinjaman ganda, wadah sesuai pinjaman | dicek di `request_transaction` (saat diminta) dan `device_report` (saat sensor melapor) |
| ID transaksi unik, permintaan ulang aman | `transactions.request_id` unik; fungsi idempoten, laporan ulang dari ESP32 tidak dicatat dua kali |
| Backend menentukan status, bukan sensor | hanya `device_report` yang bisa menandai `success`/`failed` |
| Sesi lepas saat selesai/batal/kedaluwarsa | `end_session`, `cancel_transaction`, `expire_stale`; heartbeat web 15 dtk, kedaluwarsa 60 dtk |
| Autentikasi perangkat terpisah, tanpa `service_role` di ESP32 | kunci alat per stasiun (hash SHA-256 di tabel `devices`), dipakai lewat Edge Function |
| Realtime + cadangan | Realtime pada `transactions, loans, profiles, station_sessions`; polling 3 dtk jika Realtime putus |
| Koneksi putus | web memeriksa status transaksi; ESP32 mengirim ulang `report` dengan `request_id` sama |

## Pemasangan

1. **Proyek Supabase**: buat di https://supabase.com. Catat *Project URL* dan *anon key* (Project Settings > API), isi `js/config.js`.
2. **Database**: jalankan tiga berkas di `supabase/migrations/` **berurutan** lewat SQL Editor, atau `supabase link` lalu `supabase db push`.
3. **Google OAuth**:
   - Google Cloud Console > APIs & Services > Credentials > *OAuth client ID* (Web application). Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`.
   - Supabase > Authentication > Providers > Google: aktifkan, isi Client ID dan Secret.
   - Supabase > Authentication > URL Configuration: *Site URL* = alamat web Anda; tambahkan alamat yang sama (dan `http://localhost:8080` untuk uji lokal) ke *Redirect URLs*.
4. **Domain kampus**: awalnya `trisakti.ac.id` dan `std.trisakti.ac.id`. Ubah di Admin > Pengaturan, atau `update app_config set allowed_domains = array[...]`. Samakan `ALLOWED_DOMAINS` di `js/config.js` (hanya untuk pesan ramah; penegakannya di database). Dokumen lama menyebut `trisakti.id`, pastikan domain yang benar.
5. **Edge Functions** (Supabase CLI):
   ```
   supabase functions deploy device-api --no-verify-jwt
   supabase functions deploy send-reminders --no-verify-jwt
   supabase secrets set CRON_SECRET=<acak panjang> RESEND_API_KEY=<kunci> MAIL_FROM="Wadah Pintar <noreply@domain-anda>"
   ```
   `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY` disediakan otomatis untuk fungsi dan tidak pernah dikirim ke browser atau ESP32.
6. **Hosting** (harus HTTPS karena kamera dan login Google): unggah folder ini ke hosting statis (Netlify, Cloudflare Pages, Vercel, GitHub Pages). Tidak perlu build. Uji lokal: `python3 -m http.server 8080`.
7. **Admin pertama**: login sekali, isi NIM, lalu di SQL Editor:
   ```sql
   update public.profiles set role = 'admin' where email = 'email-anda@trisakti.ac.id';
   ```
   Muat ulang; tombol **Admin** muncul.
8. **Di panel Admin**: tambah **Stasiun** (mis. `ST-01`), cetak QR-nya, **Buat kunci alat** (tampil sekali, simpan di firmware), lalu tambah **Wadah** (kode unik + UID tag RFID).

### Pengingat email (opsional)

Jadwalkan di SQL Editor (aktifkan ekstensi `pg_cron` dan `pg_net` dulu). 01:00 UTC = 08:00 WIB:
```sql
select cron.schedule('pengingat-wadah', '0 1 * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>')
  )
$$);
```
Email dikirim lewat Resend. Untuk mengirim ke domain kampus, domain pengirim Anda perlu diverifikasi di Resend; atau ganti fungsi `sendMail` dengan SMTP/penyedia lain.

## Uji tanpa perangkat keras

Tidak ada mode demo di website. Untuk menguji seluruh alur sebelum ESP32 siap, jalankan pengganti alat dari komputer (Node 18+):
```
DEVICE_URL=https://<project-ref>.supabase.co/functions/v1/device-api DEVICE_KEY=<kunci alat> node tools/simulate-device.mjs
```
Dari HP: login, scan QR stasiun, tekan Pinjam/Kembalikan. Skrip menanyakan UID tag dan berat, lalu melapor ke backend yang sama dengan yang dipakai firmware asli.

## Model data

| Tabel | Isi |
|---|---|
| `profiles` | id (= auth uid), email, full_name, nim, role (`user`/`admin`), locked |
| `containers` | code (unik, hanya admin), rfid_uid (unik), status (`available`/`borrowed`/`maintenance`) |
| `stations` | code (isi QR), name, status |
| `station_sessions` | station, user, status (`active`/`completed`/`cancelled`/`expired`), expires_at |
| `transactions` | request_id (unik), session, station, user, container, type, status (`pending`/`success`/`failed`/`cancelled`/`expired`), reason, weight |
| `loans` | user, container, borrowed_at, due_at, returned_at, penanda email |
| `device_events` | log diagnostik dari alat |
| `devices` | satu kunci (hash) per stasiun, last_seen |
| `app_config` | max_loan (2), weight_min/max (180/220), loan_days (3), session_seconds (60), allowed_domains |

## Yang perlu Anda putuskan atau periksa

- **Lama peminjaman** (`loan_days`, awalnya 3 hari) belum ada di dokumen; ubah di Pengaturan.
- **Berat wadah** 180-220 g berasal dari aturan awal; rangkuman menyatakan rentang final ditentukan dari kalibrasi wadah nyata.
- **Masa sesi** 60 detik tanpa denyut web. Jika jaringan kampus sering putus, naikkan `session_seconds`.
- **Beberapa wadah, satu stasiun**: model saat ini tidak mengikat wadah ke stasiun tertentu. Jika tiap stasiun punya stok sendiri, tambahkan `station_id` pada `containers` (dicatat sebagai perluasan; belum ada di rangkuman).
- Rangkuman menyebut tabel sebagai **rancangan awal**: tambah/ubah kolom lewat migrasi baru, jangan ubah tiga berkas yang sudah dijalankan.
- Firmware ESP32 (Tahap 1 dan 3) belum termasuk; kontrak API ada di `docs/protokol-esp32.md`.
