
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
  hb: 0, wt: 0, poll: 0, tm: [], ch: {}, token: '', stream: null,
  alert: false, stCode: ''
};

let LOGIN_MSG = '';

const P = {
  check: '<path d="M5 13l4 4L19 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v.01M14 21h.01M17 21h4v-4"/>',
  out: '<path d="M4 13v6a2 2 0 002 2h12a2 2 0 002-2v-6"/><path d="M12 15V3M8 7l4-4 4 4"/>',
  inn: '<path d="M4 13v6a2 2 0 002 2h12a2 2 0 002-2v-6"/><path d="M12 3v12M8 11l4 4 4-4"/>',
  leave: '<path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l5-5-5-5M15 12H3"/>'
};

const svg = n => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;

const ic = (n, c = '') => `<div class="ic ${c}">${svg(n)}</div>`;

// Logo "G" Google untuk tombol masuk.
const GLOGO = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

// Waktu relatif singkat: "5 menit lalu", "2 hari lalu".
const ago = t => {
  if (!t) return '';
  const m = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 60000));
  if (m < 1) return 'baru saja';
  if (m < 60) return `${m} menit lalu`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} jam lalu`;
  return `${Math.round(h / 24)} hari lalu`;
};

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

// Baris proses di layar transaksi, gaya struk printer. Status: done | now | todo.
const log = list => `<ol class="log">${list.map(([t, st]) =>
  `<li class="${st}"><span>${t}</span></li>`
).join('')}</ol>`;

const nowStr = () => new Date().toLocaleString('id-ID', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});

// Hasil transaksi: cap singkat, judul, dan penjelasan. kind: good | bad | wait.
const verdict = (kind, stamp, title, text) => `
  <div class="verdict">
    <span class="stamp ${kind}">${stamp}</span>
    <h2>${title}</h2>
    ${text ? `<p class="lead">${text}</p>` : ''}
  </div>`;

const V = {
  login: () => `
    <div class="login">
      <div class="login-main">
        <div class="mark">
          <img src="assets/logo.png" alt="Logo Universitas Trisakti">
          <span>Universitas Trisakti</span>
        </div>
        <h1>Wadah makan pakai ulang. <mark>Ambil di stasiun</mark>, kembalikan di stasiun.</h1>
        <p class="lead">Masuk dengan akun kampus, scan QR di stasiun, lalu pilih pinjam atau kembalikan. Pintunya terbuka sendiri.</p>
        ${alertBox(S.msg)}
        <button class="pb gbtn" data-a="login">${GLOGO}<span>Masuk dengan Google</span></button>
        <p class="fine">Hanya untuk akun <b>@trisakti.ac.id</b></p>
      </div>
      <dl class="spec">
        <div><dt>Batas pinjam</dt><dd>${S.cfg.maxLoan} wadah per orang</dd></div>
        <div><dt>Pemeriksaan</dt><dd>Tag RFID dan berat ${S.cfg.weightMin}-${S.cfg.weightMax} g</dd></div>
        <div><dt>Pintu</dt><dd>Buka dan tutup otomatis</dd></div>
      </dl>
    </div>
  `,

  nim: () => `
    <h2>Masukkan NIM</h2>
    <p class="lead">NIM dipakai untuk mencatat pinjaman atas namamu.</p>
    <label class="lbl">NIM
      <input id="nim" class="big-in" inputmode="numeric" autocomplete="off" maxlength="20" placeholder="2021xxxxxx">
    </label>
    ${alertBox(S.msg)}
    ${btn('savenim', 'Simpan')}
    ${btn('logout', 'Batal', 1)}
  `,

  wait: () => `
    <div class="center">
      <div class="spin" aria-hidden="true"></div>
      <h2>Menghubungi stasiun</h2>
      <p class="lead">Memeriksa apakah stasiun siap dipakai.</p>
    </div>
  `,

  scan: () => `
    <h2>Scan QR di stasiun</h2>
    <p class="lead">QR ada di bagian depan stasiun. Arahkan kamera sampai terbaca.</p>
    <div class="view" aria-hidden="true"><video id="cam" playsinline muted></video><i></i></div>
    <div id="camerr" class="alert" hidden>Kamera tidak bisa dipakai. Ketik kode stasiun di bawah.</div>
    ${alertBox(S.msg)}
    <p class="or">atau ketik kode stasiun</p>
    <div class="row code-row">
      <input id="sid" placeholder="SLB-001" aria-label="Kode stasiun" autocomplete="off" autocapitalize="characters">
      <button class="pb inl" data-a="manual">Buka</button>
    </div>
    <button class="link" data-a="dash">Lihat wadah saya tanpa scan</button>
  `,

  busy: () => `
    ${verdict('wait', 'Dipakai', 'Stasiun sedang dipakai', 'Ada pengguna lain di stasiun ini. Tunggu transaksinya selesai, lalu scan ulang.')}
    ${btn('again', 'Scan ulang')}
    ${btn('scan', 'Kembali', 1)}
  `,

  dash: () => {
    const i = info();
    const on = !!S.sess;
    const name = esc(S.p.full_name || S.u?.email || 'Pengguna');
    const idLine = esc(S.p.nim ? 'NIM ' + S.p.nim : (S.u?.email || ''));
    const left = S.cfg.maxLoan - i.n;

    const warn = i.late
      ? '<div class="alert"><b>Ada wadah yang lewat jatuh tempo.</b><br>Kuota dikunci sampai wadah dikembalikan.</div>'
      : (S.p.locked
          ? '<div class="alert">Kuota kamu dikunci oleh petugas. Hubungi petugas kampus.</div>'
          : '');

    const canBorrow = on && !i.locked && !i.full;
    const canReturn = on && i.n > 0;

    const borrowHint = !on ? 'Scan QR dulu'
      : i.locked ? 'Kuota dikunci'
      : i.full ? 'Kuota penuh'
      : `Sisa jatah ${left}`;

    const returnHint = !on ? 'Scan QR dulu'
      : i.n ? `${i.n} wadah di tanganmu`
      : 'Belum ada pinjaman';

    const bar = `<div class="q-bar" role="img" aria-label="${i.n} dari ${S.cfg.maxLoan} wadah dipinjam">${
      Array.from({length: S.cfg.maxLoan}, (_, k) => `<i class="${k < i.n ? 'f' : ''}"></i>`).join('')
    }</div>`;

    const tickets = S.loans.length
      ? S.loans.map((l, k) => `
          <li class="ticket">
            <span class="no">${k + 1}</span>
            <div><b>Wadah ${k + 1}</b><span>Diambil ${fmt(l.borrowed_at)}, ${ago(l.borrowed_at)}</span></div>
            <em class="tag${isLate(l) ? ' late' : ''}">${isLate(l) ? 'Terlambat' : 'Aktif'}</em>
          </li>`).join('')
      : '<li class="empty">Belum ada wadah yang kamu pinjam.</li>';

    return `
      <div class="dash">
        <section class="panel">
          <div class="st">
            <span class="st-code">${esc(S.stCode || 'Belum ada stasiun')}</span>
            <span class="st-state${on ? ' on' : ''}">${on ? 'Terhubung' : 'Belum terhubung'}</span>
          </div>
          ${warn}
          ${stationAlertBox()}
          <div class="btns">
            <button class="key key-take" data-a="borrow"${canBorrow ? '' : ' disabled'}>
              <small>01</small><b>Pinjam</b><span>${borrowHint}</span>
            </button>
            <button class="key key-give" data-a="ret"${canReturn ? '' : ' disabled'}>
              <small>02</small><b>Kembalikan</b><span>${returnHint}</span>
            </button>
          </div>
          ${on
            ? `<button class="link" data-a="end">Selesai, lepas stasiun</button>`
            : `<button class="pb scan-cta" data-a="scan">${svg('qr')}<span>Scan QR stasiun</span></button>
               <p class="hint">Pinjam dan kembalikan hanya bisa setelah scan QR di stasiun.</p>`}
        </section>
        <section class="ledger">
          <div class="who"><b>${name}</b><span>${idLine}</span></div>
          <div class="quota">
            <p class="q-n">${i.n}<em>/${S.cfg.maxLoan}</em></p>
            <p class="q-l">wadah sedang kamu pinjam</p>
            ${bar}
          </div>
          <h3>Pinjaman aktif</h3>
          <ul class="tickets">${tickets}</ul>
        </section>
      </div>
    `;
  },

  borrow: () => `
    <p class="where">Pinjam / ${esc(S.stCode || 'stasiun')}</p>
    <h2>Stasiun sedang memeriksa wadah</h2>
    <p class="lead">Kalau wadah lolos, pintu terbuka sendiri. Ambil satu wadah, lalu pintu menutup.</p>
    ${log([
      ['Permintaan diterima stasiun', 'done'],
      ['Membaca tag RFID dan menimbang wadah', 'now'],
      ['Pintu terbuka, ambil wadah', 'todo'],
      ['Pinjaman dicatat atas namamu', 'todo']
    ])}
    ${btn('cancel', 'Batal', 1)}
  `,

  ret: () => `
    <p class="where">Kembalikan / ${esc(S.stCode || 'stasiun')}</p>
    <h2>Masukkan wadah ke stasiun</h2>
    <p class="lead">Pintu terbuka sebentar lagi. Letakkan wadah di atas tatakan, stasiun membaca tag dan beratnya.</p>
    ${stationAlertBox()}
    ${log([
      ['Permintaan diterima stasiun', 'done'],
      ['Pintu terbuka, letakkan wadah di tatakan', 'now'],
      ['Membaca tag RFID dan menimbang', 'todo'],
      ['Pinjaman ditutup, pintu menutup', 'todo']
    ])}
    ${btn('cancel', 'Batal', 1)}
  `,

  verify: () => `
    <p class="where">Kembalikan / ${esc(S.stCode || 'stasiun')}</p>
    <h2>Wadah diterima</h2>
    <p class="lead">Hasil pemeriksaan stasiun.</p>
    <div class="chks">
      <div class="chk" id="c1">Tag RFID cocok dengan wadah terdaftar</div>
      <div class="chk" id="c2">Berat ${esc(S.w)} g, dalam rentang ${S.cfg.weightMin}-${S.cfg.weightMax} g</div>
      <div class="chk" id="c3">Wadah tercatat atas namamu</div>
    </div>
    <div class="bar"><i id="pg"></i></div>
  `,

  ok: () => {
    const ret = S.kind === 'ret';
    return `
      ${verdict(
        'good',
        ret ? 'Dikembalikan' : 'Dipinjam',
        ret ? 'Wadah sudah kembali' : 'Pinjaman tercatat',
        ret ? 'Terima kasih sudah mengembalikan wadahnya.' : 'Wadah tercatat atas namamu. Kembalikan ke stasiun setelah dipakai.'
      )}
      <div class="receipt">
        <div><span>Jenis</span><b>${ret ? 'Pengembalian' : 'Peminjaman'}</b></div>
        <div><span>Stasiun</span><b>${esc(S.stCode || '-')}</b></div>
        ${ret && S.w ? `<div><span>Berat</span><b>${esc(S.w)} g</b></div>` : ''}
        <div><span>Waktu</span><b>${nowStr()}</b></div>
        <div><span>Pinjaman aktif</span><b>${S.loans.length} dari ${S.cfg.maxLoan}</b></div>
      </div>
      ${btn('dash', 'Kembali ke menu')}
    `;
  },

  err: () => `
    ${verdict('bad', 'Gagal', 'Transaksi belum berhasil', '')}
    ${alertBox(S.msg)}
    ${stationAlertBox()}
    ${btn('retry', 'Coba lagi')}
    ${btn('dash', 'Kembali ke menu', 1)}
  `,

  timeout: () => `
    ${verdict('wait', 'Habis', 'Sesi stasiun berakhir', 'Tidak ada aktivitas beberapa saat, jadi stasiun dilepas untuk pengguna lain. Scan QR lagi untuk melanjutkan.')}
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
  // .scr membatasi gaya layar pengguna; panel admin tetap memakai .card biasa.
  a.innerHTML = `<section class="card scr v-${v}">${V[v]()}</section>`;

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
    S.stCode = String(code || '').trim().toUpperCase();
    watchStation(code);
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
  unsub('st');

  S.sess = null;
  S.tx = null;
  S.alert = false;
  S.stCode = '';

  if (release && id) {
    sb.rpc('end_session', {p_session: id}).then(() => {}, () => {});
  }
}

/* ---------- Peringatan dari stasiun (pintu masih menunggu wadah dikeluarkan) ---------- */

// Banner hanya tampil untuk pengguna yang sedang memakai stasiun itu.
function stationAlertBox() {
  return S.alert
    ? '<div class="alert" role="alert"><b>Masih ada wadah di dalam stasiun.</b><br>Segera keluarkan wadah agar pintu bisa menutup, atau coba lagi.</div>'
    : '';
}

function setAlert(st) {
  // Peringatan lebih dari 10 menit dianggap basi (mis. perangkat mati saat peringatan aktif).
  const fresh = !!st &&
    st.door_alert === 'blocked' &&
    !!st.door_alert_at &&
    Date.now() - new Date(st.door_alert_at).getTime() < 600000;

  const changed = S.alert !== fresh;
  S.alert = fresh;

  if (changed && ['dash', 'ret', 'err'].includes(S.view)) {
    show(S.view, S.msg, true);
  }
}

async function watchStation(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return;

  S.stCode = c;
  unsub('st');

  S.ch.st = sub('st-' + c, 'stations', `station_code=eq.${c}`, pl => {
    if (S.stCode === c) setAlert(pl.new);
  });

  try {
    const st = await ok(
      sb.from('stations')
        .select('door_alert,door_alert_at')
        .eq('station_code', c)
        .maybeSingle()
    );

    if (S.stCode === c) setAlert(st);
  } catch {
    // Tanpa banner pun transaksi tetap berjalan.
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

/* ---------- Intro ARCID ---------- */

const intro = () => `
  <div class="intro arcid-intro">
    <div class="arcid-stage" aria-hidden="true">
      <img class="arcid-logo" src="assets/arcid-logo.svg" alt="">
      <span class="arcid-shadow"></span>
    </div>
    <h2 class="arcid-name" aria-label="ARCID">
      ${[...'ARCID'].map((c, i) => `<span style="--i:${i}">${c}</span>`).join('')}
    </h2>
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
    alreadyShown = sessionStorage.getItem('swp_arcid_intro_shown') === '1';
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
    sessionStorage.setItem('swp_arcid_intro_shown', '1');
  } catch {}

  SP.hidden = false;
  SP.classList.remove('out');
  SP.innerHTML = intro();

  document.body.style.overflow = 'hidden';
  spT = setTimeout(endSplash, 4100);
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
