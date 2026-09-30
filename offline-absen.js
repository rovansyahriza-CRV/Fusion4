// ============ MODUL ABSEN OFFLINE - Fusion4 SmartGate ============
// Dipakai di digital-badge.html, attendance-fusion4.html, DAN service-worker.js (importScripts),
// jadi semua fungsi inti di sini gak boleh bergantung ke `window` / DOM.
//
// Mode offline = HP PRIBADI, boleh dititipi maks OFFLINE_MAX_PROFILES orang (buat yang pinjam HP).
// Tiap orang cuma masuk kalau dia sendiri login Badge (PIN) di HP itu saat online.
//   1. Online  -> prepareOfflinePack(qr, pin): simpan/perbarui profil+wajah+lokasi orang itu,
//                 dan precache library + model wajah (buat blank spot total).
//                 refreshAllOfflineProfiles(): perbarui SEMUA profil titipan (wajah enroll ulang,
//                 lokasi baru, AuthCheck), hapus yang sudah nonaktif/resign.
//      Profil titipan yang 30 hari gak dipakai di HP itu dihapus otomatis (pemilik HP tidak).
//      Pemilik HP = profil yang paling dulu disimpan.
//   2. Offline -> attendance-fusion4.html cek geofence lokal + wajah 1:1, lalu queueOfflineAbsen().
//   3. Sinyal balik -> syncQueuedAbsen() kirim ke RPC submit_absensi_offline (idempotent per clientId).
//      Hasil (diterima/ditolak) disimpan di store "history" buat ditampilkan di Badge.

const OFFLINE_SUPABASE_URL = 'https://nhmpwjriextmbotmvvbu.supabase.co';
const OFFLINE_SUPABASE_KEY = 'sb_publishable_XNqLw7iz873TtrLn9ag8dQ_AkL2rImz';

const OFFLINE_DB_NAME = "Fusion4OfflineDB";
const OFFLINE_DB_VERSION = 3;
const STORE_QUEUE = "queue";
const STORE_PROFILE = "profile";   // key: QrCodeId -> profil + descriptor + lokasi
const OFFLINE_MAX_PROFILES = 5;
const OFFLINE_PROFILE_EXPIRE_MS = 30 * 24 * 3600 * 1000;
const STORE_HISTORY = "history";   // hasil sync terakhir

const OFFLINE_ASSET_CACHE = "fusion4-offline-assets-v1";
const FACE_MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js/weights";
// Semua yang dibutuhkan halaman Absen + Badge buat jalan tanpa internet sama sekali.
const OFFLINE_ASSET_URLS = [
  "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js",
  "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js",
  FACE_MODEL_URL + "/tiny_face_detector_model-weights_manifest.json",
  FACE_MODEL_URL + "/tiny_face_detector_model-shard1",
  FACE_MODEL_URL + "/face_landmark_68_model-weights_manifest.json",
  FACE_MODEL_URL + "/face_landmark_68_model-shard1",
  FACE_MODEL_URL + "/face_recognition_model-weights_manifest.json",
  FACE_MODEL_URL + "/face_recognition_model-shard1",
  FACE_MODEL_URL + "/face_recognition_model-shard2"
];

// 1 koneksi dipakai ulang; ditutup kalau ada tab lain yang upgrade versi DB (biar gak ke-block).
let offlineDbPromise = null;
function openOfflineDB() {
  if (offlineDbPromise) return offlineDbPromise;
  offlineDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_PROFILE)) {
        db.createObjectStore(STORE_PROFILE);
      } else if (e.oldVersion < 3) {
        // Versi 2 nyimpen 1 profil di key "me" -> pindah ke key QrCodeId.
        const store = e.target.transaction.objectStore(STORE_PROFILE);
        const req = store.get("me");
        req.onsuccess = () => {
          const p = req.result;
          if (!p) return;
          const now = new Date().toISOString();
          store.put(Object.assign({ addedAt: p.updatedAt || now, lastUsedAt: now }, p), p.qrCodeId);
          store.delete("me");
        };
      }
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        db.createObjectStore(STORE_HISTORY, { keyPath: "clientId" });
      }
      // Versi 1 nyimpen wajah SEMUA karyawan -- udah gak dipakai (cuma wajah sendiri).
      if (db.objectStoreNames.contains("faceCache")) db.deleteObjectStore("faceCache");
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); offlineDbPromise = null; };
      db.onclose = () => { offlineDbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { offlineDbPromise = null; reject(req.error); };
  });
  return offlineDbPromise;
}

function idbRequest(storeName, mode, fn) {
  return openOfflineDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    let result;
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  }));
}

async function offlineRpc(fnName, params) {
  const res = await fetch(`${OFFLINE_SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": OFFLINE_SUPABASE_KEY,
      "Authorization": `Bearer ${OFFLINE_SUPABASE_KEY}`
    },
    body: JSON.stringify(params)
  });
  if (!res.ok) throw new Error(`RPC ${fnName} gagal (${res.status})`);
  return res.json();
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ============ 1. PAKET OFFLINE (panggil tiap buka Badge/Absen saat online) ============
const normQr = (qr) => String(qr || "").trim().toUpperCase();

// Urut paling dulu disimpan -> index 0 = pemilik HP.
async function listOfflineProfiles() {
  try {
    const all = (await idbRequest(STORE_PROFILE, "readonly", s => s.getAll())) || [];
    return all.filter(p => p && p.qrCodeId)
      .sort((a, b) => String(a.addedAt || "").localeCompare(String(b.addedAt || "")))
      .map((p, i) => Object.assign(p, { isOwner: i === 0 }));
  } catch (e) { return []; }
}

// Tanpa qrCodeId: kembalikan profil kalau HP ini cuma nyimpen 1 orang (gak ambigu).
async function getOfflineProfile(qrCodeId) {
  const all = await listOfflineProfiles();
  if (qrCodeId) return all.find(p => p.qrCodeId === normQr(qrCodeId)) || null;
  return all.length === 1 ? all[0] : null;
}

async function deleteOfflineProfile(qrCodeId) {
  await idbRequest(STORE_PROFILE, "readwrite", s => s.delete(normQr(qrCodeId)));
}

async function markOfflineProfileUsed(qrCodeId) {
  const p = await getOfflineProfile(qrCodeId);
  if (!p) return;
  p.lastUsedAt = new Date().toISOString();
  delete p.isOwner;
  await idbRequest(STORE_PROFILE, "readwrite", s => s.put(p, p.qrCodeId));
}

// Titipan (bukan pemilik HP) yang 30 hari gak dipakai di HP ini -> hapus.
async function removeExpiredOfflineProfiles() {
  const batas = Date.now() - OFFLINE_PROFILE_EXPIRE_MS;
  const hapus = (await listOfflineProfiles())
    .filter(p => !p.isOwner && Date.parse(p.lastUsedAt || p.addedAt || 0) < batas);
  for (const p of hapus) await deleteOfflineProfile(p.qrCodeId);
  return hapus.map(p => p.nama);
}

function profileFromPack(pack, lama, pinHash) {
  const now = new Date().toISOString();
  return {
    qrCodeId: pack.qrCodeId,
    nama: pack.nama,
    kualifikasi: pack.kualifikasi || "",
    needAuth: !!pack.needAuth,
    descriptor: pack.descriptor || null,
    lokasi: pack.lokasi || [],
    pinHash: pinHash || (lama && lama.pinHash) || null,
    clockOffsetMs: Date.parse(pack.serverTime) - Date.now(),
    addedAt: (lama && lama.addedAt) || now,
    lastUsedAt: (lama && lama.lastUsedAt) || now,
    updatedAt: now
  };
}

// Dipanggil saat orang itu SENDIRI login Badge di HP ini (online).
// pin (opsional) disimpan sebagai hash, buat buka Badge offline pakai PIN yang sama.
async function prepareOfflinePack(qrCodeId, pin) {
  await removeExpiredOfflineProfiles();
  const pack = await offlineRpc("get_offline_pack", { p_qrcode: qrCodeId });
  if (!pack || pack.status !== "OK") throw new Error((pack && pack.message) || "Paket offline tidak tersedia.");

  const semua = await listOfflineProfiles();
  const lama = semua.find(p => p.qrCodeId === pack.qrCodeId) || null;
  if (!lama && semua.length >= OFFLINE_MAX_PROFILES) {
    const err = new Error(`HP ini sudah menyimpan ${OFFLINE_MAX_PROFILES} orang untuk absen offline. Hapus salah satu di daftar "Tersimpan di HP ini" dulu.`);
    err.code = "PENUH";
    throw err;
  }

  const profile = profileFromPack(pack, lama, pin ? await sha256Hex(pack.qrCodeId + ":" + pin) : null);
  profile.lastUsedAt = new Date().toISOString();
  await idbRequest(STORE_PROFILE, "readwrite", s => s.put(profile, profile.qrCodeId));

  let assetsReady = false;
  try { assetsReady = await precacheOfflineAssets(); } catch (e) { console.warn("Precache aset offline gagal:", e); }
  return { profile, assetsReady };
}

// Perbarui semua profil di HP ini dari server (wajah enroll ulang, lokasi, AuthCheck).
// Karyawan nonaktif / tidak ditemukan -> dihapus dari HP. PIN & waktu pakai tetap.
async function refreshAllOfflineProfiles() {
  await removeExpiredOfflineProfiles();
  const dihapus = [];
  for (const lama of await listOfflineProfiles()) {
    let pack;
    try { pack = await offlineRpc("get_offline_pack", { p_qrcode: lama.qrCodeId }); }
    catch (e) { break; } // jaringan bermasalah -> coba lagi lain waktu
    if (!pack || pack.status !== "OK") {
      await deleteOfflineProfile(lama.qrCodeId);
      dihapus.push(lama.nama);
      continue;
    }
    const baru = profileFromPack(pack, lama, null);
    await idbRequest(STORE_PROFILE, "readwrite", s => s.put(baru, baru.qrCodeId));
  }
  return { dihapus };
}

async function precacheOfflineAssets() {
  if (typeof caches === "undefined") return false;
  const cache = await caches.open(OFFLINE_ASSET_CACHE);
  const hasil = await Promise.allSettled(OFFLINE_ASSET_URLS.map(async (url) => {
    if (await cache.match(url)) return;
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error(url + " " + res.status);
    await cache.put(url, res);
  }));
  return hasil.every(h => h.status === "fulfilled");
}

async function offlineAssetsReady() {
  if (typeof caches === "undefined") return false;
  const cache = await caches.open(OFFLINE_ASSET_CACHE);
  const ada = await Promise.all(OFFLINE_ASSET_URLS.map(u => cache.match(u)));
  return ada.every(Boolean);
}

// Status buat indikator "Siap Offline" di Badge.
async function getOfflineReadiness(qrCodeId) {
  const profile = await getOfflineProfile(qrCodeId);
  const assets = await offlineAssetsReady().catch(() => false);
  const hasFace = !!profile && Array.isArray(profile.descriptor) && profile.descriptor.length > 0;
  const lokasiCount = profile ? (profile.lokasi || []).length : 0;
  return {
    profile,
    hasFace,
    lokasiCount,
    assetsReady: assets,
    ready: hasFace && lokasiCount > 0 && assets && !profile.needAuth,
    pending: await countPendingQueue().catch(() => 0),
    profiles: await listOfflineProfiles(),
    maxProfiles: OFFLINE_MAX_PROFILES
  };
}

// ============ 2. GEOFENCE LOKAL (rumus sama dengan find_nearest_location di server) ============
function findNearestOfflineLocation(lat, lng, lokasiList) {
  let best = null;
  (lokasiList || []).forEach(l => {
    const toRad = d => d * Math.PI / 180;
    const a = Math.pow(Math.sin(toRad(lat - l.lat) / 2), 2) +
      Math.cos(toRad(lat)) * Math.cos(toRad(l.lat)) * Math.pow(Math.sin(toRad(lng - l.lng) / 2), 2);
    const dist = Math.round(6371000 * 2 * Math.asin(Math.sqrt(a)));
    if (!best || dist < best.distance) best = { nama: l.nama, distance: dist, radius: Number(l.radius) || 100 };
  });
  if (!best) return null;
  best.inside = best.distance <= best.radius;
  return best;
}

// ============ 3. ANTRIAN LOKAL ============
function newClientId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
}

async function queueOfflineAbsen({ qrCodeId, nama, gps, lokasi }) {
  const record = {
    clientId: newClientId(),
    qrCodeId,
    nama,
    lat: gps ? gps.lat : null,
    lng: gps ? gps.lng : null,
    lokasi: lokasi || "",
    timestampOffline: new Date().toISOString(), // waktu ASLI absen, bukan waktu kirim nanti
    deviceInfo: (typeof navigator !== "undefined" ? navigator.userAgent : "").slice(0, 250)
  };
  await idbRequest(STORE_QUEUE, "readwrite", s => s.add(record));
  await markOfflineProfileUsed(qrCodeId).catch(() => {});
  requestBackgroundSync();
  return record;
}

async function countPendingQueue() {
  return (await idbRequest(STORE_QUEUE, "readonly", s => s.count())) || 0;
}

async function getPendingQueue() {
  return (await idbRequest(STORE_QUEUE, "readonly", s => s.getAll())) || [];
}

async function getSyncHistory(limit) {
  const all = (await idbRequest(STORE_HISTORY, "readonly", s => s.getAll())) || [];
  return all.sort((a, b) => String(b.syncedAt).localeCompare(String(a.syncedAt))).slice(0, limit || 10);
}

// Minta service worker sync di background (Chrome Android) -- jalan walau halaman ditutup.
function requestBackgroundSync() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
  navigator.serviceWorker.ready
    .then(reg => reg.sync && reg.sync.register("fusion4-absen-offline"))
    .catch(() => {});
}

// ============ 4. SYNC ANTRIAN KE SERVER ============
let syncSedangJalan = false;
async function syncQueuedAbsen() {
  if (syncSedangJalan) return { sent: 0 };
  if (typeof navigator !== "undefined" && navigator.onLine === false) return { sent: 0 };
  syncSedangJalan = true;
  let sent = 0;
  try {
    const all = await getPendingQueue();
    for (const record of all) {
      let hasil;
      try {
        hasil = await offlineRpc("submit_absensi_offline", {
          p_client_id: record.clientId,
          p_qrcodeid: record.qrCodeId,
          p_waktu_hp: record.timestampOffline,
          p_lat: record.lat,
          p_lng: record.lng,
          p_device_info: record.deviceInfo || ""
        });
      } catch (err) {
        console.warn("⚠️ Gagal sync (jaringan belum stabil), coba lagi nanti:", record.qrCodeId, err.message);
        break; // stop loop, jangan lanjut ke record berikutnya kalau network masih bermasalah
      }
      // Server udah nyatet (diterima ATAU ditolak masuk log) -> keluarkan dari antrian.
      await idbRequest(STORE_HISTORY, "readwrite", s => s.put({
        clientId: record.clientId,
        nama: record.nama,
        timestampOffline: record.timestampOffline,
        syncedAt: new Date().toISOString(),
        status: hasil && hasil.status,
        message: hasil && hasil.message,
        slot: hasil && hasil.slot
      }));
      await idbRequest(STORE_QUEUE, "readwrite", s => s.delete(record.id));
      sent++;
    }
  } finally {
    syncSedangJalan = false;
  }
  if (sent > 0 && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("fusion4-offline-synced", { detail: { sent } }));
  }
  return { sent };
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => syncQueuedAbsen().catch(() => {}));
  setInterval(() => syncQueuedAbsen().catch(() => {}), 60000); // jaga-jaga kalau event 'online' gak kepicu
  syncQueuedAbsen().catch(() => {});
}
