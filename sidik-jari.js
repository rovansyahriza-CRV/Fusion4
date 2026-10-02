// ============ SIDIK JARI (WebAuthn) - Fusion4 SmartGate ============
// Dipakai digital-badge.html (daftar) & attendance-fusion4.html (absen). Butuh library
// @simplewebauthn/browser (global SimpleWebAuthnBrowser). Online-only.
// Sidik jari tidak pernah keluar dari HP: sensor HP membuka kunci, server (Edge Function
// "sidik-jari") cuma mengecek tanda tangan kunci itu + sesi Badge + aturan 1 orang 1 HP.

const SJ_URL = 'https://nhmpwjriextmbotmvvbu.supabase.co/functions/v1/sidik-jari';

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
  if (n === 'NotAllowedError' || n === 'AbortError') return 'Sidik jari tidak dikenali / dibatalkan.';
  if (n === 'InvalidStateError') return 'Sidik jari untuk aplikasi ini sudah ada di HP ini. Minta reset ke HR/PIC.';
  if (n === 'NotSupportedError' || n === 'SecurityError') return 'HP / browser ini belum mendukung sidik jari. Pakai Scan Wajah.';
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
