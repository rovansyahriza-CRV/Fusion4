// =====================================================================================
// SMMS-BIMA — Client helper buat Drive File Bridge
// Butuh DRIVE_BRIDGE_URL & DRIVE_BRIDGE_TOKEN didefinisikan di config.js.
// =====================================================================================

// Convert File/Blob (dari <input type="file"> atau canvas hasil kompres) jadi base64
// murni (tanpa prefix "data:image/jpeg;base64,").
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const base64 = result.substring(result.indexOf(",") + 1);
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Kompres + resize gambar di browser sebelum upload, biar hemat storage Drive.
// maxDimension: sisi terpanjang di-resize ke sekian px. quality: 0-1 buat JPEG.
function compressImage(file, maxDimension = 1280, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > height && width > maxDimension) {
        height = Math.round((height * maxDimension) / width);
        width = maxDimension;
      } else if (height > maxDimension) {
        width = Math.round((width * maxDimension) / height);
        height = maxDimension;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error("Gagal kompres gambar."));
          resolve(blob);
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = reject;
    img.src = url;
  });
}

// Upload satu file (foto sudah dikompres, atau PDF blob) ke Drive lewat Apps Script.
// category: "photos" | "reports"
// PENTING: body dikirim tanpa header Content-Type eksplisit ("application/json") supaya
// browser mengirimnya sebagai "text/plain" request -- ini bikin fetch() TIDAK memicu
// CORS preflight (OPTIONS), yang mana Apps Script Web App tidak bisa menjawabnya.
// Apps Script tetap bisa JSON.parse(e.postData.contents) dengan normal.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Apps Script Web App kadang kena limit (concurrent execution / rate limit) kalau dipanggil
// beruntun cepat (misal generate semua slip sekaligus), dan balikin halaman error HTML dari
// Google -- bukan JSON -- yang bikin res.json() meledak dengan "Unexpected token '<'...".
// Makanya di sini responsenya dibaca sebagai text dulu baru di-parse manual, dan kalau gagal
// (bukan JSON valid) dianggap error transient lalu di-retry beberapa kali dengan jeda.
async function postToDriveBridgeWithRetry(payload, { retries = 3, baseDelayMs = 1500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(baseDelayMs * attempt); // backoff: 1.5s, 3s, 4.5s, ...
    try {
      const res = await fetch(DRIVE_BRIDGE_URL, {
        method: "POST",
        body: JSON.stringify(payload),
        // sengaja TIDAK set headers: {"Content-Type": "application/json"} -- lihat catatan di atas
      });
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (parseErr) {
        throw new Error(
          `Server Drive bridge kirim balasan tidak valid (kemungkinan kena limit Apps Script, HTTP ${res.status}). Coba lagi sebentar.`
        );
      }
      if (data.error) throw new Error(data.error);
      return data;
    } catch (err) {
      lastErr = err;
      // Ga usah retry kalau errornya emang dari Apps Script sendiri (bukan masalah transient
      // kayak response HTML/limit) -- itu udah pasti bakal gagal lagi meski di-retry.
      if (err.message && !err.message.includes("balasan tidak valid")) break;
    }
  }
  throw lastErr;
}

async function uploadToDrive(category, fileName, mimeType, blobOrFile) {
  const base64Data = await fileToBase64(blobOrFile);
  const payload = {
    token: DRIVE_BRIDGE_TOKEN,
    action: "upload",
    category,
    fileName,
    mimeType,
    base64Data,
  };
  return postToDriveBridgeWithRetry(payload); // { fileId, viewUrl, directUrl }
}

// Baca balik file dari Drive sebagai base64 (dipakai buat nempel ulang foto ke PDF yang
// di-generate ulang).
async function readFromDrive(fileId) {
  const url = `${DRIVE_BRIDGE_URL}?action=read&fileId=${encodeURIComponent(fileId)}&token=${encodeURIComponent(DRIVE_BRIDGE_TOKEN)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data; // { fileName, mimeType, base64Data }
}

// Shortcut: kompres foto lalu langsung upload ke folder "photos".
async function uploadPhotoToDrive(file, fileName) {
  const compressed = await compressImage(file);
  return uploadToDrive("photos", fileName, "image/jpeg", compressed);
}

// Blob -> data URL (dipakai buat nempel foto langsung ke PDF pas generate, tanpa perlu
// fetch balik ke Drive).
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Shortcut: kompres foto SEKALI, balikin baik Blob (buat upload ke Drive) maupun data URL
// (buat langsung ditempel ke PDF) -- biar gak double-compress kalau butuh dua-duanya.
async function compressImageForReport(file) {
  const compressedBlob = await compressImage(file);
  const dataUrl = await blobToDataUrl(compressedBlob);
  return { compressedBlob, dataUrl };
}

// Shortcut: upload PDF (Blob dari jsPDF .output('blob')) ke folder "reports".
async function uploadReportPdfToDrive(pdfBlob, fileName) {
  return uploadToDrive("reports", fileName, "application/pdf", pdfBlob);
}
