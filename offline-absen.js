// ============ MODUL ABSEN OFFLINE - Fusion4 SmartGate ============
// Dipakai di digital-badge.html, attendance-fusion4.html, DAN service-worker.js (importScripts),
// jadi semua fungsi inti di sini gak boleh bergantung ke `window` / DOM.
//
// Mode offline = HP PRIBADI: HP cuma nyimpen wajah pemiliknya sendiri + daftar lokasi aktif.
//   1. Online  -> prepareOfflinePack(qr, pin): simpan profil+wajah+lokasi ke IndexedDB,
//                 dan precache library + model wajah (buat blank spot total).
//   2. Offline -> attendance-fusion4.html cek geofence lokal + wajah 1:1, lalu queueOfflineAbsen().
//   3. Sinyal balik -> syncQueuedAbsen() kirim ke RPC submit_absensi_offline (idempotent per clientId).
//      Hasil (diterima/ditolak) disimpan di store "history" buat ditampilkan di Badge.

const OFFLINE_SUPABASE_URL = 'https://nhmpwjriextmbotmvvbu.supabase.co';
const OFFLINE_SUPABASE_KEY = 'sb_publishable_XNqLw7iz873TtrLn9ag8dQ_AkL2rImz';

const OFFLINE_DB_NAME = "Fusion4OfflineDB";
const OFFLINE_DB_VERSION = 2;
const STORE_QUEUE = "queue";
const STORE_PROFILE = "profile";   // key: "me" -> profil pemilik HP + descriptor + lokasi
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

function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_PROFILE)) {
        db.createObjectStore(STORE_PROFILE);
      }
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        db.createObjectStore(STORE_HISTORY, { keyPath: "clientId" });
      }
      // Versi 1 nyimpen wajah SEMUA karyawan -- udah gak dipakai (cuma wajah sendiri).
      if (db.objectStoreNames.contains("faceCache")) db.deleteObjectStore("faceCache");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
async function getOfflineProfile() {
  try { return (await idbRequest(STORE_PROFILE, "readonly", s => s.get("me"))) || null; }
  catch (e) { return null; }
}

// pin (opsional) disimpan sebagai hash, buat buka Badge offline pakai PIN yang sama.
async function prepareOfflinePack(qrCodeId, pin) {
  const pack = await offlineRpc("get_offline_pack", { p_qrcode: qrCodeId });
  if (!pack || pack.status !== "OK") throw new Error((pack && pack.message) || "Paket offline tidak tersedia.");

  const lama = await getOfflineProfile();
  const sameOwner = lama && lama.qrCodeId === pack.qrCodeId;
  const profile = {
    qrCodeId: pack.qrCodeId,
    nama: pack.nama,
    kualifikasi: pack.kualifikasi || "",
    needAuth: !!pack.needAuth,
    descriptor: pack.descriptor || null,
    lokasi: pack.lokasi || [],
    pinHash: pin ? await sha256Hex(pack.qrCodeId + ":" + pin) : (sameOwner ? lama.pinHash : null),
    clockOffsetMs: Date.parse(pack.serverTime) - Date.now(),
    updatedAt: new Date().toISOString()
  };
  await idbRequest(STORE_PROFILE, "readwrite", s => s.put(profile, "me"));

  let assetsReady = false;
  try { assetsReady = await precacheOfflineAssets(); } catch (e) { console.warn("Precache aset offline gagal:", e); }
  return { profile, assetsReady };
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
  const profile = await getOfflineProfile();
  const cocok = !!profile && (!qrCodeId || profile.qrCodeId === String(qrCodeId).trim().toUpperCase());
  const assets = await offlineAssetsReady().catch(() => false);
  return {
    profile: cocok ? profile : null,
    hasFace: cocok && Array.isArray(profile.descriptor) && profile.descriptor.length > 0,
    lokasiCount: cocok ? (profile.lokasi || []).length : 0,
    assetsReady: assets,
    ready: cocok && Array.isArray(profile.descriptor) && profile.descriptor.length > 0 && (profile.lokasi || []).length > 0 && assets && !profile.needAuth,
    pending: await countPendingQueue().catch(() => 0)
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
