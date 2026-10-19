// Panel admin: wadah (kode unik + UID RFID), pengguna, transaksi, stasiun (QR + kunci alat), pengaturan.
// Semua akses dibatasi RLS (hanya profiles.role = 'admin'); aksi sensitif memakai fungsi database.
export function mount(S, sb) {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const dt = t => t ? new Date(t).toLocaleDateString('id-ID', {day: 'numeric', month: 'short', year: 'numeric'}) : '-';
  const tm = t => t ? new Date(t).toLocaleString('id-ID', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}) : '-';
  const ok = async p => { const {data, error} = await p; if (error) throw error; return data; };
  const one = x => Array.isArray(x) ? x[0] : x;
  const late = l => !!l.due_at && new Date(l.due_at).getTime() < Date.now();
  const L = {ringkasan: 'Ringkasan', wadah: 'Wadah', pengguna: 'Pengguna', transaksi: 'Transaksi', stasiun: 'Stasiun', pengaturan: 'Pengaturan'};
  const REASON = {
    not_registered: 'Wadah tidak terdaftar', not_available: 'Wadah tidak tersedia', weight: 'Berat tidak sesuai', not_owner: 'Bukan wadah pengguna',
    sensor: 'Sensor gagal', quota_full: 'Kuota penuh', locked: 'Kuota dikunci', no_stock: 'Stok habis', no_loan: 'Tidak ada pinjaman',
    session_expired: 'Sesi berakhir', session_ended: 'Sesi dilepas', user_cancelled: 'Dibatalkan pengguna', superseded: 'Diganti permintaan baru',
    admin_force: 'Dikembalikan admin', admin_release: 'Dibebaskan admin'
  };
  const TXSEL = '*, profiles(full_name), containers(code), stations(code)';
  let cur = 'ringkasan';

  const app = $('#app');
  app.dataset.v = 'admin';
  app.innerHTML = `<div class="adm"><nav class="nav" aria-label="Menu admin">${Object.entries(L).map(([k, v]) => `<button data-t="${k}">${v}</button>`).join('')}<a href="#">Kembali ke aplikasi</a></nav><section class="card" id="pane"></section></div>`;
  const pane = $('#pane');

  const result = t => t.status === 'success' ? '<span class="pl">Berhasil</span>'
    : t.status === 'pending' ? '<span class="pl y">Menunggu</span>'
    : `<span class="pl r">${esc(REASON[t.reason] || t.reason || t.status)}</span>`;
  const txTable = tx => `<div class="tw"><table><thead><tr><th>Waktu</th><th>Pengguna</th><th>Wadah</th><th>Jenis</th><th>Stasiun</th><th>Hasil</th></tr></thead><tbody>${tx.map(t => `<tr><td>${tm(t.created_at)}</td><td>${esc((one(t.profiles) || {}).full_name)}</td><td><b>${esc((one(t.containers) || {}).code || '-')}</b></td><td>${t.type === 'borrow' ? 'Pinjam' : 'Kembalikan'}</td><td>${esc((one(t.stations) || {}).code || '-')}</td><td>${result(t)}</td></tr>`).join('') || '<tr><td colspan="6">Belum ada transaksi.</td></tr>'}</tbody></table></div>`;

  const T = {
    async ringkasan() {
      const [cs, loans, users, tx] = await Promise.all([
        ok(sb.from('containers').select('id,status')),
        ok(sb.from('loans').select('id,due_at').is('returned_at', null)),
        countUsers(),
        ok(sb.from('transactions').select(TXSEL).order('created_at', {ascending: false}).limit(8))
      ]);
      const st = [['Total wadah', cs.length], ['Tersedia', cs.filter(c => c.status === 'available').length], ['Dipinjam', loans.length], ['Terlambat', loans.filter(late).length], ['Pengguna', users]];
      return `<h2>Ringkasan</h2><div class="stats">${st.map(([a, n]) => `<div class="box"><span class="sub">${a}</span><div class="big">${n}</div></div>`).join('')}</div><h3 style="margin-top:28px">Transaksi terbaru</h3>${txTable(tx)}`;
    },
    async wadah() {
      const cs = await ok(sb.from('containers').select('*, loans(user_id, due_at, returned_at, profiles(full_name))').order('code'));
      return `<h2>Wadah</h2><p class="sub">Kode unik wadah dan UID tag RFID-nya. Kode hanya terlihat oleh admin.</p>
      <form class="row" id="fw"><input name="code" placeholder="Kode unik, mis. WD-042" required><input name="rfid" placeholder="UID tag RFID" required><button class="pb inl">Tambah wadah</button></form>
      <div class="tw"><table><thead><tr><th>Kode</th><th>RFID</th><th>Status</th><th>Dipinjam oleh</th><th>Jatuh tempo</th><th></th></tr></thead><tbody>${cs.map(c => {
        const ln = (c.loans || []).find(l => !l.returned_at), b = c.status === 'borrowed';
        return `<tr><td><b>${esc(c.code)}</b></td><td>${esc(c.rfid_uid)}</td><td>${b ? '<span class="pl b">Dipinjam</span>' : `<select data-st="${esc(c.id)}" aria-label="Status ${esc(c.code)}"><option value="available"${c.status === 'available' ? ' selected' : ''}>Tersedia</option><option value="maintenance"${c.status === 'maintenance' ? ' selected' : ''}>Perawatan</option></select>`}</td><td>${esc((ln && one(ln.profiles) || {}).full_name || '-')}</td><td>${dt(ln && ln.due_at)}</td><td>${b ? `<button class="gh" data-force="${esc(c.id)}" data-code="${esc(c.code)}">Paksa kembali</button> ` : ''}<button class="gh" data-del="${esc(c.id)}" data-code="${esc(c.code)}">Hapus</button></td></tr>`;
      }).join('') || '<tr><td colspan="6">Belum ada wadah.</td></tr>'}</tbody></table></div>`;
    },
    async pengguna() {
      const [us, loans] = await Promise.all([ok(sb.from('profiles').select('*').order('created_at')), ok(sb.from('loans').select('user_id,due_at').is('returned_at', null))]);
      return `<h2>Pengguna</h2><div class="tw"><table><thead><tr><th>Nama</th><th>NIM</th><th>Email</th><th>Dipinjam</th><th>Status</th><th></th></tr></thead><tbody>${us.map(u => {
        const mine = loans.filter(l => l.user_id === u.id), lt = mine.some(late);
        const s = u.locked ? '<span class="pl r">Dikunci petugas</span>' : lt ? '<span class="pl y">Terlambat</span>' : '<span class="pl">Aktif</span>';
        return `<tr><td><b>${esc(u.full_name)}</b>${u.role === 'admin' ? ' <span class="pl b">Admin</span>' : ''}</td><td>${esc(u.nim || '-')}</td><td>${esc(u.email)}</td><td>${mine.length}</td><td>${s}</td><td><button class="gh" data-lock="${esc(u.id)}" data-v="${u.locked ? 1 : 0}">${u.locked ? 'Buka kunci' : 'Kunci kuota'}</button></td></tr>`;
      }).join('') || '<tr><td colspan="6">Belum ada pengguna.</td></tr>'}</tbody></table></div>`;
    },
    async transaksi() {
      return `<h2>Transaksi</h2><p class="sub">50 transaksi terakhir.</p>${txTable(await ok(sb.from('transactions').select(TXSEL).order('created_at', {ascending: false}).limit(50)))}`;
    },
    async stasiun() {
      const ss = await ok(sb.from('stations').select('*, devices(last_seen), station_sessions(status, expires_at)').order('code'));
      const base = location.origin + location.pathname.replace(/index\.html$/, '');
      return `<h2>Stasiun</h2><p class="sub">Cetak QR dan tempel di stasiun. QR berisi tautan ke aplikasi dengan kode stasiun. Tiap stasiun punya <b>kunci alat</b> sendiri untuk ESP32.</p>
      <form class="row" id="fs"><input name="code" placeholder="Kode stasiun, mis. ST-01" required><input name="name" placeholder="Nama stasiun (opsional)"><button class="pb inl">Tambah stasiun</button></form>
      <div class="stn">${ss.map(s => {
        const busy = (s.station_sessions || []).some(x => x.status === 'active' && new Date(x.expires_at) > new Date());
        const d = one(s.devices), on = d && d.last_seen && Date.now() - new Date(d.last_seen).getTime() < 60000;
        return `<div class="box b"><b>${esc(s.name)}</b> <span class="pl ${busy ? 'y' : ''}">${busy ? 'Dipakai' : 'Kosong'}</span><br><span class="sub">Kode: ${esc(s.code)}</span><br>
        <span class="sub">Alat: ${d ? (on ? '<span class="pl">Online</span>' : 'Offline') : 'belum ada kunci'}</span><br>
        <div class="qr" data-u="${esc(base + '?station=' + s.code)}"></div>
        <div class="row"><button class="gh" data-free="${esc(s.code)}">Bebaskan paksa</button><button class="gh" data-key="${esc(s.code)}">${d ? 'Ganti kunci alat' : 'Buat kunci alat'}</button></div></div>`;
      }).join('') || '<p class="sub">Belum ada stasiun.</p>'}</div>`;
    },
    async pengaturan() {
      const c = S.cfg, dom = (await ok(sb.from('app_config').select('allowed_domains').maybeSingle())).allowed_domains.join(', ');
      return `<h2>Pengaturan</h2><p class="sub">Dipakai backend saat memeriksa kuota, berat wadah, dan jatuh tempo.</p>
      <form id="fc"><label class="lbl">Maksimal wadah per pengguna<input name="max_loan" type="number" min="1" value="${c.maxLoan}" required></label>
      <label class="lbl">Berat minimum wadah (g)<input name="weight_min" type="number" min="0" step="any" value="${c.weightMin}" required></label>
      <label class="lbl">Berat maksimum wadah (g)<input name="weight_max" type="number" min="0" step="any" value="${c.weightMax}" required></label>
      <label class="lbl">Lama peminjaman sebelum jatuh tempo (hari)<input name="loan_days" type="number" min="1" value="${c.loanDays}" required></label>
      <label class="lbl">Domain email kampus yang boleh login (pisahkan koma)<input name="allowed_domains" value="${esc(dom)}" required></label>
      <button class="pb inl" style="margin-top:18px">Simpan pengaturan</button></form>`;
    }
  };

  async function countUsers() {
    const {count} = await sb.from('profiles').select('id', {count: 'exact', head: true});
    return count ?? '-';
  }

  const AFTER = {
    stasiun() { app.querySelectorAll('.qr').forEach(el => new QRCode(el, {text: el.dataset.u, width: 132, height: 132})); }
  };

  async function tab(k) {
    cur = k;
    app.querySelectorAll('[data-t]').forEach(b => b.setAttribute('aria-current', String(b.dataset.t === k)));
    pane.innerHTML = '<p class="sub">Memuat...</p>';
    try { pane.innerHTML = await T[k](); if (AFTER[k]) AFTER[k](); }
    catch (e) { console.error(e); pane.innerHTML = '<div class="alert">Gagal memuat data. Pastikan akun ini berperan admin dan migrasi database sudah dijalankan.</div>'; }
  }
  const guard = async fn => { try { await fn(); } catch (e) { alert('Gagal: ' + (e.message || e)); } };

  app.querySelector('.nav').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) tab(b.dataset.t); });
  pane.onsubmit = e => guard(async () => {
    e.preventDefault();
    const f = e.target, d = new FormData(f);
    if (f.id === 'fw') await ok(sb.from('containers').insert({code: d.get('code').trim().toUpperCase(), rfid_uid: d.get('rfid').trim()}));
    if (f.id === 'fs') { const code = d.get('code').trim().toUpperCase(); await ok(sb.from('stations').insert({code, name: d.get('name').trim() || code})); }
    if (f.id === 'fc') {
      const c = {};
      ['max_loan', 'weight_min', 'weight_max', 'loan_days'].forEach(k => c[k] = Number(d.get(k)));
      c.allowed_domains = d.get('allowed_domains').split(',').map(x => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
      await ok(sb.from('app_config').update(c).eq('id', true));
      Object.assign(S.cfg, {maxLoan: c.max_loan, weightMin: c.weight_min, weightMax: c.weight_max, loanDays: c.loan_days});
    }
    tab(cur);
  });
  pane.onchange = e => guard(async () => { const id = e.target.dataset.st; if (id) await ok(sb.from('containers').update({status: e.target.value}).eq('id', id)); });
  pane.onclick = e => guard(async () => {
    const b = e.target.closest('button'); if (!b) return;
    const d = b.dataset;
    if (d.del && confirm('Hapus wadah ' + d.code + '? Wadah yang punya riwayat transaksi tidak bisa dihapus (ubah ke Perawatan).')) { await ok(sb.from('containers').delete().eq('id', d.del)); tab(cur); }
    if (d.force && confirm('Tandai wadah ' + d.code + ' sudah dikembalikan?')) { await ok(sb.rpc('admin_force_return', {p_container: d.force})); tab(cur); }
    if (d.lock) { await ok(sb.rpc('admin_set_locked', {p_user: d.lock, p_locked: d.v !== '1'})); tab(cur); }
    if (d.free) { await ok(sb.rpc('admin_release_station', {p_station: d.free})); tab(cur); }
    if (d.key && confirm('Buat kunci alat baru untuk ' + d.key + '? Kunci lama (jika ada) langsung tidak berlaku.')) {
      const key = await ok(sb.rpc('admin_create_device', {p_station: d.key}));
      prompt('Salin kunci alat untuk ' + d.key + '. Kunci ini hanya ditampilkan SEKALI. Simpan di firmware ESP32 (header x-device-key).', key);
      tab(cur);
    }
  });
  tab('ringkasan');
}
