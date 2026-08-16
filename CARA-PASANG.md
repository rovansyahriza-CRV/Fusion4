# Cara Pasang PWA ke Fusion4 SmartGate

## 1. Upload 4 file ini ke root repo GitHub (folder yang sama dengan logo.png)
- `manifest.json`
- `service-worker.js`
- `icon-192.png`
- `icon-512.png`

## 2. Tambahkan tag ini di `<head>` pada SEMUA file HTML
(attendance-fusion4.html, enroll_fusion4.html, pindah-lokasi.html, ijin-keluar.html)

```html
<link rel="manifest" href="/Fusion4/manifest.json">
<meta name="theme-color" content="#243463">

<!-- Khusus supaya bagus juga di iOS Safari -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Fusion4">
<link rel="apple-touch-icon" href="/Fusion4/icon-192.png">
```

## 3. Tambahkan script ini sebelum `</body>` di attendance-fusion4.html
(cukup di file utama, tidak perlu di semua file)

```html
<script>
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/Fusion4/service-worker.js')
        .then(() => console.log('SmartGate PWA: service worker aktif'))
        .catch((err) => console.error('SmartGate PWA gagal:', err));
    });
  }
</script>
```

## 4. Ikon sudah disiapkan
`icon-192.png` dan `icon-512.png` sudah dibuat persegi sempurna dari logo Fusion4
(versi rounded-square putih). Tinggal upload ke repo, tidak perlu resize manual lagi.

## 5. Testing
- Android (Chrome): buka attendance-fusion4.html, akan muncul prompt "Add to Home Screen"
  otomatis, atau lewat menu titik tiga > "Install app"
- iOS (Safari): buka halaman, tap tombol Share > "Add to Home Screen" (Safari iOS
  tidak kasih prompt otomatis, harus manual)
- Setelah install, buka dari ikon homescreen — harusnya tampil fullscreen tanpa
  address bar browser

## Catatan penting
- Service worker di atas SENGAJA tidak cache data GPS/absensi/model wajah — hanya
  cache shell HTML/CSS/logo. Ini supaya tidak ada absen yang kepakai data basi
  saat offline. Kalau nanti mau tambah mode "benar-benar offline" (misal buat
  area site yang sinyalnya jelek), perlu strategi cache berbeda untuk model
  face-api.js — kasih tau saja kalau butuh itu.
