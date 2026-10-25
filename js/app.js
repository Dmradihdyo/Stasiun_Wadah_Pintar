
import {sb, ok, configured, SUPABASE_URL, SUPABASE_ANON_KEY} from './supabase.js';
import {ALLOWED_DOMAINS} from './config.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const fmt = t => t ? new Date(t).toLocaleDateString('id-ID', {day: 'numeric', month: 'short', year: 'numeric'}) : '-';
const isLate = l => !!l.due_at && new Date(l.due_at).getTime() < Date.now();
const okMail = e => ALLOWED_DOMAINS.some(d => (e || '').toLowerCase().endsWith('@' + d));

const S = {
  u: null, p: null,
  cfg: {maxLoan: 2, weightMin: 80, weightMax: 120, loanDays: 3},
  loans: [], sess: null, last: '', view: '', msg: '',
  kind: 'borrow', rid: '', tx: null, done: false, w: 0,
  hb: 0, wt: 0, poll: 0, tm: [], ch: {}, token: '', stream: null
};

let LOGIN_MSG = '';

const P = {
  check: '<path d="M5 13l4 4L19 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
};

const ic = (n, c = '') => `<div class="ic ${c}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[n]}</svg></div>`;

const LB = '<svg viewBox="0 0 96 64" width="96" height="64" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"><rect x="6" y="18" width="84" height="40" rx="8"/><path d="M6 30h84M30 18v-6a4 4 0 014-4h28a4 4 0 014 4v6"/></svg>';

const btn = (a, t, alt, dis) => `<button class="pb${alt ? ' alt' : ''}" data-a="${a}"${dis ? ' disabled' : ''}>${t}</button>`;

const alertBox = m => m ? `<div class="alert" role="alert">${esc(m)}</div>` : '';

function info() {
  const n = S.loans.length;
  const late = S.loans.some(isLate);
  return {
    n,
    late,
    locked: !!(S.p && S.p.locked) || late,
    full: n >= S.cfg.maxLoan
  };
}

function reasonText(r) {
  return ({
    not_registered: 'Wadah tidak terdaftar',
    not_available: 'Wadah ini sedang tidak tersedia',
    weight: `Berat tidak sesuai (${r.weight ?? '?'} g / ${S.cfg.weightMin}-${S.cfg.weightMax} g)`,
    not_owner: 'Bukan wadah Anda',
    sensor: 'Sensor gagal membaca. Periksa posisi wadah lalu coba lagi',
    quota_full: 'Kuota peminjaman sudah penuh',
    locked: 'Kuota dikunci karena ada wadah yang terlambat dikembalikan atau dikunci petugas',
    no_stock: 'Wadah di stasiun sedang habis',
    no_loan: 'Anda tidak memiliki wadah yang sedang dipinjam',
    profile_incomplete: 'Profil belum lengkap. Hubungi petugas kampus.',
    session_expired: 'Sesi stasiun berakhir. Scan QR ulang',
    not_removed: 'Wadah tidak diambil dalam batas waktu. Peminjaman dibatalkan, silakan coba lagi',
    removal_in_progress: 'Peminjaman sedang menunggu wadah diambil. Ambil wadah dari stasiun'
  })[r.reason] || 'Terjadi kesalahan pada stasiun';
}

const STN_ERR = {
  not_found: 'Stasiun tidak ditemukan. Periksa kode stasiun.',
  unavailable: 'Stasiun sedang tidak beroperasi.',
  no_profile: 'Profil tidak ditemukan. Masuk ulang.'
};

/* ---------- Tampilan ---------- */

const V = {
  login: () => `
    <img class="lg" src="assets/logo.png" alt="Logo Trisakti">
    <h1>Wadah Pintar</h1>
    <p class="sub">Pinjam dan kembalikan wadah makan tanpa antre.</p>
    ${alertBox(S.msg)}
    ${btn('login', 'Masuk dengan Google')}
    <p class="sub">Gunakan akun Google kampus Trisakti</p>
  `,

  nim: () => `
    <h2>Lengkapi data</h2>
    <p class="sub">Masukkan NIM kamu untuk melanjutkan.</p>
    <label class="lbl">NIM
      <input id="nim" inputmode="numeric" autocomplete="off" maxlength="20" placeholder="Contoh: 2021xxxx">
    </label>
    ${alertBox(S.msg)}
    ${btn('savenim', 'Simpan dan lanjut')}
    ${btn('logout', 'Batal', 1)}
  `,

  wait: () => `${ic('clock')}<h2>Memeriksa stasiun</h2><p class="sub">Mohon tunggu sebentar.</p>`,

  scan: () => `
    <h2>Scan QR stasiun</h2>
    <p class="sub">Pindai QR untuk memulai.</p>
    <div class="view" aria-hidden="true"><video id="cam" playsinline muted></video><i></i></div>
    <div id="camerr" class="alert" hidden>Kamera tidak bisa dipakai. Masukkan kode stasiun di bawah.</div>
    ${alertBox(S.msg)}
    <div class="row">
      <input id="sid" placeholder="Kode stasiun, mis. ST-01" aria-label="Kode stasiun" autocomplete="off">
      <button class="pb inl" data-a="manual">Pakai kode</button>
    </div>
    ${btn('dash', 'Lihat wadah saya tanpa scan', 1)}
  `,

  busy: () => `
    ${ic('clock', 'w')}
    <h2>Stasiun sedang digunakan</h2>
    <p class="sub">Mohon antre. Stasiun siap setelah transaksi pengguna sebelumnya selesai.</p>
    ${btn('again', 'Scan ulang')}
    ${btn('scan', 'Kembali', 1)}
  `,

  dash: () => {
    const i = info();
    const on = !!S.sess;

    const dots = '<div class="dots">' +
      Array.from({length: S.cfg.maxLoan}, (_, k) =>
        `<i class="${k < i.n ? 'f' : ''}"></i>`
      ).join('') + '</div>';

    const warn = i.late
      ? '<div class="alert"><b>Ada wadah yang belum dikembalikan.</b><br>Kuota peminjaman dikunci sampai wadah dikembalikan. Pengingat juga dikirim ke email kampus kamu.</div>'
      : (S.p.locked
          ? '<div class="alert">Kuota kamu dikunci oleh petugas. Hubungi petugas kampus.</div>'
          : '');

    const list = S.loans.map((l, k) =>
      `<div class="box b"><b>Wadah ${k + 1}</b><br><span class="sub">dipinjam ${fmt(l.borrowed_at)}</span></div>`
    ).join('') || '<p class="sub">Belum ada wadah yang dipinjam.</p>';

    return `
      <div class="dash">
        <div>
          <h2>Menu utama</h2>
          ${warn}
          <div class="box">
            <b>${esc(S.p.full_name || S.u?.email || 'Pengguna')}</b><br>
            <span class="sub">${esc(S.u?.email || '')}</span>
          </div>
          <div class="box">
            <b>Kuota: ${i.n}/${S.cfg.maxLoan} wadah dipinjam</b>
            ${dots}
          </div>
          ${btn('borrow', 'Pinjam wadah', 0, !on || i.locked || i.full)}
          ${btn('ret', 'Kembalikan wadah', 1, !on || !i.n)}
          ${!on
            ? '<p class="sub">Scan QR stasiun untuk meminjam atau mengembalikan wadah.</p>' + btn('scan', 'Scan QR stasiun')
            : (i.full && !i.locked ? '<p class="sub">Kuota penuh. Kembalikan wadah dulu.</p>' : '')}
          ${on ? btn('end', 'Selesai dan lepas stasiun', 1) : ''}
        </div>
        <div>
          <h3>Wadah yang dipinjam</h3>
          ${list}
        </div>
      </div>
    `;
  },

  borrow: () => `
    <h2>Ambil wadah</h2>
    <p class="sub">Pintu stasiun terbuka. Ambil 1 wadah dari slot.</p>
    <div class="slot">${LB}</div>
    <div class="box">Menunggu stasiun mendeteksi wadah...</div>
    ${btn('cancel', 'Batal', 1)}
  `,

  ret: () => `
    <h2>Kembalikan</h2>
    <p class="sub">Letakkan wadah di slot pengembalian.</p>
    <div class="slot">${LB}</div>
    <div class="box">Menunggu wadah...</div>
    ${btn('cancel', 'Batal', 1)}
  `,

  verify: () => `
    <h2>Memverifikasi</h2>
    <p class="sub">Pemeriksaan otomatis</p>
    <div class="box"><b>Wadah</b> sedang diperiksa</div>
    <div class="chk" id="c1">RFID terbaca</div>
    <div class="chk" id="c2">Berat ${esc(S.w)} g</div>
    <div class="chk" id="c3">Pemilik pinjaman sesuai</div>
    <div class="bar"><i id="pg"></i></div>
    <p class="sub">Memproses...</p>
  `,

  ok: () => `
    ${ic('check')}
    <h2>${S.kind === 'ret' ? 'Pengembalian berhasil' : 'Peminjaman berhasil'}</h2>
    <div class="box b c" style="text-align:center">
      Kuota diperbarui<br>
      <b>${S.loans.length}/${S.cfg.maxLoan} wadah dipinjam</b>
    </div>
    ${btn('dash', 'Kembali ke menu')}
  `,

  err: () => `
    ${ic('x', 'e')}
    <h2>Terjadi kesalahan</h2>
    ${alertBox(S.msg)}
    ${btn('retry', 'Coba lagi')}
    ${btn('dash', 'Batal', 1)}
  `,

  timeout: () => `
    ${ic('clock', 'w')}
    <h2>Sesi berakhir</h2>
    <p class="sub">Sesi stasiun ditutup karena tidak ada aktivitas. Scan QR ulang untuk memulai transaksi baru.</p>
    ${btn('scan', 'Scan ulang')}
  `
};

const E = {
  scan: () => startCam(),

  verify: () => {
    const t = (id, ms, w) => S.tm.push(setTimeout(() => {
      const e = $('#' + id);
      if (e) e.classList.add('on');

      const p = $('#pg');
      if (p) p.style.width = w + '%';
    }, ms));

    t('c1', 400, 33);
    t('c2', 900, 66);
    t('c3', 1400, 100);

    S.tm.push(setTimeout(() => {
      S.kind = 'ret';
      show('ok');
    }, 2000));
  }
};

function show(v, msg = '', keep = false) {
  stopCam();
  S.tm.forEach(clearTimeout);
  S.tm = [];

  S.view = v;
  S.msg = msg;

  const a = $('#app');
  a.dataset.v = v;
  a.innerHTML = `<section class="card v-${v}">${V[v]()}</section>`;

  if (E[v]) E[v]();
  if (!keep) window.scrollTo(0, 0);

  renderWho();
}

function renderWho() {
  const w = $('#who');
  if (!S.u || !S.p) {
    w.innerHTML = '';
    return;
  }

  w.innerHTML = `
    <span class="nm">${esc(S.p.full_name)}</span>
    ${S.p.role === 'admin' ? '<a class="gh" href="#admin">Admin</a>' : ''}
    <button class="gh" data-a="logout">Keluar</button>
  `;
}

/* ---------- Kamera dan QR ---------- */

function stopCam() {
  if (S.stream) S.stream.getTracks().forEach(t => t.stop());
  S.stream = null;
}

const parseStation = v => {
  try {
    return new URL(v).searchParams.get('station') || v.trim();
  } catch {
    return String(v).trim();
  }
};

async function startCam() {
  const v = $('#cam');

  try {
    S.stream = await navigator.mediaDevices.getUserMedia({
      video: {facingMode: 'environment'}
    });
    v.srcObject = S.stream;
    await v.play();
  } catch {
    const e = $('#camerr');
    if (e) e.hidden = false;
    return;
  }

  const det = 'BarcodeDetector' in window
    ? new BarcodeDetector({formats: ['qr_code']})
    : null;

  const cv = document.createElement('canvas');
  const cx = cv.getContext('2d', {willReadFrequently: true});

  const loop = async () => {
    if (S.view !== 'scan' || !S.stream) return;

    let val = null;

    try {
      if (det) {
        const r = await det.detect(v);
        val = r[0] && r[0].rawValue;
      } else if (window.jsQR && v.videoWidth) {
        cv.width = v.videoWidth;
        cv.height = v.videoHeight;
        cx.drawImage(v, 0, 0);

        const im = cx.getImageData(0, 0, cv.width, cv.height);
        const c = jsQR(im.data, im.width, im.height);
        val = c && c.data;
      }
    } catch {
      // Abaikan frame yang gagal dibaca.
    }

    if (val) {
      stopCam();
      return claim(parseStation(val));
    }

    requestAnimationFrame(loop);
  };

  loop();
}

/* ---------- Realtime ---------- */

const sub = (name, table, filter, fn) =>
  sb.channel(name)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table,
      filter
    }, fn)
    .subscribe();

const unsub = k => {
  if (S.ch[k]) {
    sb.removeChannel(S.ch[k]);
    S.ch[k] = null;
  }
};

/* ---------- Sesi stasiun ---------- */

async function claim(code) {
  S.last = code;
  show('wait');

  try {
    const r = await ok(sb.rpc('start_session', {p_station: code}));

    if (!r.ok) {
      return r.reason === 'busy'
        ? show('busy')
        : show('scan', STN_ERR[r.reason] || 'Gagal membuka stasiun. Coba lagi.');
    }

    startSession(r.session_id);
    show('dash');
  } catch {
    show('scan', 'Gagal menghubungi stasiun. Coba lagi.');
  }
}

function startSession(id) {
  S.sess = id;
  clearInterval(S.hb);
  unsub('s');

  S.hb = setInterval(beat, 15000);

  S.ch.s = sub('s-' + id, 'station_sessions', `id=eq.${id}`, pl => {
    if (pl.new && pl.new.status !== 'active') lost();
  });
}

async function beat() {
  const id = S.sess;
  if (!id) return;

  try {
    if (!(await ok(sb.rpc('touch_session', {p_session: id})) && S.sess === id)) {
      lost();
    }
  } catch {
    // Coba lagi pada denyut berikutnya jika jaringan terputus sesaat.
  }
}

function lost() {
  if (!S.sess) return;
  endSession(false);
  show('timeout');
}

function endSession(release = true) {
  const id = S.sess;

  clearInterval(S.hb);
  clearTimeout(S.wt);
  clearInterval(S.poll);
  unsub('s');
  unsub('t');

  S.sess = null;
  S.tx = null;

  if (release && id) {
    sb.rpc('end_session', {p_session: id}).then(() => {}, () => {});
  }
}

/* ---------- Transaksi ---------- */

async function startTx(type) {
  S.kind = type === 'return' ? 'ret' : 'borrow';
  S.done = false;
  S.rid = crypto.randomUUID();

  try {
    const r = await ok(sb.rpc('request_transaction', {
      p_session: S.sess,
      p_type: type,
      p_request_id: S.rid
    }));

    if (!r.ok) {
      return r.reason === 'session_invalid' ? lost() : fail(r.reason);
    }

    S.tx = r.transaction_id;
    show(S.kind);
    watchTx(S.tx);
    startWait();
  } catch {
    show('err', 'Gagal menghubungi stasiun. Coba lagi.');
  }
}

function watchTx(id) {
  unsub('t');
  clearInterval(S.poll);

  S.ch.t = sub('t-' + id, 'transactions', `id=eq.${id}`, pl => onTx(pl.new));

  S.poll = setInterval(async () => {
    try {
      const t = await ok(
        sb.from('transactions')
          .select('id,status,weight_grams,notes')
          .eq('id', id)
          .maybeSingle()
      );

      if (t) onTx(t);
    } catch {
      // Ulangi jika pemeriksaan gagal.
    }
  }, 3000);
}

async function onTx(t) {
  if (!t || t.id !== S.tx || S.done || t.status === 'pending') return;
  if (S.view !== 'borrow' && S.view !== 'ret') return;

  S.done = true;
  clearTimeout(S.wt);
  clearInterval(S.poll);
  unsub('t');

  if (t.status === 'cancelled') return;

  if (t.status === 'success') {
    try {
      await loadLoans();
    } catch {
      // Kuota dapat diperbarui oleh Realtime.
    }

    S.w = t.weight_grams;
    return S.kind === 'ret' ? show('verify') : show('ok');
  }

  fail(t.notes || t.status, t.weight_grams);
}

function fail(reason, weight) {
  let text = reasonText({reason, weight});

  // Pengembalian yang ditolak sensor: pintu stasiun tetap terbuka sampai wadah
  // dikeluarkan atau diletakkan dengan benar.
  if (S.kind === 'ret' && ['not_registered', 'not_owner', 'weight', 'sensor'].includes(reason)) {
    text += '. Pintu tetap terbuka: keluarkan wadah dari stasiun, atau letakkan wadah yang benar lalu coba lagi';
  }

  show('err', text);
}

function startWait() {
  clearTimeout(S.wt);

  S.wt = setTimeout(() => {
    if (S.view !== 'borrow' && S.view !== 'ret') return;
    cancelTx();
    show('err', 'Stasiun tidak merespons. Coba lagi.');
  }, 90000);
}

function cancelTx() {
  clearTimeout(S.wt);
  clearInterval(S.poll);
  unsub('t');

  if (S.tx && !S.done) {
    sb.rpc('cancel_transaction', {p_tx: S.tx}).then(() => {}, () => {});
  }

  S.done = true;
  S.tx = null;
}

/* ---------- Data pengguna ---------- */

async function loadConfig() {
  S.cfg = {maxLoan: 2, weightMin: 80, weightMax: 120, loanDays: 3};
}

async function loadLoans() {
  S.loans = await ok(
    sb.from('loans')
      .select('id,borrowed_at,container_id,status')
      .eq('user_id', S.u.id)
      .eq('status', 'active')
      .order('borrowed_at')
  );
}

async function begin(p) {
  S.p = p;
  const id = S.u.id;

  S.ch.p = sub('p-' + id, 'profiles', `id=eq.${id}`, pl => {
    if (pl.new && pl.new.id) {
      S.p = pl.new;
      if (S.view === 'dash') show('dash', '', true);
    }
  });

  S.ch.l = sub('l-' + id, 'loans', `user_id=eq.${id}`, async () => {
    try {
      await loadLoans();
    } catch {
      return;
    }

    if (S.view === 'dash') show('dash', '', true);
  });

  await loadLoans();
  route();
}

function route() {
  if (location.hash === '#admin' && S.p.role === 'admin') {
    stopCam();
    return import('./admin.js')
      .then(m => m.mount(S, sb))
      .catch(() => show('err', 'Halaman admin gagal dimuat.'));
  }

  let sid = new URLSearchParams(location.search).get('station');

  if (!sid) {
    try {
      sid = sessionStorage.getItem('wp-station');
    } catch {}
  }

  try {
    sessionStorage.removeItem('wp-station');
  } catch {}

  if (sid) {
    history.replaceState(null, '', location.pathname + location.hash);
    return claim(sid);
  }

  show(S.sess ? 'dash' : 'scan');
}

function cleanup() {
  endSession(false);
  ['p', 'l'].forEach(unsub);
  S.loans = [];
}

/* ---------- Autentikasi Google OAuth ---------- */

{
  const q = new URLSearchParams(location.search + '&' + location.hash.slice(1));

  if (q.get('error_description') || q.get('error')) {
    LOGIN_MSG = 'Login gagal atau ditolak. Gunakan akun Google kampus dengan domain @trisakti.ac.id.';
    history.replaceState(null, '', location.pathname);
  }
}

let rejectingAccount = false;
let handlingUserId = '';

async function onUser(u) {
  if (rejectingAccount) return;

  if (!configured) {
    cleanup();
    S.u = null;
    S.p = null;
    renderWho();
    show('login', 'Supabase belum dikonfigurasi. Periksa js/config.js.');
    return;
  }

  if (!u) {
    cleanup();
    S.u = null;
    S.p = null;
    renderWho();
    show('login', LOGIN_MSG || 'Silakan masuk menggunakan akun Google kampus Trisakti.');
    LOGIN_MSG = '';
    handlingUserId = '';
    return;
  }

  if (!okMail(u.email)) {
    const message = 'Akses ditolak. Gunakan akun Google kampus dengan email @trisakti.ac.id.';

    rejectingAccount = true;
    cleanup();
    S.u = null;
    S.p = null;
    renderWho();

    try {
      const {error} = await sb.auth.signOut();
      if (error) console.error('Gagal mengakhiri sesi akun non-kampus:', error);
    } catch (e) {
      console.error('Gagal mengakhiri sesi akun non-kampus:', e);
    }

    rejectingAccount = false;
    LOGIN_MSG = '';
    show('login', message);
    handlingUserId = '';
    return;
  }

  if (handlingUserId === u.id && S.u?.id === u.id && S.p) {
    S.u = u;
    return;
  }

  handlingUserId = u.id;
  cleanup();
  S.u = u;

  try {
    await loadConfig();

    const p = await ok(
      sb.from('profiles')
        .select('*')
        .eq('id', u.id)
        .maybeSingle()
    );

    if (!p) {
      const message = 'Profil akun belum tersedia di database. Coba keluar lalu masuk kembali; jika tetap muncul, hubungi petugas.';

      cleanup();
      S.u = null;
      S.p = null;
      renderWho();

      rejectingAccount = true;
      try {
        await sb.auth.signOut();
      } catch (e) {
        console.error(e);
      }
      rejectingAccount = false;

      handlingUserId = '';
      show('login', message);
      return;
    }

    await begin(p);
  } catch (e) {
    console.error('Gagal memuat data pengguna:', e);

    cleanup();
    S.u = null;
    S.p = null;
    renderWho();
    handlingUserId = '';

    show('login', 'Gagal memuat data akun. Periksa koneksi dan kebijakan RLS Supabase, lalu coba lagi.');
  }
}

sb.auth.onAuthStateChange((ev, session) => {
  S.token = session?.access_token || '';
  const u = session?.user || null;

  if (rejectingAccount) return;

  if (['TOKEN_REFRESHED', 'USER_UPDATED'].includes(ev) && u?.id === S.u?.id) {
    if (u) S.u = u;
    return;
  }

  setTimeout(() => {
    onUser(u).catch(error => {
      console.error('Kesalahan autentikasi:', error);
      cleanup();
      S.u = null;
      S.p = null;
      renderWho();
      show('login', 'Terjadi kesalahan saat memeriksa akun. Silakan login kembali.');
    });
  }, 0);
});

/* ---------- Aksi tombol ---------- */

const A = {
  login: async () => {
    if (!configured) {
      return show('login', 'Supabase belum dikonfigurasi. Isi js/config.js (lihat README).');
    }

    const sid = new URLSearchParams(location.search).get('station');

    try {
      if (sid) sessionStorage.setItem('wp-station', sid);
    } catch {}

    const {error} = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: location.origin + location.pathname,
        queryParams: {prompt: 'select_account'}
      }
    });

    if (error) show('login', 'Login gagal. Coba lagi.');
  },

  logout: async () => {
    endSession();
    await sb.auth.signOut();
  },

  manual: () => {
    const v = ($('#sid').value || '').trim();
    if (v) claim(parseStation(v));
  },

  dash: () => show('dash'),
  scan: () => show('scan'),
  again: () => claim(S.last),

  borrow: () => {
    const i = info();
    if (!i.locked && !i.full) startTx('borrow');
  },

  ret: () => startTx('return'),
  retry: () => startTx(S.kind === 'ret' ? 'return' : 'borrow'),

  cancel: () => {
    cancelTx();
    show('dash');
  },

  end: () => {
    endSession();
    show('scan');
  }
};

document.addEventListener('click', e => {
  const b = e.target.closest('[data-a]');

  if (b && !b.disabled && A[b.dataset.a]) {
    A[b.dataset.a]();
  }

  const r = e.target.closest('.pb,.gh');

  if (r && !r.disabled) {
    const k = r.getBoundingClientRect();
    const d = Math.max(k.width, k.height) * 2;
    const s = document.createElement('span');

    s.className = 'rp';
    s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - k.left - d / 2}px;top:${e.clientY - k.top - d / 2}px`;

    r.appendChild(s);
    setTimeout(() => s.remove(), 650);
  }
});

addEventListener('hashchange', () => {
  if (S.p) route();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') beat();
});

addEventListener('pagehide', () => {
  if (S.sess && S.token) {
    fetch(`${SUPABASE_URL}/rest/v1/rpc/end_session`, {
      method: 'POST',
      keepalive: true,
      headers: {
        'content-type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        authorization: 'Bearer ' + S.token
      },
      body: JSON.stringify({p_session: S.sess})
    }).catch(() => {});
  }
});

/* ---------- Intro Universitas Trisakti ---------- */

const intro = () => `
  <div class="intro">
    <div class="lw">
      <div class="rings"><i></i><i></i><i></i><i></i></div>
      <img class="il" src="assets/logo.png" alt="">
    </div>
    <h2 class="it" aria-label="Universitas Trisakti">
      ${[...'Universitas Trisakti'].map((c, i) =>
        `<span style="--i:${i}">${c === ' ' ? '&nbsp;' : c}</span>`
      ).join('')}
    </h2>
    <p class="is">Stasiun Wadah Pintar</p>
    <div class="ib"><i></i></div>
  </div>
`;

const SP = $('#splash');
let spT;

function endSplash() {
  clearTimeout(spT);
  SP.classList.add('out');
  document.body.style.overflow = '';

  setTimeout(() => {
    SP.hidden = true;
    SP.innerHTML = '';
  }, 800);
}

function splash() {
  let alreadyShown = false;

  try {
    alreadyShown = sessionStorage.getItem('swp_trisakti_intro_shown') === '1';
  } catch {}

  // Jangan tampilkan intro lagi jika sudah muncul pada tab ini.
  // Ini juga mencegah intro berulang setelah kembali dari Google OAuth.
  if (alreadyShown || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    SP.hidden = true;
    SP.innerHTML = '';
    document.body.style.overflow = '';
    return;
  }

  // Tandai sebelum intro dimulai agar tidak terulang setelah redirect OAuth.
  try {
    sessionStorage.setItem('swp_trisakti_intro_shown', '1');
  } catch {}

  SP.hidden = false;
  SP.classList.remove('out');
  SP.innerHTML = intro() + '<button class="skip" type="button">Lewati intro</button>';

  document.body.style.overflow = 'hidden';
  SP.querySelector('.skip').onclick = endSplash;

  spT = setTimeout(endSplash, 4700);
}

splash();

/* ---------- Tema gelap dan terang ---------- */

const root = document.documentElement;
const th = $('#th');

const isDark = () =>
  root.dataset.theme
    ? root.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme:dark)').matches;

const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>';

function paintTheme() {
  const d = isDark();

  th.innerHTML = d ? SUN : MOON;
  th.setAttribute('aria-label', d ? 'Ganti ke tema terang' : 'Ganti ke tema gelap');
  th.title = th.getAttribute('aria-label');

  const m = $('meta[name=theme-color]');
  if (m) m.content = d ? '#1E1E1E' : '#FFFFFF';
}

th.addEventListener('click', () => {
  const n = isDark() ? 'light' : 'dark';

  root.dataset.theme = n;

  try {
    localStorage.setItem('wp-theme', n);
  } catch {}

  paintTheme();
});

matchMedia('(prefers-color-scheme:dark)').addEventListener('change', paintTheme);
paintTheme();
