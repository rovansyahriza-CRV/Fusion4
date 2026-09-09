/* ==========================================================================
   PO/SO PDF Generation + Auto-Email (Desktop version)
   Mirrors the logic already working in digital-badge.html (Virtual Wallet),
   adapted for the desktop app.js context (uses currentUser instead of
   window.currentBadgeData for the approver's name).

   HOW TO USE:
   1. Add these two script tags to index.html <head>, BEFORE the tag that
      loads app.js (only add whichever one isn't already present):
        <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
   2. Add this file too, also BEFORE app.js:
        <script src="po-pdf-functions.js"></script>
   3. In app.js, inside approvePo(poId), right after the successful
      purchaseOrder update + showToast(...) + loadApprovalPoPage() call, add:
        sendPoApprovalEmailDesktop(poId).catch(e => console.warn('Gagal kirim PO/SO ke vendor:', e.message));

   NOTE: this file loads the company logo at runtime via fetch('BimaLogo.png'),
   so BimaLogo.png must sit in the same folder as this file and index.html,
   and the page must be served over http(s) (GitHub Pages, a local dev
   server, etc.) — opening index.html directly as a file:// path will make
   the fetch fail (the PDF still generates, just without the logo).
   ========================================================================== */

const PO_EMAIL_URL = "https://script.google.com/macros/s/AKfycbww8VikG_wpAvQro1-9vLC_llnvKFigFotzKXS-T_kaIHKA4q2QGbYXqZObEF5j_1Hr/exec";
const PO_HO_EMAIL = "rovan.syahriza@gmail.com";

function terbilang(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  const ones = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh',
    'sebelas', 'dua belas', 'tiga belas', 'empat belas', 'lima belas', 'enam belas', 'tujuh belas', 'delapan belas', 'sembilan belas'];

  function words(num) {
    if (num < 20) return ones[num];
    if (num < 100) {
      const sisa = num % 10;
      return words(Math.floor(num / 10)) + ' puluh' + (sisa ? ' ' + words(sisa) : '');
    }
    if (num < 200) return 'seratus' + (num % 100 ? ' ' + words(num % 100) : '');
    if (num < 1000) {
      const sisa = num % 100;
      return words(Math.floor(num / 100)) + ' ratus' + (sisa ? ' ' + words(sisa) : '');
    }
    if (num < 2000) return 'seribu' + (num % 1000 ? ' ' + words(num % 1000) : '');
    if (num < 1000000) {
      const sisa = num % 1000;
      return words(Math.floor(num / 1000)) + ' ribu' + (sisa ? ' ' + words(sisa) : '');
    }
    if (num < 1000000000) {
      const sisa = num % 1000000;
      return words(Math.floor(num / 1000000)) + ' juta' + (sisa ? ' ' + words(sisa) : '');
    }
    if (num < 1000000000000) {
      const sisa = num % 1000000000;
      return words(Math.floor(num / 1000000000)) + ' miliar' + (sisa ? ' ' + words(sisa) : '');
    }
    const sisa = num % 1000000000000;
    return words(Math.floor(num / 1000000000000)) + ' triliun' + (sisa ? ' ' + words(sisa) : '');
  }

  if (n === 0) return 'nol rupiah';
  return words(n).trim() + ' rupiah';
}

function generatePoQrDataUrl(text, size) {
  size = size || 200;
  return new Promise((resolve) => {
    try {
      if (typeof QRCode === 'undefined') {
        console.warn('QRCode library not loaded.');
        return resolve(null);
      }
      const holder = document.createElement('div');
      holder.style.position = 'fixed';
      holder.style.left = '-9999px';
      holder.style.top = '0';
      document.body.appendChild(holder);
      new QRCode(holder, {
        text: text,
        width: size,
        height: size,
        colorDark: '#1c2321',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M,
      });
      setTimeout(() => {
        try {
          const canvas = holder.querySelector('canvas');
          const img = holder.querySelector('img');
          let dataUrl = null;
          if (canvas) dataUrl = canvas.toDataURL('image/png');
          else if (img) dataUrl = img.src;
          document.body.removeChild(holder);
          resolve(dataUrl);
        } catch (e) {
          try { document.body.removeChild(holder); } catch(_) {}
          resolve(null);
        }
      }, 80);
    } catch (err) {
      console.warn('generatePoQrDataUrl error:', err);
      resolve(null);
    }
  });
}

let cachedBimaLogoDataUrl = null;
async function loadBimaLogoDataUrl() {
  if (typeof BIMA_LOGO_BASE64 !== 'undefined' && BIMA_LOGO_BASE64) {
    return BIMA_LOGO_BASE64.startsWith('data:') ? BIMA_LOGO_BASE64 : ('data:image/png;base64,' + BIMA_LOGO_BASE64);
  }
  if (cachedBimaLogoDataUrl) return cachedBimaLogoDataUrl;
  try {
    const res = await fetch('logo-bima.png');
    const blob = await res.blob();
    cachedBimaLogoDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    return cachedBimaLogoDataUrl;
  } catch (e) {
    try {
      const res2 = await fetch('BimaLogo.png');
      const blob2 = await res2.blob();
      cachedBimaLogoDataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob2);
      });
      return cachedBimaLogoDataUrl;
    } catch (e2) {
      console.warn('Gagal memuat logo untuk PDF:', e2.message);
      return null;
    }
  }
}

async function generatePoPdfBase64(poHeader, vendorInfo, termData, items) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  const docLabel = poHeader.doctype === 'SO' ? 'SERVICE ORDER' : 'PURCHASE ORDER';
  const vendorName = vendorInfo ? vendorInfo.VendorName : (poHeader.vendorname || '-');

  const validationUrl = `https://rovansyahriza-crv.github.io/SMMS-BIMA/po-validate.html?doc=${encodeURIComponent(poHeader.docnumber)}&total=${Math.round(Number(poHeader.totalamount) || 0)}`;
  const qrDataUrl = await generatePoQrDataUrl(validationUrl, 200);

  // Letterhead
  const logoDataUrl = await loadBimaLogoDataUrl();
  if (logoDataUrl) {
    try {
      doc.addImage(logoDataUrl, 'PNG', 14, 10, 20, 20);
    } catch (logoErr) {
      console.warn('Gagal addImage logo di PDF:', logoErr);
    }
  }
  doc.setFontSize(13);
  doc.setTextColor(61, 61, 61);
  doc.text('PT. Bilal Mitra Aryatama', 38, 16);
  doc.setFontSize(8);
  doc.setTextColor(138, 133, 128);
  const addrLines = doc.splitTextToSize(
    'Jl. Alamanda Raya Blok G3-18, Balikpapan Baru, Balikpapan, Kalimantan Timur · marketing@bilalmitra.com', 150
  );
  doc.text(addrLines, 38, 21);

  doc.setDrawColor(232, 86, 44);
  doc.setLineWidth(0.8);
  doc.line(14, 34, 196, 34);
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.2);

  // Title
  doc.setFontSize(15);
  doc.setTextColor(61, 61, 61);
  doc.text(docLabel, 105, 44, { align: 'center' });
  doc.setFontSize(10);
  doc.setTextColor(232, 86, 44);
  doc.text(poHeader.docnumber, 105, 50, { align: 'center' });
  doc.setTextColor(0, 0, 0);

  // Info grid
  let y = 62;
  doc.setFontSize(8);
  doc.setTextColor(138, 133, 128);
  doc.text('KEPADA YTH. (VENDOR)', 14, y);
  doc.text('DETAIL DOKUMEN', 110, y);
  y += 6;

  doc.setFontSize(11);
  doc.setTextColor(61, 61, 61);
  doc.text(vendorName, 14, y);

  doc.setFontSize(9);
  doc.setTextColor(0, 0, 0);
  const approvedDateStr = poHeader.approveddate ? new Date(poHeader.approveddate).toLocaleDateString('id-ID') : new Date().toLocaleDateString('id-ID');
  const metaLines = [
    ['Tanggal', new Date().toLocaleDateString('id-ID')],
    ['Referensi RFQ', poHeader.norfq || '-'],
    ['Titik Pengiriman', poHeader.deliverypoint || '-'],
    ['Disetujui oleh', poHeader.approvedby || '-'],
    ['Tgl. Disetujui', approvedDateStr]
  ];
  let metaY = y;
  metaLines.forEach(([label, val]) => {
    doc.text(label, 110, metaY);
    doc.text(':', 145, metaY);
    doc.text(String(val), 149, metaY);
    metaY += 6;
  });

  y += 6;
  const vendorAddr = vendorInfo && vendorInfo.Address ? vendorInfo.Address : '-';
  const vendorContact = vendorInfo && vendorInfo.ContactNo ? vendorInfo.ContactNo : '-';
  const vendorAddrLines = doc.splitTextToSize(vendorAddr, 90);
  doc.text(vendorAddrLines, 14, y);
  y += vendorAddrLines.length * 5;
  doc.text(`Kontak: ${vendorContact}`, 14, y);

  y = Math.max(y + 12, metaY + 4);

  // Item table header
  const COL_NO = 15, COL_DESC = 24, COL_QTY = 86, COL_TGL = 116, COL_HARGA = 142, COL_SUB = 196;
  doc.setFontSize(8.5);
  doc.setFillColor(61, 61, 61);
  doc.rect(14, y, 182, 7, 'F');
  doc.setTextColor(255, 255, 255);
  doc.text("No", COL_NO, y + 5);
  doc.text("Deskripsi Item", COL_DESC, y + 5);
  doc.text("Qty", COL_QTY, y + 5);
  doc.text("Tgl. Kirim", COL_TGL, y + 5);
  doc.text("Harga Satuan", COL_HARGA, y + 5);
  doc.text("Subtotal", COL_SUB, y + 5, { align: 'right' });
  doc.setTextColor(0, 0, 0);
  y += 12;

  function formatDeliveryDate(raw) {
    if (!raw) return '-';
    const d = new Date(raw);
    return isNaN(d.getTime()) ? String(raw) : d.toLocaleDateString('id-ID');
  }

  let subtotal = 0;
  (items || []).forEach((it, i) => {
    subtotal += Number(it.Subtotal || 0);
    const desc = it.ItemDescription || '-';
    const descLines = doc.splitTextToSize(desc, 58);
    const qtyStr = `${it.Qty || ''} ${it.Unit || ''}`.trim();
    const qtyLines = doc.splitTextToSize(qtyStr, 26);

    doc.setFontSize(8.5);
    doc.text(String(i + 1), COL_NO, y);
    doc.text(descLines, COL_DESC, y);
    doc.text(qtyLines, COL_QTY, y);
    doc.text(formatDeliveryDate(it.VendorDeliveryDate), COL_TGL, y);
    doc.text("Rp " + Number(it.UnitPrice || 0).toLocaleString("id-ID"), COL_HARGA, y);
    doc.text("Rp " + Number(it.Subtotal || 0).toLocaleString("id-ID"), COL_SUB, y, { align: 'right' });

    const maxLines = Math.max(descLines.length, qtyLines.length);
    const lineHeight = 5;
    y += Math.max(maxLines * lineHeight, 7);
    doc.setDrawColor(230, 230, 230);
    doc.line(14, y - 3, 196, y - 3);
    doc.setDrawColor(0, 0, 0);
  });

  y += 4;
  const mobilisasi = termData ? Number(termData.MobilisasiCost || 0) : 0;
  const otherService = termData ? Number(termData.OtherServiceCost || 0) : 0;
  const ppn = termData ? Number(termData.PPNAmount || 0) : 0;

  doc.setFontSize(9);
  doc.setTextColor(100, 100, 100);
  doc.text("Subtotal Item", 130, y);
  doc.text("Rp " + subtotal.toLocaleString("id-ID"), 196, y, { align: 'right' });
  y += 6;
  if (mobilisasi > 0) {
    doc.text("Mobilisasi", 130, y);
    doc.text("Rp " + mobilisasi.toLocaleString("id-ID"), 196, y, { align: 'right' });
    y += 6;
  }
  if (otherService > 0) {
    const otherLabel = (termData && termData.OtherServiceDescription) ? `Biaya Jasa (${termData.OtherServiceDescription})` : 'Biaya Jasa Lain';
    doc.text(otherLabel, 130, y);
    doc.text("Rp " + otherService.toLocaleString("id-ID"), 196, y, { align: 'right' });
    y += 6;
  }
  if (ppn > 0) {
    doc.text("PPN 11%", 130, y);
    doc.text("Rp " + Math.round(ppn).toLocaleString("id-ID"), 196, y, { align: 'right' });
    y += 6;
  }

  doc.setDrawColor(61, 61, 61);
  doc.setLineWidth(0.6);
  doc.line(130, y, 196, y);
  y += 7;
  doc.setFontSize(12);
  doc.setTextColor(232, 86, 44);
  doc.text("TOTAL", 130, y);
  doc.text("Rp " + Number(poHeader.totalamount || 0).toLocaleString("id-ID"), 196, y, { align: 'right' });
  doc.setTextColor(0, 0, 0);
  doc.setLineWidth(0.2);
  y += 10;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'italic');
  const terbilangLines = doc.splitTextToSize(`Terbilang: ${terbilang(poHeader.totalamount)}`, 182);
  doc.text(terbilangLines, 14, y);
  doc.setFont('helvetica', 'normal');
  y += terbilangLines.length * 5 + 6;

  // Terms box
  const paymentTermType = termData ? termData.PaymentTermType : null;
  const dpPercentage = termData ? termData.DPPercentage : null;
  const termLines = [];
  termLines.push(`Termin pembayaran: ${paymentTermType || 'Full Payment'}${(paymentTermType === 'Partial' && dpPercentage) ? ` (DP ${dpPercentage}% / Sisa ${100 - dpPercentage}%)` : ''}`);
  if (ppn > 0) termLines.push('PPN 11% sudah termasuk dalam total di atas');
  termLines.push(poHeader.doctype === 'SO'
    ? 'Durasi pekerjaan mengikuti kesepakatan pada RFQ (Service Order)'
    : 'Waktu pengiriman barang mengikuti kesepakatan pada RFQ (Purchase Order)');
  termLines.push('Dokumen ini berlaku sebagai perintah kerja resmi setelah disetujui/diterima kedua pihak');

  doc.setFontSize(8.5);
  const wrappedTermLines = termLines.map(line => doc.splitTextToSize(`• ${line}`, 172));
  const termsBoxHeight = wrappedTermLines.reduce((acc, w) => acc + w.length * 5, 0) + 14;

  if (y + termsBoxHeight > 260) { doc.addPage(); y = 20; }

  doc.setFillColor(244, 239, 233);
  doc.roundedRect(14, y, 182, termsBoxHeight, 3, 3, 'F');
  doc.setFontSize(9);
  doc.setTextColor(61, 61, 61);
  doc.text('SYARAT & TERMIN PEMBAYARAN', 20, y + 8);
  doc.setFontSize(8.5);
  doc.setTextColor(0, 0, 0);
  let termY = y + 14;
  wrappedTermLines.forEach(wrapped => {
    doc.text(wrapped, 20, termY);
    termY += wrapped.length * 5;
  });

  y += termsBoxHeight + 20;
  if (y > 250) { doc.addPage(); y = 20; }

  // Signatures
  doc.setFontSize(9);
  doc.setTextColor(138, 133, 128);
  doc.text('Disetujui oleh (Perusahaan) - Tanda Tangan Digital', 14, y);
  doc.text('Diterima oleh (Vendor)', 130, y);

  const qrY = y + 4;
  if (qrDataUrl) {
    doc.addImage(qrDataUrl, 'PNG', 22, qrY, 26, 26);
  }
  doc.setFontSize(7);
  doc.setTextColor(170, 170, 170);
  doc.text('Scan untuk validasi keaslian dokumen', 35, qrY + 30, { align: 'center' });

  const lineY = qrY + 34;
  doc.setDrawColor(150, 150, 150);
  doc.line(14, lineY, 70, lineY);
  doc.line(130, lineY, 186, lineY);
  doc.setDrawColor(0, 0, 0);

  doc.setFontSize(10);
  doc.setTextColor(61, 61, 61);
  doc.text(String(poHeader.approvedby || '-'), 42, lineY + 6, { align: 'center' });
  doc.text(vendorName, 158, lineY + 6, { align: 'center' });

  doc.setFontSize(8);
  doc.setTextColor(138, 133, 128);
  doc.text('Direktur', 42, lineY + 11, { align: 'center' });
  doc.text('(Nama & Cap Perusahaan)', 158, lineY + 11, { align: 'center' });

  doc.setFontSize(8);
  doc.setTextColor(170, 170, 170);
  doc.text('Dokumen ini dibuat otomatis oleh sistem SMMS BIMA. Nomor dokumen sah sebagai referensi resmi transaksi.', 105, 288, { align: 'center' });

  return doc.output('datauristring').split(',')[1];
}

async function sendPoApprovalEmailDesktop(poId) {
  const poid = Number(poId);

  const { data: poRow, error: poErr } = await supabaseClient
    .from('purchaseOrder')
    .select('*')
    .eq('POID', poid)
    .single();
  if (poErr || !poRow) throw new Error('PO/SO tidak ditemukan untuk kirim email.');

  const [{ data: rfqRow }, { data: vendorRow }, { data: termRows }, { data: items }] = await Promise.all([
    supabaseClient.from('rfq').select('NoRFQ').eq('RFQID', poRow.RFQID).maybeSingle(),
    supabaseClient.from('vendor').select('VendorName, Email, Address, ContactNo').eq('VendorID', poRow.VendorID).maybeSingle(),
    supabaseClient.from('rfqVendorTerm').select('*').eq('RFQVendorID', poRow.RFQVendorID).order('RFQVendorTermID', { ascending: false }).limit(1),
    supabaseClient.from('purchaseOrderDetail').select('*').eq('POID', poid)
  ]);
  const termRow = (termRows && termRows[0]) || null;

  const vendorName = vendorRow ? vendorRow.VendorName : '-';
  const vendorEmail = vendorRow ? vendorRow.Email : null;
  const approverName = (typeof currentUser !== 'undefined' && currentUser && (currentUser.nama || currentUser.Username)) || poRow.ManagementApprovalBy || '-';

  const poHeader = {
    doctype: poRow.DocType,
    docnumber: poRow.DocNumber,
    norfq: rfqRow ? rfqRow.NoRFQ : '-',
    totalamount: poRow.TotalAmount,
    approvedby: approverName,
    approveddate: poRow.ManagementApprovalDate,
    deliverypoint: poRow.DeliveryPoint
  };

  const pdfBase64 = await generatePoPdfBase64(poHeader, vendorRow, termRow, items);

  // Simpan juga PDF-nya ke Google Drive (sebelumnya cuma dikirim lewat email, gak pernah
  // disimpan) -- biar konsisten sama Request/RFQ/Seleksi Vendor yang semuanya punya report
  // tersimpan di Drive + kolom ReportURL. Isolated try/catch: kalau gagal upload, jangan
  // sampai bikin approve PO/pengiriman email jadi ikutan gagal.
  try {
    const uploadedPoPdf = await uploadBase64ToDrive(
      'reports',
      `${poHeader.doctype}-${poHeader.docnumber}.pdf`,
      'application/pdf',
      pdfBase64
    );
    await supabaseClient
      .from('purchaseOrder')
      .update({ ReportURL: uploadedPoPdf.directUrl, ReportFileID: uploadedPoPdf.fileId })
      .eq('POID', poid);
  } catch (reportErr) {
    console.warn('Gagal upload/simpan report PDF PO/SO ke Drive:', reportErr);
  }

  const docLabel = poHeader.doctype === 'SO' ? 'Service Order' : 'Purchase Order';

  const recipients = [PO_HO_EMAIL];
  if (vendorEmail) recipients.push(vendorEmail);

  const payload = {
    action: "SEND_EMAIL",
    to: recipients.join(","),
    subject: `${docLabel} - ${poHeader.docnumber} untuk ${vendorName}`,
    body: `${docLabel} ${poHeader.docnumber} untuk RFQ ${poHeader.norfq} telah disetujui. Dokumen terlampir dalam PDF.`,
    pdfBase64: pdfBase64,
    fileName: `${poHeader.doctype}-${poHeader.docnumber}-${vendorName}.pdf`
  };

  const res = await fetch(PO_EMAIL_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  });
  const result = await res.json();
  if (!result.success) throw new Error(result.error || "Gagal mengirim PDF PO/SO");

  await supabaseClient.from('purchaseOrder').update({ SentDate: new Date().toISOString() }).eq('POID', poid);
}