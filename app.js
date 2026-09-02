const SUPABASE_URL = 'https://nhmpwjriextmbotmvvbu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_XNqLw7iz873TtrLn9ag8dQ_AkL2rImz';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

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
    updateUIAuth();
    // Refresh PIC dari database tiap buka app, biar kalau admin baru ubah PIC-nya,
    // gak perlu logout/login dulu buat efeknya kerasa.
    currentUser.pic = await fetchKaryawanPic(currentUser.id);
    localStorage.setItem('fusion4_smartgate_user', JSON.stringify(currentUser));
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
      };
      currentUser.pic = await fetchKaryawanPic(currentUser.id);
      localStorage.setItem('fusion4_smartgate_user', JSON.stringify(currentUser));
      updateUIAuth();
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
// AKSES SIDEBAR BERDASARKAN PIC (paswordTbl.pic) -- default gak diisi/kosong = akses
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
  { key: 'OIL', label: 'Otorisasi Ijin & Lembur', sectionId: 'sec-otorisasi', btnId: 'btnNavOtorisasi' },
];

async function fetchKaryawanPic(id) {
  try {
    const { data, error } = await supabaseClient.rpc('get_karyawan_pic', { p_id: parseInt(id, 10) });
    if (error) throw error;
    return data || '';
  } catch (err) {
    console.error('Error fetchKaryawanPic:', err);
    return '';
  }
}

function hasSectionAccess(key) {
  const picRaw = (currentUser && currentUser.pic) ? String(currentUser.pic).trim() : '';
  if (!picRaw) return true; // PIC kosong = default akses semua menu
  const tokens = picRaw.toUpperCase().split(',').map(t => t.trim()).filter(Boolean);
  if (tokens.includes('ALL') || tokens.includes('*')) return true;
  return tokens.includes(key.toUpperCase());
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
   'karyawanTglMasuk','karyawanPassword','karyawanAuthor','karyawanPic','karyawanEditId']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
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

