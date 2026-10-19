// Pengganti ESP32 untuk menguji alur end-to-end SEBELUM perangkat keras siap.
// Skrip ini memanggil Edge Function device-api persis seperti firmware: hanya memakai kunci alat, bukan service_role.
//
//   DEVICE_URL=https://<ref>.supabase.co/functions/v1/device-api DEVICE_KEY=<kunci alat> node tools/simulate-device.mjs
//
// Saat pengguna meminta pinjam/kembali dari web, skrip menanyakan UID tag dan berat (seolah dibaca sensor).
import readline from 'node:readline/promises';

const URL_ = process.env.DEVICE_URL, KEY = process.env.DEVICE_KEY;
if (!URL_ || !KEY) { console.error('Set DEVICE_URL dan DEVICE_KEY.'); process.exit(1); }
const rl = readline.createInterface({input: process.stdin, output: process.stdout});
const call = async body => {
  const r = await fetch(URL_, {method: 'POST', headers: {'content-type': 'application/json', 'x-device-key': KEY}, body: JSON.stringify(body)});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j)}`);
  return j;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('Simulator alat berjalan. Menunggu perintah dari web (Ctrl+C untuk berhenti)...');
let lastAsked = '';
for (;;) {
  try {
    const c = await call({action: 'poll'});
    if (c.has_command && c.request_id !== lastAsked) {
      lastAsked = c.request_id;
      console.log(`\n>> Perintah: ${c.type === 'borrow' ? 'PINJAM' : 'KEMBALIKAN'} (berat valid ${c.weight_min}-${c.weight_max} g). Pintu dianggap terbuka.`);
      await call({action: 'event', event: 'door_open', payload: {request_id: c.request_id}});
      const rfid = (await rl.question('UID tag RFID yang terbaca (kosong = tidak terbaca): ')).trim();
      const w = (await rl.question('Berat terukur (g, kosong = sensor gagal): ')).trim();
      const res = await call({action: 'report', request_id: c.request_id, rfid: rfid || null, weight: w === '' ? null : Number(w), sensor_ok: rfid !== '' && w !== ''});
      console.log('<< Hasil backend:', res.ok ? 'BERHASIL' : `GAGAL (${res.reason})`, '| pintu', res.ok ? 'ditutup, buzzer sukses' : 'tetap aman, buzzer error');
    }
  } catch (e) { console.error('Error:', e.message); }
  await sleep(2000);
}
