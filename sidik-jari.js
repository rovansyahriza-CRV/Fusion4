// ============ SIDIK JARI (WebAuthn) - Fusion4 SmartGate ============
// Dipakai digital-badge.html (daftar) & attendance-fusion4.html (absen). Butuh library
// @simplewebauthn/browser (global SimpleWebAuthnBrowser). Online-only.
// Sidik jari tidak pernah keluar dari HP: sensor HP membuka kunci, server (Edge Function
// "sidik-jari") cuma mengecek tanda tangan kunci itu + sesi Badge + aturan 1 orang 1 HP.

const SJ_URL = 'https://nhmpwjriextmbotmvvbu.supabase.co/functions/v1/sidik-jari';

// Istilah sesuai HP. Web tidak bisa memilih jari atau wajah -- HP yang menentukan:
// iPhone X ke atas = Face ID, iPhone SE/8 ke bawah = Touch ID, Android & lainnya = sidik jari.
const SJ_ISTILAH = (function () {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const jari = { nama: 'Sidik Jari', kecil: 'sidik jari', ikon: '👆', aksi: 'Tempel jari Anda', lokasi: 'di sensor HP',
                 tombolDaftar: 'Lanjut Tempel Jari', menunggu: 'Menunggu sidik jari...' };
  if (!ios) return jari;
  const layarKecil = typeof screen !== 'undefined' && Math.max(screen.width, screen.height) <= 667;
  if (/iPhone|iPod/.test(ua) && layarKecil) {
    return Object.assign({}, jari, { nama: 'Touch ID', kecil: 'Touch ID', lokasi: 'di tombol Home',
                                     tombolDaftar: 'Lanjut Touch ID', menunggu: 'Menunggu Touch ID...' });
  }
  return { nama: 'Face ID', kecil: 'Face ID', ikon: '🙂', aksi: 'Lihat ke layar HP', lokasi: 'Face ID akan memindai wajah Anda',
           tombolDaftar: 'Lanjut Face ID', menunggu: 'Menunggu Face ID...' };
})();

// Ganti kata "sidik jari" (termasuk pesan dari server) sesuai istilah HP ini.
function sjTeks(teks) {
  const s = String(teks == null ? '' : teks);
  if (SJ_ISTILAH.nama === 'Sidik Jari') return s;
  return s.replace(/Sidik Jari/g, SJ_ISTILAH.nama).replace(/[Ss]idik jari/g, SJ_ISTILAH.kecil)
          .replace(/tempel jari/gi, SJ_ISTILAH.nama).replace(/👆/g, SJ_ISTILAH.ikon);
}

// Terapkan sjTeks ke semua teks di dalam elemen (popup, kartu, baris status).
function sjTerapkanIstilah(el) {
  if (!el || SJ_ISTILAH.nama === 'Sidik Jari' || typeof document === 'undefined') return;
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const baru = sjTeks(n.nodeValue);
    if (baru !== n.nodeValue) n.nodeValue = baru;
  }
}

// HP punya sensor (sidik jari / kunci layar) yang bisa dipakai browser ini?
async function sjDidukung() {
  try {
    if (typeof SimpleWebAuthnBrowser === 'undefined' || !window.PublicKeyCredential) return false;
    if (!PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (e) { return false; }
}

// Nama HP buat ditampilkan (mis. "SM-A155F" / "iPhone"). Cuma label, bukan pengaman.
async function sjNamaPerangkat() {
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      const v = await navigator.userAgentData.getHighEntropyValues(['model', 'platform']);
      if (v.model) return (v.platform ? v.platform + ' ' : '') + v.model;
    }
  } catch (e) {}
  const ua = navigator.userAgent || '';
  const m = ua.match(/Android [\d.]+; ([^;)]+)/);
  if (m && m[1] && m[1].trim() !== 'K') return 'Android ' + m[1].trim();
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  return (navigator.platform || 'Perangkat').slice(0, 40);
}

async function sjPanggil(body) {
  const res = await fetch(SJ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Server sidik jari tidak merespon (' + res.status + ').');
  return res.json();
}

function sjPesanError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'AbortError') return sjTeks('Sidik jari tidak dikenali / dibatalkan.');
  if (n === 'InvalidStateError') return sjTeks('Sidik jari untuk aplikasi ini sudah ada di HP ini. Minta reset ke HR/PIC.');
  if (n === 'NotSupportedError' || n === 'SecurityError') return sjTeks('HP / browser ini belum mendukung sidik jari. Pakai Scan Wajah.');
  return (e && e.message) || 'Sidik jari gagal.';
}

// Daftar: sesi Badge -> tantangan -> popup sidik jari HP -> server cek & simpan kunci publik.
async function sjDaftar(token, device) {
  const r = await sjPanggil({ aksi: 'daftar_opsi', token, device });
  if (!r || r.status !== 'OK') return r || { status: 'ERROR', message: 'Gagal memulai pendaftaran.' };
  let respon;
  try {
    respon = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: r.options });
  } catch (e) {
    return { status: 'BATAL', message: sjPesanError(e) };
  }
  return sjPanggil({ aksi: 'daftar_verifikasi', token, device, label: await sjNamaPerangkat(), respon });
}

// Absen: hasil OK = { status:'OK', nama, qrCodeId, perangkat }.
async function sjVerifikasi(token, device) {
  const r = await sjPanggil({ aksi: 'absen_opsi', token, device });
  if (!r || r.status !== 'OK') return r || { status: 'ERROR', message: 'Gagal memulai verifikasi.' };
  let respon;
  try {
    respon = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: r.options });
  } catch (e) {
    return { status: 'BATAL', message: sjPesanError(e) };
  }
  return sjPanggil({ aksi: 'absen_verifikasi', token, device, respon });
}
