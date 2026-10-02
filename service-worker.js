// Service Worker - Fusion4 SmartGate
// 1. Shell (HTML/JS/logo) -> network-first, fallback cache. Kalau sinyal lemot (>4 detik)
//    dan file-nya ada di cache, langsung pakai cache biar halaman tetap kebuka di site.
// 2. Library CDN + model wajah -> cache-first (versi dikunci, gak berubah). Ini yang bikin
//    Absen Offline tetap jalan di site blank spot total.
// 3. Data Supabase (absen, GPS, dsb) TIDAK PERNAH di-cache -- absen offline lewat antrian
//    IndexedDB di offline-absen.js, bukan lewat cache.
// 4. Background Sync: antrian absen offline dikirim walau halaman sudah ditutup (Chrome Android).

importScripts('offline-absen.js');

const CACHE_NAME = 'fusion4-shell-v5';
const RUNTIME_CDN_CACHE = 'fusion4-cdn-runtime-v1';
const KEEP_CACHES = [CACHE_NAME, RUNTIME_CDN_CACHE, OFFLINE_ASSET_CACHE];

const SHELL_FILES = [
  '/Fusion4/attendance-fusion4.html',
  '/Fusion4/digital-badge.html',
  '/Fusion4/offline-absen.js',
  '/Fusion4/enroll_fusion4.html',
  '/Fusion4/pindah-lokasi.html',
  '/Fusion4/ijin-keluar.html',
  '/Fusion4/driveBridge.js',
  '/Fusion4/reportPdf.js',
  '/Fusion4/logo.png',
  '/Fusion4/logo-bima.png',
  '/Fusion4/manifest.json',
  '/Fusion4/manifest-badge.json',
  '/Fusion4/icon-192.png',
  '/Fusion4/badge-icon-192.png',
  '/Fusion4/set-lokasi.html',
  '/Fusion4/manifest-setlokasi.json',
  '/Fusion4/setlokasi-logo-192.png',
  '/Fusion4/setlokasi-logo-180.png'
];

const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

// Install: simpan shell + aset offline. Satu file gagal gak bikin install gagal total.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(SHELL_FILES.map((f) => cache.add(f)));
    await precacheOfflineAssets().catch(() => {});
  })());
  self.skipWaiting();
});

// Activate: bersihkan cache versi lama (cache aset offline tetap disimpan)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => !KEEP_CACHES.includes(key)).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

function isShellRequest(url) {
  return url.origin === self.location.origin && SHELL_FILES.includes(url.pathname);
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') {
    const cache = await caches.open(RUNTIME_CDN_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirstShell(request, url) {
  const cache = await caches.open(CACHE_NAME);
  // Key cache tanpa query string (?QrCodeId=... dsb) biar 1 file = 1 entri.
  const cached = await cache.match(url.pathname);

  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(url.pathname, response.clone());
    return response;
  });

  if (!cached) return network;

  // Sinyal lemot: kalau 4 detik belum dapat jawaban, pakai versi cache.
  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), 4000));
  return Promise.race([network.catch(() => cached), timeout]);
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  if (isShellRequest(url)) {
    event.respondWith(networkFirstShell(event.request, url));
  }
  // Selain itu (Supabase, Apps Script, Drive, dll) -> langsung ke network, gak di-cache.
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'fusion4-absen-offline') {
    // Kalau masih ada sisa antrian (jaringan putus di tengah), lempar error biar browser retry.
    event.waitUntil(syncQueuedAbsen().then(async () => {
      if (await countPendingQueue() > 0) throw new Error('Antrian absen offline belum habis');
    }));
  }
});
