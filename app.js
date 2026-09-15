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
    setupLoginSearch();
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
  { key: 'ER', label: 'Permintaan Karyawan', sectionId: 'sec-employee-request', btnId: 'btnNavEmployeeRequest' },
  { key: 'KK', label: 'Kontrak Karyawan', sectionId: 'sec-kontrak', btnId: 'btnNavKontrak' },
  { key: 'DK', label: 'Data Karyawan', sectionId: 'sec-karyawan', btnId: 'btnNavKaryawan' },
  { key: 'KB', label: 'Kompensasi & Benefit', sectionId: 'sec-kompensasi', btnId: 'btnNavKompensasi' },
  { key: 'KDB', label: 'Kelola Digital Badge', sectionId: 'sec-badge', btnId: 'btnNavBadge' },
  { key: 'MAE', label: 'Monitoring Attendance & Enroll', sectionId: 'sec-monitoring', btnId: 'btnNavMonitoring' },
  { key: 'OIL', label: 'Otorisasi Ijin & Lembur', sectionId: 'sec-otorisasi', btnId: 'btnNavOtorisasi' },
  { key: 'KL', label: 'Kelola Lokasi', sectionId: 'sec-lokasi', btnId: 'btnNavLokasi' },
  { key: 'GP', label: 'Ganti Password (Admin)', sectionId: 'sec-password-admin', btnId: 'btnNavPasswordAdmin' },
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

// Login versi searchable combobox: BEDA sama loadUserDropdown() versi lama yang langsung nge-dump
// SEMUA nama admin/PIC ke <select> begitu halaman dibuka (kebaca orang luar sebelum login).
// Sekarang daftar nama baru muncul sebagai saran ketika user udah ngetik minimal 2 huruf, dan
// hasilnya di-query fresh dari server tiap ketikan (RPC search_active_karyawan, dibatasi 8 hasil) --
// bukan hasil filter dari list yang udah ke-load duluan di client.
function setupLoginSearch() {
  const searchEl = document.getElementById('loginSearch');
  const hiddenIdEl = document.getElementById('loginId');
  const suggestEl = document.getElementById('loginSuggestions');
  if (!searchEl || !hiddenIdEl || !suggestEl) return;

  let debounceTimer = null;

  function closeSuggestions() {
    suggestEl.style.display = 'none';
    suggestEl.innerHTML = '';
  }

  function selectSuggestion(user) {
    hiddenIdEl.value = String(user.id).trim();
    searchEl.value = `${String(user.nama).trim()} (ID: ${String(user.id).trim()})`;
    closeSuggestions();
  }

  function renderSuggestions(list) {
    if (!list.length) {
      suggestEl.innerHTML = '<div style="padding:10px 12px; color:#888; font-size:13px;">Nama tidak ditemukan.</div>';
      suggestEl.style.display = 'block';
      return;
    }
    suggestEl.innerHTML = '';
    list.forEach(user => {
      const item = document.createElement('div');
      item.textContent = `${String(user.nama).trim()} (ID: ${String(user.id).trim()})`;
      item.style.cssText = 'padding:10px 12px; cursor:pointer; font-size:14px; border-bottom:1px solid #f0f0f0;';
      item.addEventListener('mouseenter', () => { item.style.background = '#f2f2f2'; });
      item.addEventListener('mouseleave', () => { item.style.background = '#fff'; });
      // mousedown (bukan click) supaya keeksekusi duluan sebelum event blur di input nutup daftar ini.
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectSuggestion(user);
      });
      suggestEl.appendChild(item);
    });
    suggestEl.style.display = 'block';
  }

  async function runSearch(query) {
    try {
      const { data, error } = await supabaseClient.rpc('search_active_karyawan', { p_query: query });
      if (error) throw error;
      renderSuggestions(data || []);
    } catch (error) {
      console.error('Error search_active_karyawan:', error);
      suggestEl.innerHTML = '<div style="padding:10px 12px; color:#c00; font-size:13px;">Gagal terhubung ke server.</div>';
      suggestEl.style.display = 'block';
    }
  }

  searchEl.addEventListener('input', () => {
    // Ketikan berubah -> pilihan lama (kalau ada) jadi gak valid lagi, wajib pilih ulang dari saran.
    hiddenIdEl.value = '';
    const query = searchEl.value.trim();
    clearTimeout(debounceTimer);
    if (query.length < 2) {
      closeSuggestions();
      return;
    }
    debounceTimer = setTimeout(() => runSearch(query), 250);
  });

  searchEl.addEventListener('focus', () => {
    if (searchEl.value.trim().length >= 2 && suggestEl.innerHTML) {
      suggestEl.style.display = 'block';
    }
  });

  searchEl.addEventListener('blur', () => {
    // Delay dikit biar mousedown di item saran sempet ke-handle duluan sebelum daftar ditutup.
    setTimeout(closeSuggestions, 150);
  });
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

  if (!id) {
    showToast('Ketik nama Anda dan pilih dari daftar saran dulu.', 'error');
    return;
  }

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
        } else if (uVal.includes('IJIN')) {
          bg = '#EDE9FE'; color = '#6D28D9'; border = '#DDD6FE';
          displayVal = '📝 ' + escapeHtml(val);
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

function applyPastedCoord() {
  const raw = (document.getElementById('lokasiPasteCoord')?.value || '').trim();
  if (!raw) { showToast('Paste dulu koordinatnya, contoh: -6.208763, 106.845599', 'error'); return; }

  // Terima format "lat, lng" hasil copy dari Google Maps -- dipisah koma atau spasi,
  // boleh pakai desimal negatif (LS/BB).
  const match = raw.match(/(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)/);
  if (!match) {
    showToast('Format koordinat tidak dikenali. Contoh: -6.208763, 106.845599', 'error');
    return;
  }

  const lat = parseFloat(match[1]);
  const lng = parseFloat(match[2]);
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    showToast('Nilai koordinat di luar jangkauan wajar. Cek lagi ya.', 'error');
    return;
  }

  initLokasiMapIfNeeded();
  setLokasiMapPoint(lat, lng, true);
  showToast('Koordinat berhasil di-set: ' + lat.toFixed(6) + ', ' + lng.toFixed(6), 'success');
}

document.addEventListener('keydown', (e) => {
  if (e.target && e.target.id === 'lokasiPasteCoord' && e.key === 'Enter') {
    e.preventDefault();
    applyPastedCoord();
  }
});

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
  if (document.getElementById('lokasiPasteCoord')) document.getElementById('lokasiPasteCoord').value = '';
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
  populateKaryawanDivisiOptions();

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
    ? 'Mode edit update Departemen, Divisi, Kualifikasi/Jabatan, Kode Proyek, Author, dan PIC. Field lain (Nama, Password, dll) gak berubah.'
    : 'QrCodeId & Digital PIN di-generate otomatis. Field detail lain (KTP, alamat, dll) bisa dilengkapi belakangan.';
  const btnSubmit = document.getElementById('btnSubmitKaryawan');
  if (btnSubmit) btnSubmit.textContent = isEdit ? '💾 Simpan Perubahan' : '💾 Simpan Karyawan Baru';
  const btnReset = document.getElementById('btnResetKaryawan');
  if (btnReset) btnReset.textContent = isEdit ? '✕ Batal Edit' : '↺ Kosongkan Form';
}

function ensureSelectHasValue(selectEl, value) {
  if (!selectEl || !value) return;
  const exists = Array.from(selectEl.options).some(o => o.value === value);
  if (!exists) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value + ' (data lama)';
    selectEl.appendChild(opt);
  }
  selectEl.value = value;
}

function editKaryawan(id) {
  const row = (karyawanState.rows || []).find(r => r.id === id);
  if (!row) { showToast('Data karyawan tidak ditemukan.', 'error'); return; }

  setKaryawanEditMode(true);
  document.getElementById('karyawanFormTitle').textContent = `✏️ Edit Karyawan: ${row.namapersonnel || ''}`;
  document.getElementById('karyawanEditId').value = row.id;
  document.getElementById('karyawanNama').value = row.namapersonnel || '';

  populateKaryawanDivisiOptions();
  const divSelect = document.getElementById('karyawanDivisi');
  ensureSelectHasValue(divSelect, row.divisi);
  handleKaryawanDivisiChange();
  const deptSelect = document.getElementById('karyawanDepartemen');
  ensureSelectHasValue(deptSelect, row.departemen);
  handleKaryawanDepartemenChange();
  const kualSelect = document.getElementById('karyawanKualifikasi');
  ensureSelectHasValue(kualSelect, row.kualifikasi);
  handleKaryawanKualifikasiChange();

  document.getElementById('karyawanType').value = row.type || '';
  document.getElementById('karyawanStatusNikah').value = row.statuspernikahan || '';
  document.getElementById('karyawanJumlahAnak').value = row.jumlahanak || '';
  document.getElementById('karyawanAuthor').value = row.author || '';
  document.getElementById('karyawanPic').value = row.pic || '';

  document.getElementById('karyawanFormTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function populateKaryawanDivisiOptions() {
  const divSelect = document.getElementById('karyawanDivisi');
  if (!divSelect || typeof BIMA_ORG_MATRIX === 'undefined') return;
  divSelect.innerHTML = '<option value="">-- Pilih Divisi --</option>';
  Object.keys(BIMA_ORG_MATRIX).forEach(div => {
    const opt = document.createElement('option');
    opt.value = div;
    opt.textContent = div;
    divSelect.appendChild(opt);
  });
}

function handleKaryawanDivisiChange() {
  const divSelect = document.getElementById('karyawanDivisi');
  const deptSelect = document.getElementById('karyawanDepartemen');
  const kualSelect = document.getElementById('karyawanKualifikasi');
  const customGroup = document.getElementById('groupKaryawanKualifikasiCustom');
  if (!deptSelect || !kualSelect) return;

  const selectedDiv = divSelect ? divSelect.value : '';
  deptSelect.innerHTML = '<option value="">-- Pilih Departemen --</option>';
  kualSelect.innerHTML = '<option value="">-- Pilih Departemen Terlebih Dahulu --</option>';
  if (customGroup) customGroup.style.display = 'none';

  if (!selectedDiv || !BIMA_ORG_MATRIX[selectedDiv]) return;

  Object.keys(BIMA_ORG_MATRIX[selectedDiv]).forEach(d => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    deptSelect.appendChild(opt);
  });
}

function handleKaryawanDepartemenChange() {
  const divSelect = document.getElementById('karyawanDivisi');
  const deptSelect = document.getElementById('karyawanDepartemen');
  const kualSelect = document.getElementById('karyawanKualifikasi');
  const customGroup = document.getElementById('groupKaryawanKualifikasiCustom');
  if (!kualSelect) return;

  const selectedDiv = divSelect ? divSelect.value : '';
  const selectedDept = deptSelect ? deptSelect.value : '';

  kualSelect.innerHTML = '<option value="">-- Pilih Kualifikasi / Jabatan --</option>';
  if (customGroup) customGroup.style.display = 'none';

  if (!selectedDiv || !selectedDept || !BIMA_ORG_MATRIX[selectedDiv] || !BIMA_ORG_MATRIX[selectedDiv][selectedDept]) return;

  const defaultPositions = BIMA_ORG_MATRIX[selectedDiv][selectedDept] || [];
  const historicalPositions = (karyawanState.rows || [])
    .filter(r => r.divisi === selectedDiv && r.departemen === selectedDept && r.kualifikasi)
    .map(r => String(r.kualifikasi).trim());
  const combined = [...new Set([...defaultPositions, ...historicalPositions])];

  combined.forEach(p => {
    if (!p || p === 'CUSTOM') return;
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    kualSelect.appendChild(opt);
  });

  const customOpt = document.createElement('option');
  customOpt.value = 'CUSTOM';
  customOpt.textContent = '➕ Jabatan Lainnya (Ketik Sendiri)...';
  kualSelect.appendChild(customOpt);
}

function handleKaryawanKualifikasiChange() {
  const kualSelect = document.getElementById('karyawanKualifikasi');
  const customGroup = document.getElementById('groupKaryawanKualifikasiCustom');
  const customInput = document.getElementById('karyawanKualifikasiCustom');
  if (!kualSelect || !customGroup) return;

  if (kualSelect.value === 'CUSTOM') {
    customGroup.style.display = 'block';
    if (customInput) customInput.focus();
  } else {
    customGroup.style.display = 'none';
    if (customInput) customInput.value = '';
  }
}

function resetKaryawanForm() {
  ['karyawanNama','karyawanType','karyawanTglMasuk','karyawanAuthor','karyawanPic','karyawanEditId','karyawanEmail','karyawanKualifikasiCustom','karyawanStatusNikah','karyawanJumlahAnak']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const passEl = document.getElementById('karyawanPassword');
  if (passEl) passEl.value = '12345';
  const hintEl = document.getElementById('karyawanNamaHint');
  if (hintEl) hintEl.style.display = 'none';
  const emailWrap = document.getElementById('karyawanEmailWrap');
  if (emailWrap) emailWrap.style.display = 'none';

  populateKaryawanDivisiOptions();
  const deptSelect = document.getElementById('karyawanDepartemen');
  if (deptSelect) deptSelect.innerHTML = '<option value="">-- Pilih Divisi Terlebih Dahulu --</option>';
  const kualSelect = document.getElementById('karyawanKualifikasi');
  if (kualSelect) kualSelect.innerHTML = '<option value="">-- Pilih Departemen Terlebih Dahulu --</option>';
  const customGroup = document.getElementById('groupKaryawanKualifikasiCustom');
  if (customGroup) customGroup.style.display = 'none';

  setKaryawanEditMode(false);
  document.getElementById('karyawanFormTitle').textContent = '+ Tambah Karyawan Baru';
}

let karyawanNamaCheckTimer = null;
function cekDuplikatNamaKaryawan() {
  clearTimeout(karyawanNamaCheckTimer);
  karyawanNamaCheckTimer = setTimeout(() => {
    const nama = (document.getElementById('karyawanNama')?.value || '').trim();
    const hintEl = document.getElementById('karyawanNamaHint');
    const emailWrap = document.getElementById('karyawanEmailWrap');
    const editId = document.getElementById('karyawanEditId')?.value || '';

    if (editId || nama.length < 3) {
      if (hintEl) hintEl.style.display = 'none';
      if (emailWrap) emailWrap.style.display = 'none';
      return;
    }

    const namaLower = nama.toLowerCase();
    const match = (karyawanState.rows || []).find(r =>
      String(r.namapersonnel || '').toLowerCase().trim() === namaLower
    );

    if (match) {
      if (hintEl) {
        hintEl.style.display = 'block';
        hintEl.style.color = '#b45309';
        hintEl.textContent = `⚠️ Sudah ada karyawan dengan nama sama: ${match.namapersonnel} (${match.qrcodeid}). Pastikan ini bukan duplikat.`;
      }
      if (emailWrap) emailWrap.style.display = 'none';
    } else {
      if (hintEl) {
        hintEl.style.display = 'block';
        hintEl.style.color = '#0d9488';
        hintEl.textContent = '✅ Nama baru, belum ada di data. Isi email (opsional) untuk kirim link Digital Badge & PIN otomatis.';
      }
      if (emailWrap) emailWrap.style.display = '';
    }
  }, 400);
}

async function submitKaryawanBaru() {
  const editId = document.getElementById('karyawanEditId')?.value || '';
  const nama = document.getElementById('karyawanNama')?.value.trim() || '';
  const departemen = document.getElementById('karyawanDepartemen')?.value.trim() || '';
  const divisi = document.getElementById('karyawanDivisi')?.value.trim() || '';
  const author = document.getElementById('karyawanAuthor')?.value.trim() || '';
  const pic = document.getElementById('karyawanPic')?.value.trim() || '';
  const type = document.getElementById('karyawanType')?.value.trim() || '';
  let kualifikasi = document.getElementById('karyawanKualifikasi')?.value.trim() || '';
  const isCustomKualifikasi = kualifikasi === 'CUSTOM';
  if (isCustomKualifikasi) {
    kualifikasi = document.getElementById('karyawanKualifikasiCustom')?.value.trim() || '';
  }
  const statusNikah = document.getElementById('karyawanStatusNikah')?.value.trim() || '';
  const jumlahAnak = document.getElementById('karyawanJumlahAnak')?.value.trim() || '';

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
        p_kualifikasi: kualifikasi || null,
        p_type: type || null,
        p_status_nikah: statusNikah || null,
        p_jumlah_anak: jumlahAnak || null,
      });
      if (error) throw error;

      if (hasil && hasil.status === 'SUCCESS') {
        showToast(hasil.message || 'Data karyawan berhasil diupdate.', 'success');
        if (isCustomKualifikasi && kualifikasi && divisi && departemen) {
          await syncCustomKualifikasiToMasterGaji(divisi, departemen, kualifikasi);
        }
        resetKaryawanForm();
        loadKaryawanPage();
      } else {
        showToast((hasil && hasil.message) || 'Gagal update karyawan.', 'error');
      }
      return;
    }

    const tglMasuk = document.getElementById('karyawanTglMasuk')?.value || null;
    const password = document.getElementById('karyawanPassword')?.value || '';
    const email = document.getElementById('karyawanEmail')?.value.trim() || '';

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
      p_email: email || null,
      p_status_nikah: statusNikah || null,
      p_jumlah_anak: jumlahAnak || null,
    });
    if (error) throw error;

    if (hasil && hasil.status === 'SUCCESS') {
      const pinInfo = hasil.digitalpin ? ` Digital PIN: ${hasil.digitalpin}` : '';
      const qrInfo = hasil.qrcodeid ? ` QrCodeId: ${hasil.qrcodeid}` : '';
      showToast((hasil.message || 'Karyawan baru berhasil dibuat.') + qrInfo + pinInfo, 'success');

      if (isCustomKualifikasi && kualifikasi && divisi && departemen) {
        await syncCustomKualifikasiToMasterGaji(divisi, departemen, kualifikasi);
      }

      if (email && hasil.digitalpin) {
        try {
          const link = `https://rovansyahriza-crv.github.io/Fusion4/digital-badge.html?pin=${hasil.digitalpin}`;
          await fetch(RFQ_EMAIL_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify({
              action: "SEND_SIMPLE_EMAIL",
              to: email,
              subject: `Akses Digital Badge Anda — ${nama}`,
              body: `Halo ${nama},\n\nAnda telah terdaftar di Fusion4 SmartGate. Berikut akses Digital Badge Anda:\n\nLink: ${link}\nPIN: ${hasil.digitalpin}\n\nSimpan PIN ini baik-baik, jangan dibagikan ke orang lain.\n\nTerima kasih.`
            })
          });
          showToast(`Email link Digital Badge & PIN berhasil dikirim ke ${email}.`, 'success');
        } catch (emailErr) {
          console.error('Gagal kirim email badge:', emailErr);
          showToast('Karyawan tersimpan, tapi gagal kirim email: ' + emailErr.message, 'error');
        }
      }

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

  if (!polaKerjaState || polaKerjaState.length === 0) {
    try {
      const { data: polaData } = await supabaseClient.rpc('list_pola_kerja');
      polaKerjaState = polaData || [];
    } catch (e) { console.warn('Gagal memuat Pola Kerja:', e); }
  }
  handleKontrakJenisChange();

  if (!kbState.gaji || kbState.gaji.length === 0) {
    try {
      const { data: gajiData } = await supabaseClient.rpc('list_master_gaji');
      kbState.gaji = gajiData || [];
    } catch (e) { console.warn('Gagal preload Master Gaji untuk sinkron Kontrak:', e); }
  }

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

let kontrakKaryawanCache = [];

async function loadKontrakKaryawanDropdown() {
  const datalistEl = document.getElementById('kontrakKaryawanDatalist');
  if (!datalistEl) return;

  try {
    const { data, error } = await supabaseClient.rpc('get_all_active_karyawan_for_kontrak');
    if (error) throw error;
    kontrakKaryawanCache = data || [];
    datalistEl.innerHTML = kontrakKaryawanCache.map(k => `<option value="${escapeHtml(k.nama)}">`).join('');
  } catch (err) {
    console.error('Gagal memuat daftar karyawan untuk kontrak:', err);
  }
}

let polaKerjaState = [];

function handleKontrakJenisChange() {
  const jenis = document.getElementById('kontrakJenis')?.value;
  const berakhirInput = document.getElementById('kontrakBerakhir');
  const hintEl = document.getElementById('kontrakBerakhirHint');
  const kategoriWrap = document.getElementById('kontrakKategoriWrap');
  const polaWrap = document.getElementById('kontrakPolaWrap');

  if (berakhirInput) {
    if (jenis === 'PKWTT') {
      berakhirInput.value = '';
      berakhirInput.disabled = true;
      berakhirInput.style.background = '#f5f2ee';
      if (hintEl) hintEl.style.display = 'block';
    } else {
      berakhirInput.disabled = false;
      berakhirInput.style.background = '';
      if (hintEl) hintEl.style.display = 'none';
    }
  }

  // Kategori & Pola Kerja cuma relevan buat PKWT
  if (kategoriWrap) kategoriWrap.style.display = jenis === 'PKWT' ? 'block' : 'none';
  if (polaWrap) polaWrap.style.display = jenis === 'PKWT' ? 'block' : 'none';
  if (jenis !== 'PKWT') {
    const kategoriSel = document.getElementById('kontrakKategori');
    if (kategoriSel) kategoriSel.value = '';
    const polaSel = document.getElementById('kontrakPolaKerja');
    if (polaSel) polaSel.innerHTML = '<option value="">-- Pilih Kategori Dahulu --</option>';
  }
}

function handleKontrakKategoriChange() {
  const kategori = document.getElementById('kontrakKategori')?.value;
  const polaSel = document.getElementById('kontrakPolaKerja');
  if (!polaSel) return;
  polaSel.innerHTML = '<option value="">-- Pilih Pola Kerja --</option>';
  if (!kategori) {
    polaSel.innerHTML = '<option value="">-- Pilih Kategori Dahulu --</option>';
    return;
  }
  polaKerjaState.filter(p => p.Kategori === kategori).forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.Id;
    opt.textContent = p.NamaPola;
    polaSel.appendChild(opt);
  });
}

function cekKaryawanKontrak() {
  const inputEl = document.getElementById('kontrakKaryawanInput');
  const hiddenEl = document.getElementById('kontrakKaryawan');
  const hintEl = document.getElementById('kontrakKaryawanHint');
  const emailWrap = document.getElementById('kontrakEmailWrap');
  const editId = document.getElementById('kontrakEditId')?.value || '';
  const nama = (inputEl?.value || '').trim();

  if (editId) return; // mode edit: kunci ke karyawan yang sudah ter-link, jangan diubah logic-nya

  if (nama.length < 2) {
    hiddenEl.value = '';
    if (hintEl) hintEl.style.display = 'none';
    if (emailWrap) emailWrap.style.display = 'none';
    return;
  }

  const match = kontrakKaryawanCache.find(k => String(k.nama || '').toLowerCase().trim() === nama.toLowerCase());

  if (match) {
    hiddenEl.value = match.id;
    if (hintEl) {
      hintEl.style.display = 'block';
      hintEl.style.color = '#0d9488';
      hintEl.textContent = `✅ Karyawan ditemukan: ${match.nama} (ID: ${match.id}).`;
    }
    if (emailWrap) emailWrap.style.display = 'none';

    // Sinkron ke Master Gaji & Tunjangan kalau Kualifikasi karyawan ini ada di daftar.
    // Gaji Pokok: nggak auto-isi (itu range, HRD yang milih angka pastinya) -- cuma ditampilkan sebagai referensi.
    // Tunjangan: langsung auto-isi (nominal tetap, gak perlu nego).
    const gajiMatch = (kbState.gaji || []).find(g => (g.Kualifikasi || '').trim().toLowerCase() === (match.kualifikasi || '').trim().toLowerCase());
    if (gajiMatch) {
      const setVal = (elId, num) => { const el = document.getElementById(elId); if (el) el.value = num != null ? Number(num).toLocaleString('id-ID') : ''; };
      setVal('kontrakTjJabatan', gajiMatch.TunjanganJabatan);
      setVal('kontrakTjTransport', gajiMatch.TunjanganTransport);
      setVal('kontrakTjMakan', gajiMatch.TunjanganMakan);
      setVal('kontrakTjLain', gajiMatch.TunjanganLain);

      const gajiEl = document.getElementById('kontrakGaji');
      if (gajiEl && gajiMatch.RangeGajiMin != null && gajiMatch.RangeGajiMax != null) {
        gajiEl.placeholder = `Range: Rp ${Number(gajiMatch.RangeGajiMin).toLocaleString('id-ID')} - Rp ${Number(gajiMatch.RangeGajiMax).toLocaleString('id-ID')}`;
      }
      if (hintEl) hintEl.textContent += ` Tunjangan auto-isi & range Gaji ditampilkan dari Master Gaji (${gajiMatch.Kualifikasi}).`;
    }
  } else {
    hiddenEl.value = '';
    if (hintEl) {
      hintEl.style.display = 'block';
      hintEl.style.color = '#b45309';
      hintEl.textContent = '⚠️ Nama belum ada di data. Klik "Simpan Kontrak" akan otomatis membuat data karyawan baru. Isi email (opsional) untuk kirim link Digital Badge & PIN.';
    }
    if (emailWrap) emailWrap.style.display = '';
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
  document.getElementById('kontrakKaryawanInput').value = row.namakaryawan || '';
  const hintEl = document.getElementById('kontrakKaryawanHint');
  if (hintEl) hintEl.style.display = 'none';
  const emailWrap = document.getElementById('kontrakEmailWrap');
  if (emailWrap) emailWrap.style.display = 'none';
  document.getElementById('kontrakJenis').value = row.jeniskontrak || 'PKWT';
  handleKontrakJenisChange();
  const kategoriSel = document.getElementById('kontrakKategori');
  if (kategoriSel) kategoriSel.value = row.polakerjakategori || '';
  handleKontrakKategoriChange();
  const polaSel = document.getElementById('kontrakPolaKerja');
  if (polaSel && row.polakerjaid) polaSel.value = row.polakerjaid;
  document.getElementById('kontrakNomor').value = row.nomorkontrak || '';
  document.getElementById('kontrakGaji').value = row.gajipokok != null ? Number(row.gajipokok).toLocaleString('id-ID') : '';
  document.getElementById('kontrakTjJabatan').value = row.tunjanganjabatan != null ? Number(row.tunjanganjabatan).toLocaleString('id-ID') : '';
  document.getElementById('kontrakTjTransport').value = row.tunjangantransport != null ? Number(row.tunjangantransport).toLocaleString('id-ID') : '';
  document.getElementById('kontrakTjMakan').value = row.tunjanganmakan != null ? Number(row.tunjanganmakan).toLocaleString('id-ID') : '';
  document.getElementById('kontrakTjLain').value = row.tunjanganlain != null ? Number(row.tunjanganlain).toLocaleString('id-ID') : '';
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
  let karyawanId = document.getElementById('kontrakKaryawan')?.value;
  const namaInput = (document.getElementById('kontrakKaryawanInput')?.value || '').trim();
  const emailBaru = (document.getElementById('kontrakEmail')?.value || '').trim();
  const jenis = document.getElementById('kontrakJenis')?.value;
  const nomor = document.getElementById('kontrakNomor')?.value.trim();
  const gaji = parseRupiahInput(document.getElementById('kontrakGaji'));
  const tjJabatan = parseRupiahInput(document.getElementById('kontrakTjJabatan'));
  const tjTransport = parseRupiahInput(document.getElementById('kontrakTjTransport'));
  const tjMakan = parseRupiahInput(document.getElementById('kontrakTjMakan'));
  const tjLain = parseRupiahInput(document.getElementById('kontrakTjLain'));
  const polaKerjaId = document.getElementById('kontrakPolaKerja')?.value || null;
  const mulai = document.getElementById('kontrakMulai')?.value || null;
  const berakhir = document.getElementById('kontrakBerakhir')?.value || null;
  const fileEl = document.getElementById('kontrakFile');
  const file = fileEl?.files?.[0];

  if (!editId && !karyawanId && !namaInput) { showToast('Isi dulu nama karyawannya.', 'error'); return; }
  if (editId && !karyawanId) { showToast('Pilih dulu karyawannya.', 'error'); return; }
  if (!nomor) { showToast('Nomor kontrak wajib diisi.', 'error'); return; }
  if (!mulai) { showToast('Tanggal mulai kontrak wajib diisi.', 'error'); return; }
  if (jenis === 'PKWT' && !berakhir) { showToast('Tanggal berakhir wajib diisi untuk PKWT.', 'error'); return; }

  const btn = document.getElementById('btnSubmitKontrak');
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan...'; }

  try {
    let karyawanBaruDigitalpin = null;

    // Kalau bukan mode edit dan nama nggak match karyawan yang sudah ada -> quick-create dulu
    if (!editId && !karyawanId) {
      const { data: hasilKaryawan, error: errKaryawan } = await supabaseClient.rpc('create_karyawan_full', {
        p_nama: namaInput,
        p_email: emailBaru || null,
      });
      if (errKaryawan) throw errKaryawan;
      if (!hasilKaryawan || hasilKaryawan.status !== 'SUCCESS') {
        throw new Error((hasilKaryawan && hasilKaryawan.message) || 'Gagal membuat data karyawan baru.');
      }
      karyawanId = hasilKaryawan.id;
      karyawanBaruDigitalpin = hasilKaryawan.digitalpin;
    }

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
      const uploaded = await uploadToDrive('reports', `KONTRAK_${nomor.replace(/\//g, '-')}.pdf`, 'application/pdf', file);
      fileUrl = uploaded.fileId ? `https://drive.google.com/file/d/${uploaded.fileId}/view` : (uploaded.viewUrl || uploaded.directUrl);
      fileId = uploaded.fileId;
    }

    if (editId) {
      const { error } = await supabaseClient.rpc('update_kontrak_karyawan', {
        p_id: parseInt(editId, 10), p_karyawanid: parseInt(karyawanId, 10), p_jeniskontrak: jenis,
        p_nomorkontrak: nomor, p_tanggalmulai: mulai, p_tanggalberakhir: berakhir,
        p_gajipokok: gaji, p_filekontrakurl: fileUrl, p_filekontrakfileid: fileId,
        p_tunjangan_jabatan: tjJabatan, p_tunjangan_transport: tjTransport,
        p_tunjangan_makan: tjMakan, p_tunjangan_lain: tjLain,
        p_pola_kerja_id: polaKerjaId ? parseInt(polaKerjaId, 10) : null,
      });
      if (error) throw error;
      showToast('Kontrak berhasil diperbarui.', 'success');
    } else {
      const { error } = await supabaseClient.rpc('create_kontrak_karyawan', {
        p_karyawanid: parseInt(karyawanId, 10), p_jeniskontrak: jenis,
        p_nomorkontrak: nomor, p_tanggalmulai: mulai, p_tanggalberakhir: berakhir,
        p_gajipokok: gaji, p_filekontrakurl: fileUrl, p_filekontrakfileid: fileId,
        p_tunjangan_jabatan: tjJabatan, p_tunjangan_transport: tjTransport,
        p_tunjangan_makan: tjMakan, p_tunjangan_lain: tjLain,
        p_pola_kerja_id: polaKerjaId ? parseInt(polaKerjaId, 10) : null,
      });
      if (error) throw error;
      showToast('Kontrak baru berhasil ditambahkan.' + (karyawanBaruDigitalpin ? ' Data karyawan baru juga otomatis dibuat.' : ''), 'success');
    }

    if (karyawanBaruDigitalpin && emailBaru) {
      try {
        const link = `https://rovansyahriza-crv.github.io/Fusion4/digital-badge.html?pin=${karyawanBaruDigitalpin}`;
        await fetch(RFQ_EMAIL_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            action: "SEND_SIMPLE_EMAIL",
            to: emailBaru,
            subject: `Akses Digital Badge Anda — ${namaInput}`,
            body: `Halo ${namaInput},\n\nAnda telah terdaftar di Fusion4 SmartGate. Berikut akses Digital Badge Anda:\n\nLink: ${link}\nPIN: ${karyawanBaruDigitalpin}\n\nSimpan PIN ini baik-baik, jangan dibagikan ke orang lain.\n\nTerima kasih.`
          })
        });
        showToast(`Email link Digital Badge & PIN berhasil dikirim ke ${emailBaru}.`, 'success');
      } catch (emailErr) {
        console.error('Gagal kirim email badge:', emailErr);
        showToast('Kontrak & karyawan tersimpan, tapi gagal kirim email: ' + emailErr.message, 'error');
      }
    }

    resetKontrakForm();
    loadKontrakPage();
    loadKontrakKaryawanDropdown();
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
  document.getElementById('kontrakKaryawanInput').value = '';
  document.getElementById('kontrakEmail').value = '';
  const hintEl = document.getElementById('kontrakKaryawanHint');
  if (hintEl) hintEl.style.display = 'none';
  const emailWrap = document.getElementById('kontrakEmailWrap');
  if (emailWrap) emailWrap.style.display = 'none';
  document.getElementById('kontrakJenis').value = 'PKWT';
  handleKontrakJenisChange();
  const kategoriSel = document.getElementById('kontrakKategori');
  if (kategoriSel) kategoriSel.value = '';
  const polaSel = document.getElementById('kontrakPolaKerja');
  if (polaSel) polaSel.innerHTML = '<option value="">-- Pilih Kategori Dahulu --</option>';
  document.getElementById('kontrakNomor').value = '';
  document.getElementById('kontrakGaji').value = '';
  document.getElementById('kontrakTjJabatan').value = '';
  document.getElementById('kontrakTjTransport').value = '';
  document.getElementById('kontrakTjMakan').value = '';
  document.getElementById('kontrakTjLain').value = '';
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
  const jenisHari = document.getElementById('pengajuanJenisHari')?.value || 'HARI_KERJA';

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
      p_lokasi: lokasi,
      p_jenis_hari: jenisHari
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
  "Direksi": {
    "Board of Directors": [
      "Direktur Utama",
      "Direktur Operasional",
      "Direktur Keuangan",
      "Komisaris Utama",
      "Komisaris"
    ]
  },
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
      "HSE Admin & Doc Control",
      "HSE Method"
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
      "Project Sponsor",
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
    ],
    "Mechanical Construction": [
      "Mechanical Supervisor",
      "Mechanical Foreman",
      "Pipe Fitter",
      "Welder Class-1",
      "Welder Class-2",
      "Welder Class-3",
      "Rigger",
      "Scaffolder",
      "Millwright / Equipment Installer",
      "Mechanical Helper"
    ],
    "Civil Construction": [
      "Civil Supervisor",
      "Civil Foreman",
      "Surveyor",
      "Formwork Carpenter (Tukang Bekisting)",
      "Steel Bender/Fixer (Tukang Besi)",
      "Concrete Worker/Mason (Tukang Cor/Batu)",
      "Heavy Equipment Operator (Excavator/Loader)",
      "Civil Helper"
    ],
    "Electrical Construction": [
      "Electrical Supervisor",
      "Electrical Foreman",
      "Electrician",
      "Cable Puller / Installer",
      "Panel Installer / Wireman",
      "Testing & Commissioning Technician (Electrical)",
      "Electrical Helper"
    ],
    "Instrumentation Construction": [
      "Instrument Supervisor",
      "Instrument Foreman",
      "Instrument Technician",
      "Calibration Technician",
      "Loop Checker",
      "Testing & Commissioning Technician (Instrument)",
      "Instrument Helper"
    ],
    "Direct Project (Umum)": [
      "Driver Operation"
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
      "Expatriate / Permit Admin",
      "Driver"
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

  ensureSelectHasValue(divEl, req.divisi);
  handleKaryawanDivisiChange();
  ensureSelectHasValue(deptEl, req.departemen);
  handleKaryawanDepartemenChange();
  ensureSelectHasValue(kualEl, req.posisijabatan);
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

  const statusColor = { PROSES: '#b45309', BATAL_INTERVIEW: '#7c3aed', LULUS_INTERVIEW: '#0369a1', DITOLAK: '#b91c1c', DITERIMA: '#047857' };
  const statusBg = { PROSES: '#fef3c7', BATAL_INTERVIEW: '#ede9fe', LULUS_INTERVIEW: '#e0f2fe', DITOLAK: '#fee2e2', DITERIMA: '#ecfdf5' };
  const statusLabel = { PROSES: 'Proses', BATAL_INTERVIEW: 'Batal Interview', LULUS_INTERVIEW: 'Lulus Interview', DITOLAK: 'Ditolak', DITERIMA: 'Diterima' };
  const interviewLabel = {
    BELUM_DIKIRIM: '⚪ Undangan interview belum dikirim',
    MENUNGGU_KONFIRMASI: '🟡 Menunggu konfirmasi hadir',
    DIKONFIRMASI: '🟢 Sudah konfirmasi hadir'
  };
  const tawaranLabel = {
    BELUM_DIKIRIM: '⚪ Tawaran belum dikirim',
    MENUNGGU_KONFIRMASI: '🟡 Menunggu respon tawaran',
    DIKONFIRMASI: '🟢 Sudah respon tawaran'
  };

  const rowsHtml = kandidatList.length ? kandidatList.map(k => {
    let actionBtn = '';
    if (k.Status === 'PROSES' && k.InterviewKonfirmasiStatus === 'BELUM_DIKIRIM') {
      actionBtn = `<button type="button" style="font-size:10px; padding:5px 8px; border-radius:6px; border:none; background:#0d9488; color:#fff; cursor:pointer;" onclick="kirimUndanganInterview(${k.Id}, '${escapeHtml(k.NamaKandidat).replace(/'/g, "\\'")}', ${reqId})">📩 Kirim Undangan Interview</button>`;
    } else if (k.Status === 'PROSES' && k.InterviewKonfirmasiStatus === 'DIKONFIRMASI') {
      actionBtn = `<button type="button" style="font-size:10px; padding:5px 8px; border-radius:6px; border:none; background:#0369a1; color:#fff; cursor:pointer;" onclick="bukaFormHasilInterview(${k.Id}, '${escapeHtml(k.NamaKandidat).replace(/'/g, "\\'")}', ${reqId})">📋 Isi Hasil Interview</button>`;
    } else if (k.Status === 'LULUS_INTERVIEW' && (!k.KonfirmasiStatus || k.KonfirmasiStatus === 'BELUM_DIKIRIM')) {
      actionBtn = `<button type="button" style="font-size:10px; padding:5px 8px; border-radius:6px; border:none; background:#047857; color:#fff; cursor:pointer;" onclick="kirimLinkKonfirmasi(${k.Id}, '${escapeHtml(k.NamaKandidat).replace(/'/g, "\\'")}', ${reqId})">📧 Kirim Tawaran Kerja</button>`;
    } else if (k.Status === 'BATAL_INTERVIEW') {
      actionBtn = `<button type="button" style="font-size:10px; padding:5px 8px; border-radius:6px; border:none; background:#7c3aed; color:#fff; cursor:pointer;" onclick="kirimUndanganInterview(${k.Id}, '${escapeHtml(k.NamaKandidat).replace(/'/g, "\\'")}', ${reqId})">🔁 Jadwal Ulang Interview</button>`;
    }

    return `
    <div style="padding:8px 10px; background:#fff; border:1px solid #e2e8f0; border-radius:6px; margin-bottom:6px;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
        <div style="flex:1; min-width:150px;">
          <strong style="font-size:12px; color:#0f172a;">${escapeHtml(k.NamaKandidat)}</strong>
          <span style="display:inline-block; margin-left:6px; padding:1px 6px; font-size:10px; font-weight:700; border-radius:8px; background:${statusBg[k.Status] || '#f1f5f9'}; color:${statusColor[k.Status] || '#475569'};">${statusLabel[k.Status] || k.Status}</span>
          <div style="font-size:10px; color:#64748b; margin-top:2px;">
            Interview: ${k.TglInterview || '-'} • ${interviewLabel[k.InterviewKonfirmasiStatus] || k.InterviewKonfirmasiStatus}
            ${k.CvUrl ? ` • <a href="${k.CvUrl}" target="_blank" rel="noopener" style="color:#0d9488; font-weight:700;">📎 Lihat CV</a>` : ' • <span style="color:#94a3b8;">Belum ada CV</span>'}
          </div>
          ${k.InterviewHasil ? `<div style="font-size:10px; color:#64748b; margin-top:2px;">
              Hasil interview: <strong>${k.InterviewHasil}</strong>${k.InterviewSkor != null ? ' (Skor: ' + k.InterviewSkor + ')' : ''}${k.InterviewerNama ? ' — oleh ' + escapeHtml(k.InterviewerNama) : ''}
              ${k.InterviewDokumenUrl ? ` • <a href="${k.InterviewDokumenUrl}" target="_blank" rel="noopener" style="color:#0369a1; font-weight:700;">📄 Dokumen</a>` : ''}
              • <a href="javascript:void(0)" onclick="cetakLembarInterview(${k.Id})" style="color:#7c3aed; font-weight:700;">🖨️ Cetak Lembar Interview</a>
              ${k.InterviewCatatan ? '<br>💬 ' + escapeHtml(k.InterviewCatatan) : ''}
            </div>` : ''}
          ${(k.Status === 'LULUS_INTERVIEW' || k.Status === 'DITERIMA') ? `<div style="font-size:10px; color:#64748b; margin-top:2px;">Tawaran kerja: ${tawaranLabel[k.KonfirmasiStatus] || k.KonfirmasiStatus || 'BELUM_DIKIRIM'}</div>` : ''}
        </div>
        ${actionBtn ? `<div style="display:flex; gap:6px;">${actionBtn}</div>` : ''}
      </div>
    </div>
  `;
  }).join('') : `<div style="font-size:11px; color:#64748b; padding:6px 0;">Belum ada kandidat yang disounding.</div>`;

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
      <div style="margin-top:6px;">
        <label style="font-size:11px; color:#0f766e; font-weight:700; display:block; margin-bottom:3px;">📎 Lampirkan CV (opsional — PDF/DOCX/gambar)</label>
        <input type="file" id="kandidatCv-${reqId}" accept=".pdf,.doc,.docx,image/*" style="width:100%; font-size:11px; padding:4px; border-radius:6px; border:1px solid #cbd5e1; background:#fff;">
      </div>
      <button type="button" id="btnTambahKandidat-${reqId}" style="margin-top:8px; width:100%; padding:7px; font-size:12px; font-weight:700; border:none; border-radius:6px; background:#0d9488; color:#fff; cursor:pointer;" onclick="submitKandidatBaru(${reqId})">
        ➕ Tambah Kandidat
      </button>
    </div>
  `;
}

async function submitKandidatBaru(reqId) {
  const namaEl = document.getElementById(`kandidatNama-${reqId}`);
  const tglEl = document.getElementById(`kandidatTglInterview-${reqId}`);
  const cvEl = document.getElementById(`kandidatCv-${reqId}`);
  const btnEl = document.getElementById(`btnTambahKandidat-${reqId}`);
  const nama = (namaEl?.value || '').trim();
  const tgl = tglEl?.value || null;
  const cvFile = cvEl?.files?.[0] || null;

  if (!nama) {
    showToast('Nama kandidat wajib diisi!', 'error');
    return;
  }

  if (btnEl) { btnEl.disabled = true; btnEl.textContent = cvFile ? '⏳ Mengunggah CV...' : '⏳ Menyimpan...'; }

  try {
    let cvUrl = null, cvFileId = null, cvFileName = null;

    // Upload CV ke Google Drive dulu (kalau ada file dipilih)
    if (cvFile) {
      if (typeof uploadToDrive !== 'function') {
        showToast('Fitur upload Drive belum siap (driveBridge.js belum termuat). Kandidat tetap disimpan tanpa CV.', 'error');
      } else {
        const ext = cvFile.name.split('.').pop() || 'pdf';
        const fileName = `CV_${nama.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.${ext}`;
        const uploadRes = await uploadToDrive('reports', fileName, cvFile.type || 'application/octet-stream', cvFile);
        cvUrl = uploadRes.directUrl || uploadRes.viewUrl || null;
        cvFileId = uploadRes.fileId || null;
        cvFileName = cvFile.name;
      }
    }

    const actor = currentUser ? `${currentUser.nama} (${currentUser.id})` : 'System';
    const { data, error } = await supabaseClient.rpc('submit_kandidat_rekrutmen', {
      p_request_id: reqId,
      p_nama_kandidat: nama,
      p_tgl_interview: tgl,
      p_status: 'PROSES',
      p_notes: null,
      p_actor_name: actor,
      p_cv_url: cvUrl,
      p_cv_fileid: cvFileId,
      p_cv_filename: cvFileName
    });
    if (error) throw error;

    showToast(data?.message || 'Kandidat berhasil dicatat.', 'success');
    if (namaEl) namaEl.value = '';
    if (tglEl) tglEl.value = '';
    if (cvEl) cvEl.value = '';
    await loadKandidatRekrutmen(reqId);
  } catch (err) {
    console.error('Error submitKandidatBaru:', err);
    showToast('Gagal mencatat kandidat: ' + err.message, 'error');
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = '➕ Tambah Kandidat'; }
  }
}

async function kirimUndanganInterview(kandidatId, namaKandidat, reqId) {
  const email = (prompt(`Masukkan email ${namaKandidat} untuk kirim undangan interview:`) || '').trim();
  if (!email) return;

  try {
    const { data: reqRes, error: reqErr } = await supabaseClient.rpc('kirim_undangan_interview_kandidat', { p_kandidat_id: kandidatId });
    if (reqErr) throw reqErr;
    if (reqRes?.status !== 'SUCCESS') {
      showToast(reqRes?.message || 'Gagal generate undangan interview.', 'error');
      return;
    }

    const { data: listData } = await supabaseClient.rpc('list_kandidat_rekrutmen', { p_request_id: reqId });
    const kandidat = (listData?.kandidat || []).find(k => k.Id === kandidatId);
    const tglInterview = kandidat?.TglInterview || '(jadwal menyusul)';
    const link = `https://rovansyahriza-crv.github.io/Fusion4/konfirmasi-interview.html?kandidat=${kandidatId}`;

    await fetch(RFQ_EMAIL_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "SEND_SIMPLE_EMAIL",
        to: email,
        subject: `Undangan Interview — ${namaKandidat}`,
        body: `Halo ${namaKandidat},\n\nAnda diundang untuk mengikuti proses interview pada tanggal ${tglInterview}.\nMohon konfirmasi kehadiran Anda melalui link berikut:\n${link}\n\nMasukkan PIN Anda: ${reqRes.pin}\n\nTerima kasih.`
      })
    });

    showToast(`Undangan interview berhasil dikirim ke ${email}.`, 'success');
    await loadKandidatRekrutmen(reqId);
  } catch (err) {
    console.error('Error kirimUndanganInterview:', err);
    showToast('Gagal mengirim undangan interview: ' + err.message, 'error');
  }
}

const INTERVIEW_KRITERIA = [
  { key: 'pendidikan', nama: 'Latar Belakang Pendidikan' },
  { key: 'pengalaman', nama: 'Pengalaman Kerja' },
  { key: 'teknis', nama: 'Pengetahuan Teknis (Job Knowledge)' },
  { key: 'komunikasi', nama: 'Komunikasi' },
  { key: 'masalah', nama: 'Penyelesaian Masalah' },
  { key: 'tim', nama: 'Kerja Sama Tim' },
  { key: 'leadership', nama: 'Leadership & Inisiatif' },
  { key: 'motivasi', nama: 'Motivasi & Etos Kerja' }
];

function bukaFormHasilInterview(kandidatId, namaKandidat, reqId) {
  document.getElementById('hiKandidatId').value = kandidatId;
  document.getElementById('hiReqId').value = reqId;
  document.getElementById('hasilInterviewSubtitle').textContent = `Kandidat: ${namaKandidat}`;
  document.getElementById('hiInterviewerNama').value = '';
  document.getElementById('hiTanggalPelaksanaan').value = new Date().toISOString().slice(0, 10);
  document.getElementById('hiCatatan').value = '';
  document.getElementById('hiSkorFinal').value = '';
  document.getElementById('hiRataRata').textContent = '-';
  document.getElementById('hiSkorOtomatis').textContent = '-';
  document.getElementById('hiDokumen').value = '';

  const listEl = document.getElementById('hiKriteriaList');
  listEl.innerHTML = INTERVIEW_KRITERIA.map(k => `
    <div style="border:1px solid #e2e8f0; border-radius:8px; padding:10px; margin-bottom:8px;">
      <div style="font-weight:700; font-size:12.5px; color:#0f172a; margin-bottom:6px;">${k.nama}</div>
      <div style="display:flex; gap:6px; margin-bottom:6px;">
        ${[5,4,3,2,1].map(n => `
          <label style="flex:1; text-align:center; font-size:11px; cursor:pointer; padding:5px 0; border:1px solid #cbd5e1; border-radius:6px; user-select:none;" class="hi-radio-label" data-key="${k.key}">
            <input type="radio" name="hiSkor_${k.key}" value="${n}" style="margin-right:3px;" onchange="hitungRataRataInterview()">${n}
          </label>
        `).join('')}
      </div>
      <input type="text" id="hiKomentar_${k.key}" placeholder="Komentar (opsional)" style="width:100%; padding:5px 7px; font-size:11px; border-radius:5px; border:1px solid #e2e8f0;">
    </div>
  `).join('');

  document.getElementById('modalHasilInterview').style.display = 'flex';
}

function hitungRataRataInterview() {
  const skorList = INTERVIEW_KRITERIA.map(k => {
    const checked = document.querySelector(`input[name="hiSkor_${k.key}"]:checked`);
    return checked ? Number(checked.value) : null;
  }).filter(v => v !== null);

  if (skorList.length === 0) {
    document.getElementById('hiRataRata').textContent = '-';
    document.getElementById('hiSkorOtomatis').textContent = '-';
    return;
  }

  const rata = skorList.reduce((a, b) => a + b, 0) / skorList.length;
  const skor100 = Math.round(rata * 20);
  document.getElementById('hiRataRata').textContent = rata.toFixed(2) + ` (${skorList.length}/8 diisi)`;
  document.getElementById('hiSkorOtomatis').textContent = skor100;

  // Isi otomatis Skor Final kalau user belum ubah manual
  const skorFinalEl = document.getElementById('hiSkorFinal');
  if (!skorFinalEl.dataset.manualEdit) {
    skorFinalEl.value = skor100;
  }
}

function closeModalHasilInterview() {
  document.getElementById('modalHasilInterview').style.display = 'none';
}

document.addEventListener('DOMContentLoaded', () => {
  const skorFinalEl = document.getElementById('hiSkorFinal');
  if (skorFinalEl) {
    skorFinalEl.addEventListener('input', () => { skorFinalEl.dataset.manualEdit = '1'; });
  }
});

async function konfirmasiHasilInterview(hasil) {
  const kandidatId = Number(document.getElementById('hiKandidatId').value);
  const reqId = Number(document.getElementById('hiReqId').value);
  const interviewerNama = document.getElementById('hiInterviewerNama').value.trim();
  const tglPelaksanaan = document.getElementById('hiTanggalPelaksanaan').value || null;
  const catatan = document.getElementById('hiCatatan').value.trim();
  const skorFinalRaw = document.getElementById('hiSkorFinal').value;
  const skorFinal = skorFinalRaw ? Number(skorFinalRaw) : null;
  const dokumenFile = document.getElementById('hiDokumen').files?.[0] || null;

  if (!interviewerNama || !catatan) {
    showToast('Nama interviewer dan catatan wajib diisi!', 'error');
    return;
  }

  const kriteriaJson = INTERVIEW_KRITERIA.map(k => {
    const checked = document.querySelector(`input[name="hiSkor_${k.key}"]:checked`);
    return {
      nama: k.nama,
      skor: checked ? Number(checked.value) : null,
      komentar: document.getElementById(`hiKomentar_${k.key}`)?.value?.trim() || ''
    };
  });

  if (!confirm(`Simpan hasil interview sebagai ${hasil === 'LULUS' ? 'LULUS' : 'TIDAK LULUS'}?`)) return;

  try {
    let dokUrl = null, dokFileId = null, dokFileName = null;

    if (dokumenFile) {
      if (typeof uploadToDrive === 'function') {
        const ext = dokumenFile.name.split('.').pop() || 'pdf';
        const fileName = `Interview_${interviewerNama.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.${ext}`;
        const uploadRes = await uploadToDrive('reports', fileName, dokumenFile.type || 'application/octet-stream', dokumenFile);
        dokUrl = uploadRes.directUrl || uploadRes.viewUrl || null;
        dokFileId = uploadRes.fileId || null;
        dokFileName = dokumenFile.name;
      }
    }

    const actor = currentUser ? `${currentUser.nama} (${currentUser.id})` : 'System';
    const { data, error } = await supabaseClient.rpc('submit_hasil_interview', {
      p_kandidat_id: kandidatId,
      p_interviewer_nama: interviewerNama,
      p_tanggal_pelaksanaan: tglPelaksanaan,
      p_catatan: catatan,
      p_skor: skorFinal,
      p_hasil: hasil,
      p_kriteria_json: kriteriaJson,
      p_dokumen_url: dokUrl,
      p_dokumen_fileid: dokFileId,
      p_dokumen_filename: dokFileName,
      p_actor_name: actor
    });
    if (error) throw error;

    showToast(data?.message || 'Hasil interview tersimpan.', hasil === 'LULUS' ? 'success' : 'error');
    closeModalHasilInterview();
    await loadKandidatRekrutmen(reqId);
  } catch (err) {
    console.error('Error konfirmasiHasilInterview:', err);
    showToast('Gagal menyimpan hasil interview: ' + err.message, 'error');
  }
}

async function kirimLinkKonfirmasi(kandidatId, namaKandidat, reqId) {
  const email = (prompt(`Masukkan email ${namaKandidat} untuk kirim tawaran kerja:`) || '').trim();
  if (!email) return;

  try {
    // Ambil PIN & detail terbaru dari list (supaya PIN akurat, bukan tebakan client)
    const { data: listData, error: listErr } = await supabaseClient.rpc('list_kandidat_rekrutmen', { p_request_id: reqId });
    if (listErr) throw listErr;
    const kandidat = (listData?.kandidat || []).find(k => k.Id === kandidatId);
    if (!kandidat) {
      showToast('Data kandidat tidak ditemukan.', 'error');
      return;
    }

    const { data: sendRes, error: sendErr } = await supabaseClient.rpc('catat_pengiriman_konfirmasi_kandidat', { p_kandidat_id: kandidatId });
    if (sendErr) throw sendErr;
    if (sendRes?.status !== 'SUCCESS') {
      showToast(sendRes?.message || 'Kandidat belum berstatus Lulus Interview.', 'error');
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

    showToast(`Tawaran kerja berhasil dikirim ke ${email}.`, 'success');
    await loadKandidatRekrutmen(reqId);
  } catch (err) {
    console.error('Error kirimLinkKonfirmasi:', err);
    showToast('Gagal mengirim tawaran kerja: ' + err.message, 'error');
  }
}

async function cetakLembarInterview(kandidatId) {
  try {
    const { data, error } = await supabaseClient.rpc('get_lembar_interview_data', { p_kandidat_id: kandidatId });
    if (error) throw error;
    if (data.status !== 'SUCCESS') {
      showToast(data.message || 'Gagal mengambil data lembar interview.', 'error');
      return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = 210, H = 297, margin = 18;
    const NAVY = '#1e293b', GREEN = '#16a34a', RED = '#dc2626', GRAY = '#64748b', LIGHT = '#f1f5f9', BORDER = '#cbd5e1';

    const val = (v, fallback = '-') => (v === null || v === undefined || v === '') ? fallback : v;

    function wrapText(text, x, y, maxWidth, size, leading) {
      doc.setFontSize(size);
      const lines = doc.splitTextToSize(String(text || '-'), maxWidth);
      lines.forEach(line => { doc.text(line, x, y); y += leading; });
      return y;
    }

    // ===== PAGE 1: SUMMARY =====
    doc.setFillColor(NAVY);
    doc.rect(0, 0, W, 32, 'F');
    doc.setTextColor('#ffffff');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
    doc.text('PT. BILAL MITRA ARYATAMA', margin, 14);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text('Fusion4 SmartGate — HRD & Recruitment System', margin, 20);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
    doc.text('LEMBAR HASIL INTERVIEW', W - margin, 14, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text('Interview Evaluation Sheet', W - margin, 20, { align: 'right' });

    let y = 42;
    const contentW = W - 2 * margin;
    doc.setFillColor(LIGHT); doc.setDrawColor(BORDER);
    doc.roundedRect(margin, y, contentW, 16, 1, 1, 'FD');
    doc.setTextColor(GRAY); doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    doc.text('NO. HASIL INTERVIEW', margin + 3, y + 6);
    doc.text('NO. PERMINTAAN KARYAWAN (REQUEST)', margin + contentW / 2 + 3, y + 6);
    doc.setTextColor(NAVY); doc.setFontSize(13);
    doc.text(data.no_hasil_interview, margin + 3, y + 13);
    doc.text(val(data.request_no), margin + contentW / 2 + 3, y + 13);
    y += 26;

    function sectionTitle(text) {
      doc.setFillColor(NAVY); doc.rect(margin, y - 3, 1, 4, 'F');
      doc.setTextColor(NAVY); doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
      doc.text(text, margin + 3, y);
      y += 8;
    }
    function labelValue(x, yy, label, value, size = 9) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(size); doc.setTextColor(GRAY);
      doc.text(label, x, yy);
      const lw = doc.getTextWidth(label);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(NAVY);
      doc.text(String(value), x + lw + 2, yy);
    }

    sectionTitle('DATA PERMINTAAN');
    const col2 = margin + contentW / 2;
    labelValue(margin, y, 'Posisi', val(data.posisi));
    labelValue(col2, y, 'Divisi/Dept', `${val(data.divisi)} / ${val(data.departemen)}`);
    y += 6;
    labelValue(margin, y, 'Site/Proyek', `${val(data.lokasi_site)} (${val(data.project_code)})`);
    labelValue(col2, y, 'Jml Kebutuhan', `${val(data.jumlah_orang, 1)} Orang`);
    y += 10;
    doc.setDrawColor(BORDER); doc.line(margin, y, W - margin, y);
    y += 9;

    sectionTitle('DATA KANDIDAT');
    labelValue(margin, y, 'Nama Kandidat', val(data.nama_kandidat), 10);
    y += 6;
    labelValue(margin, y, 'Jadwal Interview', val(data.tgl_interview_jadwal));
    labelValue(col2, y, 'Tgl Pelaksanaan', val(data.tgl_pelaksanaan));
    y += 6;
    labelValue(margin, y, 'Interviewer', val(data.interviewer));
    y += 10;
    doc.line(margin, y, W - margin, y);
    y += 9;

    sectionTitle('HASIL EVALUASI');
    y += 3;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(GRAY);
    doc.text('SKOR / NILAI', margin, y);
    doc.setFontSize(20); doc.setTextColor(NAVY);
    doc.text(String(val(data.skor)), margin, y + 9);

    const isLulus = data.hasil === 'LULUS';
    doc.setFillColor(isLulus ? GREEN : RED);
    doc.roundedRect(margin + 55, y - 8, 45, 11, 1.5, 1.5, 'F');
    doc.setTextColor('#ffffff'); doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.text(isLulus ? 'LULUS' : 'TIDAK LULUS', margin + 55 + 22.5, y - 1.5, { align: 'center' });

    y += 16;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(GRAY);
    doc.text('CATATAN / FEEDBACK INTERVIEW', margin, y);
    y += 5;
    const boxTop = y;
    doc.setTextColor(NAVY);
    let ty = wrapText(val(data.catatan), margin + 3, y + 4, contentW - 6, 9, 4.6);
    const boxBottom = ty - 1.5;
    doc.setDrawColor(BORDER);
    doc.rect(margin, boxTop, contentW, boxBottom - boxTop, 'S');
    y = boxBottom + 14;

    const signW = (contentW - 20) / 3;
    const signLabels = ['Interviewer', 'HRD (PER)', 'Direksi (APER)'];
    const signNames = [val(data.interviewer), 'CRV', 'Nila Sari'];
    signLabels.forEach((lbl, i) => {
      const sx = margin + i * (signW + 10);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(GRAY);
      doc.text(lbl, sx, y);
      doc.setDrawColor(NAVY); doc.line(sx, y + 20, sx + signW, y + 20);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(NAVY);
      doc.text(`( ${signNames[i]} )`, sx, y + 25);
    });

    doc.setFont('helvetica', 'italic'); doc.setFontSize(7); doc.setTextColor(GRAY);
    doc.text(`Dicetak otomatis dari Fusion4 SmartGate — ${val(data.request_no)} / ${data.no_hasil_interview}`, margin, H - 12);
    doc.text(new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }), W - margin, H - 12, { align: 'right' });

    // ===== PAGE 2: CHECKLIST =====
    doc.addPage();
    y = margin;
    doc.setTextColor(NAVY); doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text('INTERVIEW EVALUATION FORM', W / 2, y, { align: 'center' });
    y += 12;

    const rowH = 9;
    doc.setDrawColor(NAVY); doc.rect(margin, y, contentW, rowH * 2, 'S');
    doc.line(margin, y + rowH, margin + contentW, y + rowH);
    const midX = margin + contentW * 0.62;
    doc.line(midX, y, midX, y + rowH * 2);

    function headerCell(cx, cy, label, value) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(NAVY);
      doc.text(label, cx + 2, cy + 6);
      const lw = doc.getTextWidth(label);
      doc.setFont('helvetica', 'normal');
      doc.text(String(val(value)), cx + 2 + lw + 2, cy + 6);
    }
    headerCell(margin, y, 'Interviewer:', data.interviewer);
    headerCell(midX, y, 'Tanggal Interview:', data.tgl_pelaksanaan);
    headerCell(margin, y + rowH, 'Nama Kandidat:', data.nama_kandidat);
    headerCell(midX, y + rowH, 'Posisi:', data.posisi);
    y += rowH * 2 + 5;

    const instr = 'Interview Evaluation Form diisi oleh interviewer untuk menentukan tingkatan kualifikasi kandidat atas posisi yang dilamar. Interviewer harus memberi kandidat penilaian dan komentar yang spesifik di tempat yang sudah disediakan. Penilaian dilakukan berdasarkan skala yang sudah disusun dibawah.';
    const instrH = 16;
    doc.setFillColor('#e2e8f0'); doc.rect(margin, y, contentW, instrH, 'F');
    doc.setTextColor(NAVY);
    wrapText(instr, margin + 2, y + 5, contentW - 4, 8.5, 4);
    y += instrH + 5;

    const scaleLabels = ['5 – Luar Biasa', '4 – Diatas Rata-Rata', '3 – Rata-Rata', '2 – Memuaskan', '1 – Tidak Memuaskan'];
    const scaleRowH = 9;
    const labelColW = contentW * 0.11;
    const scaleColW = (contentW - labelColW) / scaleLabels.length;
    doc.setDrawColor(BORDER); doc.rect(margin, y, contentW, scaleRowH, 'S');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(NAVY);
    doc.text('Scale:', margin + 2, y + 6);
    scaleLabels.forEach((lbl, i) => {
      const cx = margin + labelColW + i * scaleColW;
      if (i > 0) doc.line(cx, y, cx, y + scaleRowH);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      wrapText(lbl, cx + 2, y + 4.5, scaleColW - 4, 8, 4);
    });
    y += scaleRowH;

    const qColW = contentW * 0.62;
    const rateColW = (contentW - qColW) / 5;
    const rateHeaderH = 14;
    doc.rect(margin, y, contentW, rateHeaderH, 'S');
    doc.line(margin + qColW, y, margin + qColW, y + rateHeaderH);
    const dividerY = y + 6.5;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(NAVY);
    doc.text('Rating', margin + qColW + (contentW - qColW) / 2, y + 4.5, { align: 'center' });
    doc.line(margin + qColW, dividerY, margin + contentW, dividerY);
    ['5', '4', '3', '2', '1'].forEach((num, i) => {
      const cx = margin + qColW + i * rateColW;
      if (i > 0) doc.line(cx, y, cx, dividerY);
      doc.text(num, cx + rateColW / 2, dividerY + 5.5, { align: 'center' });
    });
    y += rateHeaderH;

    const kriteriaList = Array.isArray(data.kriteria) ? data.kriteria : [];
    const remainingH = H - y - 18;
    const critRowH = remainingH / Math.max(kriteriaList.length, 1);

    kriteriaList.forEach(crit => {
      const rowTop = y, rowBottom = y + critRowH;
      doc.setDrawColor(BORDER); doc.rect(margin, rowTop, contentW, critRowH, 'S');
      doc.line(margin + qColW, rowTop, margin + qColW, rowBottom);
      for (let i = 1; i < 5; i++) {
        const cx = margin + qColW + i * rateColW;
        doc.line(cx, rowTop, cx, rowBottom);
      }

      doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(NAVY);
      doc.text(crit.nama, margin + 2, rowTop + 5);

      doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(GRAY);
      doc.text('Komentar:', margin + 2, rowTop + 10);
      const komentarW = doc.getTextWidth('Komentar: ');
      doc.setFont('helvetica', 'italic'); doc.setTextColor(NAVY);
      wrapText(crit.komentar || '-', margin + 2 + komentarW, rowTop + 10, qColW - 4 - komentarW, 8, 4);

      const boxSize = 4.5;
      const boxY = rowTop + critRowH / 2 - boxSize / 2;
      [5, 4, 3, 2, 1].forEach((num, i) => {
        const cx = margin + qColW + i * rateColW + rateColW / 2 - boxSize / 2;
        if (num === crit.skor) {
          doc.setFillColor(GREEN);
          doc.rect(cx, boxY, boxSize, boxSize, 'F');
          doc.setTextColor('#ffffff'); doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
          doc.text('X', cx + boxSize / 2, boxY + 3.2, { align: 'center' });
        } else {
          doc.setDrawColor(NAVY);
          doc.rect(cx, boxY, boxSize, boxSize, 'S');
        }
      });

      y = rowBottom;
    });

    doc.setFont('helvetica', 'italic'); doc.setFontSize(7); doc.setTextColor(GRAY);
    doc.text(`Dicetak otomatis dari Fusion4 SmartGate — ${val(data.request_no)} / ${data.no_hasil_interview}`, margin, H - 12);
    doc.text('Halaman 2 dari 2', W - margin, H - 12, { align: 'right' });

    doc.save(`Lembar-Interview-${data.no_hasil_interview}-${(data.nama_kandidat || '').replace(/[^a-zA-Z0-9]/g, '_')}.pdf`);
  } catch (err) {
    console.error('Error cetakLembarInterview:', err);
    showToast('Gagal membuat PDF lembar interview: ' + err.message, 'error');
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




// ==========================================
// KOMPENSASI & BENEFIT (Master Gaji, Aturan Pesangon, Aturan PPh 21)
// Author: "Kompensasi & Benefit" -- basis perhitungan payroll, terpisah dari BIMA_ORG_MATRIX
// ==========================================

let kbState = { gaji: [], pesangon: [], ptkp: [], pph: [], bpjs: [], ter: [] };

async function loadKompensasiPage() {
  try {
    const [gajiRes, pesangonRes, ptkpRes, pphRes, bpjsRes, terRes] = await Promise.all([
      supabaseClient.rpc('list_master_gaji'),
      supabaseClient.rpc('list_aturan_pesangon'),
      supabaseClient.rpc('list_ptkp'),
      supabaseClient.rpc('list_tarif_pph'),
      supabaseClient.rpc('list_bpjs'),
      supabaseClient.rpc('list_ter')
    ]);
    if (gajiRes.error) throw gajiRes.error;
    if (pesangonRes.error) throw pesangonRes.error;
    if (ptkpRes.error) throw ptkpRes.error;
    if (pphRes.error) throw pphRes.error;
    if (bpjsRes.error) throw bpjsRes.error;
    if (terRes.error) throw terRes.error;

    kbState.gaji = gajiRes.data || [];
    kbState.pesangon = pesangonRes.data || [];
    kbState.ptkp = ptkpRes.data || [];
    kbState.pph = pphRes.data || [];
    kbState.bpjs = bpjsRes.data || [];
    kbState.ter = terRes.data || [];

    populateKbGajiDivisiFilter();
    renderKbGajiTable();
    renderKbPesangonTables();
    renderKbPphTables();
    renderKbBpjsTable();

    if (!karyawanState.rows || karyawanState.rows.length === 0) {
      const { data: karData } = await supabaseClient.rpc('list_karyawan_all');
      karyawanState.rows = karData || [];
    }
    if (!kontrakState.rows || kontrakState.rows.length === 0) {
      const { data: kontrakData } = await supabaseClient.rpc('list_kontrak_karyawan_full');
      kontrakState.rows = kontrakData || [];
    }
    const { data: polaData } = await supabaseClient.rpc('list_pola_kerja');
    polaKerjaState = polaData || [];
    renderKbPolaTable();

    const { data: liburData } = await supabaseClient.rpc('list_hari_libur');
    renderKbLiburTable(liburData || []);
    populateSimulatorDropdowns();
    renderPayrollRiwayat();
  } catch (err) {
    showToast('Gagal memuat data Kompensasi & Benefit: ' + err.message, 'error');
  }
}

function populateSimulatorDropdowns() {
  const karyawanSel = document.getElementById('simKaryawan');
  if (karyawanSel) {
    karyawanSel.innerHTML = '<option value="">-- Isi manual --</option>';
    (karyawanState.rows || []).forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.namapersonnel;
      karyawanSel.appendChild(opt);
    });
  }
  const jabatanSel = document.getElementById('simJabatan');
  if (jabatanSel) {
    jabatanSel.innerHTML = '<option value="">-- Isi manual --</option>';
    kbState.gaji.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.Id;
      opt.textContent = `${r.Kualifikasi} (${r.Divisi})`;
      jabatanSel.appendChild(opt);
    });
  }
  const ptkpSel = document.getElementById('simPtkp');
  if (ptkpSel) {
    ptkpSel.innerHTML = '';
    kbState.ptkp.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.StatusPTKP;
      opt.textContent = r.StatusPTKP;
      ptkpSel.appendChild(opt);
    });
  }
}

function deriveStatusPTKP(statusNikah, jumlahAnak) {
  const kawin = (statusNikah || '').trim().toLowerCase() === 'menikah' ? 'K' : 'TK';
  const anak = Math.min(Math.max(parseInt(jumlahAnak, 10) || 0, 0), 3);
  return `${kawin}/${anak}`;
}

function handleSimKaryawanChange() {
  const id = document.getElementById('simKaryawan').value;
  const ptkpSel = document.getElementById('simPtkp');
  if (!id) return;
  const row = (karyawanState.rows || []).find(r => String(r.id) === String(id));
  if (!row) return;
  if (!row.statuspernikahan) {
    showToast(`Data pernikahan/tanggungan ${row.namapersonnel} belum diisi di Data Karyawan.`, 'error');
  } else {
    const ptkp = deriveStatusPTKP(row.statuspernikahan, row.jumlahanak);
    if (ptkpSel) ptkpSel.value = ptkp;
  }

  // Cari kontrak aktif/terbaru karyawan ini, auto-isi Gaji Pokok & Tunjangan dari situ (bukan dari Master Gaji generik)
  const kontrakList = (kontrakState.rows || []).filter(r => String(r.karyawanid) === String(id));
  if (kontrakList.length === 0) {
    showToast(`${row.namapersonnel} belum punya data Kontrak Karyawan -- isi Gaji/Tunjangan manual dulu.`, 'error');
    return;
  }
  kontrakList.sort((a, b) => new Date(b.tanggalmulai || 0) - new Date(a.tanggalmulai || 0));
  const kontrak = kontrakList[0];

  const setVal = (elId, num) => { const el = document.getElementById(elId); if (el) el.value = num != null ? Number(num).toLocaleString('id-ID') : ''; };
  setVal('simGajiPokok', kontrak.gajipokok);
  setVal('simTjJabatan', kontrak.tunjanganjabatan);
  setVal('simTjTransport', kontrak.tunjangantransport);
  setVal('simTjMakan', kontrak.tunjanganmakan);
  setVal('simTjLain', kontrak.tunjanganlain);

  // Masa kerja dihitung otomatis dari TglMasuk karyawan (bukan tanggal mulai kontrak ini doang --
  // masa kerja itu akumulasi total sejak awal kerja, bukan sejak kontrak terbaru diteken)
  const masaKerjaEl = document.getElementById('simMasaKerja');
  if (masaKerjaEl && row.tglmasuk) {
    const mulai = new Date(row.tglmasuk);
    const sekarang = new Date();
    const tahun = Math.round(((sekarang - mulai) / (1000 * 60 * 60 * 24 * 365.25)) * 2) / 2; // dibulatkan ke 0.5 tahun terdekat
    masaKerjaEl.value = Math.max(tahun, 0);
  }

  showToast(`${row.namapersonnel}: Gaji & Tunjangan diambil dari Kontrak ${kontrak.nomorkontrak || ''} (${kontrak.jeniskontrak || ''})${row.statuspernikahan ? ', PTKP ' + deriveStatusPTKP(row.statuspernikahan, row.jumlahanak) : ''}${row.tglmasuk ? ', Masa Kerja dihitung dari TglMasuk ' + row.tglmasuk : ''}.`, 'success');
}

function handleSimJabatanChange() {
  const id = document.getElementById('simJabatan').value;
  if (!id) return;
  const row = kbState.gaji.find(r => String(r.Id) === String(id));
  if (!row) return;
  const setVal = (elId, num) => { const el = document.getElementById(elId); if (el) el.value = num != null ? Number(num).toLocaleString('id-ID') : ''; };
  setVal('simGajiPokok', row.RangeGajiMin);
  setVal('simTjJabatan', row.TunjanganJabatan);
  setVal('simTjTransport', row.TunjanganTransport);
  setVal('simTjMakan', row.TunjanganMakan);
  setVal('simTjLain', row.TunjanganLain);
}

function getTerKategoriFromPtkp(status) {
  if (['TK/0', 'TK/1', 'K/0'].includes(status)) return 'A';
  if (['TK/2', 'TK/3', 'K/1', 'K/2'].includes(status)) return 'B';
  if (status === 'K/3') return 'C';
  return 'A';
}

function cariTarifTer(kategori, bruto) {
  const row = kbState.ter.find(r => r.Kategori === kategori && Number(bruto) >= Number(r.PenghasilanBrutoMin) && (r.PenghasilanBrutoMax == null || Number(bruto) <= Number(r.PenghasilanBrutoMax)));
  return row ? Number(row.TarifPersen) : 0;
}

function cariAturanPesangon(jenis, masaKerjaTahun) {
  const row = kbState.pesangon.find(r => r.JenisKompensasi === jenis && Number(masaKerjaTahun) >= Number(r.MasaKerjaMinTahun) && (r.MasaKerjaMaxTahun == null || Number(masaKerjaTahun) < Number(r.MasaKerjaMaxTahun)));
  return row ? Number(row.JumlahBulanUpah) : 0;
}

function fmtRp(n) {
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}

function hitungSimulatorPayroll() {
  const gajiPokok = parseRupiahInput(document.getElementById('simGajiPokok')) || 0;
  const tjJabatan = parseRupiahInput(document.getElementById('simTjJabatan')) || 0;
  const tjTransport = parseRupiahInput(document.getElementById('simTjTransport')) || 0;
  const tjMakan = parseRupiahInput(document.getElementById('simTjMakan')) || 0;
  const tjLain = parseRupiahInput(document.getElementById('simTjLain')) || 0;
  const ptkpStatus = document.getElementById('simPtkp').value;
  const masaKerja = Number(document.getElementById('simMasaKerja').value) || 0;

  const bruto = gajiPokok + tjJabatan + tjTransport + tjMakan + tjLain;

  if (bruto <= 0) { showToast('Isi Gaji Pokok atau pilih Jabatan dulu.', 'error'); return; }

  // -- BPJS: generalisasi dari baris yang "Aktif" di bpjsTbl --
  const aktifRows = kbState.bpjs.filter(r => r.IsAktif);
  let totalBpjsKaryawan = 0, totalBpjsPerusahaan = 0;
  const bpjsDetailRows = aktifRows.map(r => {
    const base = r.BatasUpahMax != null ? Math.min(bruto, Number(r.BatasUpahMax)) : bruto;
    const karyawan = base * (Number(r.PersenKaryawan) / 100);
    const perusahaan = base * (Number(r.PersenPerusahaan) / 100);
    totalBpjsKaryawan += karyawan;
    totalBpjsPerusahaan += perusahaan;
    return { nama: r.Program + (r.Keterangan ? ' (' + r.Keterangan + ')' : ''), karyawan, perusahaan };
  });

  // -- PPh 21 (TER Bulanan) --
  const kategori = getTerKategoriFromPtkp(ptkpStatus);
  const tarifTer = cariTarifTer(kategori, bruto);
  const pph21 = bruto * (tarifTer / 100);

  const totalPotonganKaryawan = totalBpjsKaryawan + pph21;
  const thp = bruto - totalPotonganKaryawan;
  const totalBiayaPerusahaan = bruto + totalBpjsPerusahaan;

  // -- THR (prorata kalau masa kerja < 1 tahun) --
  const masaKerjaBulan = masaKerja * 12;
  const thr = masaKerjaBulan >= 12 ? bruto : (masaKerjaBulan / 12) * bruto;

  // -- Estimasi Pesangon (kalau PHK hari ini) --
  const bulanUP = cariAturanPesangon('Uang Pesangon', masaKerja);
  const bulanUPMK = cariAturanPesangon('Uang Penghargaan Masa Kerja', masaKerja);
  const estimasiUP = bulanUP * bruto;
  const estimasiUPMK = bulanUPMK * bruto;

  // ---- Render ----
  document.getElementById('simResultWrap').style.display = 'block';

  document.getElementById('simThpBox').innerHTML = `
    <div style="display:flex; gap:10px; flex-wrap:wrap;">
      <div class="summary-tile"><div class="num" style="font-size:16px;">${fmtRp(bruto)}</div><div class="lbl">Penghasilan Bruto</div></div>
      <div class="summary-tile"><div class="num" style="font-size:16px; color:#c0392b;">- ${fmtRp(totalPotonganKaryawan)}</div><div class="lbl">Total Potongan Karyawan</div></div>
      <div class="summary-tile"><div class="num" style="font-size:18px; color:#178a4c;">${fmtRp(thp)}</div><div class="lbl">Take Home Pay (THP)</div></div>
    </div>
    <p style="font-size:11px; color:#8a94a3; margin-top:8px;">PPh 21 dihitung pakai Tarif Efektif Rata-rata (TER) Kategori ${kategori} (${tarifTer}%) sesuai status PTKP ${ptkpStatus}. Rekonsiliasi tarif progresif tahunan dilakukan di masa pajak Desember.</p>
  `;

  const pihak3Rows = bpjsDetailRows.map(b => `
    <tr><td>${escapeHtml(b.nama)}</td><td>${fmtRp(b.karyawan)}</td><td>${fmtRp(b.perusahaan)}</td></tr>
  `).join('') + `
    <tr style="font-weight:700; background:#f7f4f1;"><td>Subtotal BPJS</td><td>${fmtRp(totalBpjsKaryawan)}</td><td>${fmtRp(totalBpjsPerusahaan)}</td></tr>
    <tr><td>PPh 21 (TER ${kategori})</td><td>${fmtRp(pph21)}</td><td>-</td></tr>
    <tr style="font-weight:700; background:#e8f4ee;"><td>TOTAL DIBAYAR KE PIHAK KE-3</td><td>${fmtRp(totalPotonganKaryawan)}</td><td>${fmtRp(totalBpjsPerusahaan)}</td></tr>
    <tr><td colspan="3" style="font-size:11px; color:#8a94a3;">Total Biaya Perusahaan per bulan (Bruto + BPJS Perusahaan) = ${fmtRp(totalBiayaPerusahaan)}</td></tr>
  `;
  document.getElementById('simPihak3Body').innerHTML = pihak3Rows;

  document.getElementById('simThrPesangonBox').innerHTML = `
    <div style="display:flex; gap:10px; flex-wrap:wrap;">
      <div class="summary-tile"><div class="num" style="font-size:16px;">${fmtRp(thr)}</div><div class="lbl">Estimasi THR (${masaKerjaBulan >= 12 ? '1x gaji, masa kerja cukup' : 'prorata ' + masaKerjaBulan.toFixed(0) + ' bulan'})</div></div>
      <div class="summary-tile"><div class="num" style="font-size:16px;">${fmtRp(estimasiUP + estimasiUPMK)}</div><div class="lbl">Estimasi Pesangon jika PHK hari ini</div></div>
    </div>
    <p style="font-size:11px; color:#8a94a3; margin-top:8px;">
      Pesangon = Uang Pesangon (${bulanUP} bulan upah = ${fmtRp(estimasiUP)}) + Uang Penghargaan Masa Kerja (${bulanUPMK} bulan upah = ${fmtRp(estimasiUPMK)}), berdasarkan masa kerja ${masaKerja} tahun.
      Belum termasuk faktor pengali sesuai alasan PHK (PP 35/2021) dan Uang Penggantian Hak (sisa cuti, dll). THR &amp; Pesangon nilainya tetap/independen, bukan potongan dari THP bulanan.
    </p>
  `;
}

function switchKbTab(tab, btn) {
  document.querySelectorAll('#kbTabs .tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('kbTabGaji').style.display = tab === 'gaji' ? 'block' : 'none';
  document.getElementById('kbTabPesangon').style.display = tab === 'pesangon' ? 'block' : 'none';
  document.getElementById('kbTabPph').style.display = tab === 'pph' ? 'block' : 'none';
  document.getElementById('kbTabBpjs').style.display = tab === 'bpjs' ? 'block' : 'none';
  document.getElementById('kbTabSimulator').style.display = tab === 'simulator' ? 'block' : 'none';
  document.getElementById('kbTabPola').style.display = tab === 'pola' ? 'block' : 'none';
  document.getElementById('kbTabProses').style.display = tab === 'proses' ? 'block' : 'none';
}

function populateKbGajiDivisiFilter() {
  const sel = document.getElementById('kbGajiFilterDivisi');
  if (!sel) return;
  const currentVal = sel.value;
  const divisiList = [...new Set(kbState.gaji.map(r => r.Divisi))].sort();
  sel.innerHTML = '<option value="">Semua Divisi</option>';
  divisiList.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d; opt.textContent = d;
    sel.appendChild(opt);
  });
  sel.value = currentVal;
}

function handleKbGajiFilterDivisiChange() {
  const divisi = document.getElementById('kbGajiFilterDivisi').value;
  const deptSel = document.getElementById('kbGajiFilterDepartemen');
  deptSel.innerHTML = '<option value="">Semua Departemen</option>';
  if (divisi) {
    const depts = [...new Set(kbState.gaji.filter(r => r.Divisi === divisi).map(r => r.Departemen))].sort();
    depts.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d; opt.textContent = d;
      deptSel.appendChild(opt);
    });
  }
  renderKbGajiTable();
}

function formatRupiahInput(el) {
  const raw = el.value.replace(/\D/g, '');
  el.value = raw === '' ? '' : Number(raw).toLocaleString('id-ID');
}

function parseRupiahInput(el) {
  const raw = el.value.replace(/\D/g, '');
  return raw === '' ? null : Number(raw);
}

function renderKbGajiTable() {
  const divisi = document.getElementById('kbGajiFilterDivisi')?.value || '';
  const dept = document.getElementById('kbGajiFilterDepartemen')?.value || '';
  const q = (document.getElementById('kbGajiSearch')?.value || '').trim().toLowerCase();
  let rows = kbState.gaji;
  if (divisi) rows = rows.filter(r => r.Divisi === divisi);
  if (dept) rows = rows.filter(r => r.Departemen === dept);
  if (q) rows = rows.filter(r => (r.Kualifikasi || '').toLowerCase().includes(q));

  const countEl = document.getElementById('kbGajiCount');
  if (countEl) countEl.textContent = rows.length + ' baris';

  const tbody = document.getElementById('kbGajiTableBody');
  if (!tbody) return;
  tbody.innerHTML = rows.map(r => `
    <tr data-kb-id="${r.Id}">
      <td>${escapeHtml(r.Divisi || '-')}</td>
      <td>${escapeHtml(r.Departemen || '-')}</td>
      <td>${escapeHtml(r.Kualifikasi || '-')}</td>
      <td><input type="text" inputmode="numeric" class="kb-gaji-min" value="${r.RangeGajiMin != null ? Number(r.RangeGajiMin).toLocaleString('id-ID') : ''}" oninput="formatRupiahInput(this); calcKbGajiRowTotal(this.closest('tr'))" style="width:110px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
      <td><input type="text" inputmode="numeric" class="kb-gaji-max" value="${r.RangeGajiMax != null ? Number(r.RangeGajiMax).toLocaleString('id-ID') : ''}" oninput="formatRupiahInput(this); calcKbGajiRowTotal(this.closest('tr'))" style="width:110px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
      <td><input type="text" inputmode="numeric" class="kb-tj-jabatan" value="${r.TunjanganJabatan != null ? Number(r.TunjanganJabatan).toLocaleString('id-ID') : ''}" oninput="formatRupiahInput(this); calcKbGajiRowTotal(this.closest('tr'))" style="width:100px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
      <td><input type="text" inputmode="numeric" class="kb-tj-transport" value="${r.TunjanganTransport != null ? Number(r.TunjanganTransport).toLocaleString('id-ID') : ''}" oninput="formatRupiahInput(this); calcKbGajiRowTotal(this.closest('tr'))" style="width:100px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
      <td><input type="text" inputmode="numeric" class="kb-tj-makan" value="${r.TunjanganMakan != null ? Number(r.TunjanganMakan).toLocaleString('id-ID') : ''}" oninput="formatRupiahInput(this); calcKbGajiRowTotal(this.closest('tr'))" style="width:100px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
      <td><input type="text" inputmode="numeric" class="kb-tj-lain" value="${r.TunjanganLain != null ? Number(r.TunjanganLain).toLocaleString('id-ID') : ''}" oninput="formatRupiahInput(this); calcKbGajiRowTotal(this.closest('tr'))" style="width:100px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
      <td><strong class="kb-total-min" style="white-space:nowrap;">Rp 0</strong></td>
      <td><strong class="kb-total-max" style="white-space:nowrap;">Rp 0</strong></td>
      <td><input type="text" class="kb-catatan" value="${escapeHtml(r.Catatan || '')}" style="width:140px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
    </tr>
  `).join('');

  // Hitung total awal buat semua baris berdasarkan data yang udah di-load
  tbody.querySelectorAll('tr[data-kb-id]').forEach(tr => calcKbGajiRowTotal(tr));
}

function calcKbGajiRowTotal(tr) {
  if (!tr) return;
  const val = (cls) => parseRupiahInput(tr.querySelector('.' + cls)) || 0;
  const tunjanganTotal = val('kb-tj-jabatan') + val('kb-tj-transport') + val('kb-tj-makan') + val('kb-tj-lain');
  const totalMin = val('kb-gaji-min') + tunjanganTotal;
  const totalMax = val('kb-gaji-max') + tunjanganTotal;
  const minEl = tr.querySelector('.kb-total-min');
  const maxEl = tr.querySelector('.kb-total-max');
  if (minEl) minEl.textContent = 'Rp ' + totalMin.toLocaleString('id-ID');
  if (maxEl) maxEl.textContent = 'Rp ' + totalMax.toLocaleString('id-ID');
}

async function simpanSemuaKbGaji() {
  const rows = document.querySelectorAll('#kbGajiTableBody tr[data-kb-id]');
  if (rows.length === 0) { showToast('Tidak ada baris untuk disimpan (cek filter yang aktif).', 'error'); return; }
  showToast(`Menyimpan ${rows.length} baris...`, 'info');
  let success = 0, failed = 0;
  for (const tr of rows) {
    const id = tr.dataset.kbId;
    const getVal = (cls) => parseRupiahInput(tr.querySelector('.' + cls));
    const catatan = tr.querySelector('.kb-catatan').value.trim() || null;
    try {
      const { data, error } = await supabaseClient.rpc('update_master_gaji', {
        p_id: Number(id),
        p_range_gaji_min: getVal('kb-gaji-min'),
        p_range_gaji_max: getVal('kb-gaji-max'),
        p_tunjangan_jabatan: getVal('kb-tj-jabatan'),
        p_tunjangan_transport: getVal('kb-tj-transport'),
        p_tunjangan_makan: getVal('kb-tj-makan'),
        p_tunjangan_lain: getVal('kb-tj-lain'),
        p_catatan: catatan
      });
      if (error || (data && data.status === 'ERROR')) failed++; else success++;
    } catch (e) { failed++; }
  }
  showToast(`Selesai. ${success} baris tersimpan${failed > 0 ? `, ${failed} gagal` : ''}.`, failed > 0 ? 'error' : 'success');
  loadKompensasiPage();
}

function renderKbPesangonTables() {
  const up = kbState.pesangon.filter(r => r.JenisKompensasi === 'Uang Pesangon');
  const upmk = kbState.pesangon.filter(r => r.JenisKompensasi === 'Uang Penghargaan Masa Kerja');
  const rowHtml = (r) => `
    <tr data-kb-id="${r.Id}">
      <td><input type="number" class="kb-masa-min" value="${r.MasaKerjaMinTahun ?? ''}" style="width:80px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
      <td><input type="number" class="kb-masa-max" value="${r.MasaKerjaMaxTahun ?? ''}" placeholder="tak terbatas" style="width:110px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
      <td><input type="number" class="kb-jumlah-bulan" value="${r.JumlahBulanUpah ?? ''}" style="width:80px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
      <td><input type="text" class="kb-catatan" value="${escapeHtml(r.Catatan || '')}" style="width:220px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
    </tr>`;
  const upBody = document.getElementById('kbPesangonUPBody');
  const upmkBody = document.getElementById('kbPesangonUPMKBody');
  if (upBody) upBody.innerHTML = up.map(rowHtml).join('');
  if (upmkBody) upmkBody.innerHTML = upmk.map(rowHtml).join('');
}

async function simpanSemuaKbPesangon() {
  const rows = document.querySelectorAll('#kbPesangonUPBody tr[data-kb-id], #kbPesangonUPMKBody tr[data-kb-id]');
  if (rows.length === 0) return;
  showToast(`Menyimpan ${rows.length} baris...`, 'info');
  let success = 0, failed = 0;
  for (const tr of rows) {
    const id = tr.dataset.kbId;
    const minV = tr.querySelector('.kb-masa-min').value.trim();
    const maxV = tr.querySelector('.kb-masa-max').value.trim();
    const bulanV = tr.querySelector('.kb-jumlah-bulan').value.trim();
    const catatan = tr.querySelector('.kb-catatan').value.trim() || null;
    try {
      const { data, error } = await supabaseClient.rpc('update_aturan_pesangon', {
        p_id: Number(id),
        p_masa_kerja_min: minV === '' ? null : Number(minV),
        p_masa_kerja_max: maxV === '' ? null : Number(maxV),
        p_jumlah_bulan: bulanV === '' ? null : Number(bulanV),
        p_catatan: catatan
      });
      if (error || (data && data.status === 'ERROR')) failed++; else success++;
    } catch (e) { failed++; }
  }
  showToast(`Selesai. ${success} baris tersimpan${failed > 0 ? `, ${failed} gagal` : ''}.`, failed > 0 ? 'error' : 'success');
  loadKompensasiPage();
}

function renderKbPphTables() {
  const ptkpBody = document.getElementById('kbPtkpBody');
  const tarifBody = document.getElementById('kbTarifPphBody');
  if (ptkpBody) {
    ptkpBody.innerHTML = kbState.ptkp.map(r => `
      <tr data-kb-id="${r.Id}">
        <td>${escapeHtml(r.StatusPTKP || '-')}</td>
        <td><input type="text" inputmode="numeric" class="kb-ptkp-nominal" value="${r.NominalPTKP != null ? Number(r.NominalPTKP).toLocaleString('id-ID') : ''}" oninput="formatRupiahInput(this)" style="width:180px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
      </tr>`).join('');
  }
  if (tarifBody) {
    tarifBody.innerHTML = kbState.pph.map(r => `
      <tr data-kb-id="${r.Id}">
        <td><input type="text" inputmode="numeric" class="kb-pph-min" value="${r.PenghasilanMin != null ? Number(r.PenghasilanMin).toLocaleString('id-ID') : ''}" oninput="formatRupiahInput(this)" style="width:160px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
        <td><input type="text" inputmode="numeric" class="kb-pph-max" value="${r.PenghasilanMax != null ? Number(r.PenghasilanMax).toLocaleString('id-ID') : ''}" oninput="formatRupiahInput(this)" placeholder="tak terbatas" style="width:160px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
        <td><input type="number" class="kb-pph-persen" value="${r.TarifPersen ?? ''}" style="width:80px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
      </tr>`).join('');
  }
}

async function simpanSemuaKbPph() {
  const ptkpRows = document.querySelectorAll('#kbPtkpBody tr[data-kb-id]');
  const tarifRows = document.querySelectorAll('#kbTarifPphBody tr[data-kb-id]');
  let success = 0, failed = 0;
  for (const tr of ptkpRows) {
    const id = tr.dataset.kbId;
    const val = parseRupiahInput(tr.querySelector('.kb-ptkp-nominal'));
    try {
      const { data, error } = await supabaseClient.rpc('update_ptkp', { p_id: Number(id), p_nominal: val });
      if (error || (data && data.status === 'ERROR')) failed++; else success++;
    } catch (e) { failed++; }
  }
  for (const tr of tarifRows) {
    const id = tr.dataset.kbId;
    const minV = parseRupiahInput(tr.querySelector('.kb-pph-min'));
    const maxV = parseRupiahInput(tr.querySelector('.kb-pph-max'));
    const persenV = tr.querySelector('.kb-pph-persen').value.trim();
    try {
      const { data, error } = await supabaseClient.rpc('update_tarif_pph', {
        p_id: Number(id),
        p_penghasilan_min: minV,
        p_penghasilan_max: maxV,
        p_tarif_persen: persenV === '' ? null : Number(persenV)
      });
      if (error || (data && data.status === 'ERROR')) failed++; else success++;
    } catch (e) { failed++; }
  }
  showToast(`Selesai. ${success} baris tersimpan${failed > 0 ? `, ${failed} gagal` : ''}.`, failed > 0 ? 'error' : 'success');
  loadKompensasiPage();
}

function renderKbBpjsTable() {
  const tbody = document.getElementById('kbBpjsTableBody');
  if (!tbody) return;
  tbody.innerHTML = kbState.bpjs.map(r => `
    <tr data-kb-id="${r.Id}">
      <td><strong>${escapeHtml(r.Program || '-')}</strong></td>
      <td>${escapeHtml(r.Keterangan || '-')}</td>
      <td><input type="number" step="0.01" class="kb-bpjs-karyawan" value="${r.PersenKaryawan ?? 0}" style="width:70px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
      <td><input type="number" step="0.01" class="kb-bpjs-perusahaan" value="${r.PersenPerusahaan ?? 0}" style="width:70px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
      <td><input type="text" inputmode="numeric" class="kb-bpjs-batas" value="${r.BatasUpahMax != null ? Number(r.BatasUpahMax).toLocaleString('id-ID') : ''}" oninput="formatRupiahInput(this)" placeholder="tak terbatas" style="width:140px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
      <td style="text-align:center;"><input type="checkbox" class="kb-bpjs-aktif" ${r.IsAktif ? 'checked' : ''} style="width:18px;height:18px;"></td>
      <td><input type="text" class="kb-catatan" value="${escapeHtml(r.Catatan || '')}" style="width:220px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
    </tr>`).join('');
}

async function simpanSemuaKbBpjs() {
  const rows = document.querySelectorAll('#kbBpjsTableBody tr[data-kb-id]');
  if (rows.length === 0) return;
  showToast(`Menyimpan ${rows.length} baris...`, 'info');
  let success = 0, failed = 0;
  for (const tr of rows) {
    const id = tr.dataset.kbId;
    const karyawan = Number(tr.querySelector('.kb-bpjs-karyawan').value.trim() || 0);
    const perusahaan = Number(tr.querySelector('.kb-bpjs-perusahaan').value.trim() || 0);
    const batasV = parseRupiahInput(tr.querySelector('.kb-bpjs-batas'));
    const aktif = tr.querySelector('.kb-bpjs-aktif').checked;
    const catatan = tr.querySelector('.kb-catatan').value.trim() || null;
    try {
      const { data, error } = await supabaseClient.rpc('update_bpjs', {
        p_id: Number(id),
        p_persen_karyawan: karyawan,
        p_persen_perusahaan: perusahaan,
        p_batas_upah_max: batasV,
        p_is_aktif: aktif,
        p_catatan: catatan
      });
      if (error || (data && data.status === 'ERROR')) failed++; else success++;
    } catch (e) { failed++; }
  }
  showToast(`Selesai. ${success} baris tersimpan${failed > 0 ? `, ${failed} gagal` : ''}.`, failed > 0 ? 'error' : 'success');
  loadKompensasiPage();
}

function renderKbPolaTable() {
  const tbody = document.getElementById('kbPolaTableBody');
  if (!tbody) return;
  tbody.innerHTML = polaKerjaState.map(p => `
    <tr data-kb-id="${p.Id}">
      <td>${escapeHtml(p.Kategori || '-')}</td>
      <td><strong>${escapeHtml(p.NamaPola || '-')}</strong><br><span style="font-size:10px;color:#8a94a3;">${escapeHtml(p.Keterangan || '')}</span></td>
      <td>${p.JamNormalPerHari != null ? p.JamNormalPerHari + ' jam' : '-'}</td>
      <td>${p.JamLemburOtomatisPerHari > 0 ? '+' + p.JamLemburOtomatisPerHari + ' jam' : '-'}</td>
      <td style="text-align:center;"><input type="checkbox" class="kb-pola-weekend-off" ${p.SabtuMingguOff ? 'checked' : ''} style="width:18px;height:18px;"></td>
      <td style="text-align:center;"><input type="checkbox" class="kb-pola-libur-nasional" ${p.LiburNasionalBerlaku ? 'checked' : ''} style="width:18px;height:18px;"></td>
      <td><input type="number" step="0.01" class="kb-pola-pembagi" value="${p.PembagiJamKerja ?? ''}" placeholder="Contoh: 173" style="width:100px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
      <td><input type="number" step="0.01" class="kb-pola-mult-kerja" value="${p.MultiplierHariKerja ?? ''}" placeholder="Contoh: 1.5" style="width:100px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
      <td><input type="number" step="0.01" class="kb-pola-mult-off" value="${p.MultiplierHariOff ?? ''}" placeholder="Contoh: 2" style="width:100px;padding:4px 6px;border-radius:6px;border:1px solid #e6ded9;"></td>
    </tr>`).join('');
}

async function simpanSemuaKbPola() {
  const rows = document.querySelectorAll('#kbPolaTableBody tr[data-kb-id]');
  if (rows.length === 0) return;
  showToast(`Menyimpan ${rows.length} baris...`, 'info');
  let success = 0, failed = 0;
  for (const tr of rows) {
    const id = tr.dataset.kbId;
    const pembagiV = tr.querySelector('.kb-pola-pembagi').value.trim();
    const multKerjaV = tr.querySelector('.kb-pola-mult-kerja').value.trim();
    const multOffV = tr.querySelector('.kb-pola-mult-off').value.trim();
    const weekendOff = tr.querySelector('.kb-pola-weekend-off').checked;
    const liburNasional = tr.querySelector('.kb-pola-libur-nasional').checked;
    try {
      const { data, error } = await supabaseClient.rpc('update_pola_kerja', {
        p_id: Number(id),
        p_pembagi_jam: pembagiV === '' ? null : Number(pembagiV),
        p_multiplier_hari_kerja: multKerjaV === '' ? null : Number(multKerjaV),
        p_multiplier_hari_off: multOffV === '' ? null : Number(multOffV),
        p_sabtu_minggu_off: weekendOff,
        p_libur_nasional_berlaku: liburNasional
      });
      if (error || (data && data.status === 'ERROR')) failed++; else success++;
    } catch (e) { failed++; }
  }
  showToast(`Selesai. ${success} baris tersimpan${failed > 0 ? `, ${failed} gagal` : ''}.`, failed > 0 ? 'error' : 'success');
  loadKompensasiPage();
}

async function syncCustomKualifikasiToMasterGaji(divisi, departemen, kualifikasi) {
  try {
    const { data, error } = await supabaseClient.rpc('add_master_gaji', {
      p_divisi: divisi,
      p_departemen: departemen,
      p_kualifikasi: kualifikasi
    });
    if (error) throw error;
    if (data && data.status === 'SUCCESS' && data.message === 'Baris baru ditambahkan.') {
      showToast(`Jabatan "${kualifikasi}" otomatis ditambahkan ke Master Gaji & Tunjangan.`, 'info');
    }
  } catch (e) {
    console.warn('Gagal sinkron Kualifikasi custom ke Master Gaji:', e);
  }
}

async function autoDeteksiJenisHari() {
  const tanggal = document.getElementById('pengajuanTanggal')?.value;
  const qrcode = document.getElementById('pengajuanKaryawan')?.value || null;
  const jenisHariSel = document.getElementById('pengajuanJenisHari');
  const hintEl = document.getElementById('pengajuanJenisHariHint');
  if (!tanggal || !jenisHariSel) return;

  try {
    const { data, error } = await supabaseClient.rpc('cek_jenis_hari', { p_tanggal: tanggal, p_qrcode: qrcode });
    if (error) throw error;
    if (data && data.jenis_hari) {
      jenisHariSel.value = data.jenis_hari;
      if (hintEl) {
        hintEl.style.display = 'block';
        hintEl.style.color = data.jenis_hari === 'HARI_OFF' ? '#c0392b' : '#178a4c';
        hintEl.textContent = `🔍 Auto-terdeteksi: ${data.jenis_hari === 'HARI_OFF' ? 'Hari OFF' : 'Hari Kerja'} (${data.alasan}). Bisa diubah manual kalau perlu.`;
      }
    }
  } catch (e) {
    console.warn('Gagal auto-deteksi jenis hari:', e);
  }
}

let kbLiburState = [];

function renderKbLiburTable(rows) {
  if (rows) kbLiburState = rows;
  const tbody = document.getElementById('kbLiburTableBody');
  const tahunSel = document.getElementById('kbLiburFilterTahun');
  if (!tbody) return;

  // Populate filter tahun (sekali per data baru, tapi aman dipanggil berulang)
  if (tahunSel) {
    const currentVal = tahunSel.value;
    const tahunList = [...new Set(kbLiburState.map(r => new Date(r.Tanggal).getFullYear()))].sort((a, b) => b - a);
    tahunSel.innerHTML = '<option value="">Semua Tahun</option>' + tahunList.map(t => `<option value="${t}">${t}</option>`).join('');
    tahunSel.value = currentVal;
  }

  const filterTahun = tahunSel?.value || '';
  const filtered = filterTahun
    ? kbLiburState.filter(r => new Date(r.Tanggal).getFullYear() === Number(filterTahun))
    : kbLiburState;

  tbody.innerHTML = filtered.map(r => `
    <tr>
      <td>${new Date(r.Tanggal).toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}</td>
      <td>${escapeHtml(r.Keterangan || '-')}</td>
      <td>${escapeHtml(r.Jenis || '-')}</td>
      <td style="white-space:nowrap;">
        <button type="button" class="btn-secondary" style="padding:4px 8px; font-size:11px;" onclick="editKbLibur(${r.Id})">✏️</button>
        <button type="button" class="btn-secondary" style="padding:4px 8px; font-size:11px; color:#c0392b;" onclick="deleteKbLibur(${r.Id})">🗑️</button>
      </td>
    </tr>`).join('');
}

function editKbLibur(id) {
  const row = kbLiburState.find(r => r.Id === id);
  if (!row) return;
  document.getElementById('kbLiburEditId').value = row.Id;
  document.getElementById('kbLiburTanggalBaru').value = row.Tanggal;
  document.getElementById('kbLiburKeteranganBaru').value = row.Keterangan || '';
  document.getElementById('kbLiburJenisBaru').value = row.Jenis || 'Libur Nasional';
  document.getElementById('kbLiburSubmitBtn').textContent = '💾 Simpan Perubahan';
  document.getElementById('kbLiburBatalBtn').style.display = 'inline-block';
}

function batalEditKbLibur() {
  document.getElementById('kbLiburEditId').value = '';
  document.getElementById('kbLiburTanggalBaru').value = '';
  document.getElementById('kbLiburKeteranganBaru').value = '';
  document.getElementById('kbLiburJenisBaru').value = 'Libur Nasional';
  document.getElementById('kbLiburSubmitBtn').textContent = '+ Tambah';
  document.getElementById('kbLiburBatalBtn').style.display = 'none';
}

async function tambahKbLibur() {
  const editId = document.getElementById('kbLiburEditId')?.value;
  const tanggal = document.getElementById('kbLiburTanggalBaru')?.value;
  const keterangan = document.getElementById('kbLiburKeteranganBaru')?.value.trim();
  const jenis = document.getElementById('kbLiburJenisBaru')?.value;
  if (!tanggal || !keterangan) { showToast('Isi tanggal dan keterangan dulu.', 'error'); return; }

  try {
    const rpcName = editId ? 'update_hari_libur' : 'add_hari_libur';
    const params = editId
      ? { p_id: Number(editId), p_tanggal: tanggal, p_keterangan: keterangan, p_jenis: jenis }
      : { p_tanggal: tanggal, p_keterangan: keterangan, p_jenis: jenis };
    const { data, error } = await supabaseClient.rpc(rpcName, params);
    if (error) throw error;
    if (data && data.status === 'SUCCESS') {
      showToast(editId ? 'Hari libur berhasil diperbarui.' : 'Hari libur berhasil ditambahkan.', 'success');
      batalEditKbLibur();
      const { data: liburData } = await supabaseClient.rpc('list_hari_libur');
      renderKbLiburTable(liburData || []);
    } else {
      showToast((data && data.message) || 'Gagal menyimpan.', 'error');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function deleteKbLibur(id) {
  const row = kbLiburState.find(r => r.Id === id);
  if (!row) return;
  if (!confirm(`Hapus "${row.Keterangan}" (${row.Tanggal})?`)) return;
  try {
    const { data, error } = await supabaseClient.rpc('delete_hari_libur', { p_id: id });
    if (error) throw error;
    if (data && data.status === 'SUCCESS') {
      showToast('Hari libur berhasil dihapus.', 'success');
      const { data: liburData } = await supabaseClient.rpc('list_hari_libur');
      renderKbLiburTable(liburData || []);
    } else {
      showToast((data && data.message) || 'Gagal menghapus.', 'error');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

// ==========================================
// PROSES PAYROLL BULANAN
// ==========================================
let payrollHasilState = [];

const NAMA_BULAN = ['', 'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

async function jalankanProsesPayroll() {
  const bulan = Number(document.getElementById('prosesBulan')?.value);
  const tahun = Number(document.getElementById('prosesTahun')?.value);
  if (!bulan || !tahun) { showToast('Pilih bulan dan tahun dulu.', 'error'); return; }

  if (!confirm(`Proses payroll periode ${NAMA_BULAN[bulan]} ${tahun}? Kalau periode ini sudah pernah diproses, datanya akan ditimpa dengan hasil terbaru.`)) return;

  showToast('Memproses payroll, mohon tunggu...', 'info');
  try {
    const namaProcessor = (typeof currentUser !== 'undefined' && currentUser) ? currentUser.nama : 'Admin';
    const { data, error } = await supabaseClient.rpc('proses_payroll_bulanan', {
      p_bulan: bulan, p_tahun: tahun, p_processed_by: namaProcessor
    });
    if (error) throw error;
    if (data && data.status === 'SUCCESS') {
      showToast(`Payroll berhasil diproses: ${data.jumlah_karyawan_diproses} karyawan.`, 'success');
      await muatHasilPayroll();
      await renderPayrollRiwayat();
    } else {
      showToast((data && data.message) || 'Gagal proses payroll.', 'error');
    }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

async function muatHasilPayroll() {
  const bulan = Number(document.getElementById('prosesBulan')?.value);
  const tahun = Number(document.getElementById('prosesTahun')?.value);
  if (!bulan || !tahun) return;

  const periodeText = `— ${NAMA_BULAN[bulan]} ${tahun}`;
  const labelEl = document.getElementById('prosesPeriodeLabel');
  if (labelEl) labelEl.textContent = periodeText;
  const financeLabelEl = document.getElementById('financeDetailPeriodeLabel');
  if (financeLabelEl) financeLabelEl.textContent = periodeText;

  try {
    const { data, error } = await supabaseClient.rpc('list_payroll_bulanan', { p_bulan: bulan, p_tahun: tahun });
    if (error) throw error;
    payrollHasilState = data || [];
    renderPayrollHasilTable();
    // Kalau tabel detail finance lagi kebuka, refresh juga isinya biar nyambung sama periode yang baru dimuat.
    const financeWrap = document.getElementById('financeDetailTableWrap');
    if (financeWrap && financeWrap.style.display !== 'none') renderFinanceDetailTable();
  } catch (e) {
    showToast('Gagal memuat hasil payroll: ' + e.message, 'error');
  }
}

// ---- Detail Payroll untuk Finance: tabel rincian lengkap (gaji, tunjangan, BPJS
// karyawan+perusahaan, PPh21, THP) per karyawan + baris TOTAL, bisa dilihat di layar
// atau di-export ke Excel buat dikirim ke tim Finance. ----
const FINANCE_DETAIL_COLUMNS = [
  { key: 'NamaKaryawan', label: 'Nama' },
  { key: 'Departemen', label: 'Departemen' },
  { key: 'Kualifikasi', label: 'Jabatan' },
  { key: 'JenisKontrak', label: 'Kontrak' },
  { key: 'GajiPokok', label: 'Gaji Pokok', numeric: true },
  { key: 'TunjanganJabatan', label: 'Tunj. Jabatan', numeric: true },
  { key: 'TunjanganTransport', label: 'Tunj. Transport', numeric: true },
  { key: 'TunjanganMakan', label: 'Tunj. Makan', numeric: true },
  { key: 'TunjanganLain', label: 'Tunj. Lain', numeric: true },
  { key: 'NilaiLembur', label: 'Lembur', numeric: true },
  { key: 'PenghasilanBruto', label: 'Bruto', numeric: true },
  { key: 'BpjsKesehatanKaryawan', label: 'BPJS Kesehatan (Kry)', numeric: true },
  { key: 'JhtKaryawan', label: 'JHT (Kry)', numeric: true },
  { key: 'JpKaryawan', label: 'JP (Kry)', numeric: true },
  { key: 'TotalBpjsKaryawan', label: 'Total BPJS Karyawan', numeric: true },
  { key: 'TotalBpjsPerusahaan', label: 'Total BPJS Perusahaan', numeric: true },
  { key: 'Pph21', label: 'PPh 21', numeric: true },
  { key: 'TotalPotongan', label: 'Total Potongan', numeric: true },
  { key: 'TakeHomePay', label: 'Take Home Pay', numeric: true },
];

function toggleFinanceDetailTable() {
  const wrap = document.getElementById('financeDetailTableWrap');
  if (!wrap) return;
  const isHidden = wrap.style.display === 'none';
  if (isHidden) renderFinanceDetailTable();
  wrap.style.display = isHidden ? 'block' : 'none';
}

function renderFinanceDetailTable() {
  const tbody = document.getElementById('financeDetailBody');
  if (!tbody) return;
  if (payrollHasilState.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${FINANCE_DETAIL_COLUMNS.length}" style="text-align:center; color:#8a94a3; padding:16px;">Belum ada data untuk periode ini.</td></tr>`;
    return;
  }
  const rp = (n) => 'Rp ' + Math.round(Number(n || 0)).toLocaleString('id-ID');
  const totals = {};
  FINANCE_DETAIL_COLUMNS.forEach(c => { if (c.numeric) totals[c.key] = 0; });

  const rowsHtml = payrollHasilState.map(r => {
    const cells = FINANCE_DETAIL_COLUMNS.map(c => {
      if (c.numeric) {
        totals[c.key] += Number(r[c.key] || 0);
        return `<td style="text-align:right; white-space:nowrap;">${rp(r[c.key])}</td>`;
      }
      return `<td>${escapeHtml(r[c.key] || '-')}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  const totalCells = FINANCE_DETAIL_COLUMNS.map((c, i) => {
    if (i === 0) return `<td><strong>TOTAL (${payrollHasilState.length} karyawan)</strong></td>`;
    if (c.numeric) return `<td style="text-align:right; white-space:nowrap;"><strong>${rp(totals[c.key])}</strong></td>`;
    return `<td></td>`;
  }).join('');

  tbody.innerHTML = rowsHtml + `<tr style="background:#f8fafc; border-top:2px solid #cbd5e1;">${totalCells}</tr>`;
}

function exportPayrollFinanceExcel() {
  if (payrollHasilState.length === 0) { showToast('Belum ada data payroll untuk di-export.', 'error'); return; }
  if (typeof XLSX === 'undefined') { showToast('Library Excel belum termuat, coba refresh halaman.', 'error'); return; }

  const bulan = Number(document.getElementById('prosesBulan')?.value);
  const tahun = Number(document.getElementById('prosesTahun')?.value);
  const periodeLabel = `${NAMA_BULAN[bulan] || ''} ${tahun || ''}`.trim();

  const totals = {};
  FINANCE_DETAIL_COLUMNS.forEach(c => { if (c.numeric) totals[c.key] = 0; });

  const dataRows = payrollHasilState.map(r => FINANCE_DETAIL_COLUMNS.map(c => {
    if (c.numeric) {
      const v = Math.round(Number(r[c.key] || 0));
      totals[c.key] += v;
      return v;
    }
    return r[c.key] || '-';
  }));

  const totalRow = FINANCE_DETAIL_COLUMNS.map((c, i) => {
    if (i === 0) return `TOTAL (${payrollHasilState.length} karyawan)`;
    return c.numeric ? totals[c.key] : '';
  });

  const aoa = [
    [`Detail Payroll untuk Finance — ${periodeLabel}`],
    [],
    FINANCE_DETAIL_COLUMNS.map(c => c.label),
    ...dataRows,
    totalRow,
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = FINANCE_DETAIL_COLUMNS.map(c => ({ wch: c.numeric ? 16 : 20 }));
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: FINANCE_DETAIL_COLUMNS.length - 1 } }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Payroll Detail');
  XLSX.writeFile(wb, `Detail_Payroll_Finance_${NAMA_BULAN[bulan] || 'periode'}_${tahun || ''}.xlsx`);
  showToast('Export Excel berhasil dibuat.', 'success');
}

function renderPayrollHasilTable() {
  const tbody = document.getElementById('prosesHasilBody');
  if (!tbody) return;
  if (payrollHasilState.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:#8a94a3; padding:16px;">Belum ada data untuk periode ini.</td></tr>';
    return;
  }
  const rp = (n) => 'Rp ' + Math.round(Number(n || 0)).toLocaleString('id-ID');
  tbody.innerHTML = payrollHasilState.map(r => {
    const totalJamLembur = Number(r.JamLemburOtomatisKerja || 0) + Number(r.JamLemburOtomatisOff || 0) + Number(r.JamLemburManualKerja || 0) + Number(r.JamLemburManualOff || 0);
    return `
    <tr>
      <td>${escapeHtml(r.NamaKaryawan || '-')}</td>
      <td>${escapeHtml(r.Kualifikasi || '-')}</td>
      <td>${rp(r.PenghasilanBruto)}</td>
      <td>${rp(r.TotalPotongan)}</td>
      <td><strong>${rp(r.TakeHomePay)}</strong></td>
      <td style="text-align:center;">${r.JumlahHariHadir || 0}</td>
      <td style="text-align:center;">${totalJamLembur} jam</td>
      <td>
        ${r.ReportURL
          ? `<a href="${r.ReportURL}" target="_blank" class="report-link">📄 Lihat</a>
             <button type="button" class="btn-secondary" style="padding:4px 6px; font-size:11px; margin-left:4px;" onclick="generateSlipPdfSingle(${r.Id})" title="Generate ulang slip (misal habis update format PDF)">🔄</button>`
          : `<button type="button" class="btn-secondary" style="padding:4px 8px; font-size:11px;" onclick="generateSlipPdfSingle(${r.Id})">Generate</button>`}
      </td>
    </tr>`;
  }).join('');
}

async function renderPayrollRiwayat() {
  const tbody = document.getElementById('prosesRiwayatBody');
  if (!tbody) return;
  try {
    const { data, error } = await supabaseClient.rpc('list_payroll_periode_tersimpan');
    if (error) throw error;
    if (!data || data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; color:#8a94a3; padding:12px;">Belum ada periode yang diproses.</td></tr>';
      return;
    }
    tbody.innerHTML = data.map(r => `
      <tr>
        <td>${NAMA_BULAN[r.bulan]} ${r.tahun}</td>
        <td style="text-align:center;">${r.jumlah_karyawan}</td>
        <td><button type="button" class="btn-secondary" style="padding:4px 10px; font-size:11px;" onclick="lihatPeriodePayroll(${r.bulan}, ${r.tahun})">👁️ Lihat</button></td>
      </tr>`).join('');
  } catch (e) {
    console.warn('Gagal memuat riwayat payroll:', e);
  }
}

function lihatPeriodePayroll(bulan, tahun) {
  document.getElementById('prosesBulan').value = bulan;
  document.getElementById('prosesTahun').value = tahun;
  muatHasilPayroll();
}

// Logo BIMA di-cache sekali per sesi biar generateSemuaSlip() ga fetch file gambar berkali-kali
let _bimaLogoDataUrlCache = null;
async function getBimaLogoDataUrl() {
  if (_bimaLogoDataUrlCache !== null) return _bimaLogoDataUrlCache || null;
  try {
    const resp = await fetch('logo-bima.png');
    const blob = await resp.blob();
    _bimaLogoDataUrlCache = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    _bimaLogoDataUrlCache = false; // gagal load logo bukan alasan buat gagalin seluruh slip
  }
  return _bimaLogoDataUrlCache || null;
}

// Warna brand BIMA (diambil dari logo-bima.png) -- dipakai biar tema slip nyambung sama identitas perusahaan
const SLIP_ORANGE = [233, 82, 37];
const SLIP_DARK = [58, 58, 58];
const SLIP_GRAY = [120, 120, 120];
const SLIP_LINE = [222, 222, 222];
const SLIP_GREEN = [15, 122, 69];
const SLIP_GREEN_BG = [232, 244, 238];
const SLIP_RED = [196, 60, 60];
const SLIP_BLUE = [40, 100, 180];

const TIMESHEET_STATUS_STYLE = {
  HADIR_LENGKAP: { color: SLIP_GREEN, label: 'Hadir Lengkap' },
  KURANG_LENGKAP: { color: SLIP_ORANGE, label: 'Kurang Lengkap' },
  PARSIAL: { color: SLIP_ORANGE, label: 'Parsial' },
  CUTI: { color: SLIP_BLUE, label: 'Cuti' },
  IJIN: { color: SLIP_BLUE, label: 'Ijin' },
  LIBUR: { color: SLIP_GRAY, label: 'Libur' },
  TIDAK_HADIR: { color: SLIP_RED, label: 'Tidak Hadir' },
};

// Potong teks supaya muat di lebar kolom PDF tanpa numpuk ke baris berikutnya (dipakai di tabel timesheet).
function truncateJsPdfText(doc, text, maxWidth) {
  text = String(text == null ? '' : text);
  if (doc.getTextWidth(text) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && doc.getTextWidth(t + '…') > maxWidth) {
    t = t.slice(0, -1);
  }
  return t + '…';
}

// Format total menit jadi "J:MM" (contoh 363 menit -> "6:03"). Dipakai buat kolom Jam Kerja timesheet
// dan ringkasan jam di halaman 1.
function formatJamMenit(totalMenit) {
  const m = Math.max(0, Math.round(Number(totalMenit) || 0));
  const j = Math.floor(m / 60);
  const sisa = m % 60;
  return j + ':' + String(sisa).padStart(2, '0');
}

// Jumlahkan field jam (dalam menit) dari seluruh hari di timesheetData satu bulan.
function sumTimesheetJam(timesheetData) {
  const out = { regularMenit: 0, lemburRegulerMenit: 0, lemburOffMenit: 0 };
  (timesheetData || []).forEach(d => {
    out.regularMenit += Number(d.jamRegularMenit || 0);
    out.lemburRegulerMenit += Number(d.jamLemburRegulerMenit || 0);
    out.lemburOffMenit += Number(d.jamLemburOffMenit || 0);
  });
  return out;
}

// ---- Estimasi Potongan Jam Kurang (khusus Pekerja Lapangan 8/10/12 Jam) ----
// Kebijakan (dikonfirmasi bareng CRV):
// 1. Target Jam Wajib Bulanan = PembagiJamKerja pola kerja (173, sesuai 40 jam/minggu dirata-ratain
//    setahun -- angka yang sama dipakai buat tarif per jam, biar satu sumber angka) -- TAPI
//    DIPRORATA sesuai porsi hari kerja (jenisHari=HARI_KERJA) yang jadwalnya udah lewat s/d hari
//    ini (dibanding total hari kerja terjadwal sebulan penuh). Ini buat nyegah kasus slip yang
//    digenerate di tengah periode berjalan (misal tanggal 14) nunjukin "kekurangan" jam kayak
//    karyawan gagal penuhin target SEBULAN PENUH, padahal sisa harinya emang belum kejalanin.
//    Kalau periode udah closed (semua hari kerja di bulan itu udah lewat tanggalnya), rasionya
//    otomatis 1 alias balik ke target penuh kayak biasa.
// 2. Jam Aktual Bulanan = total (Jam Regular + Jam Lembur Reguler) sebulan, DITAMBAH kredit hari
//    Cuti/Ijin APPROVED (dianggap "lunas" senilai jam normal pola hari itu -- JamNormalPerHari +
//    JamLemburOtomatisPerHari -- karena cuti/ijin resmi gak boleh dipotong gajinya).
// 3. Kekurangan Kasar = MAX(0, Jam Wajib Bulanan (prorata) - Jam Aktual Bulanan).
// 4. Surplus Jam Off = total Jam Lembur Hari Off sebulan (masuk pas hari libur/off) -- dipakai
//    buat NUTUP kekurangan dulu (netting) sebelum dipotong, biar karyawan yang udah masuk pas
//    hari off-nya gak double rugi. Surplus ini TETAP dibayar penuh sebagai lembur hari off,
//    cuma pengaruh ke ada/nggaknya potongan, bukan ke nilai lemburnya.
// 5. Kekurangan Bersih = MAX(0, Kekurangan Kasar - Surplus Jam Off) -- ini yang dipotong, pakai
//    tarif flat (Gaji Pokok / PembagiJamKerja), TANPA multiplier (bukan lembur, jadi gak dikali).
// Cuma berlaku buat Pola Kerja Kategori "Pekerja Lapangan" (8/10/12 Jam) -- Staff/PMT (Reguler
// lumpsum, Rotasi 3 Bulan "gaji penuh tanpa potongan") di luar cakupan ini.
// Estimasi doang buat cross-check HR -- BELUM otomatis motong TotalPotongan/TakeHomePay di slip
// (itu masih hasil RPC payroll utama yang terpisah).
function hitungPotonganJamKurang(timesheetData, row) {
  const polaRef = (timesheetData[0] && timesheetData[0].polaKerjaRef) || {};
  if (polaRef.kategori !== 'Pekerja Lapangan') return null;

  const pembagi = Number(polaRef.pembagiJamKerja) || 173;
  const jamNormalMenit = Math.round((Number(polaRef.jamNormalPerHari) || 8) * 60);
  const jamLemburOtomatisMenit = Math.round((Number(polaRef.jamLemburOtomatisPerHari) || 0) * 60);
  const kreditCutiIjinMenit = jamNormalMenit + jamLemburOtomatisMenit;

  const hariIni = getTodayDateString();
  let jamAktualBulananMenit = 0;
  let surplusOffMenit = 0;
  let totalHariKerjaSebulan = 0;
  let hariKerjaTerlewati = 0;
  (timesheetData || []).forEach(d => {
    if (d.status === 'CUTI' || d.status === 'IJIN') {
      jamAktualBulananMenit += kreditCutiIjinMenit;
    } else {
      jamAktualBulananMenit += Number(d.jamRegularMenit || 0) + Number(d.jamLemburRegulerMenit || 0);
    }
    surplusOffMenit += Number(d.jamLemburOffMenit || 0);
    if (d.jenisHari === 'HARI_KERJA') {
      totalHariKerjaSebulan++;
      if (d.tanggal && d.tanggal <= hariIni) hariKerjaTerlewati++;
    }
  });

  const rasioTerlewati = totalHariKerjaSebulan > 0 ? Math.min(1, hariKerjaTerlewati / totalHariKerjaSebulan) : 0;
  const jamWajibMenit = Math.round(pembagi * 60 * rasioTerlewati);
  const kekuranganKasarMenit = Math.max(0, jamWajibMenit - jamAktualBulananMenit);
  const kekuranganBersihMenit = Math.max(0, kekuranganKasarMenit - surplusOffMenit);
  const tarifPerJam = Number(row.GajiPokok || 0) / pembagi;
  const potonganRp = tarifPerJam * (kekuranganBersihMenit / 60);

  return { jamWajibMenit, jamAktualBulananMenit, kekuranganKasarMenit, surplusOffMenit, kekuranganBersihMenit, potonganRp, rasioTerlewati };
}

// ---- Halaman 2 Slip Gaji: Timesheet Bulanan (pendukung payroll) ----
// timesheetData: array hasil RPC get_timesheet_bulanan (satu objek per tanggal dalam periode).
function renderTimesheetPage(doc, row, timesheetData, { pageW, marginX, contentW, logoDataUrl }) {
  doc.addPage();
  let y = 14;

  doc.setFillColor(...SLIP_ORANGE);
  doc.rect(0, 0, pageW, 3, 'F');
  y += 10;

  const textX = logoDataUrl ? marginX + 20 : marginX;
  if (logoDataUrl) {
    doc.addImage(logoDataUrl, 'PNG', marginX, y - 11, 16, 16);
  }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...SLIP_DARK);
  doc.text('PT BILAL MITRA ARYATAMA (BIMA)', textX, y - 4);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...SLIP_ORANGE);
  doc.text('TIMESHEET BULANAN (PENDUKUNG PAYROLL)', textX, y + 1.5);
  y += 8;
  doc.setDrawColor(...SLIP_ORANGE); doc.setLineWidth(0.6);
  doc.line(marginX, y, pageW - marginX, y);
  y += 9;

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal'); doc.setTextColor(...SLIP_GRAY); doc.text('Nama Karyawan', marginX, y);
  doc.setFont('helvetica', 'bold'); doc.setTextColor(...SLIP_DARK); doc.text(String(row.NamaKaryawan || '-'), marginX + 35, y);
  doc.setFont('helvetica', 'normal'); doc.setTextColor(...SLIP_GRAY); doc.text('Periode', marginX + 95, y);
  doc.setFont('helvetica', 'bold'); doc.setTextColor(...SLIP_DARK); doc.text(`${NAMA_BULAN[row.Bulan]} ${row.Tahun}`, marginX + 130, y);
  y += 9;

  const cols = [
    { key: 'tanggalDisplay', label: 'Tgl', w: 6, align: 'center' },
    { key: 'hari', label: 'Hari', w: 10, align: 'left' },
    { key: 'jamMasuk1', label: 'Masuk', w: 11, align: 'center' },
    { key: 'jamIstirahat', label: 'Istirahat', w: 13, align: 'center' },
    { key: 'jamMasuk2', label: 'Masuk Lagi', w: 15, align: 'center' },
    { key: 'jamPulang', label: 'Pulang', w: 11, align: 'center' },
    { key: 'jamKerja', label: 'Jam', w: 12, align: 'center' },
    { key: 'status', label: 'Status', w: 21, align: 'center' },
  ];
  const ketW = contentW - cols.reduce((s, c) => s + c.w, 0);
  cols.push({ key: 'keterangan', label: 'Keterangan', w: ketW, align: 'left' });

  let cx = marginX;
  const colX = cols.map(c => { const startX = cx; cx += c.w; return startX; });

  const drawTableHeader = () => {
    doc.setFillColor(...SLIP_DARK);
    doc.rect(marginX, y - 4, contentW, 6, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(255, 255, 255);
    cols.forEach((c, i) => {
      const tx = c.align === 'center' ? colX[i] + c.w / 2 : colX[i] + 1;
      doc.text(c.label, tx, y, { align: c.align === 'center' ? 'center' : 'left' });
    });
    y += 5;
  };
  drawTableHeader();

  const pageH = doc.internal.pageSize.getHeight();
  const rowH = 5.6;
  const bottomLimit = pageH - 16;

  timesheetData.forEach((d, idx) => {
    if (y > bottomLimit) {
      doc.addPage();
      y = 16;
      drawTableHeader();
    }

    if (idx % 2 === 1) {
      doc.setFillColor(247, 247, 247);
      doc.rect(marginX, y - 3.8, contentW, rowH, 'F');
    }

    const style = TIMESHEET_STATUS_STYLE[d.status] || { color: SLIP_DARK, label: d.status || '-' };
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.8); doc.setTextColor(...SLIP_DARK);

    doc.text(String(d.tanggalDisplay || ''), colX[0] + cols[0].w / 2, y, { align: 'center' });
    doc.text(String(d.hari || ''), colX[1] + 1, y);
    doc.text((d.jamMasuk1 || '-').trim() || '-', colX[2] + cols[2].w / 2, y, { align: 'center' });
    doc.text((d.jamIstirahat || '-').trim() || '-', colX[3] + cols[3].w / 2, y, { align: 'center' });
    doc.text((d.jamMasuk2 || '-').trim() || '-', colX[4] + cols[4].w / 2, y, { align: 'center' });
    doc.text((d.jamPulang || '-').trim() || '-', colX[5] + cols[5].w / 2, y, { align: 'center' });

    // Jam kerja aktual hari itu (Jam Regular + Jam Lembur Reguler/Off) -- dari get_timesheet_bulanan.
    // Dikasih warna oranye kalau ada komponen lembur di dalamnya, biar kelihatan beda dari jam biasa.
    const jamAktual = Number(d.jamAktualMenit || 0);
    const adaLembur = Number(d.jamLemburRegulerMenit || 0) > 0 || Number(d.jamLemburOffMenit || 0) > 0;
    doc.setFont('helvetica', adaLembur ? 'bold' : 'normal'); doc.setFontSize(6.8);
    doc.setTextColor(...(adaLembur ? SLIP_ORANGE : SLIP_DARK));
    doc.text(jamAktual > 0 ? formatJamMenit(jamAktual) : '-', colX[6] + cols[6].w / 2, y, { align: 'center' });

    doc.setFont('helvetica', 'bold'); doc.setTextColor(...style.color); doc.setFontSize(6.8);
    doc.text(style.label, colX[7] + cols[7].w / 2, y, { align: 'center' });

    doc.setFont('helvetica', 'normal'); doc.setTextColor(...SLIP_GRAY); doc.setFontSize(6.2);
    doc.text(truncateJsPdfText(doc, d.keterangan || '-', cols[8].w - 2), colX[8] + 1, y);

    y += rowH;
  });

  y += 5;
  // Total jam + catatan penutup butuh ~40mm; kalau tabel udah mepet ke bawah, pindah ke halaman baru
  // dulu biar gak numpuk/kepotong sama footer.
  if (y > pageH - 40) {
    doc.addPage();
    y = 16;
  }
  doc.setDrawColor(...SLIP_LINE); doc.setLineWidth(0.3);
  doc.line(marginX, y, pageW - marginX, y);
  y += 6;

  // ---- Total jam sebulan (detail perhitungan Rupiah-nya ada di ringkasan halaman 1) ----
  const totalJam = sumTimesheetJam(timesheetData);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(...SLIP_DARK);
  doc.text('Total Jam Kerja Bulan Ini', marginX, y);
  y += 6;
  const jamStats = [
    ['Jam Regular', formatJamMenit(totalJam.regularMenit), SLIP_DARK],
    ['Jam Lembur Reguler', formatJamMenit(totalJam.lemburRegulerMenit), SLIP_ORANGE],
    ['Jam Lembur Hari Off/Libur', formatJamMenit(totalJam.lemburOffMenit), SLIP_ORANGE],
  ];
  const statW = contentW / 3;
  jamStats.forEach((s, i) => {
    const sx = marginX + i * statW;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...SLIP_GRAY);
    doc.text(s[0], sx, y);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...s[2]);
    doc.text(s[1] + ' jam', sx, y + 6);
  });
  y += 12;

  doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...SLIP_GRAY);
  doc.text('Keterangan dihitung otomatis dari data scan absensi, jadwal TimeLimit lokasi kerja, dan pengajuan Ijin/Cuti berstatus APPROVED.', marginX, y, { maxWidth: contentW });
  y += 4;
  doc.text('Kolom Jam menunjukkan jam kerja aktual per hari (oranye = mengandung komponen lembur). Rincian nilai Rupiah lembur ada di halaman 1.', marginX, y, { maxWidth: contentW });
  y += 4;
  doc.text('Timesheet ini adalah dokumen pendukung payroll dan digenerate otomatis oleh sistem Fusion4 SmartGate.', marginX, y, { maxWidth: contentW });

  const finalPageH = doc.internal.pageSize.getHeight();
  doc.setDrawColor(...SLIP_LINE); doc.setLineWidth(0.2);
  doc.line(marginX, finalPageH - 14, pageW - marginX, finalPageH - 14);
  doc.setTextColor(...SLIP_GRAY); doc.setFontSize(7);
  doc.text('Fusion4 SmartGate - PT Bilal Mitra Aryatama (BIMA)', marginX, finalPageH - 10);
  doc.text('Dokumen ini digenerate otomatis dan sah tanpa tanda tangan basah.', marginX, finalPageH - 6.5);
}

async function generateSlipPdf(payrollId) {
  const row = payrollHasilState.find(r => r.Id === payrollId);
  if (!row) { showToast('Data tidak ditemukan.', 'error'); return; }

  showToast(`Membuat slip gaji ${row.NamaKaryawan}...`, 'info');
  try {
    const rp = (n) => 'Rp ' + Math.round(Number(n || 0)).toLocaleString('id-ID');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const pageW = 210;
    const marginX = 18;
    const contentW = pageW - marginX * 2;
    let y = 14;

    // ---- Aksen bar atas ----
    doc.setFillColor(...SLIP_ORANGE);
    doc.rect(0, 0, pageW, 3, 'F');
    y += 10;

    // ---- Header: logo + nama perusahaan ----
    const logoDataUrl = await getBimaLogoDataUrl();
    const textX = logoDataUrl ? marginX + 20 : marginX;
    if (logoDataUrl) {
      doc.addImage(logoDataUrl, 'PNG', marginX, y - 11, 16, 16);
    }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...SLIP_DARK);
    doc.text('PT BILAL MITRA ARYATAMA (BIMA)', textX, y - 4);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...SLIP_ORANGE);
    doc.text('SLIP GAJI KARYAWAN', textX, y + 1.5);
    y += 8;
    doc.setDrawColor(...SLIP_ORANGE); doc.setLineWidth(0.6);
    doc.line(marginX, y, pageW - marginX, y);
    y += 9;

    // ---- Info grid 2 kolom ----
    doc.setFontSize(9);
    const infoLeft = [['Nama Karyawan', row.NamaKaryawan], ['Jabatan', row.Kualifikasi || '-'], ['Departemen', row.Departemen || '-']];
    const infoRight = [['Periode', `${NAMA_BULAN[row.Bulan]} ${row.Tahun}`], ['Jenis Kontrak', row.JenisKontrak || '-'], ['Status PTKP', row.StatusPTKP || '-']];
    infoLeft.forEach((r, i) => {
      doc.setFont('helvetica', 'normal'); doc.setTextColor(...SLIP_GRAY); doc.text(r[0], marginX, y + i * 6);
      doc.setFont('helvetica', 'bold'); doc.setTextColor(...SLIP_DARK); doc.text(String(r[1]), marginX + 35, y + i * 6);
    });
    infoRight.forEach((r, i) => {
      doc.setFont('helvetica', 'normal'); doc.setTextColor(...SLIP_GRAY); doc.text(r[0], marginX + 95, y + i * 6);
      doc.setFont('helvetica', 'bold'); doc.setTextColor(...SLIP_DARK); doc.text(String(r[1]), marginX + 130, y + i * 6);
    });
    y += 22;

    doc.setDrawColor(...SLIP_ORANGE); doc.setFillColor(...SLIP_ORANGE);
    doc.rect(marginX, y - 3.5, 1.2, 4.5, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...SLIP_DARK);
    doc.text('RINCIAN GAJI', marginX + 4, y);
    y += 7;

    const pendapatan = [
      ['Gaji Pokok', rp(row.GajiPokok)],
      ['Tunjangan Jabatan', rp(row.TunjanganJabatan)],
      ['Tunjangan Transport', rp(row.TunjanganTransport)],
      ['Tunjangan Makan', rp(row.TunjanganMakan)],
      ['Tunjangan Lain', rp(row.TunjanganLain)],
      ['Nilai Lembur', rp(row.NilaiLembur)],
    ];
    const potongan = [
      ['BPJS Kesehatan', rp(row.BpjsKesehatanKaryawan)],
      ['JHT', rp(row.JhtKaryawan)],
      ['JP', rp(row.JpKaryawan)],
      ['PPh 21', rp(row.Pph21)],
    ];

    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...SLIP_GRAY);
    doc.text('PENDAPATAN', marginX, y);
    doc.text('POTONGAN', marginX + 95, y);
    y += 5;

    doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...SLIP_DARK);
    let yL = y, yR = y;
    pendapatan.forEach(p => { doc.text(p[0], marginX, yL); doc.text(p[1], marginX + 55, yL, { align: 'right' }); yL += 5.5; });
    potongan.forEach(p => { doc.text(p[0], marginX + 95, yR); doc.text(p[1], marginX + 160, yR, { align: 'right' }); yR += 5.5; });

    y = Math.max(yL, yR) + 3;
    doc.setDrawColor(...SLIP_LINE); doc.setLineWidth(0.3);
    doc.line(marginX, y, pageW - marginX, y);
    y += 7;

    // ---- Total Pendapatan & Total Potongan: masing-masing satu baris penuh, biar labelnya
    // (apalagi "Total Pendapatan (Bruto)" yang panjang) ga numpuk sama angkanya ----
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...SLIP_DARK);
    doc.text('Total Pendapatan (Bruto)', marginX, y);
    doc.text(rp(row.PenghasilanBruto), pageW - marginX, y, { align: 'right' });
    y += 6.5;
    doc.text('Total Potongan', marginX, y);
    doc.text(rp(row.TotalPotongan), pageW - marginX, y, { align: 'right' });
    y += 10;

    doc.setFillColor(...SLIP_GREEN_BG); doc.setDrawColor(...SLIP_GREEN); doc.setLineWidth(0.4);
    doc.roundedRect(marginX, y - 6, contentW, 14, 2, 2, 'FD');
    doc.setTextColor(...SLIP_GREEN); doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
    doc.text('TAKE HOME PAY (THP)', marginX + 4, y + 2.5);
    doc.text(rp(row.TakeHomePay), pageW - marginX - 4, y + 2.5, { align: 'right' });
    y += 18;

    // ---- Ambil timesheet bulanan lebih awal (dipakai buat Ringkasan Jam Kerja di halaman 1 ini
    // DAN buat render tabel lengkap di halaman 2 -- jadi cuma fetch sekali). ----
    let timesheetData = null;
    try {
      const { data: tsData, error: timesheetErr } = await supabaseClient.rpc('get_timesheet_bulanan', {
        p_karyawan_id: row.KaryawanId, p_bulan: row.Bulan, p_tahun: row.Tahun
      });
      if (timesheetErr) throw timesheetErr;
      if (Array.isArray(tsData) && tsData.length) timesheetData = tsData;
    } catch (tsErr) {
      console.warn('Gagal memuat timesheet bulanan untuk slip', row.NamaKaryawan, tsErr);
      // Tetap lanjut generate slip walau timesheet gagal dimuat, biar proses payroll ga keblok.
    }

    // ---- Ringkasan Jam Kerja (dari timesheet, referensi Pola Kerja karyawan) ----
    if (timesheetData) {
      const totalJam = sumTimesheetJam(timesheetData);
      const polaRef = (timesheetData[0] && timesheetData[0].polaKerjaRef) || {};
      const pembagi = Number(polaRef.pembagiJamKerja) || 173;
      const multKerja = Number(polaRef.multiplierHariKerja) || 1.5;
      const multOff = Number(polaRef.multiplierHariOff) || 2;
      const tarifPerJam = Number(row.GajiPokok || 0) / pembagi;
      const rpLemburReguler = tarifPerJam * (totalJam.lemburRegulerMenit / 60) * multKerja;
      const rpLemburOff = tarifPerJam * (totalJam.lemburOffMenit / 60) * multOff;

      doc.setDrawColor(...SLIP_ORANGE); doc.setFillColor(...SLIP_ORANGE);
      doc.rect(marginX, y - 3.5, 1.2, 4.5, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...SLIP_DARK);
      doc.text('RINGKASAN JAM KERJA (LAMPIRAN TIMESHEET HAL. 2)', marginX + 4, y);
      y += 7;

      const jamRows = [
        ['Jam Regular', formatJamMenit(totalJam.regularMenit) + ' jam', null, null],
        ['Jam Lembur Reguler (otomatis, x' + multKerja + ')', formatJamMenit(totalJam.lemburRegulerMenit) + ' jam', rp(rpLemburReguler), null],
        ['Jam Lembur Hari Off/Libur (x' + multOff + ')', formatJamMenit(totalJam.lemburOffMenit) + ' jam', rp(rpLemburOff), null],
      ];

      // ---- Estimasi Potongan Jam Kurang (cuma Pekerja Lapangan 8/10/12 Jam) ----
      const potonganJamKurang = hitungPotonganJamKurang(timesheetData, row);
      if (potonganJamKurang) {
        const targetLabel = potonganJamKurang.rasioTerlewati < 1
          ? 'target prorata ' + formatJamMenit(potonganJamKurang.jamWajibMenit) + ' jam s/d hari ini'
          : 'target ' + pembagi + ' jam/bln';
        jamRows.push([
          'Kekurangan Jam (net. surplus off, ' + targetLabel + ')',
          formatJamMenit(potonganJamKurang.kekuranganBersihMenit) + ' jam',
          (potonganJamKurang.kekuranganBersihMenit > 0 ? '- ' + rp(potonganJamKurang.potonganRp) : rp(0)),
          SLIP_RED,
        ]);
      }

      doc.setFontSize(8.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(...SLIP_DARK);
      jamRows.forEach(r => {
        doc.setTextColor(...(r[3] || SLIP_DARK));
        doc.text(r[0], marginX, y);
        doc.text(r[1], marginX + 110, y, { align: 'right' });
        if (r[2]) doc.text('~ ' + r[2], pageW - marginX, y, { align: 'right' });
        y += 5.5;
      });
      y += 1;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...SLIP_GRAY);
      // Pakai splitTextToSize + y dinamis (bukan y += angka tetap) buat ngukur beneran berapa baris
      // yang kepakai -- soalnya panjang teksnya bisa berubah-ubah (ex: klausa prorata di bawah),
      // jadi spasi fixed gampang numpuk/overlap kalau teksnya jadi lebih panjang dari perkiraan.
      const catatanRupiahLines = doc.splitTextToSize('Estimasi Rupiah lembur di atas dihitung dari Gaji Pokok / Pembagi Jam Kerja x jam x multiplier Pola Kerja, buat cross-check HR -- bukan pengganti field Nilai Lembur di atas.', contentW);
      doc.text(catatanRupiahLines, marginX, y);
      y += catatanRupiahLines.length * 3.4 + 2;
      if (potonganJamKurang) {
        const targetNote = potonganJamKurang.rasioTerlewati < 1
          ? 'diprorata sesuai hari kerja terjadwal yang sudah lewat karena periode ini masih berjalan'
          : 'target penuh sebulan karena periode ini sudah selesai';
        const catatanKekuranganLines = doc.splitTextToSize('Kekurangan Jam Kerja Lapangan: dihitung dari total jam wajib (' + targetNote + ') dikurangi jam kerja aktual (Cuti/Ijin approved dianggap lunas), lalu dikurangi lagi surplus jam kerja di hari off/libur. Estimasi cross-check HR, belum otomatis motong Total Potongan/THP di atas.', contentW);
        doc.text(catatanKekuranganLines, marginX, y);
        y += catatanKekuranganLines.length * 3.4 + 2;
      } else {
        y += 4;
      }
    }

    doc.setTextColor(...SLIP_GRAY); doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
    doc.text('Catatan: Potongan BPJS hanya porsi karyawan. Perusahaan menanggung tambahan BPJS Kesehatan, JHT, JP, JKK, dan JKM.', marginX, y, { maxWidth: contentW });
    y += 4;
    doc.text('PPh 21 dihitung dengan metode Tarif Efektif Rata-rata (TER) bulanan sesuai PMK 168/2023.', marginX, y, { maxWidth: contentW });
    y += 4;
    doc.text(`Jumlah hari hadir: ${row.JumlahHariHadir || 0} hari. Diproses otomatis oleh sistem Fusion4 SmartGate.`, marginX, y, { maxWidth: contentW });

    // ---- Footer ----
    const pageH = doc.internal.pageSize.getHeight();
    doc.setDrawColor(...SLIP_LINE); doc.setLineWidth(0.2);
    doc.line(marginX, pageH - 14, pageW - marginX, pageH - 14);
    doc.setTextColor(...SLIP_GRAY); doc.setFontSize(7);
    doc.text('Fusion4 SmartGate - PT Bilal Mitra Aryatama (BIMA)', marginX, pageH - 10);
    doc.text('Dokumen ini digenerate otomatis dan sah tanpa tanda tangan basah.', marginX, pageH - 6.5);

    // ---- Halaman 2: Timesheet Bulanan (pendukung payroll), refer TimeLimit + data scan absensi real ----
    if (timesheetData) {
      renderTimesheetPage(doc, row, timesheetData, { pageW, marginX, contentW, logoDataUrl });
    }

    const pdfBlob = doc.output('blob');
    const uploaded = await uploadToDrive('reports', `SLIP_${(row.NamaKaryawan || 'karyawan').replace(/\s+/g, '_')}_${row.Bulan}_${row.Tahun}.pdf`, 'application/pdf', pdfBlob);
    const reportUrl = uploaded.fileId ? `https://drive.google.com/file/d/${uploaded.fileId}/view` : (uploaded.viewUrl || uploaded.directUrl);

    await supabaseClient.rpc('update_payroll_report_url', { p_id: payrollId, p_report_url: reportUrl, p_report_fileid: uploaded.fileId });
    showToast(`Slip gaji ${row.NamaKaryawan} berhasil dibuat.`, 'success');
    await muatHasilPayroll();
  } catch (e) {
    showToast('Gagal membuat slip: ' + e.message, 'error');
  }
}

function setSlipGenProgress(shown, { current, total, label } = {}) {
  const box = document.getElementById('slipGenProgress');
  const bar = document.getElementById('slipGenProgressBar');
  const lbl = document.getElementById('slipGenProgressLabel');
  const cnt = document.getElementById('slipGenProgressCount');
  const btn = document.getElementById('btnGenerateSemuaSlip');
  if (!box || !bar || !lbl || !cnt) return;
  box.style.display = shown ? 'block' : 'none';
  if (btn) btn.disabled = shown;
  if (shown) {
    const pct = total ? Math.round((current / total) * 100) : 0;
    bar.style.width = pct + '%';
    cnt.textContent = `${current}/${total}`;
    if (label) lbl.textContent = label;
  }
}

// Dipakai tombol "Generate"/"🔄 Generate Ulang" per-baris di tabel, biar tetep kelihatan progress-nya
// (sekarang generateSlipPdf lebih lama karena juga narik timesheet bulanan buat halaman 2).
async function generateSlipPdfSingle(payrollId) {
  const row = payrollHasilState.find(r => r.Id === payrollId);
  setSlipGenProgress(true, { current: 0, total: 1, label: `Membuat slip ${row ? row.NamaKaryawan : ''}...` });
  try {
    await generateSlipPdf(payrollId);
  } finally {
    setSlipGenProgress(true, { current: 1, total: 1, label: 'Selesai' });
    setTimeout(() => setSlipGenProgress(false), 700);
  }
}

async function generateSemuaSlip() {
  const belumAdaSlip = payrollHasilState.filter(r => !r.ReportURL);
  if (belumAdaSlip.length === 0) { showToast('Semua slip sudah dibuat.', 'info'); return; }
  const total = belumAdaSlip.length;
  setSlipGenProgress(true, { current: 0, total, label: 'Menyiapkan...' });
  for (let i = 0; i < total; i++) {
    if (i > 0) await new Promise(resolve => setTimeout(resolve, 1500)); // jeda dikit biar ga kena rate limit Apps Script kalau digenerate beruntun
    const row = belumAdaSlip[i];
    setSlipGenProgress(true, { current: i, total, label: `Membuat slip ${row.NamaKaryawan}...` });
    await generateSlipPdf(row.Id);
    setSlipGenProgress(true, { current: i + 1, total, label: `Selesai: ${row.NamaKaryawan}` });
  }
  setSlipGenProgress(false);
  showToast('Semua slip gaji selesai dibuat.', 'success');
}
