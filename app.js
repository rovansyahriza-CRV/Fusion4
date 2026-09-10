const SUPABASE_URL = 'https://nhmpwjriextmbotmvvbu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_XNqLw7iz873TtrLn9ag8dQ_AkL2rImz';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const RFQ_EMAIL_URL = "https://script.google.com/macros/s/AKfycbww8VikG_wpAvQro1-9vLC_llnvKFigFotzKXS-T_kaIHKA4q2QGbYXqZObEF5j_1Hr/exec"; // shared GAS email sender (dipakai bareng SMMS-BIMA)

// State Aplikasi
let currentUser = null;

document.addEventListener('DOMContentLoaded', () => {
  initAuthSession();
});

// ==========================================
// AUTH -- pakai RPC verify_login / get_active_karyawan yang sama persis dengan
// SMMS BIMA (paswordTbl & karyawanTbl memang satu tabel yang sama-sama dipakai).
// ==========================================

async function initAuthSession() {
  const savedUser = localStorage.getItem('fusion4_smartgate_user');
  if (savedUser) {
    currentUser = JSON.parse(savedUser);
    // Refresh PIC & Author dari database tiap buka app
    currentUser.pic = await fetchKaryawanPic(currentUser.id);
    currentUser.author = await fetchKaryawanAuthor(currentUser.id);
    localStorage.setItem('fusion4_smartgate_user', JSON.stringify(currentUser));
    updateUIAuth();
    applySidebarAccess();
  } else {
    currentUser = null;
    updateUIAuth();
    loadUserDropdown();
  }
}

async function loginUser(idKaryawan, password) {
  try {
    const { data, error } = await supabaseClient.rpc('verify_login', {
      p_id: idKaryawan,
      p_password: password
    });
    if (error) throw error;

    if (data && data.length > 0) {
      const userRow = data[0];
      currentUser = {
        id: userRow.id,
        nama: userRow.nama,
        kualifikasi: userRow.kualifikasi,
        pic: '',
        author: '',
      };
      currentUser.pic = await fetchKaryawanPic(currentUser.id);
      currentUser.author = await fetchKaryawanAuthor(currentUser.id);
      localStorage.setItem('fusion4_smartgate_user', JSON.stringify(currentUser));
      updateUIAuth();
      applySidebarAccess();
      showToast(`Selamat datang, ${currentUser.nama}!`, 'success');
      return true;
    } else {
      showToast('Login Gagal: ID atau Password salah.', 'error');
      return false;
    }
  } catch (error) {
    console.error('Error login:', error);
    showToast('Terjadi kesalahan koneksi saat login.', 'error');
    return false;
  }
}

// ==========================================
// AKSES SIDEBAR BERDASARKAN PIC (paswordTbl.pic / PIC) -- default gak diisi/kosong = akses
// semua menu (biar user lama yang belum di-set PIC gak keblokir tiba-tiba). Begitu PIC
// diisi initial menu tertentu, cuma menu itu yang kebuka; sisanya tetap kelihatan di
// sidebar tapi kekunci (klik = toast, gak pindah section).
// ==========================================

const SIDEBAR_ACCESS_MAP = [
  { key: 'MAE', label: 'Monitoring Attendance & Enroll', sectionId: 'sec-monitoring', btnId: 'btnNavMonitoring' },
  { key: 'KL', label: 'Kelola Lokasi', sectionId: 'sec-lokasi', btnId: 'btnNavLokasi' },
  { key: 'GP', label: 'Ganti Password (Admin)', sectionId: 'sec-password-admin', btnId: 'btnNavPasswordAdmin' },
  { key: 'DK', label: 'Data Karyawan', sectionId: 'sec-karyawan', btnId: 'btnNavKaryawan' },
  { key: 'KDB', label: 'Kelola Digital Badge', sectionId: 'sec-badge', btnId: 'btnNavBadge' },
  { key: 'KK', label: 'Kontrak Karyawan', sectionId: 'sec-kontrak', btnId: 'btnNavKontrak' },
  { key: 'ER', label: 'Permintaan Karyawan', sectionId: 'sec-employee-request', btnId: 'btnNavEmployeeRequest' },
  { key: 'OIL', label: 'Otorisasi Ijin & Lembur', sectionId: 'sec-otorisasi', btnId: 'btnNavOtorisasi' },
];

async function fetchKaryawanPic(id) {
  try {
    const { data, error } = await supabaseClient
      .from('paswordTbl')
      .select('PIC, pic')
      .eq('Id', parseInt(id, 10))
      .maybeSingle();
    if (!error && data) {
      const val = (data.PIC !== null && data.PIC !== undefined && data.PIC !== '') ? data.PIC : (data.pic || '');
      return String(val).trim();
    }
    const { data: rpcData } = await supabaseClient.rpc('get_karyawan_pic', { p_id: parseInt(id, 10) });
    return String(rpcData || '').trim();
  } catch (err) {
    console.error('Error fetchKaryawanPic:', err);
    return '';
  }
}

async function fetchKaryawanAuthor(id) {
  try {
    const { data, error } = await supabaseClient
      .from('paswordTbl')
      .select('Author')
      .eq('Id', parseInt(id, 10))
      .maybeSingle();
    if (!error && data && data.Author) {
      return String(data.Author).trim();
    }
    const { data: dAll } = await supabaseClient
      .from('paswordTbl')
      .select('*')
      .eq('Id', parseInt(id, 10))
      .maybeSingle();
    if (dAll && (dAll.Author || dAll.author)) {
      return String(dAll.Author || dAll.author).trim();
    }
    return '';
  } catch (err) {
    console.error('Error fetchKaryawanAuthor:', err);
    return '';
  }
}

function hasSectionAccess(key) {
  if (!currentUser) return false;
  const picRaw = String(currentUser.pic || '').toUpperCase();
  const authorRaw = String(currentUser.author || '').toUpperCase();

  if (!picRaw && !authorRaw) return true; // Default akses semua jika belum diset
  if (picRaw.includes('ALL') || picRaw.includes('*') || authorRaw.includes('ALL') || authorRaw.includes('ADMIN')) return true;

  const picTokens = picRaw.split(',').map(t => t.trim()).filter(Boolean);
  const authTokens = authorRaw.split(',').map(t => t.trim()).filter(Boolean);

  if (key === 'ER') {
    return (
      picTokens.some(t => t.startsWith('ER') || t === 'PER' || t === 'HR') ||
      authTokens.some(t => t.startsWith('AER') || t === 'APER' || t === 'HR' || t === 'BOD' || t === 'LEAD')
    );
  }

  if (key === 'OIL') {
    return (
      picTokens.some(t => t === 'OIL') ||
      authTokens.some(t => t.startsWith('AR') || t.startsWith('ASV') || t.startsWith('APO') || t.includes('APPROV') || t.includes('REVIEW'))
    );
  }

  if (key === 'DK') {
    return picTokens.includes('DK') || picTokens.includes('HR') || authTokens.includes('HR');
  }

  return picTokens.includes(key.toUpperCase());
}

function applySidebarAccess() {
  SIDEBAR_ACCESS_MAP.forEach(item => {
    const btn = document.getElementById(item.btnId);
    if (!btn) return;
    btn.classList.toggle('locked', !hasSectionAccess(item.key));
  });
}

function attemptNav(key, sectionId, btnEl, loaderFn) {
  if (!hasSectionAccess(key)) {
    showToast(`Kamu gak punya akses ke menu ini. Hubungi admin buat minta akses (PIC).`, 'error');
    return;
  }
  switchMainSection(sectionId, btnEl);
  if (typeof loaderFn === 'function') loaderFn();
}

function logoutUser() {
  localStorage.removeItem('fusion4_smartgate_user');
  currentUser = null;
  window.location.reload();
}

async function loadUserDropdown() {
  const selectEl = document.getElementById('loginId');
  if (!selectEl) return;

  try {
    const { data, error } = await supabaseClient.rpc('get_active_karyawan');
    if (error) throw error;

    selectEl.innerHTML = '<option value="">-- Pilih Nama Karyawan --</option>';
    (data || []).forEach(user => {
      const option = document.createElement('option');
      option.value = String(user.id).trim();
      option.textContent = `${String(user.nama).trim()} (ID: ${String(user.id).trim()})`;
      selectEl.appendChild(option);
    });
  } catch (error) {
    console.error('Error loadUserDropdown:', error);
    selectEl.innerHTML = '<option value="">Gagal koneksi ke server</option>';
  }
}

function updateUIAuth() {
  const loginModal = document.getElementById('loginModal');
  const userInfoEl = document.getElementById('userInfo');

  if (currentUser) {
    if (loginModal) loginModal.style.display = 'none';

    if (userInfoEl) {
      userInfoEl.innerHTML = `
        <div class="user-card-profile">
          <div class="user-card-detail">
            <div class="user-name-row">
              <svg class="user-avatar-icon" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
              </svg>
              <span class="user-card-name">${currentUser.nama}</span>
            </div>
            <span class="user-card-role">${currentUser.kualifikasi || 'User'}</span>
          </div>
          <button type="button" onclick="logoutUser()" class="btn-logout-card" title="Keluar Aplikasi">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
              <polyline points="16 17 21 12 16 7"></polyline>
              <line x1="21" y1="12" x2="9" y2="12"></line>
            </svg>
            <span>Logout</span>
          </button>
        </div>
      `;
    }

    applySidebarAccess();
    loadMonitoringPage('attendance');
  } else {
    if (loginModal) loginModal.style.display = 'flex';
  }
}

document.getElementById('formLogin')?.addEventListener('submit', async function (e) {
  e.preventDefault();
  const id = document.getElementById('loginId').value;
  const pass = document.getElementById('loginPass').value;
  const btn = document.getElementById('btnLoginSubmit');

  btn.textContent = 'Memverifikasi...';
  btn.disabled = true;

  const success = await loginUser(id, pass);
  btn.textContent = 'Masuk Aplikasi';
  btn.disabled = false;

  if (success) document.getElementById('formLogin').reset();
});

// ==========================================
// UTILITAS UMUM
// ==========================================

function switchMainSection(sectionId, btnEl) {
  document.querySelectorAll('.sidebar-nav-btn').forEach(btn => btn.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');

  document.querySelectorAll('.app-section').forEach(sec => sec.style.display = 'none');
  const targetSection = document.getElementById(sectionId);
  if (targetSection) targetSection.style.display = 'flex';
}

function showToast(message, type = 'success', duration = 3000) {
  const container = document.getElementById('toastContainer');
  if (!container) { alert(message); return; }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icon = type === 'success' ? '✅' : '⚠️';
  toast.innerHTML = `<span>${icon}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('hide');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ==========================================
// MONITORING ATTENDANCE & ENROLL (read-only)
// Attendance: baca dari "absensiTbl" (hasil migrasi Absensi dari Apps Script),
// dirender generik ikutin kolom apa adanya dari database.
// Enroll: gabungan karyawanTbl + faceData (kolomnya sudah pasti diketahui).
// ==========================================

let monitoringState = { category: 'attendance', columns: [], rows: [] };

function formatJamWita(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleTimeString('id-ID', {
    timeZone: 'Asia/Makassar', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
}

function formatTglIndo(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('id-ID', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

function getTodayDateString() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function loadMonitoringPage(category, btnEl) {
  document.querySelectorAll('#monitoringTabs .tab-btn').forEach(b => {
    b.classList.toggle('active', btnEl ? b === btnEl : b.getAttribute('data-monitor-cat') === category);
  });

  const titleEl = document.getElementById('monitoringTitle');
  const subtitleEl = document.getElementById('monitoringSubtitle');
  const searchEl = document.getElementById('monitoringSearch');
  if (searchEl) searchEl.value = '';

  const dateEl = document.getElementById('monitoringDateFilter');
  if (dateEl) {
    dateEl.style.display = category === 'attendance' ? '' : 'none';
    if (category === 'attendance' && !dateEl.value) dateEl.value = getTodayDateString();
  }

  const tbody = document.getElementById('monitoringTableBody');
  const thead = document.getElementById('monitoringTableHead');
  if (tbody) tbody.innerHTML = '<tr><td style="text-align:center;color:#777;">Memuat data...</td></tr>';

  try {
    if (category === 'attendance') {
      const tglFilter = (dateEl && dateEl.value) || getTodayDateString();

      if (titleEl) titleEl.textContent = '📋 Data Attendance';
      if (subtitleEl) subtitleEl.textContent = `Log absensi tanggal ${tglFilter}.`;

      const [{ data, error }, { data: karyawanRows, error: karErr }] = await Promise.all([
        supabaseClient.from('absensiTbl').select('*').eq('Tanggal', tglFilter).order('Id', { ascending: false }).limit(500),
        supabaseClient.from('karyawanTbl').select('QrCodeId, NamaPersonnel'),
      ]);
      if (error) throw error;
      if (karErr) throw karErr;

      // Join manual ke karyawanTbl -- absensiTbl cuma nyimpen QrCodeId, gak ada Nama.
      const namaMap = {};
      (karyawanRows || []).forEach(k => {
        namaMap[String(k.QrCodeId || '').trim().toUpperCase()] = k.NamaPersonnel;
      });

      const rows = (data || []).map(r => {
        const lokasiList = [r.LokasiMasuk1, r.LokasiIstirahat, r.LokasiMasuk2, r.LokasiPulang].filter(Boolean);
        const lokasiUnik = [...new Set(lokasiList)].join(', ') || '-';

        return {
          Nama: namaMap[String(r.QrCodeId || '').trim().toUpperCase()] || r.QrCodeId,
          QrCodeId: r.QrCodeId,
          Tanggal: r.Tanggal,
          'JamMasuk1 (WITA)': formatJamWita(r.JamMasuk1),
          'JamIstirahat (WITA)': formatJamWita(r.JamIstirahat),
          'JamMasuk2 (WITA)': formatJamWita(r.JamMasuk2),
          'JamPulang (WITA)': formatJamWita(r.JamPulang),
          Lokasi: lokasiUnik,
          Status: r.Status,
        };
      });

      const columns = ['Nama', 'QrCodeId', 'Tanggal', 'JamMasuk1 (WITA)', 'JamIstirahat (WITA)', 'JamMasuk2 (WITA)', 'JamPulang (WITA)', 'Lokasi', 'Status'];

      monitoringState = { category, columns, rows };
    } else {
      if (titleEl) titleEl.textContent = '🧑‍💼 Status Enroll Wajah Karyawan';
      if (subtitleEl) subtitleEl.textContent = 'Karyawan yang sudah / belum enroll wajah (faceData).';

      const [{ data: karyawanRows, error: karErr }, { data: faceRows, error: faceErr }] = await Promise.all([
        supabaseClient.from('karyawanTbl').select('Id, NamaPersonnel, QrCodeId, Kualifikasi'),
        supabaseClient.rpc('list_enrolled_qrcodeid'),
      ]);
      if (karErr) throw karErr;
      if (faceErr) throw faceErr;

      // Bandingin QrCodeId case-insensitive -- karyawanTbl & faceData kadang beda huruf
      // besar/kecil buat data yang sama (mis. "14Ane22062026" vs "14ANE22062026").
      const enrolledSet = new Set((faceRows || []).map(f => String(f.qrcodeid || '').trim().toUpperCase()));
      const rows = (karyawanRows || []).map(k => ({
        Nama: k.NamaPersonnel,
        QrCodeId: k.QrCodeId,
        Kualifikasi: k.Kualifikasi,
        'Status Enroll': enrolledSet.has(String(k.QrCodeId || '').trim().toUpperCase()) ? '✅ Sudah Enroll' : '❌ Belum Enroll',
      }));

      monitoringState = { category, columns: ['Nama', 'QrCodeId', 'Kualifikasi', 'Status Enroll'], rows };
    }

    renderMonitoringTable();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td style="text-align:center;color:red;">Gagal memuat data: ${err.message}</td></tr>`;
  }
}

function renderMonitoringTable() {
  const { columns, rows } = monitoringState;
  const tbody = document.getElementById('monitoringTableBody');
  const thead = document.getElementById('monitoringTableHead');
  const countEl = document.getElementById('monitoringCount');
  if (!tbody || !thead) return;

  thead.innerHTML = `<tr>${columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;

  const keyword = (document.getElementById('monitoringSearch')?.value || '').toLowerCase().trim();
  const filtered = (rows || []).filter(r => {
    if (!keyword) return true;
    return columns.some(c => String(r[c] ?? '').toLowerCase().includes(keyword));
  });

  if (countEl) countEl.textContent = `${filtered.length} Data`;

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${columns.length || 1}" style="text-align:center;color:#777;">Belum ada data.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(r => `
    <tr>${columns.map(c => {
      let val = r[c];
      if (val && typeof val === 'string' && val.includes('T') && /\d{4}-\d{2}-\d{2}T/.test(val)) val = val.replace('T', ' ').split('.')[0];
      
      if (c === 'Lokasi' && val && val !== '-') {
        return `<td><span style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;background:#F1F5F9;font-weight:600;font-size:12px;color:#334155;border:1px solid #CBD5E1;">📍 ${escapeHtml(val)}</span></td>`;
      }
      if (c === 'Status' && val) {
        const uVal = String(val).toUpperCase();
        let bg = '#DCFCE7';
        let color = '#15803D';
        let border = '#86EFAC';
        let displayVal = escapeHtml(val);

        if (uVal === 'CLOSED') {
          bg = '#E2E8F0'; color = '#475569'; border = '#CBD5E1';
        } else if (uVal.includes('CUTI')) {
          bg = '#E0F2FE'; color = '#0369A1'; border = '#BAE6FD';
          displayVal = '🏖️ ' + escapeHtml(val);
        } else if (uVal.includes('SAKIT')) {
          bg = '#FEF3C7'; color = '#B45309'; border = '#FDE68A';
          displayVal = '🏥 ' + escapeHtml(val);
        }
        return `<td><span style="display:inline-block;padding:2px 8px;border-radius:6px;background:${bg};color:${color};border:1px solid ${border};font-weight:700;font-size:11px;">${displayVal}</span></td>`;
      }
      return `<td>${escapeHtml(val ?? '-')}</td>`;
    }).join('')}</tr>`).join('');
}

// ==========================================
// KELOLA LOKASI -- sama persis dengan modul di SMMS BIMA (RPC & tabel lokasiTbl
// memang dipakai bareng buat geofencing SmartGate juga).
// ==========================================

let lokasiState = { rows: [] };
let lokasiMapInstance = null;
let lokasiMapMarker = null;
let lokasiMapCircle = null;

function initLokasiMapIfNeeded() {
  if (lokasiMapInstance || typeof L === 'undefined') return;
  const mapEl = document.getElementById('lokasiMap');
  if (!mapEl) return;

  lokasiMapInstance = L.map('lokasiMap').setView([-6.2088, 106.8456], 12);

  const petaJalan = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(lokasiMapInstance);

  // Toggle "Satelit" pakai Esri World Imagery -- cuma aktif kalau ESRI_API_KEY diisi di
  // config.js (daftar gratis di https://developers.arcgis.com, gak perlu kartu kredit).
  const esriKey = (typeof ESRI_API_KEY !== 'undefined' && ESRI_API_KEY) ? ESRI_API_KEY.trim() : '';
  if (esriKey) {
    const petaSatelit = L.tileLayer(
      `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=${esriKey}`,
      { attribution: '&copy; Esri &mdash; World Imagery', maxZoom: 19 }
    );
    L.control.layers(
      { '🗺️ Peta': petaJalan, '🛰️ Satelit': petaSatelit },
      null,
      { position: 'topright', collapsed: false }
    ).addTo(lokasiMapInstance);
  }

  lokasiMapInstance.on('click', (e) => setLokasiMapPoint(e.latlng.lat, e.latlng.lng));
  setTimeout(() => { if (lokasiMapInstance) lokasiMapInstance.invalidateSize(); }, 150);
}

function setLokasiMapPoint(lat, lng, panTo) {
  if (!lokasiMapInstance) return;
  const radius = parseFloat(document.getElementById('lokasiRadius')?.value) || 100;

  if (!lokasiMapMarker) {
    lokasiMapMarker = L.marker([lat, lng], { draggable: true }).addTo(lokasiMapInstance);
    lokasiMapMarker.on('dragend', () => {
      const pos = lokasiMapMarker.getLatLng();
      setLokasiMapPoint(pos.lat, pos.lng);
    });
  } else {
    lokasiMapMarker.setLatLng([lat, lng]);
  }

  if (!lokasiMapCircle) {
    lokasiMapCircle = L.circle([lat, lng], { radius, color: '#B23A24', fillColor: '#B23A24', fillOpacity: 0.12 }).addTo(lokasiMapInstance);
  } else {
    lokasiMapCircle.setLatLng([lat, lng]);
    lokasiMapCircle.setRadius(radius);
  }

  if (panTo) lokasiMapInstance.setView([lat, lng], 16);

  const latEl = document.getElementById('lokasiLat');
  const lngEl = document.getElementById('lokasiLng');
  if (latEl) latEl.value = lat.toFixed(6);
  if (lngEl) lngEl.value = lng.toFixed(6);
}

document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'lokasiRadius' && lokasiMapCircle) {
    lokasiMapCircle.setRadius(parseFloat(e.target.value) || 100);
  }
});

async function searchAlamatLokasi() {
  const keyword = (document.getElementById('lokasiSearchAlamat')?.value || '').trim();
  if (!keyword) { showToast('Isi dulu alamat/tempat yang mau dicari.', 'error'); return; }

  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(keyword)}`);
    const results = await res.json();
    if (!results || !results.length) { showToast('Alamat tidak ditemukan.', 'error'); return; }

    const lat = parseFloat(results[0].lat);
    const lng = parseFloat(results[0].lon);
    initLokasiMapIfNeeded();
    setLokasiMapPoint(lat, lng, true);
  } catch (err) {
    showToast('Gagal mencari alamat: ' + err.message, 'error');
  }
}

async function loadLokasiPage() {
  initLokasiMapIfNeeded();
  const tbody = document.getElementById('lokasiTableBody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#777;">Memuat data...</td></tr>';

  try {
    let data = null;
    let error = null;
    try {
      const res = await supabaseClient.rpc('list_lokasi_with_timelimit');
      data = res.data;
      error = res.error;
    } catch (e) {
      error = e;
    }

    if (error || !data) {
      // Fallback ke list_lokasi_full jika RPC baru belum dieksekusi
      const fallback = await supabaseClient.rpc('list_lokasi_full');
      if (fallback.error) throw fallback.error;
      data = fallback.data;
    }

    lokasiState.rows = data || [];
    renderLokasiTable();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:red;">Gagal memuat data: ${err.message}</td></tr>`;
  }
}

function renderLokasiTable() {
  const tbody = document.getElementById('lokasiTableBody');
  const countEl = document.getElementById('lokasiCount');
  if (!tbody) return;

  const keyword = (document.getElementById('lokasiSearch')?.value || '').toLowerCase().trim();
  const filtered = (lokasiState.rows || []).filter(r => !keyword || String(r.namalokasi || '').toLowerCase().includes(keyword));

  if (countEl) countEl.textContent = `${filtered.length} Lokasi`;

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#777;">Belum ada data.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const masuk1 = r.jammasuk1 ? String(r.jammasuk1).slice(0, 5) : '07:30';
    const istirahat = r.jamistirahat ? String(r.jamistirahat).slice(0, 5) : '12:00';
    const masuk2 = r.jammasuk2 ? String(r.jammasuk2).slice(0, 5) : '13:00';
    const pulang = r.jampulang ? String(r.jampulang).slice(0, 5) : '17:00';
    const tlTitle = `Masuk 1: ${masuk1} | Istirahat: ${istirahat} | Masuk 2: ${masuk2} | Pulang: ${pulang}`;
    const tlBadge = `<span class="badge-timelimit" title="${escapeHtml(tlTitle)}"><span class="tl-icon">⏰</span>${masuk1} - ${pulang}</span>`;

    return `
      <tr>
        <td><strong>${escapeHtml(r.namalokasi)}</strong></td>
        <td>${r.latitude != null ? Number(r.latitude).toFixed(6) : '-'}</td>
        <td>${r.longitude != null ? Number(r.longitude).toFixed(6) : '-'}</td>
        <td>${r.radius != null ? r.radius : '-'}</td>
        <td>${tlBadge}</td>
        <td>${escapeHtml(r.status) || '-'}</td>
        <td>${escapeHtml(r.type) || '-'}</td>
        <td style="text-align:center;white-space:nowrap;">
          <button type="button" class="btn-logout-card" style="padding:6px 10px;" onclick="editLokasi(${r.id})">✏️ Edit</button>
          <button type="button" class="btn-logout-card" style="padding:6px 10px;color:#b23a24;" onclick="deleteLokasi(${r.id})">🗑️ Hapus</button>
        </td>
      </tr>`;
  }).join('');
}

function editLokasi(id) {
  const row = (lokasiState.rows || []).find(r => r.id === id);
  if (!row) { showToast('Data lokasi tidak ditemukan.', 'error'); return; }

  document.getElementById('lokasiFormTitle').textContent = `✏️ Edit Lokasi: ${row.namalokasi || ''}`;
  document.getElementById('lokasiEditId').value = row.id;
  document.getElementById('lokasiNama').value = row.namalokasi || '';
  document.getElementById('lokasiRadius').value = row.radius != null ? row.radius : 100;
  document.getElementById('lokasiStatus').value = row.status || 'Active';
  document.getElementById('lokasiType').value = row.type || '';
  document.getElementById('lokasiSearchAlamat').value = '';

  // Isi form TimeLimit
  if (document.getElementById('lokasiJamMasuk1')) document.getElementById('lokasiJamMasuk1').value = row.jammasuk1 ? String(row.jammasuk1).slice(0, 5) : '07:30';
  if (document.getElementById('lokasiJamIstirahat')) document.getElementById('lokasiJamIstirahat').value = row.jamistirahat ? String(row.jamistirahat).slice(0, 5) : '12:00';
  if (document.getElementById('lokasiJamMasuk2')) document.getElementById('lokasiJamMasuk2').value = row.jammasuk2 ? String(row.jammasuk2).slice(0, 5) : '13:00';
  if (document.getElementById('lokasiJamPulang')) document.getElementById('lokasiJamPulang').value = row.jampulang ? String(row.jampulang).slice(0, 5) : '17:00';

  initLokasiMapIfNeeded();
  if (row.latitude != null && row.longitude != null) setLokasiMapPoint(Number(row.latitude), Number(row.longitude), true);

  document.getElementById('lokasiFormTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteLokasi(id) {
  const row = (lokasiState.rows || []).find(r => r.id === id);
  if (!confirm(`Yakin mau hapus lokasi "${row ? row.namalokasi : id}"? Tindakan ini tidak bisa dibatalkan.`)) return;

  try {
    const { error } = await supabaseClient.rpc('delete_lokasi', { p_id: id });
    if (error) throw error;
    showToast('Lokasi berhasil dihapus.', 'success');
    if (document.getElementById('lokasiEditId')?.value == id) resetLokasiForm();
    loadLokasiPage();
  } catch (err) {
    showToast('Gagal menghapus lokasi: ' + err.message, 'error');
  }
}

async function submitLokasi() {
  const editId = document.getElementById('lokasiEditId')?.value;
  const nama = document.getElementById('lokasiNama')?.value.trim();
  const radius = parseInt(document.getElementById('lokasiRadius')?.value, 10) || 100;
  const status = document.getElementById('lokasiStatus')?.value || 'Active';
  const type = document.getElementById('lokasiType')?.value.trim() || '';
  const lat = parseFloat(document.getElementById('lokasiLat')?.value);
  const lng = parseFloat(document.getElementById('lokasiLng')?.value);

  const formatTimeVal = (val, def) => {
    const v = (val || def || '00:00').trim();
    if (v.length === 5) return v + ':00';
    if (v.length >= 8) return v.slice(0, 8);
    return v;
  };

  const jamMasuk1 = formatTimeVal(document.getElementById('lokasiJamMasuk1')?.value, '07:30');
  const jamIstirahat = formatTimeVal(document.getElementById('lokasiJamIstirahat')?.value, '12:00');
  const jamMasuk2 = formatTimeVal(document.getElementById('lokasiJamMasuk2')?.value, '13:00');
  const jamPulang = formatTimeVal(document.getElementById('lokasiJamPulang')?.value, '17:00');

  if (!nama) { showToast('Nama lokasi wajib diisi.', 'error'); return; }
  if (isNaN(lat) || isNaN(lng)) { showToast('Tentukan dulu titik lokasi di peta (klik atau cari alamat).', 'error'); return; }

  const btn = document.getElementById('btnSubmitLokasi');
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan...'; }

  try {
    // Coba simpan via save_lokasi_with_timelimit
    let saved = false;
    try {
      const { data: resData, error: errRpc } = await supabaseClient.rpc('save_lokasi_with_timelimit', {
        p_id: editId ? parseInt(editId, 10) : null,
        p_namalokasi: nama,
        p_latitude: lat,
        p_longitude: lng,
        p_radius: radius,
        p_status: status,
        p_type: type,
        p_jam_masuk1: jamMasuk1,
        p_jam_istirahat: jamIstirahat,
        p_jam_masuk2: jamMasuk2,
        p_jam_pulang: jamPulang
      });
      if (!errRpc) {
        saved = true;
        showToast(editId ? 'Lokasi & jam kerja berhasil diperbarui.' : 'Lokasi & jam kerja baru berhasil ditambahkan.', 'success');
      }
    } catch (e) {
      saved = false;
    }

    if (!saved) {
      // Fallback jika RPC baru belum terpasang
      if (editId) {
        const { error } = await supabaseClient.rpc('update_lokasi', {
          p_id: parseInt(editId, 10), p_namalokasi: nama, p_latitude: lat, p_longitude: lng,
          p_radius: radius, p_status: status, p_type: type,
        });
        if (error) throw error;
        showToast('Lokasi berhasil diperbarui.', 'success');
      } else {
        const { error } = await supabaseClient.rpc('create_lokasi', {
          p_namalokasi: nama, p_latitude: lat, p_longitude: lng,
          p_radius: radius, p_status: status, p_type: type,
        });
        if (error) throw error;
        showToast('Lokasi baru berhasil ditambahkan.', 'success');
      }
    }

    resetLokasiForm();
    loadLokasiPage();
  } catch (err) {
    showToast('Gagal menyimpan lokasi: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel || '💾 Simpan Lokasi'; }
  }
}

function resetLokasiForm() {
  document.getElementById('lokasiFormTitle').textContent = '+ Tambah Lokasi Baru';
  document.getElementById('lokasiEditId').value = '';
  document.getElementById('lokasiNama').value = '';
  document.getElementById('lokasiRadius').value = 100;
  document.getElementById('lokasiStatus').value = 'Active';
  document.getElementById('lokasiType').value = '';
  document.getElementById('lokasiSearchAlamat').value = '';
  document.getElementById('lokasiLat').value = '';
  document.getElementById('lokasiLng').value = '';

  if (document.getElementById('lokasiJamMasuk1')) document.getElementById('lokasiJamMasuk1').value = '07:30';
  if (document.getElementById('lokasiJamIstirahat')) document.getElementById('lokasiJamIstirahat').value = '12:00';
  if (document.getElementById('lokasiJamMasuk2')) document.getElementById('lokasiJamMasuk2').value = '13:00';
  if (document.getElementById('lokasiJamPulang')) document.getElementById('lokasiJamPulang').value = '17:00';

  if (lokasiMapMarker && lokasiMapInstance) { lokasiMapInstance.removeLayer(lokasiMapMarker); lokasiMapMarker = null; }
  if (lokasiMapCircle && lokasiMapInstance) { lokasiMapInstance.removeLayer(lokasiMapCircle); lokasiMapCircle = null; }
  if (lokasiMapInstance) lokasiMapInstance.setView([-6.2088, 106.8456], 12);
}

// ==========================================
// GANTI PASSWORD (ADMIN RESET) -- admin pilih karyawan, isi password baru,
// TANPA perlu tau password lama (beda dari change-password.html self-service).
// ==========================================

async function loadPasswordAdminPage() {
  const selectEl = document.getElementById('pwAdminKaryawan');
  if (!selectEl) return;
  selectEl.innerHTML = '<option value="">-- Memuat daftar karyawan... --</option>';

  try {
    const { data, error } = await supabaseClient.rpc('get_active_karyawan');
    if (error) throw error;
    selectEl.innerHTML = '<option value="">-- Pilih Karyawan --</option>';
    (data || []).forEach(k => {
      const opt = document.createElement('option');
      opt.value = k.id;
      opt.textContent = `${k.nama} (ID: ${k.id})`;
      selectEl.appendChild(opt);
    });
  } catch (err) {
    selectEl.innerHTML = '<option value="">Gagal memuat daftar karyawan</option>';
  }
  document.getElementById('pwAdminNew').value = '';
}

async function submitPasswordAdmin() {
  const karyawanId = document.getElementById('pwAdminKaryawan')?.value;
  const newPassword = document.getElementById('pwAdminNew')?.value.trim();

  if (!karyawanId) { showToast('Pilih dulu karyawannya.', 'error'); return; }
  if (!newPassword) { showToast('Password baru wajib diisi.', 'error'); return; }

  const btn = document.getElementById('btnPwAdminSubmit');
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Memproses...'; }

  try {
    const { data: hasil, error } = await supabaseClient.rpc('admin_reset_password_absensi', {
      p_karyawan_id: parseInt(karyawanId, 10),
      p_new_password: newPassword,
    });
    if (error) throw error;

    if (hasil && hasil.status === 'SUCCESS') {
      showToast(hasil.message || 'Password berhasil direset.', 'success');
      document.getElementById('pwAdminNew').value = '';
    } else {
      showToast((hasil && hasil.message) || 'Gagal reset password.', 'error');
    }
  } catch (err) {
    showToast('Gagal reset password: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel || '💾 Reset Password'; }
  }
}

// ==========================================
// KELOLA DIGITAL BADGE -- foto, kualifikasi/jabatan, status aktif.
// ==========================================

// ==========================================
// DATA KARYAWAN -- list + tambah karyawan baru (karyawanTbl + paswordTbl sekaligus).
// ==========================================

let karyawanState = { rows: [] };

async function loadKaryawanPage() {
  const tbody = document.getElementById('karyawanTableBody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#777;">Memuat data...</td></tr>';

  try {
    const { data, error } = await supabaseClient.rpc('list_karyawan_all');
    if (error) throw error;
    karyawanState.rows = data || [];
    renderKaryawanTable();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:red;">Gagal memuat data: ${err.message}</td></tr>`;
  }
}

function renderKaryawanTable() {
  const tbody = document.getElementById('karyawanTableBody');
  const countEl = document.getElementById('karyawanCount');
  if (!tbody) return;

  const keyword = (document.getElementById('karyawanSearch')?.value || '').toLowerCase().trim();
  const filtered = (karyawanState.rows || []).filter(r => !keyword ||
    String(r.namapersonnel || '').toLowerCase().includes(keyword) ||
    String(r.qrcodeid || '').toLowerCase().includes(keyword));

  if (countEl) countEl.textContent = `${filtered.length} Karyawan`;

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#777;">Belum ada data.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const statusBadge = r.isactive
      ? `<span class="badge-unit" style="background:#E5F6EC;color:#178A4C;">Active</span>`
      : `<span class="badge-unit" style="background:#FCEAE8;color:#D9312E;">Inactive</span>`;
    const tglMasuk = r.tglmasuk ? new Date(r.tglmasuk).toLocaleDateString('id-ID') : '-';
    return `
      <tr>
        <td><strong>${escapeHtml(r.namapersonnel)}</strong></td>
        <td>${escapeHtml(r.qrcodeid) || '-'}</td>
        <td>${escapeHtml(String(r.digitalpin ?? '')) || '-'}</td>
        <td>${escapeHtml(r.type) || '-'}</td>
        <td>${escapeHtml(r.kualifikasi) || '-'}</td>
        <td>${escapeHtml(r.departemen) || '-'}${r.divisi ? ' / ' + escapeHtml(r.divisi) : ''}</td>
        <td>${tglMasuk}</td>
        <td>${statusBadge}</td>
        <td style="text-align:center;">
          <button type="button" class="btn-logout-card" style="padding:6px 10px;" onclick="editKaryawan(${r.id})">✏️ Edit</button>
        </td>
      </tr>`;
  }).join('');
}

function setKaryawanEditMode(isEdit) {
  document.querySelectorAll('.karyawan-create-only').forEach(el => { el.style.display = isEdit ? 'none' : ''; });
  const namaEl = document.getElementById('karyawanNama');
  if (namaEl) namaEl.disabled = isEdit;
  const hint = document.getElementById('karyawanFormHint');
  if (hint) hint.textContent = isEdit
    ? 'Mode edit cuma update Departemen, Divisi, Author, dan PIC. Field lain gak berubah.'
    : 'QrCodeId & Digital PIN di-generate otomatis. Field detail lain (KTP, alamat, dll) bisa dilengkapi belakangan.';
  const btnSubmit = document.getElementById('btnSubmitKaryawan');
  if (btnSubmit) btnSubmit.textContent = isEdit ? '💾 Simpan Perubahan' : '💾 Simpan Karyawan Baru';
  const btnReset = document.getElementById('btnResetKaryawan');
  if (btnReset) btnReset.textContent = isEdit ? '✕ Batal Edit' : '↺ Kosongkan Form';
}

function editKaryawan(id) {
  const row = (karyawanState.rows || []).find(r => r.id === id);
  if (!row) { showToast('Data karyawan tidak ditemukan.', 'error'); return; }

  setKaryawanEditMode(true);
  document.getElementById('karyawanFormTitle').textContent = `✏️ Edit Karyawan: ${row.namapersonnel || ''}`;
  document.getElementById('karyawanEditId').value = row.id;
  document.getElementById('karyawanNama').value = row.namapersonnel || '';
  document.getElementById('karyawanDepartemen').value = row.departemen || '';
  document.getElementById('karyawanDivisi').value = row.divisi || '';
  document.getElementById('karyawanAuthor').value = row.author || '';
  document.getElementById('karyawanPic').value = row.pic || '';

  document.getElementById('karyawanFormTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetKaryawanForm() {
  ['karyawanNama','karyawanType','karyawanKualifikasi','karyawanDepartemen','karyawanDivisi',
   'karyawanTglMasuk','karyawanAuthor','karyawanPic','karyawanEditId']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const passEl = document.getElementById('karyawanPassword');
  if (passEl) passEl.value = '12345';
  setKaryawanEditMode(false);
  document.getElementById('karyawanFormTitle').textContent = '+ Tambah Karyawan Baru';
}

async function submitKaryawanBaru() {
  const editId = document.getElementById('karyawanEditId')?.value || '';
  const nama = document.getElementById('karyawanNama')?.value.trim() || '';
  const departemen = document.getElementById('karyawanDepartemen')?.value.trim() || '';
  const divisi = document.getElementById('karyawanDivisi')?.value.trim() || '';
  const author = document.getElementById('karyawanAuthor')?.value.trim() || '';
  const pic = document.getElementById('karyawanPic')?.value.trim() || '';

  if (!nama) { showToast('Nama karyawan wajib diisi.', 'error'); return; }

  const btn = document.getElementById('btnSubmitKaryawan');
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan...'; }

  try {
    if (editId) {
      const { data: hasil, error } = await supabaseClient.rpc('update_karyawan_core', {
        p_id: parseInt(editId, 10),
        p_departemen: departemen || null,
        p_divisi: divisi || null,
        p_author: author || null,
        p_pic: pic || null,
      });
      if (error) throw error;

      if (hasil && hasil.status === 'SUCCESS') {
        showToast(hasil.message || 'Data karyawan berhasil diupdate.', 'success');
        resetKaryawanForm();
        loadKaryawanPage();
      } else {
        showToast((hasil && hasil.message) || 'Gagal update karyawan.', 'error');
      }
      return;
    }

    const type = document.getElementById('karyawanType')?.value.trim() || '';
    const kualifikasi = document.getElementById('karyawanKualifikasi')?.value.trim() || '';
    const tglMasuk = document.getElementById('karyawanTglMasuk')?.value || null;
    const password = document.getElementById('karyawanPassword')?.value || '';

    if (!password) { showToast('Password login absen wajib diisi.', 'error'); return; }

    const { data: hasil, error } = await supabaseClient.rpc('create_karyawan_full', {
      p_nama: nama,
      p_type: type || null,
      p_kualifikasi: kualifikasi || null,
      p_departemen: departemen || null,
      p_divisi: divisi || null,
      p_tglmasuk: tglMasuk,
      p_password: password,
      p_author: author || null,
      p_pic: pic || null,
    });
    if (error) throw error;

    if (hasil && hasil.status === 'SUCCESS') {
      const pinInfo = hasil.digitalpin ? ` Digital PIN: ${hasil.digitalpin}` : '';
      const qrInfo = hasil.qrcodeid ? ` QrCodeId: ${hasil.qrcodeid}` : '';
      showToast((hasil.message || 'Karyawan baru berhasil dibuat.') + qrInfo + pinInfo, 'success');
      resetKaryawanForm();
      loadKaryawanPage();
    } else {
      showToast((hasil && hasil.message) || 'Gagal membuat karyawan.', 'error');
    }
  } catch (err) {
    showToast('Gagal menyimpan karyawan: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel || (editId ? '💾 Simpan Perubahan' : '💾 Simpan Karyawan Baru'); }
  }
}

let badgeState = { rows: [] };

async function loadBadgePage() {
  const tbody = document.getElementById('badgeTableBody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#777;">Memuat data...</td></tr>';

  try {
    const { data, error } = await supabaseClient.rpc('list_karyawan_badge');
    if (error) throw error;
    badgeState.rows = data || [];
    renderBadgeTable();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:red;">Gagal memuat data: ${err.message}</td></tr>`;
  }
}

function renderBadgeTable() {
  const tbody = document.getElementById('badgeTableBody');
  const countEl = document.getElementById('badgeCount');
  if (!tbody) return;

  const keyword = (document.getElementById('badgeSearch')?.value || '').toLowerCase().trim();
  const filtered = (badgeState.rows || []).filter(r => !keyword ||
    String(r.namapersonnel || '').toLowerCase().includes(keyword) ||
    String(r.qrcodeid || '').toLowerCase().includes(keyword));

  if (countEl) countEl.textContent = `${filtered.length} Karyawan`;

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#777;">Belum ada data.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const fotoCell = r.fotourl
      ? `<img src="${r.fotourl}" alt="Foto" style="width:36px;height:36px;border-radius:50%;object-fit:cover;">`
      : `<span style="display:inline-flex;width:36px;height:36px;border-radius:50%;background:#EFECE6;color:#999;align-items:center;justify-content:center;font-size:12px;">-</span>`;
    const statusBadge = r.isactive
      ? `<span class="badge-unit" style="background:#E5F6EC;color:#178A4C;">Active</span>`
      : `<span class="badge-unit" style="background:#FCEAE8;color:#D9312E;">Inactive</span>`;
    return `
      <tr>
        <td>${fotoCell}</td>
        <td><strong>${escapeHtml(r.namapersonnel)}</strong></td>
        <td>${escapeHtml(r.qrcodeid) || '-'}</td>
        <td>${escapeHtml(r.kualifikasi) || '-'}</td>
        <td>${statusBadge}</td>
        <td style="text-align:center;">
          <button type="button" class="btn-logout-card" style="padding:6px 10px;" onclick="editBadge(${r.id})">✏️ Edit</button>
        </td>
      </tr>`;
  }).join('');
}

function editBadge(id) {
  const row = (badgeState.rows || []).find(r => r.id === id);
  if (!row) { showToast('Data karyawan tidak ditemukan.', 'error'); return; }

  document.getElementById('badgeFormTitle').textContent = `✏️ Edit Badge: ${row.namapersonnel || ''}`;
  document.getElementById('badgeEditId').value = row.id;
  document.getElementById('badgeNamaLabel').value = row.namapersonnel || '';
  document.getElementById('badgeKualifikasi').value = row.kualifikasi || '';
  document.getElementById('badgeStatus').value = row.isactive ? 'true' : 'false';
  document.getElementById('badgeFotoFile').value = '';

  document.getElementById('badgeFormTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetBadgeForm() {
  document.getElementById('badgeFormTitle').textContent = 'Edit Badge Karyawan';
  document.getElementById('badgeEditId').value = '';
  document.getElementById('badgeNamaLabel').value = '';
  document.getElementById('badgeKualifikasi').value = '';
  document.getElementById('badgeStatus').value = 'true';
  document.getElementById('badgeFotoFile').value = '';
}

async function submitBadge() {
  const editId = document.getElementById('badgeEditId')?.value;
  if (!editId) { showToast('Pilih dulu karyawan yang mau diedit (klik tombol Edit di tabel).', 'error'); return; }

  const kualifikasi = document.getElementById('badgeKualifikasi')?.value.trim() || '';
  const isActive = document.getElementById('badgeStatus')?.value === 'true';
  const fotoFile = document.getElementById('badgeFotoFile')?.files?.[0];

  const btn = document.getElementById('btnSubmitBadge');
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan...'; }

  try {
    const { error: infoErr } = await supabaseClient.rpc('update_karyawan_badge_info', {
      p_id: parseInt(editId, 10), p_kualifikasi: kualifikasi, p_isactive: isActive,
    });
    if (infoErr) throw infoErr;

    if (fotoFile) {
      const base64 = await fileToBase64(fotoFile);
      const karyawanRow = (badgeState.rows || []).find(r => r.id == editId);
      const subFolder = (karyawanRow?.type || '').trim() || 'Lainnya';
      const uploaded = await uploadBase64ToDrive('badge-foto', `BADGE_${editId}_${Date.now()}.${(fotoFile.name.split('.').pop() || 'jpg')}`, fotoFile.type || 'image/jpeg', base64, subFolder);
      const { error: fotoErr } = await supabaseClient.rpc('update_karyawan_foto', {
        p_id: parseInt(editId, 10), p_fotourl: uploaded.directUrl, p_fotofileid: uploaded.fileId,
      });
      if (fotoErr) throw fotoErr;
    }

    showToast('Badge karyawan berhasil disimpan.', 'success');
    resetBadgeForm();
    loadBadgePage();
  } catch (err) {
    showToast('Gagal menyimpan badge: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel || '💾 Simpan Badge'; }
  }
}

// ==========================================
// KONTRAK KARYAWAN -- CRUD + upload file PDF kontrak.
// ==========================================

let kontrakState = { rows: [] };

async function loadKontrakPage() {
  await loadKontrakKaryawanDropdown();

  const tbody = document.getElementById('kontrakTableBody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#777;">Memuat data...</td></tr>';

  try {
    const { data, error } = await supabaseClient.rpc('list_kontrak_karyawan_full');
    if (error) throw error;
    kontrakState.rows = data || [];
    renderKontrakTable();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:red;">Gagal memuat data: ${err.message}</td></tr>`;
  }
}

async function loadKontrakKaryawanDropdown() {
  const selectEl = document.getElementById('kontrakKaryawan');
  if (!selectEl) return;
  selectEl.innerHTML = '<option value="">-- Memuat daftar karyawan... --</option>';

  try {
    const { data, error } = await supabaseClient.rpc('get_active_karyawan');
    if (error) throw error;
    selectEl.innerHTML = '<option value="">-- Pilih Karyawan --</option>';
    (data || []).forEach(k => {
      const opt = document.createElement('option');
      opt.value = k.id;
      opt.textContent = `${k.nama} (ID: ${k.id})`;
      selectEl.appendChild(opt);
    });
  } catch (err) {
    selectEl.innerHTML = '<option value="">Gagal memuat daftar karyawan</option>';
  }
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = new Date(dateStr);
  const now = new Date();
  target.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.round((target - now) / (1000 * 60 * 60 * 24));
}

function renderKontrakTable() {
  const tbody = document.getElementById('kontrakTableBody');
  const countEl = document.getElementById('kontrakCount');
  if (!tbody) return;

  const keyword = (document.getElementById('kontrakSearch')?.value || '').toLowerCase().trim();
  const filtered = (kontrakState.rows || []).filter(r => !keyword || String(r.namakaryawan || '').toLowerCase().includes(keyword));

  if (countEl) countEl.textContent = `${filtered.length} Kontrak`;

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#777;">Belum ada data.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const sisaHari = daysUntil(r.tanggalberakhir);
    const isExpiringSoon = sisaHari !== null && sisaHari <= 30;
    const rowStyle = isExpiringSoon ? 'style="background:#FCEAE8;"' : '';
    const berakhirCell = isExpiringSoon
      ? `<strong style="color:#D9312E;">${r.tanggalberakhir || '-'}</strong><br><span style="font-size:11px;color:#D9312E;">${sisaHari < 0 ? 'Sudah habis' : `Sisa ${sisaHari} hari`}</span>`
      : (r.tanggalberakhir || '-');
    const fileCell = r.filekontrakurl
      ? `<a href="${r.filekontrakurl}" target="_blank" rel="noopener" class="btn-logout-card" style="display:inline-flex;padding:5px 8px;">📄 Lihat</a>`
      : `<span style="color:#a09a92;">Belum ada</span>`;
    const gaji = r.gajipokok != null ? `Rp ${Number(r.gajipokok).toLocaleString('id-ID')}` : '-';

    return `
      <tr ${rowStyle}>
        <td><strong>${escapeHtml(r.namakaryawan)}</strong></td>
        <td>${escapeHtml(r.jeniskontrak) || '-'}</td>
        <td>${escapeHtml(r.nomorkontrak) || '-'}</td>
        <td>${r.tanggalmulai || '-'}</td>
        <td>${berakhirCell}</td>
        <td>${gaji}</td>
        <td>${fileCell}</td>
        <td style="text-align:center;white-space:nowrap;">
          <button type="button" class="btn-logout-card" style="padding:6px 10px;" onclick="editKontrak(${r.id})">✏️ Edit</button>
          <button type="button" class="btn-logout-card" style="padding:6px 10px;color:#b23a24;" onclick="deleteKontrak(${r.id})">🗑️ Hapus</button>
        </td>
      </tr>`;
  }).join('');
}

function editKontrak(id) {
  const row = (kontrakState.rows || []).find(r => r.id === id);
  if (!row) { showToast('Data kontrak tidak ditemukan.', 'error'); return; }

  document.getElementById('kontrakFormTitle').textContent = `✏️ Edit Kontrak: ${row.namakaryawan || ''}`;
  document.getElementById('kontrakEditId').value = row.id;
  document.getElementById('kontrakKaryawan').value = row.karyawanid;
  document.getElementById('kontrakJenis').value = row.jeniskontrak || 'PKWT';
  document.getElementById('kontrakNomor').value = row.nomorkontrak || '';
  document.getElementById('kontrakGaji').value = row.gajipokok || '';
  document.getElementById('kontrakMulai').value = row.tanggalmulai || '';
  document.getElementById('kontrakBerakhir').value = row.tanggalberakhir || '';
  document.getElementById('kontrakFile').value = '';

  document.getElementById('kontrakFormTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteKontrak(id) {
  const row = (kontrakState.rows || []).find(r => r.id === id);
  if (!confirm(`Yakin mau hapus kontrak "${row ? row.namakaryawan : id}"? Tindakan ini tidak bisa dibatalkan.`)) return;

  try {
    const { error } = await supabaseClient.rpc('delete_kontrak_karyawan', { p_id: id });
    if (error) throw error;
    showToast('Kontrak berhasil dihapus.', 'success');
    if (document.getElementById('kontrakEditId')?.value == id) resetKontrakForm();
    loadKontrakPage();
  } catch (err) {
    showToast('Gagal menghapus kontrak: ' + err.message, 'error');
  }
}

async function submitKontrak() {
  const editId = document.getElementById('kontrakEditId')?.value;
  const karyawanId = document.getElementById('kontrakKaryawan')?.value;
  const jenis = document.getElementById('kontrakJenis')?.value;
  const nomor = document.getElementById('kontrakNomor')?.value.trim();
  const gaji = parseFloat(document.getElementById('kontrakGaji')?.value) || null;
  const mulai = document.getElementById('kontrakMulai')?.value || null;
  const berakhir = document.getElementById('kontrakBerakhir')?.value || null;
  const fileEl = document.getElementById('kontrakFile');
  const file = fileEl?.files?.[0];

  if (!karyawanId) { showToast('Pilih dulu karyawannya.', 'error'); return; }
  if (!nomor) { showToast('Nomor kontrak wajib diisi.', 'error'); return; }
  if (!mulai || !berakhir) { showToast('Tanggal mulai & berakhir kontrak wajib diisi.', 'error'); return; }

  const btn = document.getElementById('btnSubmitKontrak');
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan...'; }

  try {
    let fileUrl = null;
    let fileId = null;

    // Kalau lagi edit dan gak upload file baru, pertahankan file kontrak yang lama.
    if (editId && !file) {
      const existing = (kontrakState.rows || []).find(r => r.id == editId);
      fileUrl = existing ? existing.filekontrakurl : null;
      fileId = existing ? existing.filekontrakfileid : null;
    }

    if (file) {
      const base64 = await fileToBase64(file);
      const uploaded = await uploadBase64ToDrive('kontrak-karyawan', `KONTRAK_${nomor.replace(/\//g, '-')}.pdf`, 'application/pdf', base64);
      fileUrl = uploaded.directUrl;
      fileId = uploaded.fileId;
    }

    if (editId) {
      const { error } = await supabaseClient.rpc('update_kontrak_karyawan', {
        p_id: parseInt(editId, 10), p_karyawanid: parseInt(karyawanId, 10), p_jeniskontrak: jenis,
        p_nomorkontrak: nomor, p_tanggalmulai: mulai, p_tanggalberakhir: berakhir,
        p_gajipokok: gaji, p_filekontrakurl: fileUrl, p_filekontrakfileid: fileId,
      });
      if (error) throw error;
      showToast('Kontrak berhasil diperbarui.', 'success');
    } else {
      const { error } = await supabaseClient.rpc('create_kontrak_karyawan', {
        p_karyawanid: parseInt(karyawanId, 10), p_jeniskontrak: jenis,
        p_nomorkontrak: nomor, p_tanggalmulai: mulai, p_tanggalberakhir: berakhir,
        p_gajipokok: gaji, p_filekontrakurl: fileUrl, p_filekontrakfileid: fileId,
      });
      if (error) throw error;
      showToast('Kontrak baru berhasil ditambahkan.', 'success');
    }

    resetKontrakForm();
    loadKontrakPage();
  } catch (err) {
    showToast('Gagal menyimpan kontrak: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel || '💾 Simpan Kontrak'; }
  }
}

function resetKontrakForm() {
  document.getElementById('kontrakFormTitle').textContent = '+ Tambah Kontrak Baru';
  document.getElementById('kontrakEditId').value = '';
  document.getElementById('kontrakKaryawan').value = '';
  document.getElementById('kontrakJenis').value = 'PKWT';
  document.getElementById('kontrakNomor').value = '';
  document.getElementById('kontrakGaji').value = '';
  document.getElementById('kontrakMulai').value = '';
  document.getElementById('kontrakBerakhir').value = '';
  document.getElementById('kontrakFile').value = '';
}

// =====================================================================================
// OTORISASI IJIN & LEMBUR (WORKFLOW APPROVAL BERJENJANG 1-3 LEVEL)
// =====================================================================================
let currentOtorisasiTab = 'queue';
let otorisasiRawData = [];
let activeApprovalItem = null;

async function loadOtorisasiPage(tab = 'queue', tabBtn = null) {
  currentOtorisasiTab = tab;

  // Set visual tab active
  const tabsContainer = document.getElementById('otorisasiTabs');
  if (tabsContainer) {
    tabsContainer.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.otoTab === tab);
    });
  }
  if (tabBtn) {
    tabsContainer?.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    tabBtn.classList.add('active');
  }

  const titleEl = document.getElementById('otorisasiTitle');
  const subtitleEl = document.getElementById('otorisasiSubtitle');
  const dateFilterEl = document.getElementById('otorisasiDateFilter');
  const dateFilter = dateFilterEl?.value || '';

  const tbody = document.getElementById('otorisasiTableBody');
  if (tbody) tbody.innerHTML = `<tr><td style="text-align:center; color:#777; padding:18px;">Memuat data otorisasi...</td></tr>`;

  try {
    // Ambil QrCodeId user login saat ini
    let currentQr = '';
    if (currentUser && currentUser.id) {
      const { data: userData } = await supabaseClient
        .from('karyawanTbl')
        .select('QrCodeId')
        .eq('Id', currentUser.id)
        .maybeSingle();
      if (userData && userData.QrCodeId) currentQr = userData.QrCodeId;
    }

    if (tab === 'queue') {
      if (titleEl) titleEl.textContent = '📥 Antrean Approval Saya';
      if (subtitleEl) subtitleEl.textContent = 'Permohonan yang memerlukan tindakan otorisasi dari akun Anda.';

      if (!currentQr) {
        otorisasiRawData = [];
      } else {
        const { data, error } = await supabaseClient.rpc('get_pending_ijin_lembur_approvals_by_qrcode', {
          p_qrcode: currentQr
        });
        if (error) throw error;
        otorisasiRawData = data || [];
      }
    } else if (tab === 'all') {
      if (titleEl) titleEl.textContent = '📝 Semua Pengajuan Ijin & Lembur';
      if (subtitleEl) subtitleEl.textContent = 'Seluruh riwayat dan tracking level persetujuan permohonan.';

      let query = supabaseClient
        .from('pengajuan_ijin_lembur_tbl')
        .select('*')
        .order('id', { ascending: false })
        .limit(300);

      if (dateFilter) {
        query = query.eq('tanggal', dateFilter);
      }

      const { data, error } = await query;
      if (error) throw error;
      otorisasiRawData = data || [];
    } else if (tab === 'vouchers') {
      if (titleEl) titleEl.textContent = '🎫 Voucher & Kode Aktif';
      if (subtitleEl) subtitleEl.textContent = 'Daftar Kode Ijin dan Voucher PIN SPKL yang sudah disetujui (Approved).';

      let query = supabaseClient
        .from('pengajuan_ijin_lembur_tbl')
        .select('*')
        .eq('status', 'APPROVED')
        .order('id', { ascending: false })
        .limit(300);

      if (dateFilter) {
        query = query.eq('tanggal', dateFilter);
      }

      const { data, error } = await query;
      if (error) throw error;
      otorisasiRawData = data || [];
    }

    renderOtorisasiTable();
  } catch (err) {
    console.error('Error loadOtorisasiPage:', err);
    if (tbody) tbody.innerHTML = `<tr><td style="text-align:center;color:red;padding:18px;">Gagal memuat data: ${escapeHtml(err.message)}</td></tr>`;
  }
}

function renderOtorisasiTable() {
  const thead = document.getElementById('otorisasiTableHead');
  const tbody = document.getElementById('otorisasiTableBody');
  const countEl = document.getElementById('otorisasiCount');
  const searchVal = (document.getElementById('otorisasiSearch')?.value || '').trim().toLowerCase();

  let filtered = (otorisasiRawData || []).filter(item => {
    if (!searchVal) return true;
    const text = `${item.nama_pemohon || ''} ${item.qrcodeid || ''} ${item.tipe || ''} ${item.alasan || ''} ${item.status || ''} ${item.kode_ijin || ''} ${item.voucher_pin || ''}`.toLowerCase();
    return text.includes(searchVal);
  });

  if (countEl) countEl.textContent = `${filtered.length} Data`;

  if (currentOtorisasiTab === 'queue') {
    if (thead) thead.innerHTML = `
      <tr>
        <th>Tipe</th>
        <th>Nama Pemohon</th>
        <th>Tanggal</th>
        <th>Lokasi / Durasi</th>
        <th>Alasan / Tugas</th>
        <th>Progress Level</th>
        <th style="text-align:center;">Tindakan</th>
      </tr>
    `;

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:#777; padding:24px;">Tidak ada permohonan dalam antrean approval Anda saat ini.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(item => {
      const typeBadge = item.tipe === 'IJIN'
        ? `<span style="color:#D97706; font-weight:700;">🚪 Ijin Pulang</span>`
        : `<span style="color:#2563EB; font-weight:700;">⏱️ Lembur (SPKL)</span>`;

      const action = item.required_action || 'APPROVE';
      let btnHtml = '';
      if (action === 'PROPOSE') {
        btnHtml = `<button type="button" class="btn-action-propose" onclick='openModalApprovalAction(${item.id}, "PROPOSE", ${JSON.stringify(JSON.stringify(item))})'>⚡ Propose</button>`;
      } else if (action === 'REVIEW') {
        btnHtml = `<button type="button" class="btn-action-review" onclick='openModalApprovalAction(${item.id}, "REVIEW", ${JSON.stringify(JSON.stringify(item))})'>🔍 Review</button>`;
      } else {
        btnHtml = `<button type="button" class="btn-action-approve" onclick='openModalApprovalAction(${item.id}, "APPROVE", ${JSON.stringify(JSON.stringify(item))})'>✅ Approve</button>`;
      }

      return `
        <tr>
          <td>${typeBadge}</td>
          <td>
            <strong>${escapeHtml(item.nama_pemohon || item.qrcodeid)}</strong><br>
            <small style="color:#64748B;">${escapeHtml(item.kualifikasi || item.qrcodeid)}</small>
          </td>
          <td>${formatTglIndo(item.tanggal)}</td>
          <td>
            ${escapeHtml(item.lokasi || '-')}
            ${item.durasi_jam ? `<br><small style="color:#64748B;">${item.durasi_jam} Jam</small>` : ''}
          </td>
          <td style="max-width:240px; white-space:normal;">${escapeHtml(item.alasan || '-')}</td>
          <td>
            <div class="step-tracker-mini">
              <span>Level ${item.current_level} dari ${item.total_levels}</span>
            </div>
          </td>
          <td style="text-align:center;">
            ${btnHtml}
          </td>
        </tr>
      `;
    }).join('');

  } else if (currentOtorisasiTab === 'all') {
    if (thead) thead.innerHTML = `
      <tr>
        <th>ID</th>
        <th>Tipe</th>
        <th>Pemohon</th>
        <th>Tanggal</th>
        <th>Alasan / Tugas</th>
        <th>Status Tracking</th>
        <th>Voucher / Kode</th>
        <th style="text-align:center;">Aksi</th>
      </tr>
    `;

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:#777; padding:24px;">Belum ada data pengajuan.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(item => {
      const typeBadge = item.tipe === 'IJIN'
        ? `<span style="color:#D97706; font-weight:700;">🚪 IJIN</span>`
        : `<span style="color:#2563EB; font-weight:700;">⏱️ LEMBUR</span>`;

      let statusBadge = '';
      if (item.status === 'PENDING_PROPOSE') {
        statusBadge = `<span class="badge-status-step badge-pending-propose">Menunggu Propose (L1)</span>`;
      } else if (item.status === 'PROPOSED') {
        statusBadge = `<span class="badge-status-step badge-proposed">Proposed (Menunggu L2)</span>`;
      } else if (item.status === 'REVIEWED') {
        statusBadge = `<span class="badge-status-step badge-reviewed">Reviewed (Menunggu L3)</span>`;
      } else if (item.status === 'APPROVED') {
        statusBadge = `<span class="badge-status-step badge-approved">✅ Approved</span>`;
      } else if (item.status === 'REJECTED') {
        statusBadge = `<span class="badge-status-step badge-rejected">❌ Ditolak</span>`;
      }

      let voucherHtml = '-';
      if (item.kode_ijin) {
        voucherHtml = `<span class="voucher-code-tag ${item.is_used ? 'voucher-used' : 'voucher-active'}">${escapeHtml(item.kode_ijin)}</span>`;
      } else if (item.voucher_pin) {
        voucherHtml = `<span class="voucher-code-tag ${item.is_used ? 'voucher-used' : 'voucher-active'}">${escapeHtml(item.voucher_pin)}</span>`;
      }

      return `
        <tr>
          <td>#${item.id}</td>
          <td>${typeBadge}</td>
          <td>
            <strong>${escapeHtml(item.nama_pemohon || item.qrcodeid)}</strong><br>
            <small style="color:#64748B;">${escapeHtml(item.kualifikasi || item.qrcodeid)}</small>
          </td>
          <td>${formatTglIndo(item.tanggal)}</td>
          <td style="max-width:200px; white-space:normal;">${escapeHtml(item.alasan || '-')}</td>
          <td>
            ${statusBadge}<br>
            <small style="color:#64748B;">Level: ${item.current_level}/${item.total_levels}</small>
          </td>
          <td>${voucherHtml}</td>
          <td style="text-align:center;">
            <button type="button" class="btn-secondary" style="padding:4px 8px; font-size:11px;" onclick='openModalApprovalAction(${item.id}, "VIEW", ${JSON.stringify(JSON.stringify(item))})'>Detail</button>
          </td>
        </tr>
      `;
    }).join('');

  } else if (currentOtorisasiTab === 'vouchers') {
    if (thead) thead.innerHTML = `
      <tr>
        <th>Kode / PIN</th>
        <th>Tipe</th>
        <th>Pemohon</th>
        <th>Tanggal</th>
        <th>Lokasi Site</th>
        <th>Status Penggunaan</th>
      </tr>
    `;

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#777; padding:24px;">Belum ada voucher atau kode aktif.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(item => {
      const code = item.kode_ijin || item.voucher_pin || '-';
      const statusUse = item.is_used
        ? `<span style="color:#64748B; font-weight:600;">🔒 Sudah Digunakan (${item.used_at ? formatJamWita(item.used_at) + ' WITA' : ''})</span>`
        : `<span style="color:#10B981; font-weight:700;">🟢 Aktif / Siap Dipakai</span>`;

      return `
        <tr>
          <td><strong class="voucher-code-tag ${item.is_used ? 'voucher-used' : 'voucher-active'}">${escapeHtml(code)}</strong></td>
          <td>${item.tipe === 'IJIN' ? '🚪 Ijin Keluar' : '⏱️ SPKL Lembur'}</td>
          <td>
            <strong>${escapeHtml(item.nama_pemohon || item.qrcodeid)}</strong><br>
            <small style="color:#64748B;">${escapeHtml(item.kualifikasi || item.qrcodeid)}</small>
          </td>
          <td>${formatTglIndo(item.tanggal)}</td>
          <td>${escapeHtml(item.lokasi || '-')}</td>
          <td>${statusUse}</td>
        </tr>
      `;
    }).join('');
  }
}

// ==========================================
// MODAL & ACTION HANDLERS
// ==========================================
async function openModalBuatPengajuan() {
  const modal = document.getElementById('modalPengajuanIjinLembur');
  if (!modal) return;

  const tglInput = document.getElementById('pengajuanTanggal');
  if (tglInput) tglInput.value = new Date().toISOString().split('T')[0];

  // Populate Karyawan
  const selectKar = document.getElementById('pengajuanKaryawan');
  if (selectKar) {
    selectKar.innerHTML = '<option value="">-- Memuat Karyawan... --</option>';
    try {
      let karyawanList = [];
      const { data, error } = await supabaseClient
        .from('karyawanTbl')
        .select('Id, NamaPersonnel, QrCodeId, Kualifikasi')
        .order('NamaPersonnel', { ascending: true });

      if (!error && data && data.length > 0) {
        karyawanList = data.map(k => ({
          id: k.Id,
          nama: k.NamaPersonnel,
          qrcodeid: k.QrCodeId,
          kualifikasi: k.Kualifikasi
        }));
      } else {
        // Fallback ke RPC list_karyawan_all
        const { data: rpcData, error: rpcErr } = await supabaseClient.rpc('list_karyawan_all');
        if (rpcErr) throw rpcErr;
        karyawanList = (rpcData || []).map(k => ({
          id: k.id,
          nama: k.namapersonnel,
          qrcodeid: k.qrcodeid,
          kualifikasi: k.kualifikasi
        }));
      }

      selectKar.innerHTML = '<option value="">-- Pilih Karyawan --</option>';
      karyawanList.forEach(k => {
        if (k.qrcodeid) {
          const opt = document.createElement('option');
          opt.value = String(k.qrcodeid).trim();
          opt.textContent = `${k.nama || k.qrcodeid} (${k.kualifikasi || '-'}) [${k.qrcodeid}]`;
          selectKar.appendChild(opt);
        }
      });
    } catch (e) {
      console.error('Gagal memuat karyawan:', e);
      selectKar.innerHTML = `<option value="">Gagal: ${escapeHtml(e.message || 'Error server')}</option>`;
    }
  }

  // Populate Lokasi
  const selectLok = document.getElementById('pengajuanLokasi');
  if (selectLok) {
    selectLok.innerHTML = '<option value="">-- Memuat Lokasi... --</option>';
    try {
      const { data, error } = await supabaseClient
        .from('lokasiTbl')
        .select('NamaLokasi')
        .order('NamaLokasi', { ascending: true });
      if (error) throw error;

      selectLok.innerHTML = '<option value="">-- Pilih Lokasi / Site --</option>';
      (data || []).forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.NamaLokasi;
        opt.textContent = l.NamaLokasi;
        selectLok.appendChild(opt);
      });
    } catch (e) {
      console.error('Gagal memuat lokasi:', e);
      selectLok.innerHTML = '<option value="">-- Pilih Lokasi / Site --</option>';
    }
  }

  modal.style.display = 'flex';
}

function closeModalBuatPengajuan() {
  const modal = document.getElementById('modalPengajuanIjinLembur');
  if (modal) modal.style.display = 'none';
}

function togglePengajuanTipeFields(tipe) {
  const extraGroup = document.getElementById('groupPengajuanLemburExtra');
  if (extraGroup) {
    extraGroup.style.display = tipe === 'LEMBUR' ? 'block' : 'none';
  }
}

async function submitFormPengajuanBaru() {
  const qrcode = document.getElementById('pengajuanKaryawan')?.value;
  const tipe = document.getElementById('pengajuanTipe')?.value;
  const tanggal = document.getElementById('pengajuanTanggal')?.value;
  const alasan = document.getElementById('pengajuanAlasan')?.value.trim();
  const lokasi = document.getElementById('pengajuanLokasi')?.value || '';
  const durasi = parseFloat(document.getElementById('pengajuanDurasi')?.value || '0') || 0;

  if (!qrcode || !tipe || !tanggal || !alasan) {
    showToast('Harap lengkapi semua field yang wajib diisi.', 'error');
    return;
  }

  const btn = document.getElementById('btnSubmitPengajuanBaru');
  if (btn) { btn.disabled = true; btn.textContent = 'Mengirim...'; }

  try {
    const { data, error } = await supabaseClient.rpc('submit_pengajuan_ijin_lembur', {
      p_pemohon_qrcode: qrcode,
      p_tipe: tipe,
      p_tanggal: tanggal,
      p_alasan: alasan,
      p_durasi_jam: durasi,
      p_lokasi: lokasi
    });

    if (error) throw error;

    if (data && data.status === 'SUCCESS') {
      showToast(`Pengajuan ${tipe} berhasil dibuat (Total ${data.total_levels} level otorisasi).`, 'success');
      closeModalBuatPengajuan();
      loadOtorisasiPage(currentOtorisasiTab);
    } else {
      showToast(data?.message || 'Gagal membuat pengajuan.', 'error');
    }
  } catch (err) {
    console.error('Error submitFormPengajuanBaru:', err);
    showToast('Gagal submit pengajuan: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Kirim Pengajuan'; }
  }
}

function openModalApprovalAction(requestId, actionName, reqJsonStr) {
  const modal = document.getElementById('modalApprovalAction');
  if (!modal) return;

  const item = typeof reqJsonStr === 'string' ? JSON.parse(reqJsonStr) : reqJsonStr;
  activeApprovalItem = { id: requestId, action: actionName, item: item };

  const titleEl = document.getElementById('modalApprovalTitle');
  const subEl = document.getElementById('modalApprovalSubtitle');
  const bodyEl = document.getElementById('modalApprovalBody');
  const btnApprove = document.getElementById('btnConfirmApprove');
  const btnReject = document.getElementById('btnConfirmReject');
  const notesInput = document.getElementById('modalApprovalNotes');

  if (notesInput) notesInput.value = '';

  if (actionName === 'PROPOSE') {
    if (titleEl) titleEl.textContent = '⚡ Usulkan Permohonan (Propose)';
    if (subEl) subEl.textContent = 'Teruskan permohonan ini ke atasan level berikutnya untuk review.';
    if (btnApprove) { btnApprove.textContent = 'Ya, Usulkan (Propose)'; btnApprove.style.display = 'block'; }
    if (btnReject) btnReject.style.display = 'block';
  } else if (actionName === 'REVIEW') {
    if (titleEl) titleEl.textContent = '🔍 Tinjau Permohonan (Review)';
    if (subEl) subEl.textContent = 'Verifikasi data dan teruskan ke level persetujuan final.';
    if (btnApprove) { btnApprove.textContent = 'Ya, Setujui & Teruskan (Review)'; btnApprove.style.display = 'block'; }
    if (btnReject) btnReject.style.display = 'block';
  } else if (actionName === 'APPROVE') {
    if (titleEl) titleEl.textContent = '✅ Persetujuan Final (Approve)';
    if (subEl) subEl.textContent = 'Persetujuan akhir akan langsung menerbitkan Kode Ijin / PIN Lembur.';
    if (btnApprove) { btnApprove.textContent = 'Ya, Setujui & Terbitkan Voucher'; btnApprove.style.display = 'block'; }
    if (btnReject) btnReject.style.display = 'block';
  } else {
    // VIEW ONLY
    if (titleEl) titleEl.textContent = '📋 Detail Pengajuan';
    if (subEl) subEl.textContent = 'Rincian riwayat data dan jejak approval.';
    if (btnApprove) btnApprove.style.display = 'none';
    if (btnReject) btnReject.style.display = 'none';
  }

  if (bodyEl) {
    bodyEl.innerHTML = `
      <div style="display:grid; grid-template-columns:110px 1fr; gap:6px;">
        <strong>Tipe:</strong> <span>${item.tipe === 'IJIN' ? '🚪 Ijin Pulang' : '⏱️ Lembur (SPKL)'}</span>
        <strong>Pemohon:</strong> <span>${escapeHtml(item.nama_pemohon || item.qrcodeid)} (${escapeHtml(item.kualifikasi || '-')})</span>
        <strong>Tanggal:</strong> <span>${formatTglIndo(item.tanggal)}</span>
        ${item.lokasi ? `<strong>Lokasi:</strong> <span>${escapeHtml(item.lokasi)}</span>` : ''}
        ${item.durasi_jam ? `<strong>Durasi:</strong> <span>${item.durasi_jam} Jam</span>` : ''}
        <strong>Alasan:</strong> <span style="white-space:pre-wrap;">${escapeHtml(item.alasan || '-')}</span>
        <strong>Progress:</strong> <span>Level ${item.current_level} dari total ${item.total_levels} Level</span>
        ${item.kode_ijin ? `<strong>Kode Ijin:</strong> <span class="voucher-code-tag voucher-active">${escapeHtml(item.kode_ijin)}</span>` : ''}
        ${item.voucher_pin ? `<strong>PIN Lembur:</strong> <span class="voucher-code-tag voucher-active">${escapeHtml(item.voucher_pin)}</span>` : ''}
      </div>
    `;
  }

  modal.style.display = 'flex';
}

function closeModalApprovalAction() {
  const modal = document.getElementById('modalApprovalAction');
  if (modal) modal.style.display = 'none';
  activeApprovalItem = null;
}

async function executeApprovalDecision(isApprove) {
  if (!activeApprovalItem) return;

  const { id, action } = activeApprovalItem;
  const notes = (document.getElementById('modalApprovalNotes')?.value || '').trim();
  const decisionAction = isApprove ? action : 'REJECT';

  // Ambil QrCodeId user login saat ini
  let currentQr = '';
  if (currentUser && currentUser.id) {
    const { data: userData } = await supabaseClient
      .from('karyawanTbl')
      .select('QrCodeId')
      .eq('Id', currentUser.id)
      .maybeSingle();
    if (userData && userData.QrCodeId) currentQr = userData.QrCodeId;
  }

  if (!currentQr) {
    showToast('Identitas QR Code akun Anda tidak ditemukan.', 'error');
    return;
  }

  const btnApprove = document.getElementById('btnConfirmApprove');
  const btnReject = document.getElementById('btnConfirmReject');
  if (btnApprove) btnApprove.disabled = true;
  if (btnReject) btnReject.disabled = true;

  try {
    const { data, error } = await supabaseClient.rpc('process_approval_action', {
      p_request_id: id,
      p_user_qrcode: currentQr,
      p_action: decisionAction,
      p_catatan: notes
    });

    if (error) throw error;

    if (data && data.status === 'SUCCESS') {
      showToast(data.message || 'Tindakan berhasil diproses.', 'success');
      closeModalApprovalAction();
      loadOtorisasiPage(currentOtorisasiTab);
    } else {
      showToast(data?.message || 'Gagal memproses approval.', 'error');
    }
  } catch (err) {
    console.error('Error executeApprovalDecision:', err);
    showToast('Gagal memproses approval: ' + err.message, 'error');
  } finally {
    if (btnApprove) btnApprove.disabled = false;
    if (btnReject) btnReject.disabled = false;
  }
}

// ==========================================
// EMPLOYEE REQUEST (PERMINTAAN KARYAWAN)
// Author: "Employee Request"
// Matrix Organisasi: 5 Divisi, 30 Departemen, & Kualifikasi Jabatan
// ==========================================

const BIMA_ORG_MATRIX = {
  "Finance": {
    "Accounts Receivable (AR)": [
      "Accounts Receivable (AR)",
      "AR Supervisor",
      "Billing & Invoicing Specialist",
      "AR Collection Officer",
      "Credit Analyst"
    ],
    "Treasury & Cash Management": [
      "Treasury & Cash Management",
      "Treasury Supervisor",
      "Cash Flow Analyst",
      "Bank Relation Officer",
      "Project / Petty Cashier"
    ],
    "Financial Planning & Analysis (FP&A)": [
      "Financial Planning & Analysis (FP&A)",
      "FP&A Lead",
      "Corporate Budgeting Analyst",
      "Financial Modeling Analyst",
      "Business Performance Analyst"
    ],
    "Accounting & Financial Reporting": [
      "Accounting & Financial Reporting",
      "General Accounting Supervisor",
      "GL Accountant",
      "Fixed Asset Accountant",
      "Financial Reporting Specialist"
    ],
    "Taxation (Perpajakan)": [
      "Taxation (Perpajakan)",
      "Tax Supervisor",
      "Corporate Tax Specialist",
      "VAT & Withholding Officer",
      "Tax Compliance Officer"
    ],
    "Payroll (Penggajian)": [
      "Payroll (Penggajian)",
      "Payroll Lead",
      "Payroll Processor",
      "BPJS & Tax Deduction Analyst",
      "Time Attendance Admin"
    ]
  },
  "Operation": {
    "Engineering": [
      "Engineering Manager",
      "Lead / Chief Engineer",
      "Civil & Structural Engineer",
      "Mechanical & Piping Engineer",
      "Electrical & Instrument Engineer",
      "Drafter / BIM Modeler"
    ],
    "HSE": [
      "HSE Manager",
      "HSE Coordinator / Lead",
      "Safety Officer / Inspector",
      "Environmental Officer",
      "Project Paramedic",
      "HSE Admin & Doc Control"
    ],
    "Project Control": [
      "Project Control Manager",
      "Project Control Lead",
      "Planner & Scheduler",
      "Cost Controller",
      "Quantity Surveyor (QS)",
      "Document Controller"
    ],
    "Project": [
      "Project Manager",
      "Site Manager",
      "Site Engineer",
      "Site Supervisor",
      "General Superintendent",
      "Site Admin"
    ],
    "QAC": [
      "QAC Manager",
      "QA/QC Coordinator",
      "QA Auditor / Specialist",
      "QC Inspector",
      "Welding / NDT Inspector",
      "Material / Lab Technician"
    ],
    "Equipment": [
      "Equipment Manager",
      "Equipment / Plant Lead",
      "Maintenance Planner",
      "Equipment Mechanic",
      "Auto Electrician",
      "Dispatcher / Fleet Admin"
    ]
  },
  "Human Resources": {
    "Talent Acquisition / Recruitment": [
      "Talent Acquisition / Recruitment",
      "Talent Acquisition Lead",
      "Technical Recruiter",
      "Sourcing Specialist",
      "Onboarding Coordinator"
    ],
    "Compensation & Benefits (CompBen)": [
      "Compensation & Benefits (CompBen)",
      "CompBen Lead",
      "Salary Grading Analyst",
      "Insurance Administrator",
      "Remuneration Officer"
    ],
    "Learning & Development (L&D)": [
      "Learning & Development (L&D)",
      "L&D Lead",
      "Training Needs Analyst",
      "Corporate Trainer",
      "LMS Administrator"
    ],
    "Employee Relations (ER)": [
      "Employee Relations (ER)",
      "Industrial Relations Specialist",
      "Dispute & Compliance Officer",
      "Employee Engagement Officer",
      "Company Culture Officer"
    ],
    "Performance Management": [
      "Performance Management",
      "Performance Management Lead",
      "KPI & OKR Specialist",
      "Appraisal Officer",
      "Succession Planning Officer"
    ],
    "HR Operations / HR Admin": [
      "HR Operations / HR Admin",
      "HR Operations Supervisor",
      "HRIS Administrator",
      "Personnel Contract Admin",
      "Expatriate / Permit Admin"
    ]
  },
  "Supply Chains": {
    "Procurement / Purchasing": [
      "Procurement / Purchasing",
      "Procurement Lead",
      "Project Buyer",
      "Service Procurement Officer",
      "Expeditor / PO Admin"
    ],
    "Warehousing & Inventory Control": [
      "Warehousing & Inventory Control",
      "Warehouse Supervisor",
      "Inventory Controller",
      "Material Receiver",
      "Storekeeper / Toolman"
    ],
    "Logistics & Distribution": [
      "Logistics & Distribution",
      "Logistics Supervisor",
      "Freight Planner",
      "Fleet Coordinator",
      "Logistics Safety Officer"
    ],
    "Supply & Demand Planning": [
      "Supply & Demand Planning",
      "Supply & Demand Lead",
      "Material Requirement Planner",
      "Demand Planner",
      "Inventory Forecast Specialist"
    ],
    "Import-Export (Exim) & Customs": [
      "Import-Export (Exim) & Customs",
      "Exim Supervisor",
      "Customs Clearance Specialist",
      "Forwarding Coordinator",
      "Shipping & LC Admin"
    ],
    "Vendor Management": [
      "Vendor Management",
      "Vendor Management Lead",
      "Vendor Auditor",
      "Supplier Performance Analyst",
      "Vendor Database Admin"
    ]
  },
  "Bussiness Development": {
    "Tender & Proposal (Bidding)": [
      "Tender & Proposal (Bidding)",
      "Bid & Proposal Lead",
      "Technical Proposal Writer",
      "Commercial Estimator",
      "Bidding Doc Controller"
    ],
    "Market Intelligence & Strategy": [
      "Market Intelligence & Strategy",
      "Market Intelligence Specialist",
      "Business Strategy Analyst",
      "Competitor Benchmark Analyst",
      "Business Feasibility Analyst"
    ],
    "Key Account Management & Sales": [
      "Key Account Management & Sales",
      "Key Account Manager",
      "Business Development Executive",
      "Client Relationship Officer",
      "Pre-Sales Solutionist"
    ],
    "Strategic Partnership & Alliances": [
      "Strategic Partnership & Alliances",
      "Partnership Manager",
      "Consortium / JV Specialist",
      "Government Relations Officer",
      "Stakeholder Relations Officer"
    ],
    "Commercial & Contract Review": [
      "Commercial & Contract Review",
      "Commercial Lead",
      "Contract Negotiation Specialist",
      "Legal Risk Assessment Officer",
      "Post-Award Commercial Officer"
    ],
    "Brand & Corporate Communications": [
      "Brand & Corporate Communications",
      "Corp Comm Lead",
      "PR Specialist",
      "Brand & Marketing Specialist",
      "Digital Media Specialist"
    ]
  }
};

let empReqState = {
  rows: [],
  currentTab: 'ALL',
  selectedRequest: null
};

function canUserSubmitEmpReq(projectCode = '') {
  if (!currentUser) return false;
  const pic = String(currentUser.pic || '').toUpperCase();
  const auth = String(currentUser.author || '').toUpperCase();
  if (pic.includes('ALL') || auth.includes('ALL') || auth.includes('ADMIN')) return true;
  const picTokens = pic.split(',').map(t => t.trim()).filter(Boolean);
  if (picTokens.includes('ER') || picTokens.includes('PER') || picTokens.includes('ER-ALL')) return true;
  if (projectCode) {
    const projClean = String(projectCode).toUpperCase().replace(/\s+/g, '');
    return picTokens.includes(`ER-${projClean}`);
  }
  return picTokens.some(t => t.startsWith('ER'));
}

function canUserApproveAer(projectCode = '') {
  if (!currentUser) return false;
  const auth = String(currentUser.author || '').toUpperCase();
  if (!auth) return false;

  if (auth.includes('ALL') || auth.includes('ADMIN')) return true;

  const tokens = auth.split(',').map(t => t.trim()).filter(Boolean);

  // Jika author memiliki 'AER' atau 'AER-ALL' (akses approval semua proyek)
  if (tokens.includes('AER') || tokens.includes('AER-ALL') || tokens.some(t => t === 'AER' || t.startsWith('AER-ALL'))) {
    return true;
  }

  // Jika projectCode diberikan (misal '015', '101')
  if (projectCode) {
    const projClean = String(projectCode).toUpperCase().replace(/\s+/g, '');
    return tokens.includes(`AER-${projClean}`) || tokens.some(t => t === `AER-${projClean}` || t.endsWith(`-${projClean}`));
  }

  return tokens.some(t => t.startsWith('AER'));
}

function canUserProcessHrd() {
  if (!currentUser) return false;
  const pic = String(currentUser.pic || '').toUpperCase();
  const auth = String(currentUser.author || '').toUpperCase();
  return pic.includes('PER') || pic.includes('HR') || pic.includes('ALL') || auth.includes('ALL') || auth.includes('ADMIN') || auth.includes('HR');
}

function canUserApproveAper() {
  if (!currentUser) return false;
  const auth = String(currentUser.author || '').toUpperCase();
  return auth.includes('APER') || auth.includes('BOD') || auth.includes('DIR') || auth.includes('ALL') || auth.includes('ADMIN');
}

function hasEmployeeRequestAuthor() {
  if (!currentUser) return false;
  const auth = String(currentUser.author || '').toUpperCase();
  const pic = String(currentUser.pic || '').toUpperCase();
  return (
    auth.includes('AER') || auth.includes('APER') || auth.includes('ALL') || auth.includes('ADMIN') ||
    auth.includes('HR') || auth.includes('LEAD') || pic.includes('PER') || pic.includes('ER') || pic.includes('ALL')
  );
}

function handleEmpReqDivisiChange() {
  const divSelect = document.getElementById('empReqDivisi');
  const deptSelect = document.getElementById('empReqDepartemen');
  const posSelect = document.getElementById('empReqPosisi');
  const customGroup = document.getElementById('groupEmpReqPosisiCustom');

  if (!deptSelect || !posSelect) return;

  const selectedDiv = divSelect ? divSelect.value : '';
  deptSelect.innerHTML = '<option value="">-- Pilih Departemen --</option>';
  posSelect.innerHTML = '<option value="">-- Pilih Departemen Terlebih Dahulu --</option>';
  if (customGroup) customGroup.style.display = 'none';

  if (!selectedDiv || !BIMA_ORG_MATRIX[selectedDiv]) return;

  const depts = Object.keys(BIMA_ORG_MATRIX[selectedDiv]);
  depts.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    deptSelect.appendChild(opt);
  });
}

function handleEmpReqDepartemenChange() {
  const divSelect = document.getElementById('empReqDivisi');
  const deptSelect = document.getElementById('empReqDepartemen');
  const posSelect = document.getElementById('empReqPosisi');
  const customGroup = document.getElementById('groupEmpReqPosisiCustom');

  if (!posSelect) return;

  const selectedDiv = divSelect ? divSelect.value : '';
  const selectedDept = deptSelect ? deptSelect.value : '';

  posSelect.innerHTML = '<option value="">-- Pilih Posisi / Kualifikasi Jabatan --</option>';
  if (customGroup) customGroup.style.display = 'none';

  if (!selectedDiv || !selectedDept || !BIMA_ORG_MATRIX[selectedDiv] || !BIMA_ORG_MATRIX[selectedDiv][selectedDept]) {
    return;
  }

  // 1. Ambil posisi standar dari Matriks Organisasi
  const defaultPositions = BIMA_ORG_MATRIX[selectedDiv][selectedDept] || [];

  // 2. Ambil posisi kustom yang pernah diinput sebelumnya dari riwayat database
  const historicalPositions = (empReqState.rows || [])
    .filter(r => r.divisi === selectedDiv && r.departemen === selectedDept && r.posisijabatan)
    .map(r => String(r.posisijabatan).trim());

  // 3. Gabungkan dan hapus duplikat (Unique)
  const combinedPositions = [...new Set([...defaultPositions, ...historicalPositions])];

  combinedPositions.forEach(p => {
    if (!p || p === 'CUSTOM') return;
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    posSelect.appendChild(opt);
  });

  // 4. Tambahkan opsi Posisi Lainnya (Ketik Sendiri)
  const customOpt = document.createElement('option');
  customOpt.value = 'CUSTOM';
  customOpt.textContent = '➕ Posisi Lainnya (Ketik Sendiri)...';
  posSelect.appendChild(customOpt);
}

function handleEmpReqPosisiChange() {
  const posSelect = document.getElementById('empReqPosisi');
  const customGroup = document.getElementById('groupEmpReqPosisiCustom');
  const customInput = document.getElementById('empReqPosisiCustom');

  if (!posSelect || !customGroup) return;

  if (posSelect.value === 'CUSTOM') {
    customGroup.style.display = 'block';
    if (customInput) customInput.focus();
  } else {
    customGroup.style.display = 'none';
    if (customInput) customInput.value = '';
  }
}

async function loadEmployeeRequestPage(tab = 'ALL', tabBtn = null) {
  empReqState.currentTab = tab;

  // Update tabs UI
  if (tabBtn) {
    document.querySelectorAll('#empReqTabs .tab-btn').forEach(b => b.classList.remove('active'));
    tabBtn.classList.add('active');
  }

  // Pre-fill pemohon name
  const pemohonInput = document.getElementById('empReqPemohon');
  if (pemohonInput && currentUser) {
    pemohonInput.value = `${currentUser.nama} (ID: ${currentUser.id})`;
  }

  // Default tanggal butuh: 14 hari ke depan
  const tglButuhInput = document.getElementById('empReqTanggalButuh');
  if (tglButuhInput && !tglButuhInput.value) {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    tglButuhInput.value = d.toISOString().split('T')[0];
  }

  // Load dropdown lokasi
  await loadEmployeeRequestLokasiDropdown();

  const tbody = document.getElementById('empReqTableBody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#777;">Memuat data...</td></tr>';

  try {
    const { data, error } = await supabaseClient.rpc('list_employee_requests', { p_status: tab });
    if (error) throw error;
    empReqState.rows = data || [];
    renderEmployeeRequestTable();
    updateEmpReqBadgeCounts();
  } catch (err) {
    console.error('Error loadEmployeeRequestPage:', err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:red;">Gagal memuat data: ${err.message}</td></tr>`;
  }
}

async function updateEmpReqBadgeCounts() {
  try {
    const { data, error } = await supabaseClient.rpc('list_employee_requests', { p_status: 'ALL' });
    if (error || !data) return;

    const all = data.length;
    const aerPending = data.filter(r => String(r.status).toUpperCase() === 'PENDING_AER' || String(r.status).toUpperCase() === 'PENDING').length;
    const hrdProcess = data.filter(r => String(r.status).toUpperCase() === 'PROSES_HRD' || String(r.status).toUpperCase() === 'IN PROGRESS').length;
    const aperPending = data.filter(r => String(r.status).toUpperCase() === 'PENDING_APER').length;
    const rekrutmenAktif = data.filter(r => String(r.status).toUpperCase() === 'REKRUTMEN_AKTIF').length;
    const fulfilled = data.filter(r => String(r.status).toUpperCase() === 'FULFILLED' || String(r.status).toUpperCase() === 'APPROVED').length;
    const rejected = data.filter(r => String(r.status).toUpperCase().startsWith('REJECTED')).length;

    const setC = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setC('countEmpReqAll', all);
    setC('countEmpReqAer', aerPending);
    setC('countEmpReqHrd', hrdProcess);
    setC('countEmpReqAper', aperPending);
    setC('countEmpReqRekrutmen', rekrutmenAktif);
    setC('countEmpReqFulfilled', fulfilled);
    setC('countEmpReqRejected', rejected);
  } catch (e) {}
}

async function loadEmployeeRequestLokasiDropdown() {
  const selectEl = document.getElementById('empReqLokasi');
  if (!selectEl) return;

  selectEl.innerHTML = '<option value="">-- Memuat Lokasi... --</option>';
  try {
    let locs = [];
    const { data: rpcData, error: rpcErr } = await supabaseClient.rpc('list_lokasi_with_timelimit');
    if (!rpcErr && rpcData && rpcData.length > 0) {
      locs = rpcData.map(l => l.namalokasi || l.NamaLokasi).filter(Boolean);
    } else {
      const { data: fullData, error: fullErr } = await supabaseClient.rpc('list_lokasi_full');
      if (!fullErr && fullData && fullData.length > 0) {
        locs = fullData.map(l => l.namalokasi || l.NamaLokasi).filter(Boolean);
      } else {
        const { data: tblData } = await supabaseClient.from('lokasiTbl').select('NamaLokasi');
        if (tblData) locs = tblData.map(l => l.NamaLokasi).filter(Boolean);
      }
    }

    locs = [...new Set(locs)].filter(name => name && name.trim()).sort((a, b) => a.localeCompare(b, 'id'));

    selectEl.innerHTML = '<option value="">-- Pilih Lokasi / Site --</option>';
    locs.forEach(nama => {
      const opt = document.createElement('option');
      opt.value = nama;
      opt.textContent = `📍 ${nama}`;
      selectEl.appendChild(opt);
    });
  } catch (err) {
    console.error('Error loadEmployeeRequestLokasiDropdown:', err);
    selectEl.innerHTML = '<option value="">Gagal memuat lokasi</option>';
  }
}

function getEmpReqStatusBadge(statusRaw) {
  const status = String(statusRaw || 'PENDING_AER').toUpperCase();
  if (status === 'PENDING_AER' || status === 'PENDING') {
    return `<span style="display:inline-block; padding:3px 8px; font-size:11px; font-weight:700; border-radius:12px; background:#fef3c7; color:#b45309;">⏳ Menunggu AER</span>`;
  }
  if (status === 'PROSES_HRD' || status === 'IN PROGRESS') {
    return `<span style="display:inline-block; padding:3px 8px; font-size:11px; font-weight:700; border-radius:12px; background:#dbeafe; color:#1d4ed8;">🔵 Proses HRD (PER)</span>`;
  }
  if (status === 'PENDING_APER') {
    return `<span style="display:inline-block; padding:3px 8px; font-size:11px; font-weight:700; border-radius:12px; background:#f3e8ff; color:#7e22ce;">🟣 Menunggu Direksi</span>`;
  }
  if (status === 'REKRUTMEN_AKTIF') {
    return `<span style="display:inline-block; padding:3px 8px; font-size:11px; font-weight:700; border-radius:12px; background:#f0fdfa; color:#0d9488;">🔎 Proses Rekrutmen</span>`;
  }
  if (status === 'FULFILLED' || status === 'APPROVED' || status === 'APPROVED_APER') {
    return `<span style="display:inline-block; padding:3px 8px; font-size:11px; font-weight:700; border-radius:12px; background:#ecfdf5; color:#047857;">🟢 Terisi Penuh</span>`;
  }
  if (status.startsWith('REJECTED')) {
    const label = status === 'REJECTED_AER' ? 'Ditolak AER' : (status === 'REJECTED_APER' ? 'Ditolak Direksi' : 'Ditolak');
    return `<span style="display:inline-block; padding:3px 8px; font-size:11px; font-weight:700; border-radius:12px; background:#fee2e2; color:#b91c1c;">🔴 ${label}</span>`;
  }
  return `<span style="display:inline-block; padding:3px 8px; font-size:11px; font-weight:700; border-radius:12px; background:#f1f5f9; color:#475569;">${status}</span>`;
}

function renderEmployeeRequestTable() {
  const tbody = document.getElementById('empReqTableBody');
  const badgeCountEl = document.getElementById('empReqBadgeCount');
  if (!tbody) return;

  const keyword = (document.getElementById('empReqSearch')?.value || '').toLowerCase().trim();
  const filtered = (empReqState.rows || []).filter(r => {
    if (!keyword) return true;
    const haystack = [
      r.requestno, r.pemohonnama, r.divisi, r.departemen, r.posisijabatan, r.lokasisite, r.projectcode, r.status
    ].join(' ').toLowerCase();
    return haystack.includes(keyword);
  });

  if (badgeCountEl) badgeCountEl.textContent = `${filtered.length} Permintaan`;

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:#777;">Belum ada data permintaan karyawan.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    const isAuthor = hasEmployeeRequestAuthor();

    return `
      <tr>
        <td><strong style="font-family:monospace; color:#1e293b;">${escapeHtml(r.requestno)}</strong></td>
        <td>${r.tanggalrequest || '-'}</td>
        <td><strong>${escapeHtml(r.pemohonnama)}</strong></td>
        <td>
          <span style="font-weight:700; color:#0f172a;">${escapeHtml(r.divisi || '-')}</span><br>
          <span style="font-size:11px; color:#64748b;">${escapeHtml(r.departemen || '-')}</span>
        </td>
        <td><span style="font-weight:600; color:#2563eb;">${escapeHtml(r.posisijabatan)}</span></td>
        <td><span style="font-weight:700; background:#f1f5f9; padding:2px 8px; border-radius:6px;">${r.jumlahorang || 1} Org</span></td>
        <td>${escapeHtml(r.lokasisite || '-')}</td>
        <td>${r.tanggaldibutuhkan || '-'}</td>
        <td>${getEmpReqStatusBadge(r.status)}</td>
        <td style="text-align:center; white-space:nowrap;">
          <button type="button" class="btn-primary" style="padding:4px 8px; font-size:11px;" onclick="openEmployeeRequestDetail(${r.id})">
            👁️ Detail
          </button>
          ${isAuthor ? `
            <button type="button" class="btn-logout-card" style="padding:4px 8px; font-size:11px; margin-left:4px;" onclick="deleteEmployeeRequest(${r.id})">
              🗑️
            </button>
          ` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

function scrollToEmpReqForm() {
  const formCard = document.getElementById('cardEmpReqForm');
  if (formCard) {
    formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const divSelect = document.getElementById('empReqDivisi');
    if (divSelect) divSelect.focus();
  }
}

async function submitEmployeeRequest() {
  if (!currentUser) {
    showToast('Silakan login terlebih dahulu.', 'error');
    return;
  }

  const divisi = document.getElementById('empReqDivisi')?.value.trim();
  const dept = document.getElementById('empReqDepartemen')?.value.trim();
  let posisi = document.getElementById('empReqPosisi')?.value.trim();
  if (posisi === 'CUSTOM') {
    posisi = document.getElementById('empReqPosisiCustom')?.value.trim();
  }

  const proj = document.getElementById('empReqProject')?.value.trim();
  const lokasi = document.getElementById('empReqLokasi')?.value.trim();
  const jml = parseInt(document.getElementById('empReqJumlah')?.value, 10) || 1;
  const tglButuh = document.getElementById('empReqTanggalButuh')?.value;
  const durasi = document.getElementById('empReqDurasi')?.value;
  const gender = document.getElementById('empReqGender')?.value;
  const pendidikan = document.getElementById('empReqPendidikan')?.value;
  const pengalaman = document.getElementById('empReqPengalaman')?.value;
  const alasan = document.getElementById('empReqAlasan')?.value;
  const kualifikasi = document.getElementById('empReqKualifikasi')?.value.trim();

  if (!divisi || !dept || !posisi || !lokasi || !tglButuh || !durasi || !alasan) {
    showToast('Mohon lengkapi Divisi, Departemen, Posisi, Lokasi, Target Tanggal, dan Alasan!', 'error');
    return;
  }

  const btn = document.getElementById('btnSubmitEmpReq');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Mengirim...'; }

  try {
    const { data, error } = await supabaseClient.rpc('submit_employee_request', {
      p_pemohon_id: currentUser.id,
      p_pemohon_nama: currentUser.nama,
      p_divisi: divisi,
      p_departemen: dept,
      p_project_code: proj,
      p_lokasi_site: lokasi,
      p_posisi_jabatan: posisi,
      p_jumlah_orang: jml,
      p_tanggal_dibutuhkan: tglButuh,
      p_durasi_kerja: durasi,
      p_jenis_kelamin: gender,
      p_pendidikan: pendidikan,
      p_pengalaman: pengalaman,
      p_kualifikasi: kualifikasi,
      p_alasan: alasan
    });

    if (error) throw error;

    showToast(data?.message || 'Permintaan karyawan berhasil dikirim!', 'success');
    resetEmployeeRequestForm();
    await loadEmployeeRequestPage(empReqState.currentTab);
  } catch (err) {
    console.error('Error submitEmployeeRequest:', err);
    showToast('Gagal mengirim permintaan: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Kirim Permintaan Karyawan'; }
  }
}

function resetEmployeeRequestForm() {
  const form = document.getElementById('formEmployeeRequest');
  if (form) form.reset();
  const pemohonInput = document.getElementById('empReqPemohon');
  if (pemohonInput && currentUser) {
    pemohonInput.value = `${currentUser.nama} (ID: ${currentUser.id})`;
  }
  handleEmpReqDivisiChange();
}

function openEmployeeRequestDetail(id) {
  const req = (empReqState.rows || []).find(r => r.id === id);
  if (!req) return;

  empReqState.selectedRequest = req;

  const modal = document.getElementById('modalEmpReqDetail');
  const bodyEl = document.getElementById('modalEmpReqBody');
  const boxApproval = document.getElementById('boxEmpReqApprovalAction');

  const status = String(req.status || 'PENDING_AER').toUpperCase();

  // 3-Level Stepper Status Helper
  const isAerDone = Boolean(req.aer_approved_by || req.aer_approved_at);
  const isHrdDone = Boolean(req.hrd_processed_by || req.hrd_processed_at);
  const isAperDone = Boolean(req.aper_approved_by || req.aper_approved_at);

  if (bodyEl) {
    bodyEl.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #e2e8f0; padding-bottom:8px; margin-bottom:12px;">
        <div>
          <span style="font-size:11px; color:#64748b; font-weight:700;">NO. REQUEST</span>
          <div style="font-size:16px; font-weight:800; font-family:monospace; color:#0f172a;">${escapeHtml(req.requestno)}</div>
        </div>
        <div>
          ${getEmpReqStatusBadge(req.status)}
        </div>
      </div>

      <!-- 3-STAGE WORKFLOW STEPPER -->
      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:8px; padding:10px 14px; margin-bottom:14px;">
        <span style="font-size:11px; font-weight:700; color:#475569; display:block; margin-bottom:8px;">📌 PROGRESS WORKFLOW 3-LEVEL:</span>
        <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:8px; font-size:11px; text-align:center;">
          <!-- Level 1: AER -->
          <div style="padding:6px; border-radius:6px; background:${isAerDone ? '#f0fdf4; border:1px solid #86efac;' : (status.startsWith('PENDING_AER') || status === 'PENDING' ? '#fef3c7; border:1px solid #fde047;' : '#f8fafc; border:1px solid #e2e8f0;')}">
            <strong>1. Atasan / PM (AER)</strong><br>
            <span>${isAerDone ? '✅ Disetujui' : (status === 'REJECTED_AER' ? '❌ Ditolak' : '⏳ Menunggu')}</span>
            ${req.aer_approved_by ? `<div style="font-size:10px; color:#15803d; margin-top:2px;">oleh: ${escapeHtml(req.aer_approved_by)}</div>` : ''}
          </div>

          <!-- Level 2: PER (HRD) -->
          <div style="padding:6px; border-radius:6px; background:${isHrdDone ? '#f0fdf4; border:1px solid #86efac;' : (status === 'PROSES_HRD' || status === 'IN PROGRESS' ? '#dbeafe; border:1px solid #93c5fd;' : '#f8fafc; border:1px solid #e2e8f0;')}">
            <strong>2. Rekrutmen HRD (PER)</strong><br>
            <span>${isHrdDone ? '✅ Seleksi Selesai' : (status === 'PROSES_HRD' || status === 'IN PROGRESS' ? '🔵 Sedang Proses' : '⏳ Menunggu')}</span>
            ${req.hrd_processed_by ? `<div style="font-size:10px; color:#2563eb; margin-top:2px;">oleh: ${escapeHtml(req.hrd_processed_by)}</div>` : ''}
          </div>

          <!-- Level 3: APER (Direksi) -->
          <div style="padding:6px; border-radius:6px; background:${isAperDone ? '#f0fdf4; border:1px solid #86efac;' : (status === 'PENDING_APER' ? '#f3e8ff; border:1px solid #d8b4fe;' : '#f8fafc; border:1px solid #e2e8f0;')}">
            <strong>3. Direksi / BOD (APER)</strong><br>
            <span>${isAperDone ? '🟢 Approved Final' : (status === 'REJECTED_APER' ? '❌ Ditolak' : '⏳ Menunggu')}</span>
            ${req.aper_approved_by ? `<div style="font-size:10px; color:#15803d; margin-top:2px;">oleh: ${escapeHtml(req.aper_approved_by)}</div>` : ''}
          </div>
        </div>
      </div>

      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px 14px; margin-bottom:12px;">
        <div><strong style="color:#64748b; font-size:11px;">PEMOHON:</strong><br><strong>${escapeHtml(req.pemohonnama)}</strong></div>
        <div><strong style="color:#64748b; font-size:11px;">DIVISI:</strong><br><strong style="color:#0f172a;">${escapeHtml(req.divisi || '-')}</strong></div>
        <div><strong style="color:#64748b; font-size:11px;">DEPARTEMEN:</strong><br>${escapeHtml(req.departemen || '-')}</div>
        <div><strong style="color:#64748b; font-size:11px;">KODE / NAMA PROYEK:</strong><br><strong style="color:#0284c7;">${escapeHtml(req.projectcode || '-')}</strong></div>
        <div><strong style="color:#64748b; font-size:11px;">LOKASI PENEMPATAN / SITE:</strong><br><strong style="color:#2563eb;">📍 ${escapeHtml(req.lokasisite || '-')}</strong></div>
        <div><strong style="color:#64748b; font-size:11px;">POSISI / KUALIFIKASI:</strong><br><strong style="font-size:14px; color:#2563eb;">${escapeHtml(req.posisijabatan)}</strong></div>
        <div><strong style="color:#64748b; font-size:11px;">JUMLAH KEBUTUHAN:</strong><br><strong style="color:#e8562c;">${req.jumlahorang || 1} Orang</strong></div>
        <div><strong style="color:#64748b; font-size:11px;">TARGET ON-BOARD:</strong><br>${req.tanggaldibutuhkan || '-'}</div>
        <div><strong style="color:#64748b; font-size:11px;">ESTIMASI DURASI KERJA:</strong><br>${escapeHtml(req.durasikerja || '-')}</div>
        <div><strong style="color:#64748b; font-size:11px;">PREFERENSI GENDER:</strong><br>${escapeHtml(req.jeniskelamin || '-')}</div>
        <div><strong style="color:#64748b; font-size:11px;">PENDIDIKAN MINIMAL:</strong><br>${escapeHtml(req.pendidikanminimal || '-')}</div>
        <div><strong style="color:#64748b; font-size:11px;">PENGALAMAN MINIMAL:</strong><br>${escapeHtml(req.pengalamanminimal || '-')}</div>
        <div><strong style="color:#64748b; font-size:11px;">ALASAN PERMINTAAN:</strong><br>${escapeHtml(req.alasanpermintaan || '-')}</div>
      </div>

      <div style="background:#fff; border:1px solid #e2e8f0; border-radius:6px; padding:10px; margin-top:8px;">
        <strong style="color:#475569; font-size:11px; display:block; margin-bottom:4px;">KUALIFIKASI KHUSUS &amp; URAIAN TUGAS:</strong>
        <div style="white-space:pre-line; color:#1e293b;">${escapeHtml(req.kualifikasikhusus || 'Tidak ada catatan khusus.')}</div>
      </div>

      <!-- AUDIT LOG CATATAN EVALUASI TIAP TINGKAT -->
      ${req.aer_notes || req.aer_approved_by ? `
        <div style="background:#f8fafc; border:1px solid #cbd5e1; border-radius:6px; padding:8px 10px; margin-top:10px; font-size:12px;">
          <strong style="color:#334155;">📝 Catatan Atasan / PM (AER):</strong> ${escapeHtml(req.aer_notes || '-')}
          <span style="color:#64748b; font-size:11px; display:block;">Oleh: ${escapeHtml(req.aer_approved_by || '-')} (${req.aer_approved_at ? new Date(req.aer_approved_at).toLocaleString('id-ID') : '-'})</span>
        </div>
      ` : ''}

      ${req.hrd_notes || req.hrd_processed_by ? `
        <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:6px; padding:8px 10px; margin-top:8px; font-size:12px;">
          <strong style="color:#1e40af;">📝 Catatan Proses HRD (PER):</strong> ${escapeHtml(req.hrd_notes || '-')}
          <span style="color:#64748b; font-size:11px; display:block;">Oleh: ${escapeHtml(req.hrd_processed_by || '-')} (${req.hrd_processed_at ? new Date(req.hrd_processed_at).toLocaleString('id-ID') : '-'})</span>
        </div>
      ` : ''}

      ${req.aper_notes || req.aper_approved_by ? `
        <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px; padding:8px 10px; margin-top:8px; font-size:12px;">
          <strong style="color:#166534;">📝 Catatan Direksi / BOD (APER):</strong> ${escapeHtml(req.aper_notes || '-')}
          <span style="color:#64748b; font-size:11px; display:block;">Oleh: ${escapeHtml(req.aper_approved_by || '-')} (${req.aper_approved_at ? new Date(req.aper_approved_at).toLocaleString('id-ID') : '-'})</span>
        </div>
      ` : ''}

      <!-- PANEL TRACKING REKRUTMEN (muncul begitu Direksi/APER approve, sampai posisi terisi penuh) -->
      ${(status === 'REKRUTMEN_AKTIF') ? `
        <div id="panelRekrutmen-${req.id}" style="background:#f0fdfa; border:1.5px dashed #0d9488; border-radius:8px; padding:12px; margin-top:12px;">
          <div style="font-size:12px; color:#0f766e;">⏳ Memuat data kandidat...</div>
        </div>
      ` : ''}

      <!-- INFO KALAU SUDAH TERISI PENUH -->
      ${(status === 'FULFILLED' || status === 'APPROVED' || status === 'APPROVED_APER') ? `
        <div style="background:#ecfdf5; border:1px solid #86efac; border-radius:8px; padding:10px 12px; margin-top:12px; font-size:12px; color:#047857;">
          ✅ Kebutuhan posisi ini sudah terisi penuh. Kandidat yang diterima sudah otomatis tercatat.
        </div>
      ` : ''}
    `;
  }

  if (status === 'REKRUTMEN_AKTIF') {
    loadKandidatRekrutmen(req.id);
  }

  // RENDER DYNAMIC ACTION BOX BERDASARKAN ROLE LOGIN & STATUS SAAT INI
  if (boxApproval) {
    const projCode = req.projectcode || req.projectCode || req.ProjectCode || '';
    const canAer = canUserApproveAer(projCode);
    const canHrd = canUserProcessHrd();
    const canAper = canUserApproveAper();

    if (status === 'PENDING_AER' || status === 'PENDING') {
      if (canAer) {
        actionHtml = `
          <label for="empReqActionNotes" style="font-weight:700; font-size:12px; color:#1e293b; display:block; margin-bottom:4px;">
            ✍️ Catatan Evaluasi Project Manager / Atasan (AER):
          </label>
          <textarea id="empReqActionNotes" rows="2" placeholder="Tuliskan catatan persetujuan atau alasan penolakan proyek..." style="width:100%; padding:8px; border-radius:6px; border:1px solid #cbd5e1; font-family:inherit; font-size:12px;"></textarea>
          <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
            <button type="button" class="btn-primary" style="flex:1; min-width:140px; background:#16a34a;" onclick="executeEmpReqStep('AER_APPROVE')">
              ✅ Setujui &amp; Teruskan ke HRD (AER)
            </button>
            <button type="button" class="btn-logout-card" style="flex:1; min-width:120px; " onclick="executeEmpReqStep('AER_REJECT')">
              ❌ Tolak Permintaan (AER)
            </button>
          </div>
        `;
      } else {
        actionHtml = `<div style="color:#b45309; background:#fef3c7; padding:8px 12px; border-radius:6px; font-size:12px;">⏳ Menunggu persetujuan Atasan / Project Manager (Author: <strong>AER</strong>).</div>`;
      }
    } else if (status === 'PROSES_HRD' || status === 'IN PROGRESS') {
      if (canHrd) {
        actionHtml = `
          <label for="empReqActionNotes" style="font-weight:700; font-size:12px; color:#1e293b; display:block; margin-bottom:4px;">
            ✍️ Catatan Evaluasi &amp; Rekrutmen HRD (PER):
          </label>
          <textarea id="empReqActionNotes" rows="2" placeholder="Contoh: Kandidat sudah lolos interview teknis &amp; MCU, diajukan ke Direksi untuk ACC final..." style="width:100%; padding:8px; border-radius:6px; border:1px solid #cbd5e1; font-family:inherit; font-size:12px;"></textarea>
          <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
            <button type="button" class="btn-primary" style="flex:1; min-width:160px; background:#7c3aed;" onclick="executeEmpReqStep('HRD_PROCEED_BOD')">
              📤 Ajukan Persetujuan Final ke Direksi (APER)
            </button>
            <button type="button" class="btn-primary" style="flex:1; min-width:140px; background:#2563eb;" onclick="executeEmpReqStep('HRD_UPDATE')">
              💾 Simpan Update Catatan HRD
            </button>
          </div>
        `;
      } else {
        actionHtml = `<div style="color:#1d4ed8; background:#dbeafe; padding:8px 12px; border-radius:6px; font-size:12px;">🔵 Sedang dalam proses seleksi &amp; rekrutmen oleh Tim HRD (PIC: <strong>PER</strong>).</div>`;
      }
    } else if (status === 'PENDING_APER') {
      if (canAper) {
        actionHtml = `
          <label for="empReqActionNotes" style="font-weight:700; font-size:12px; color:#1e293b; display:block; margin-bottom:4px;">
            ✍️ Catatan Persetujuan Direksi / BOD (APER):
          </label>
          <textarea id="empReqActionNotes" rows="2" placeholder="Tuliskan catatan otorisasi Direksi..." style="width:100%; padding:8px; border-radius:6px; border:1px solid #cbd5e1; font-family:inherit; font-size:12px;"></textarea>
          <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
            <button type="button" class="btn-primary" style="flex:1; min-width:140px; background:#059669;" onclick="executeEmpReqStep('APER_APPROVE')">
              🟢 Setujui Final / ACC Direksi (APER)
            </button>
            <button type="button" class="btn-logout-card" style="flex:1; min-width:120px; " onclick="executeEmpReqStep('APER_REJECT')">
              ❌ Tolak Pengajuan (APER)
            </button>
          </div>
        `;
      } else {
        actionHtml = `<div style="color:#7e22ce; background:#f3e8ff; padding:8px 12px; border-radius:6px; font-size:12px;">🟣 Menunggu persetujuan final dari Direksi / BOD (Author: <strong>APER</strong>).</div>`;
      }
    } else if (status === 'REKRUTMEN_AKTIF') {
      actionHtml = canHrd
        ? `<div style="color:#0f766e; background:#f0fdfa; padding:8px 12px; border-radius:6px; font-size:12px;">🔎 Permintaan sudah di-ACC Direksi. Catat kandidat yang disounding di panel atas.</div>`
        : `<div style="color:#0f766e; background:#f0fdfa; padding:8px 12px; border-radius:6px; font-size:12px;">🔎 Sudah di-ACC Direksi, Tim HRD sedang proses sourcing kandidat.</div>`;
    } else if (status === 'FULFILLED' || status === 'APPROVED') {
      actionHtml = `<div style="color:#047857; background:#ecfdf5; padding:8px 12px; border-radius:6px; font-size:12px;">✅ Permintaan telah terisi penuh. Semua kandidat yang diterima sudah didaftarkan ke sistem.</div>`;
    } else if (status.startsWith('REJECTED')) {
      actionHtml = `<div style="color:#b91c1c; background:#fee2e2; padding:8px 12px; border-radius:6px; font-size:12px;">❌ Pengajuan permintaan ini telah ditolak.</div>`;
    }

    boxApproval.innerHTML = actionHtml;
    boxApproval.style.display = 'block';
  }

  if (modal) modal.style.display = 'flex';
}

function closeModalEmpReqDetail() {
  const modal = document.getElementById('modalEmpReqDetail');
  if (modal) modal.style.display = 'none';
}

function prefillKaryawanFromRequest(reqId) {
  const req = (empReqState.rows || []).find(r => r.id === reqId) || empReqState.selectedRequest;
  if (!req) return;

  // Tutup modal detail request
  closeModalEmpReqDetail();

  // Buka menu Data Karyawan
  const btnNav = document.getElementById('btnNavKaryawan');
  attemptNav('DK', 'sec-karyawan', btnNav, () => loadKaryawanPage());

  // Reset form ke mode Tambah Baru
  resetKaryawanForm();

  // Isi field otomatis dari request
  const divEl = document.getElementById('karyawanDivisi');
  const deptEl = document.getElementById('karyawanDepartemen');
  const kualEl = document.getElementById('karyawanKualifikasi');
  const typeEl = document.getElementById('karyawanType');
  const tglEl = document.getElementById('karyawanTglMasuk');
  const passEl = document.getElementById('karyawanPassword');
  const namaEl = document.getElementById('karyawanNama');

  if (divEl) divEl.value = req.divisi || '';
  if (deptEl) deptEl.value = req.departemen || '';
  if (kualEl) kualEl.value = req.posisijabatan || '';
  if (typeEl) typeEl.value = req.projectcode || req.lokasisite || 'Project';
  if (tglEl) tglEl.value = req.tanggaldibutuhkan || getTodayDateString();
  if (passEl) passEl.value = '12345'; // Password default 12345

  // Scroll ke form dan fokus ke input nama personel
  setTimeout(() => {
    const formTitle = document.getElementById('karyawanFormTitle');
    if (formTitle) formTitle.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (namaEl) {
      namaEl.focus();
      namaEl.style.borderColor = '#0d9488';
      namaEl.style.boxShadow = '0 0 0 3px rgba(13, 148, 136, 0.2)';
      setTimeout(() => {
        namaEl.style.borderColor = '';
        namaEl.style.boxShadow = '';
      }, 3000);
    }
    showToast(`Data request #${req.requestno || req.id} berhasil disalin ke form! Password default: 12345. Silakan isi Nama Personel.`, 'success', 5000);
  }, 300);
}

// ==================== PANEL TRACKING REKRUTMEN (kandidat per request) ====================

async function loadKandidatRekrutmen(reqId) {
  const panel = document.getElementById(`panelRekrutmen-${reqId}`);
  if (!panel) return;

  try {
    const { data, error } = await supabaseClient.rpc('list_kandidat_rekrutmen', { p_request_id: reqId });
    if (error) throw error;
    renderKandidatRekrutmenPanel(reqId, data);
  } catch (err) {
    console.error('Error loadKandidatRekrutmen:', err);
    panel.innerHTML = `<div style="color:#b91c1c; font-size:12px;">Gagal memuat data kandidat: ${escapeHtml(err.message)}</div>`;
  }
}

function renderKandidatRekrutmenPanel(reqId, data) {
  const panel = document.getElementById(`panelRekrutmen-${reqId}`);
  if (!panel) return;

  const kandidatList = data?.kandidat || [];
  const jumlahDibutuhkan = data?.jumlah_dibutuhkan || 1;
  const jumlahDiterima = data?.jumlah_diterima || 0;

  const statusColor = { PROSES: '#b45309', DITOLAK: '#b91c1c', DITERIMA: '#047857' };
  const statusBg = { PROSES: '#fef3c7', DITOLAK: '#fee2e2', DITERIMA: '#ecfdf5' };
  const konfirmasiLabel = {
    BELUM_DIKIRIM: '⚪ Belum dikirim',
    MENUNGGU_KONFIRMASI: '🟡 Menunggu respon kandidat',
    DIKONFIRMASI: '🟢 Sudah dikonfirmasi kandidat'
  };

  const rowsHtml = kandidatList.length ? kandidatList.map(k => `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:8px 10px; background:#fff; border:1px solid #e2e8f0; border-radius:6px; margin-bottom:6px; flex-wrap:wrap;">
      <div style="flex:1; min-width:150px;">
        <strong style="font-size:12px; color:#0f172a;">${escapeHtml(k.NamaKandidat)}</strong>
        <span style="display:inline-block; margin-left:6px; padding:1px 6px; font-size:10px; font-weight:700; border-radius:8px; background:${statusBg[k.Status] || '#f1f5f9'}; color:${statusColor[k.Status] || '#475569'};">${escapeHtml(k.Status)}</span>
        <div style="font-size:10px; color:#64748b; margin-top:2px;">
          Interview: ${k.TglInterview || '-'} • ${konfirmasiLabel[k.KonfirmasiStatus] || k.KonfirmasiStatus}
        </div>
      </div>
      ${k.Status === 'PROSES' ? `
        <div style="display:flex; gap:6px;">
          <button type="button" style="font-size:10px; padding:5px 8px; border-radius:6px; border:none; background:#0d9488; color:#fff; cursor:pointer;" onclick="kirimLinkKonfirmasi(${k.Id}, '${escapeHtml(k.NamaKandidat).replace(/'/g, "\\'")}', ${reqId})">
            📧 Kirim Link
          </button>
        </div>
      ` : ''}
    </div>
  `).join('') : `<div style="font-size:11px; color:#64748b; padding:6px 0;">Belum ada kandidat yang disounding.</div>`;

  panel.innerHTML = `
    <strong style="color:#0f766e; font-size:13px; display:flex; align-items:center; gap:5px; margin-bottom:8px;">
      <span>🔎</span> Proses Rekrutmen — ${jumlahDiterima} / ${jumlahDibutuhkan} Orang Terisi
    </strong>
    <div id="kandidatListWrap-${reqId}">${rowsHtml}</div>
    <div style="margin-top:10px; padding-top:10px; border-top:1px dashed #99f6e4;">
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px;">
        <input type="text" id="kandidatNama-${reqId}" placeholder="Nama Kandidat" style="padding:6px 8px; font-size:12px; border-radius:6px; border:1px solid #cbd5e1;">
        <input type="date" id="kandidatTglInterview-${reqId}" style="padding:6px 8px; font-size:12px; border-radius:6px; border:1px solid #cbd5e1;">
      </div>
      <button type="button" style="margin-top:6px; width:100%; padding:7px; font-size:12px; font-weight:700; border:none; border-radius:6px; background:#0d9488; color:#fff; cursor:pointer;" onclick="submitKandidatBaru(${reqId})">
        ➕ Tambah Kandidat
      </button>
    </div>
  `;
}

async function submitKandidatBaru(reqId) {
  const namaEl = document.getElementById(`kandidatNama-${reqId}`);
  const tglEl = document.getElementById(`kandidatTglInterview-${reqId}`);
  const nama = (namaEl?.value || '').trim();
  const tgl = tglEl?.value || null;

  if (!nama) {
    showToast('Nama kandidat wajib diisi!', 'error');
    return;
  }

  try {
    const actor = currentUser ? `${currentUser.nama} (${currentUser.id})` : 'System';
    const { data, error } = await supabaseClient.rpc('submit_kandidat_rekrutmen', {
      p_request_id: reqId,
      p_nama_kandidat: nama,
      p_tgl_interview: tgl,
      p_status: 'PROSES',
      p_notes: null,
      p_actor_name: actor
    });
    if (error) throw error;

    showToast(data?.message || 'Kandidat berhasil dicatat.', 'success');
    if (namaEl) namaEl.value = '';
    if (tglEl) tglEl.value = '';
    await loadKandidatRekrutmen(reqId);
  } catch (err) {
    console.error('Error submitKandidatBaru:', err);
    showToast('Gagal mencatat kandidat: ' + err.message, 'error');
  }
}

async function kirimLinkKonfirmasi(kandidatId, namaKandidat, reqId) {
  const email = (prompt(`Masukkan email ${namaKandidat} untuk kirim link konfirmasi:`) || '').trim();
  if (!email) return;

  try {
    // Ambil PIN & detail terbaru dari list (supaya PIN akurat, bukan tebakan client)
    const { data: listData, error: listErr } = await supabaseClient.rpc('list_kandidat_rekrutmen', { p_request_id: reqId });
    if (listErr) throw listErr;
    const kandidat = (listData?.kandidat || []).find(k => k.Id === kandidatId);
    if (!kandidat || !kandidat.Pin) {
      showToast('Data kandidat/PIN tidak ditemukan.', 'error');
      return;
    }

    const link = `https://rovansyahriza-crv.github.io/Fusion4/konfirmasi-kandidat.html?kandidat=${kandidatId}`;

    await fetch(RFQ_EMAIL_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "SEND_SIMPLE_EMAIL",
        to: email,
        subject: `Konfirmasi Penerimaan Posisi — ${namaKandidat}`,
        body: `Halo ${namaKandidat},\n\nSelamat! Anda dinyatakan lolos seleksi. Silakan konfirmasi kesediaan Anda melalui link berikut:\n${link}\n\nMasukkan PIN Anda: ${kandidat.Pin}\n\nTerima kasih.`
      })
    });

    await supabaseClient.rpc('catat_pengiriman_konfirmasi_kandidat', { p_kandidat_id: kandidatId });

    showToast(`Link konfirmasi berhasil dikirim ke ${email}.`, 'success');
    await loadKandidatRekrutmen(reqId);
  } catch (err) {
    console.error('Error kirimLinkKonfirmasi:', err);
    showToast('Gagal mengirim link konfirmasi: ' + err.message, 'error');
  }
}

async function executeEmpReqStep(action) {
  if (!empReqState.selectedRequest) return;

  const reqId = empReqState.selectedRequest.id;
  const notes = (document.getElementById('empReqActionNotes')?.value || '').trim();
  const actor = currentUser ? `${currentUser.nama} (${currentUser.id})` : 'System';

  try {
    const { data, error } = await supabaseClient.rpc('process_employee_request_step', {
      p_id: reqId,
      p_actor_name: actor,
      p_step_action: action,
      p_notes: notes
    });

    if (error) throw error;

    showToast(data?.message || 'Status permintaan berhasil diperbarui.', 'success');
    closeModalEmpReqDetail();
    await loadEmployeeRequestPage(empReqState.currentTab);
  } catch (err) {
    console.error('Error executeEmpReqStep:', err);
    showToast('Gagal memproses approval: ' + err.message, 'error');
  }
}

async function deleteEmployeeRequest(id) {
  if (!confirm('Apakah Anda yakin ingin menghapus pengajuan permintaan karyawan ini?')) return;

  try {
    const { data, error } = await supabaseClient.rpc('delete_employee_request', { p_id: id });
    if (error) throw error;
    showToast(data?.message || 'Permintaan karyawan berhasil dihapus.', 'success');
    await loadEmployeeRequestPage(empReqState.currentTab);
  } catch (err) {
    console.error('Error deleteEmployeeRequest:', err);
    showToast('Gagal menghapus permintaan: ' + err.message, 'error');
  }
}