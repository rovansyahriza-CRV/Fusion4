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
async function uploadToDrive(category, fileName, mimeType, blobOrFile, subFolder) {
  const base64Data = await fileToBase64(blobOrFile);
  return uploadBase64ToDrive(category, fileName, mimeType, base64Data, subFolder);
}

// Sama kayak uploadToDrive(), tapi buat caller yang SUDAH punya base64 duluan
// (misal app.js manggil fileToBase64(file) sendiri sebelum upload -- lihat
// submitBadge() & submitKontrak() di app.js). Dipisah biar gak double-encode.
// subFolder: opsional -- dipakai Apps Script buat nentuin subfolder di dalam kategori
// (misal category "badge-foto" + subFolder "HO" -> folder Drive "Foto Karyawan/HO").
async function uploadBase64ToDrive(category, fileName, mimeType, base64Data, subFolder) {
  const payload = {
    token: DRIVE_BRIDGE_TOKEN,
    action: "upload",
    category,
    fileName,
    mimeType,
    base64Data,
    subFolder,
  };

  const res = await fetch(DRIVE_BRIDGE_URL, {
    method: "POST",
    body: JSON.stringify(payload),
    // sengaja TIDAK set headers: {"Content-Type": "application/json"} -- lihat catatan di atas
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data; // { fileId, viewUrl, directUrl }
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
