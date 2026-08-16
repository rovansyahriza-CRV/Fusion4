// ============ MODUL ABSEN OFFLINE - Fusion4 SmartGate ============
// Syarat wajib offline: QrCodeId (scan QR) + wajah (cocok dengan cache lokal).
// GPS dicatat kalau kebaca, TIDAK menghalangi proses kalau gagal/lambat.
// Kasus lembur/CLOSED/voucher/password TIDAK didukung offline (butuh jawaban server).
//
// PRASYARAT: variabel APPS_SCRIPT_URL dan library faceapi.js sudah dimuat
// duluan di halaman (sama seperti di attendance-fusion4.html / enroll_fusion4.html).

const DB_NAME = "Fusion4OfflineDB";
const DB_VERSION = 1;
const STORE_QUEUE = "queue";
const STORE_FACES = "faceCache";

const FACE_MATCH_THRESHOLD = 0.45;   // samakan dengan setting online yang sudah ada
const AMBIGUITY_MARGIN = 0.12;       // samakan dengan setting online yang sudah ada

function openOfflineDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains(STORE_FACES)) {
        db.createObjectStore(STORE_FACES, { keyPath: "qrCodeId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ============ 1. CACHE DESCRIPTOR WAJAH (panggil saat online, sekali/berkala) ============
async function syncFaceCache() {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    body: JSON.stringify({ action: "GET_ALL_FACE_DATA" }),
    headers: { "Content-Type": "text/plain" }
  });
  const semuaWajah = await res.json(); // diharapkan array {qrCodeId, nama, descriptor}

  const db = await openOfflineDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FACES, "readwrite");
    const store = tx.objectStore(STORE_FACES);
    store.clear();
    semuaWajah.forEach(item => store.put(item));
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  console.log(`✅ Cache wajah offline diperbarui: ${semuaWajah.length} orang`);
  return semuaWajah.length;
}

async function getCachedFaces() {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FACES, "readonly");
    const req = tx.objectStore(STORE_FACES).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ============ 2. PENCOCOKAN WAJAH LOKAL (1:N terhadap cache, tanpa internet) ============
async function matchFaceOffline(liveDescriptor) {
  const cachedFaces = await getCachedFaces();
  if (!cachedFaces.length) {
    return { match: null, reason: "Cache wajah kosong. Sambungkan internet dulu untuk sync data." };
  }

  let best = null, bestDist = Infinity, secondBestDist = Infinity;

  cachedFaces.forEach(f => {
    const dist = faceapi.euclideanDistance(liveDescriptor, f.descriptor);
    if (dist < bestDist) {
      secondBestDist = bestDist;
      bestDist = dist;
      best = f;
    } else if (dist < secondBestDist) {
      secondBestDist = dist;
    }
  });

  if (bestDist > FACE_MATCH_THRESHOLD) {
    return { match: null, reason: "Wajah tidak dikenali" };
  }
  if ((secondBestDist - bestDist) < AMBIGUITY_MARGIN) {
    return { match: null, reason: "Wajah mirip lebih dari satu orang, coba lagi" };
  }
  return { match: best, distance: bestDist };
}

// ============ 3. GPS NON-BLOCKING (dicatat kalau ada, tidak wajib) ============
function getGPSNonBlocking(timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    const timer = setTimeout(() => resolve(null), timeoutMs);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        clearTimeout(timer);
        resolve(null); // gagal/timeout -> tetap lanjut, bukan diblokir
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    );
  });
}

// ============ 4. SIMPAN KE ANTRIAN LOKAL ============
async function queueOfflineAbsen({ qrCodeId, nama, gps }) {
  const record = {
    qrCodeId,
    nama,
    lokasi: gps ? `${gps.lat},${gps.lng}` : "",
    timestampOffline: new Date().toISOString(), // waktu ASLI absen, bukan waktu kirim nanti
    status: "pending"
  };
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_QUEUE, "readwrite");
    tx.objectStore(STORE_QUEUE).add(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

async function countPendingQueue() {
  const db = await openOfflineDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_QUEUE, "readonly").objectStore(STORE_QUEUE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ============ 5. AUTO-SYNC ANTRIAN SAAT ONLINE ============
async function syncQueuedAbsen() {
  if (!navigator.onLine) return;

  const db = await openOfflineDB();
  const all = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE_QUEUE, "readonly").objectStore(STORE_QUEUE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  for (const record of all) {
    try {
      const res = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        body: JSON.stringify({
          qrCodeId: record.qrCodeId,
          lokasi: record.lokasi,
          voucherPIN: "",
          timestampOffline: record.timestampOffline
        }),
        headers: { "Content-Type": "text/plain" }
      });
      const hasil = await res.json();
      console.log("✅ Sync offline absen:", record.qrCodeId, hasil);

      const delDb = await openOfflineDB();
      const delTx = delDb.transaction(STORE_QUEUE, "readwrite");
      delTx.objectStore(STORE_QUEUE).delete(record.id);
    } catch (err) {
      console.warn("⚠️ Gagal sync (jaringan belum stabil), coba lagi nanti:", record.qrCodeId, err);
      break; // stop loop, jangan lanjut ke record berikutnya kalau network masih bermasalah
    }
  }
}

window.addEventListener("online", syncQueuedAbsen);
setInterval(syncQueuedAbsen, 60000); // jaga-jaga: cek antrian tiap 1 menit walau event 'online' tidak sempat terpicu
