# Protokol ESP32 ke backend

ESP32 **tidak** berbicara langsung dengan database dan **tidak** memegang `service_role` key. Ia hanya memanggil satu Edge Function, `device-api`, dengan **kunci alat** per stasiun. Backend yang memeriksa sesi, pemilik pinjaman, kuota, berat, lalu menetapkan hasil.

- URL: `https://<project-ref>.supabase.co/functions/v1/device-api`
- Metode: `POST`, `Content-Type: application/json`
- Header wajib: `x-device-key: <kunci alat>` (dibuat di Admin > Stasiun > Buat kunci alat, tampil sekali)
- Respons `401` = kunci salah/diganti. Simpan kunci di NVS/flash, bukan hard-code di repo publik.

## Alur satu transaksi

1. Pengguna login, scan QR, menekan Pinjam/Kembalikan di web. Backend membuat transaksi `pending` untuk sesi yang aktif.
2. ESP32 melakukan `poll` tiap 1-2 detik. Jika `has_command: true`, buka pintu (servo) dan mulai membaca sensor.
3. Setelah RFID dan berat **stabil** (baca berulang), kirim `report`.
4. Tunggu respons. Hanya jika `ok: true` tutup pintu (saat jalur bebas) dan bunyikan buzzer sukses. Jika `ok: false`, pintu tetap aman dan buzzer error; pengguna bisa mencoba lagi dari web.
5. Jika koneksi putus sebelum respons diterima, **kirim ulang `report` dengan `request_id` yang sama**. Backend idempoten: tidak akan mencatat dua kali dan mengembalikan hasil yang sama (`duplicate: true`).

## `poll`

```json
{ "action": "poll" }
```
Respons:
```json
{ "has_command": false }
{ "has_command": true, "type": "borrow" | "return", "request_id": "uuid", "weight_min": 180, "weight_max": 220 }
```

## `report`

```json
{ "action": "report", "request_id": "uuid dari poll", "rfid": "AA01", "weight": 195.4, "sensor_ok": true }
```
- `rfid`: UID tag wadah yang diambil (pinjam) atau diletakkan (kembali). `null` jika tidak terbaca.
- `weight`: gram, setelah stabil. Untuk pinjam boleh `null`.
- `sensor_ok`: `false` jika pembacaan gagal/tidak stabil.

Respons:
```json
{ "ok": true,  "status": "success", "reason": null, "weight": 195.4 }
{ "ok": false, "status": "failed",  "reason": "weight" }
```
`reason`: `sensor`, `not_registered`, `not_available` (pinjam: wadah tidak tersedia), `locked`, `quota_full`, `not_owner`, `weight`, `session_expired`, `unknown_request`.

## `event` (diagnostik, opsional)

```json
{ "action": "event", "event": "door_open", "payload": { "any": "json" } }
```
Tersimpan di `device_events` (terlihat admin) untuk pemecahan masalah: kalibrasi load cell, tag hilang sesaat, servo macet, dll.

## Catatan firmware (dari rangkuman final)

- RFID: baca berulang dan cek kestabilan; hilangnya sinyal sesaat bukan bukti wadah diambil.
- Load cell: kalibrasi dengan wadah nyata; rentang valid diatur di Admin > Pengaturan (dikirim lewat `poll`).
- Servo: jangan menutup saat ada tangan/wadah di jalur gerak.
- Heartbeat: setiap panggilan `poll` menandai alat *online* (terlihat di Admin > Stasiun).
- Tanpa perangkat keras, uji alurnya dengan `node tools/simulate-device.mjs` (lihat README).
