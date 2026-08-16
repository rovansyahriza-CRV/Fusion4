// Service Worker - Fusion4 SmartGate
// Cache shell statis (HTML/CSS/JS/logo) supaya app cepat dibuka & bisa tampil walau koneksi lemot.
// Data absensi (GPS, spreadsheet, model wajah) tetap butuh koneksi live -- TIDAK di-cache di sini
// supaya tidak ada data absen yang "nyangkut" basi.

const CACHE_NAME = 'fusion4-shell-v1';

const SHELL_FILES = [
  '/Fusion4/attendance-fusion4.html',
  '/Fusion4/enroll_fusion4.html',
  '/Fusion4/pindah-lokasi.html',
  '/Fusion4/ijin-keluar.html',
  '/Fusion4/logo.png'
];

// Install: simpan shell ke cache
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

// Activate: bersihkan cache versi lama
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch: network-first untuk semua request.
// Kalau offline dan filenya ada di shell cache, baru fallback ke cache.
// Ini penting karena app ini berbasis GPS + Google Sheets real-time --
// jangan sampai user absen pakai data cache yang sudah tidak akurat.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // update cache diam-diam kalau file termasuk shell
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          if (SHELL_FILES.some((f) => event.request.url.includes(f))) {
            cache.put(event.request, clone);
          }
        });
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
