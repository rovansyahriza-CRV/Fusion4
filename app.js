const SUPABASE_URL = 'https://nhmpwjriextmbotmvvbu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_XNqLw7iz873TtrLn9ag8dQ_AkL2rImz';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Penampung aman agar pemanggilan generateRefNo / generateNewRefNo tidak crash
function generateRefNo() {
  const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');
  return `BIMA/REQ/${dateStr}-${Math.floor(1000 + Math.random() * 9000)}`;
}

// Drive File Bridge -- untuk upload PDF dan lampiran file ke folder Google Drive
const DRIVE_BRIDGE_URL = "https://script.google.com/macros/s/AKfycbwfq5bqNWx0fO9LuEyQasUzkLP91gA8G-rqRKpPOIJ9r7WNN0G_klH8jXxXhY96ArlC/exec";
const DRIVE_BRIDGE_TOKEN = "bima-2026-x8f2k9";

// Helper kode item (sama persis dengan versi web script.js) -- dipakai buat kolom "Kode Item"
// di report PDF Request.
function groupPrefix(group) {
  if (!group) return 'ITEM';
  const known = {
    consumables: 'CONS', consumable: 'CONS',
    material: 'MAT', materials: 'MAT',
    tools: 'TOOL', tool: 'TOOL',
    heavyequipment: 'HE',
    serviceorder: 'SO'
  };
  const key = String(group).toLowerCase().replace(/\s+/g, '');
  if (known[key]) return known[key];
  const letters = String(group).replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase();
  return letters || 'ITEM';
}
function itemCode(m) {
  return m.ItemID != null ? `${groupPrefix(m.ItemGroup)}-${m.ItemID}` : null;
}


// State Aplikasi
let activeSheet = 'Material';
let activeGroupSheet = 'GroupMaterial';
let rawCategoryData = [];
let currentUser = null;

const RESOURCE_TABLE_MAP = {
  Material: 'material',
  Consumables: 'consumables',
  HeavyEquipment: 'heavyEquipment',
  Tools: 'tools',
  ServiceOrder: 'serviceOrder'
};

document.addEventListener('DOMContentLoaded', () => {
    initAuthSession();
    initCategoryTabs();
    initTableFilters();
    loadCurrentCategory();
    loadRequestTableData();

    // === LOGIKA AUTO SHOW/HIDE DURATION ===
    const reqItemGroup = document.getElementById('reqItemGroup');
    const rowDuration = document.getElementById('rowDuration');

    if (reqItemGroup && rowDuration) {
      reqItemGroup.addEventListener('change', function() {
        const val = this.value.toLowerCase();
        if (val.includes('heavy') || val.includes('equipment') || val.includes('rental') || val.includes('sewa')) {
          rowDuration.style.display = 'flex';
        } else {
          rowDuration.style.display = 'none';
          if (document.getElementById('reqDuration')) {
            document.getElementById('reqDuration').value = '';
          }
        }
      });
    }

    // === LOGIKA AUTO FILTER SPESIFIKASI DARI GROUP (MASTER RESOURCES) ===
    const groupInput = document.getElementById('group');
    if (groupInput) {
      groupInput.addEventListener('input', updateSpecificationOptions);
      groupInput.addEventListener('change', updateSpecificationOptions);
    }
    const specInput = document.getElementById('specification');
    if (specInput) {
      specInput.addEventListener('input', handleSpecificationInput);
      specInput.addEventListener('change', handleSpecificationInput);
    }
});
async function initAuthSession() {
  const savedUser = localStorage.getItem('bima_user');
  if (savedUser) {
    currentUser = JSON.parse(savedUser);
    updateUIAuth();

    // Auto-sync Author & PIC dari database paswordTbl tiap load page,
    // sehingga perubahan di Fusion4 langsung aktif seketika saat refresh tanpa perlu logout.
    try {
      const { data: pasRow } = await supabaseClient
        .from('paswordTbl')
        .select('Author, pic')
        .eq('Id', currentUser.id)
        .maybeSingle();
      if (pasRow) {
        currentUser.Author = pasRow.Author || '';
        currentUser.PIC = pasRow.pic || '';
        const picList = (currentUser.PIC || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const authorStr = (currentUser.Author || '').toLowerCase();
        const isAllAdmin = picList.includes('all') || picList.includes('*') || authorStr.split(',').map(s => s.trim()).includes('all');
        currentUser.canInputMaster = isAllAdmin || picList.includes('input master resources') || picList.includes('mr');
        localStorage.setItem('bima_user', JSON.stringify(currentUser));
        applyMenuAccess();
      }
    } catch (e) {
      console.warn('Auto-sync user access error:', e.message);
    }
  } else {
    currentUser = null;
    updateUIAuth();
    loadUserDropdown(); // Muat daftar user untuk dropdown jika belum login
  }
}

// Fungsi Login (bisa dipanggil dari Form Login)
// Fungsi Login (bisa dipanggil dari Form Login)
async function loginUser(idKaryawan, password) {
  try {
    const { data, error } = await supabaseClient.rpc('verify_login', {
      p_id: idKaryawan,
      p_password: password
    });
    if (error) throw error;

    if (data && data.length > 0) {
      const userRow = data[0];                    // <-- ditambahin
      const authorStr = userRow.author || '';
      const picStr = userRow.pic || '';
      const picList = picStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const isAllAdmin = picList.includes('all') || picList.includes('*') || (authorStr.toLowerCase().split(',').map(s => s.trim()).includes('all'));

      currentUser = {
        id: userRow.id,
        nama: userRow.nama,
        kualifikasi: userRow.kualifikasi,
        Author: authorStr,
        PIC: picStr,
        canInputMaster: isAllAdmin || picList.includes('input master resources') || picList.includes('mr')
      };

      // Ambil QrCodeId terpisah dari karyawanTbl -- dipakai buat QR tanda tangan digital di
      // report PDF Request. Query langsung ke tabel (bukan lewat verify_login) biar gak perlu
      // ubah RPC login yang udah jalan.
      try {
        const { data: karRow } = await supabaseClient.from('karyawanTbl').select('QrCodeId').eq('Id', userRow.id).maybeSingle();
        currentUser.qrCodeId = karRow ? (karRow.QrCodeId || '') : '';
      } catch (qrErr) {
        console.warn('Gagal ambil QrCodeId:', qrErr.message);
        currentUser.qrCodeId = '';
      }

      localStorage.setItem('bima_user', JSON.stringify(currentUser));
      updateUIAuth();
      showToast(`Selamat datang, ${currentUser.nama} (${currentUser.kualifikasi})!`, 'success');
      loadCurrentCategory();
      return true;
    } else {
      showToast("Login Gagal: ID atau Password salah.", 'error');
      return false;
    }
  } catch (error) {
    console.error("Error login:", error);
    showToast("Terjadi kesalahan koneksi saat login.", 'error');
    return false;
  }
}

// Logout User
function logoutUser() {
  localStorage.removeItem('bima_user');
  currentUser = null;
  //alert("Anda telah keluar.");
  window.location.reload();
}

// Endpoint Gmail API (Apps Script) khusus untuk pengiriman Email Notifikasi RFQ ke Vendor & HO Admin
const RFQ_EMAIL_URL = "https://script.google.com/macros/s/AKfycbww8VikG_wpAvQro1-9vLC_llnvKFigFotzKXS-T_kaIHKA4q2QGbYXqZObEF5j_1Hr/exec";
const HO_EMAIL = "rovan.syahriza@gmail.com";

// 1. Load User Dropdown via Supabase RPC get_active_karyawan
async function loadUserDropdown() {
  const selectEl = document.getElementById('loginId');
  if (!selectEl) return;

  try {
    const { data, error } = await supabaseClient.rpc('get_active_karyawan');
    if (error) throw error;

    selectEl.innerHTML = '<option value="">-- Pilih Nama Karyawan --</option>';

    if (Array.isArray(data) && data.length > 0) {
      data.forEach(user => {
        const option = document.createElement('option');
        option.value = String(user.id).trim();
        option.textContent = `${String(user.nama).trim()} (ID: ${String(user.id).trim()})`;
        selectEl.appendChild(option);
      });
    } else {
      selectEl.innerHTML = '<option value="">Daftar user kosong</option>';
    }
  } catch (error) {
    console.error("Error loadUserDropdown:", error);
    selectEl.innerHTML = '<option value="">Gagal koneksi ke server</option>';
  }
}

function updateUIAuth() {
  const formCard = document.querySelector('.form-card');
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
            <span class="user-card-role">${currentUser.kualifikasi || currentUser.PIC || 'User'}</span>
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
    
      applyMenuAccess(); 

    if (formCard) {
      formCard.style.display = currentUser.canInputMaster ? 'block' : 'none';
    }
  } else {
    if (loginModal) loginModal.style.display = 'flex';
    if (formCard) formCard.style.display = 'none';
  }
}

// Event Handler Form Login Modal
document.getElementById('formLogin')?.addEventListener('submit', async function(e) {
  e.preventDefault();
  const id = document.getElementById('loginId').value;
  const pass = document.getElementById('loginPass').value;
  const btn = document.getElementById('btnLoginSubmit');

  btn.textContent = 'Memverifikasi...';
  btn.disabled = true;

  const success = await loginUser(id, pass);
  btn.textContent = 'Masuk Aplikasi';
  btn.disabled = false;

  if (success) {
    document.getElementById('formLogin').reset();
  }
});

// ==========================================
// 2. KATEGORI & TABLE MANAGEMENT
// ==========================================
function initCategoryTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      tabs.forEach(t => t.classList.remove('active'));
      e.target.classList.add('active');

      activeSheet = e.target.getAttribute('data-sheet');
      activeGroupSheet = e.target.getAttribute('data-group');

      // Update Judul UI
      const formTitle = document.getElementById('formTitle');
      const tableTitle = document.getElementById('tableTitle');
      
      if (formTitle) formTitle.textContent = `+ Input Master ${e.target.textContent} Baru`;
      if (tableTitle) tableTitle.textContent = `List Master Data ${e.target.textContent}`;
      
      const searchInput = document.getElementById('globalSearch');
      if (searchInput) searchInput.value = '';

      resetForm();
      loadCurrentCategory();
    });
  });
}

async function loadCurrentCategory() {
  await loadCategoryData();
}

// #1 - loadGroupOptions()
function loadGroupOptions() {
  const datalist = document.getElementById('groupOptions');
  if (!datalist) return;
  datalist.innerHTML = '';

  const seen = new Set();
  (rawCategoryData || []).forEach(item => {
    const groupName = item.Group || item.GroupName || item.Name;
    if (groupName && !seen.has(groupName)) {
      seen.add(groupName);
      const option = document.createElement('option');
      option.value = String(groupName).trim();
      datalist.appendChild(option);
    }
  });
}

async function loadCategoryData() {
  const tbody = document.getElementById('tabelStok');
  if (!tbody) return;
  
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Memuat data...</td></tr>';

  try {
    const tableName = RESOURCE_TABLE_MAP[activeSheet];
    const { data, error } = await supabaseClient.from(tableName).select('*');
    if (error) throw error;

    rawCategoryData = Array.isArray(data) ? data : [];
    loadGroupOptions();
    applyFilters();
    updateSpecificationOptions();
  } catch (error) {
    console.error('Error:', error);
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color: red;">Gagal memuat data.</td></tr>';
  }
}

// #3 - updateSpecificationOptions & handleSpecificationInput
function updateSpecificationOptions() {
  const datalist = document.getElementById('specificationOptions');
  if (!datalist) return;
  datalist.innerHTML = '';

  const groupInput = document.getElementById('group');
  const selectedGroup = (groupInput ? groupInput.value : '').trim().toLowerCase();

  const seen = new Set();
  (rawCategoryData || []).forEach(item => {
    const itemGroup = (item.Group || item.GroupName || '').trim().toLowerCase();
    const spec = (item.Specification || '').trim();

    // Jika kelompok (Group) sudah dipilih/diketik, filter spesifikasi dari kelompok tsb.
    // Jika belum dipilih, tampilkan semua spesifikasi yang ada di kategori aktif.
    const isMatchedGroup = !selectedGroup || itemGroup === selectedGroup || itemGroup.includes(selectedGroup);
    if (spec && isMatchedGroup && !seen.has(spec)) {
      seen.add(spec);
      const option = document.createElement('option');
      option.value = spec;
      datalist.appendChild(option);
    }
  });
}

function handleSpecificationInput(e) {
  const specVal = (e.target.value || '').trim().toLowerCase();
  if (!specVal) return;

  const groupInput = document.getElementById('group');
  const groupVal = (groupInput ? groupInput.value : '').trim().toLowerCase();

  const matched = (rawCategoryData || []).find(item => {
    const g = (item.Group || item.GroupName || '').trim().toLowerCase();
    const s = (item.Specification || '').trim().toLowerCase();
    return s === specVal && (!groupVal || g === groupVal || g.includes(groupVal));
  });

  if (matched) {
    const sizeInput = document.getElementById('size');
    const unitInput = document.getElementById('unit');
    if (sizeInput && !sizeInput.value && matched.Size) {
      sizeInput.value = matched.Size;
    }
    if (unitInput && !unitInput.value && matched.Unit) {
      unitInput.value = matched.Unit;
    }
    if (groupInput && !groupInput.value && (matched.Group || matched.GroupName)) {
      groupInput.value = matched.Group || matched.GroupName;
    }
  }
}

// Global Live Search Filter
function initTableFilters() {
  document.getElementById('globalSearch')?.addEventListener('input', applyFilters);
}

function applyFilters() {
  const query = (document.getElementById('globalSearch')?.value || '').toLowerCase().trim();

  if (!query) {
    renderFilteredTable(rawCategoryData);
    return;
  }

  const filteredData = rawCategoryData.filter(item => {
    const group = (item.Group || '').toLowerCase();
    const spec = (item.Specification || '').toLowerCase();
    const size = (item.Size || '').toLowerCase();
    return group.includes(query) || spec.includes(query) || size.includes(query);
  });

  renderFilteredTable(filteredData);
}

function renderFilteredTable(data) {
  const tbody = document.getElementById('tabelStok');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color: #777;">Tidak ada data yang ditemukan.</td></tr>';
    document.getElementById('totalCount').textContent = '0 Items';
    return;
  }

  document.getElementById('totalCount').textContent = `${data.length} Items`;
  data.forEach(item => renderRowToTable(item));
}

function renderRowToTable(item) {
  const tbody = document.getElementById('tabelStok');
  const tr = document.createElement('tr');
  tr.setAttribute('id', `row-${item.ID}`);
  
  const canEdit = currentUser && currentUser.canInputMaster;

  const actionButtonsHtml = canEdit ? `
    <td style="text-align: center;">
      <div class="action-btns">
        <button class="btn-icon btn-icon-edit" title="Edit Data" onclick="startEdit('${item.ID}', '${escapeHtml(item.Group)}', '${escapeHtml(item.Specification)}', '${escapeHtml(item.Size)}', '${escapeHtml(item.Unit)}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
        <button class="btn-icon btn-icon-delete" title="Hapus Data" onclick="deleteItem('${item.ID}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    </td>
  ` : `<td style="text-align: center; color: #aaa;">-</td>`;

  tr.innerHTML = `
    <td><strong>${item.ID}</strong></td>
    <td><strong>${item.Group || '-'}</strong></td>
    <td>${item.Specification || '-'}</td>
    <td>${item.Size || '-'}</td>
    <td><span class="badge-unit">${item.Unit || '-'}</span></td>
    ${actionButtonsHtml}
  `;
  tbody.appendChild(tr);
}

// ==========================================
// 3. OPERASI CRUD FORM MASTER DATA
// ==========================================
document.getElementById('formStok')?.addEventListener('submit', async function(e) {
  e.preventDefault();

  if (!currentUser || !currentUser.canInputMaster) {
    alert("Anda tidak memiliki hak akses untuk menambah/mengubah data master.");
    return;
  }

  const editId = document.getElementById('editId').value;
  const btn = document.getElementById('btnSubmit');
  const isEditMode = Boolean(editId);

  btn.textContent = isEditMode ? 'Menyimpan...' : 'Menambahkan...';
  btn.disabled = true;

      const itemData = {
        Group: document.getElementById('group').value,
        Specification: document.getElementById('specification').value,
        Size: document.getElementById('size').value,
        Unit: document.getElementById('unit').value
      };

      try {
        const tableName = RESOURCE_TABLE_MAP[activeSheet];
        let error;
        if (isEditMode) {
          ({ error } = await supabaseClient.from(tableName).update(itemData).eq('ID', editId));
        } else {
          ({ error } = await supabaseClient.from(tableName).insert(itemData));
        }
        if (error) throw error;

        showToast(`Data ${activeSheet} berhasil disimpan!`, 'success');
        resetForm();
        loadCategoryData();
      } catch (error) {
        showToast('Gagal: ' + error.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });

function startEdit(id, group, spec, size, unit) {
  if (!currentUser || !currentUser.canInputMaster) return;

  document.getElementById('editId').value = id;
  document.getElementById('group').value = group;
  updateSpecificationOptions();
  document.getElementById('specification').value = spec;
  document.getElementById('size').value = size;
  document.getElementById('unit').value = unit;

  document.getElementById('btnSubmit').textContent = 'Simpan Perubahan';
  document.getElementById('btnCancel').style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.getElementById('btnCancel')?.addEventListener('click', resetForm);

function resetForm() {
  const form = document.getElementById('formStok');
  if (form) form.reset();
  
  const editId = document.getElementById('editId');
  if (editId) editId.value = '';
  
  const btnSubmit = document.getElementById('btnSubmit');
  if (btnSubmit) btnSubmit.textContent = `Tambah Master Item`;
  
  const btnCancel = document.getElementById('btnCancel');
  if (btnCancel) btnCancel.style.display = 'none';

  updateSpecificationOptions();
}

async function deleteItem(id) {
  if (!currentUser || !currentUser.canInputMaster) {
    showToast("Anda tidak memiliki hak akses untuk menghapus data master.", 'error');
    return;
  }

  if (!confirm(`Apakah Anda yakin ingin menghapus data dengan ID ${id} dari ${activeSheet}?`)) return;

  try {
    const tableName = RESOURCE_TABLE_MAP[activeSheet];
    const { error } = await supabaseClient.from(tableName).delete().eq('ID', id);
    if (error) throw error;

    loadCategoryData();
  } catch (error) {
    showToast('Gagal menghapus: ' + error.message, 'error');
  }
}

function escapeHtml(str) {
  return (str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// Function Switch Navigasi Section Sidebar (SPA)
function switchMainSection(sectionId, btnEl) {
  document.querySelectorAll('.sidebar-nav-btn').forEach(btn => btn.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');

  document.querySelectorAll('.app-section').forEach(sec => sec.style.display = 'none');
  const targetSection = document.getElementById(sectionId);
  if (targetSection) {
    targetSection.style.display = 'flex';
  }

  if (sectionId === 'sec-approval') {
    loadApprovalList();
  }

  if (sectionId === 'sec-vendor') {
    loadVendorList();
  }
}

// ==========================================
// LOGIKA MODUL MATERIAL REQUEST
// ==========================================

// Auto-populate datalist item saat kategori diubah
let currentMasterItemsCache = [];

const masterItemsCacheByGroup = {};

function addRequestRow() {
  const tbody = document.getElementById('datasheetBody');
  if (!tbody) return;

  const rowId = Date.now() + Math.floor(Math.random() * 1000);
  const controlStyle = "width:100%; padding:6px 8px; border-radius:8px; border:1px solid #DCD7CF; background:#fff; font-size:12.5px; box-sizing:border-box;";

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>
      <select class="row-group" onchange="loadItemOptionsForRow(this)" style="${controlStyle}">
        <option value="Consumables">Consumables</option>
        <option value="Material">Material</option>
        <option value="HeavyEquipment">Heavy Equipment</option>
        <option value="Tools">Tools</option>
        <option value="ServiceOrder">Service Order</option>
      </select>
    </td>
    <td>
      <input type="text" class="row-spec" list="rowOptions_${rowId}" placeholder="Ketik untuk mencari item..." autocomplete="off" oninput="autoFillRowUnit(this)" style="${controlStyle}">
      <datalist id="rowOptions_${rowId}"></datalist>
    </td>
    <td><input type="number" class="row-qty" min="1" placeholder="0" required style="${controlStyle}"></td>
    <td><input type="text" class="row-unit" placeholder="ea" style="${controlStyle}"></td>
    <td><input type="number" class="row-duration" min="1" placeholder="-" style="${controlStyle}"></td>
    <td>
      <select class="row-durunit" style="${controlStyle}">
        <option value="">-</option>
        <option value="Bulan">Bulan</option>
        <option value="Hari">Hari</option>
        <option value="Minggu">Minggu</option>
        <option value="Jam">Jam</option>
      </select>
    </td>
    <td style="text-align:center;">
      <button type="button" onclick="this.closest('tr').remove()" class="btn-icon btn-icon-delete" title="Hapus Baris">✕</button>
    </td>
  `;
  tbody.appendChild(tr);
  loadItemOptionsForRow(tr.querySelector('.row-group'));
}

async function loadItemOptionsForRow(selectEl) {
  const tr = selectEl.closest('tr');
  const datalist = tr.querySelector('datalist');
  const specInput = tr.querySelector('.row-spec');
  if (!datalist) return;

  const group = selectEl.value;
  datalist.innerHTML = '';
  if (specInput) specInput.value = '';

  // #5 - loadItemOptionsForRow (ganti bagian try-nya)
  try {
    if (!masterItemsCacheByGroup[group]) {
      const tableName = RESOURCE_TABLE_MAP[group];
      const { data, error } = await supabaseClient.from(tableName).select('*');
      if (error) throw error;
      masterItemsCacheByGroup[group] = Array.isArray(data) ? data : [];
    }

    masterItemsCacheByGroup[group].forEach(item => {
      const groupName = item.Group || item.GroupName || '';
      const spec = item.Specification || '';
      const size = item.Size ? ` (${item.Size})` : '';
      const displayText = `${groupName ? '[' + groupName + '] ' : ''}${spec}${size}`.trim();

      const option = document.createElement('option');
      option.value = displayText;
      option.setAttribute('data-unit', item.Unit || '');
      datalist.appendChild(option);
    });
  } catch (err) {
    console.error(`Gagal muat item untuk group ${group}:`, err);
  }
}

function autoFillRowUnit(specInput) {
  const tr = specInput.closest('tr');
  const group = tr.querySelector('.row-group')?.value;
  const unitInput = tr.querySelector('.row-unit');
  if (!unitInput || !masterItemsCacheByGroup[group]) return;

  const matchedItem = masterItemsCacheByGroup[group].find(item => {
    const groupName = item.Group || item.GroupName || '';
    const spec = item.Specification || '';
    const size = item.Size ? ` (${item.Size})` : '';
    const displayText = `${groupName ? '[' + groupName + '] ' : ''}${spec}${size}`.trim();
    return displayText === specInput.value;
  });

  if (matchedItem && matchedItem.Unit) {
    unitInput.value = matchedItem.Unit;
  }
}

function findMatchedCatalogItem(tr) {
  const group = tr.querySelector('.row-group')?.value;
  const specInput = tr.querySelector('.row-spec');
  if (!group || !specInput || !masterItemsCacheByGroup[group]) return null;

  return masterItemsCacheByGroup[group].find(item => {
    const groupName = item.Group || item.GroupName || '';
    const spec = item.Specification || '';
    const size = item.Size ? ` (${item.Size})` : '';
    const displayText = `${groupName ? '[' + groupName + '] ' : ''}${spec}${size}`.trim();
    return displayText === specInput.value;
  }) || null;
}

// Auto-fill kolom Satuan (UNIT) saat Item Description dipilih
document.getElementById('reqItemSpec')?.addEventListener('input', function(e) {
  const selectedVal = e.target.value;
  const unitInput = document.getElementById('reqUnit');
  
  if (!unitInput || !selectedVal) return;

  // Cari item yang cocok di cache data
  const matchedItem = currentMasterItemsCache.find(item => {
    const groupName = item.Group || item.GroupName || '';
    const spec = item.Specification || '';
    const size = item.Size ? ` (${item.Size})` : '';
    const displayText = `${groupName ? '[' + groupName + '] ' : ''}${spec}${size}`.trim();
    return displayText === selectedVal;
  });

  if (matchedItem && matchedItem.Unit) {
    unitInput.value = matchedItem.Unit;
  }
});

// Handler Simpan Request Material
async function handleSaveRequest(e) {
  e.preventDefault();
  const btn = document.getElementById('btnSubmitRequest');
  btn.textContent = 'Sending Request...';
  btn.disabled = true;

  const refNo = document.getElementById('reqRefNo').value.trim() || generateRefNo();

  const payload = {
    DATE_REQUEST: new Date().toISOString().split('T')[0],
    PROJECTID: document.getElementById('reqProjectID').value,
    WO_NO: document.getElementById('reqWoNo').value,
    ItemDescription: document.getElementById('reqItemSpec').value,
    QTY: document.getElementById('reqQty').value,
    UNIT: document.getElementById('reqUnit').value,
    Duration: document.getElementById('reqDuration')?.value ? Number(document.getElementById('reqDuration').value) : null,
    DurUnit: document.getElementById('reqDurationUnit') ? document.getElementById('reqDurationUnit').value : '',
    ItemGroup: document.getElementById('reqItemGroup').value,
    Purpose: document.getElementById('reqPurpose').value,
    RefNo: refNo,
    ExpectedDate: document.getElementById('reqExpectedDate').value,
    Status: 'Pending',
    RequestBy: (typeof currentUser !== 'undefined' && currentUser) ? currentUser.nama : 'dummy_user'
  };

  try {
    const { error } = await supabaseClient.from('request').insert([payload]);
    if (error) throw error;

    alert("Request Material berhasil dikirim!");
    document.getElementById('formRequest').reset();
    loadRequestTableData();
  } catch (error) {
    console.error("Submit Error:", error);
    alert("Gagal mengirim request: " + error.message);
  } finally {
    btn.textContent = 'Kirim Request Material';
    btn.disabled = false;
  }
}

async function loadRequestTableData() {
  const tbody = document.getElementById('tabelRequest');
  const countEl = document.getElementById('totalRequestCount');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 20px;">Memuat riwayat request...</td></tr>';

  try {
    // Tembak langsung ke Web App Spreadsheet ResourcesTransaction
// Ambil semua data dari tabel 'request' Supabase
  let { data, error } = await supabaseClient
    .from('request')
    .select('*')
    .order('created_at', { ascending: false }); // Urutkan dari yang terbaru

  if (error) throw error;
  console.log('Data dari Supabase:', data);
  // Variabel 'data' di bawahnya sudah berisi array objek dari Supabase!

    // Filter menghilangkan baris kosong
    data = data.filter(row => {
      const firstVal = String(Object.values(row)[0] || '').toLowerCase();
      return firstVal !== '' && firstVal !== 'id' && firstVal !== 'undefined';
    });

    tbody.innerHTML = '';

    if (data.length > 0) {
      if (countEl) countEl.textContent = `${data.length} Request`;
      
      data.forEach((item, index) => {
        const tr = document.createElement('tr');
        
        const id = item.ID || item.Id || item.id || (index + 1);
        const refNo = item.RefNo || item.REFNO || item.Ref_No || '-';
        const woNo = item.WO_NO || item.WoNo || item.WO || '-';
        const projId = item.PROJECTID || item.ProjectId || item.ProjectID || '-';
        const itemDesc = item.ItemDescription || item.ITEMDESCRIPTION || item.Description || item.Deskripsi || '-';
        const qty = item.QTY || item.Qty || 0;
        const unit = item.UNIT || item.Unit || '';
        const expectedDateRaw = item.ExpectedDate || item.EXPECTEDDATE || item.TglDibutuhkan || '-';
        const status = item.Status || item.STATUS || 'Pending';

        let formattedDate = String(expectedDateRaw);
        if (formattedDate.includes('T')) formattedDate = formattedDate.split('T')[0];
        if (formattedDate.includes(' ')) formattedDate = formattedDate.split(' ')[0];

        const reqNoInfo = (refNo !== '-')
          ? `<strong style="color: #2c3e50;">${refNo}</strong><br><small style="color:#718096;">WO: ${woNo} | Proj: ${projId}</small>`
          : woNo;

        tr.innerHTML = `
          <td><strong>${id}</strong></td>
          <td>${reqNoInfo}</td>
          <td>${itemDesc}</td>
          <td><strong>${qty}</strong> <span class="badge-unit">${unit}</span></td>
          <td>${formattedDate}</td>
          <td style="text-align:center;">
            <span class="badge-unit" style="background:#FFF0EC; color:#E04D23; font-weight:bold; border:1px solid #FFD8CE;">
              ${status}
            </span>
          </td>
        `;
        tbody.appendChild(tr);
      });
    } else {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color: #777; padding: 20px;">Belum ada data pengajuan di RequestTbl.</td></tr>';
      if (countEl) countEl.textContent = '0 Request';
    }
  } catch (error) {
    console.error("Error load RequestTbl:", error);
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color: #E53E3E; padding: 20px;">Gagal memuat riwayat request dari ResourcesTransaction.</td></tr>';
  }
}

// 2. Mengirim Request ke Spreadsheet ResourcesTransaction
async function handleBatchSubmitRequest(e) {
  if (e) e.preventDefault();

  const rows = document.querySelectorAll('#datasheetBody tr');
  if (rows.length === 0) {
    alert("Tambahkan minimal 1 item barang!");
    return;
  }

  const btn = document.getElementById('btnSubmitBatchRequest');
  if (btn) {
    btn.textContent = 'Mengirim Semua Request...';
    btn.disabled = true;
  }

  const headerData = {
    projectId: document.getElementById('reqProjectID')?.value || '',
    woNo: document.getElementById('reqWoNo')?.value || '',
    purpose: document.getElementById('reqPurpose')?.value || '',
    expectedDate: document.getElementById('reqExpectedDate')?.value || null,
    requestBy: (typeof currentUser !== 'undefined' && currentUser) ? currentUser.nama : 'System'
  };

  const itemsPayload = [];
  rows.forEach(tr => {
    const durationVal = tr.querySelector('.row-duration')?.value;
    const matchedItem = findMatchedCatalogItem(tr);   // <-- baris baru
    itemsPayload.push({
      DATE_REQUEST: new Date().toISOString().split('T')[0],
      PROJECTID: headerData.projectId,
      WO_NO: headerData.woNo,
      ItemGroup: tr.querySelector('.row-group')?.value || 'Material',
      ItemID: matchedItem ? matchedItem.ID : null,      // <-- baris baru
      ItemDescription: tr.querySelector('.row-spec')?.value || '',
      QTY: tr.querySelector('.row-qty')?.value || 0,
      UNIT: tr.querySelector('.row-unit')?.value || '',
      Duration: durationVal ? Number(durationVal) : null,
      DurUnit: tr.querySelector('.row-durunit')?.value || '',
      Purpose: headerData.purpose,
      ExpectedDate: headerData.expectedDate,
      Status: 'Menunggu Review',
      RequestBy: headerData.requestBy
    });
  });

  try {
    // tepat setelah dapat generatedRefNo, SEBELUM insert ke tabel request:
    const { data: refData, error: refError } = await supabaseClient.rpc('generate_refno');
    if (refError) throw refError;
    const generatedRefNo = refData;

    const { error: approvalError } = await supabaseClient.from('request_approval').insert({
      RefNo: generatedRefNo,
      ProjectID: headerData.projectId,
      CurrentLevel: 'Review'
    });
    if (approvalError) throw approvalError;

    const payloadToInsert = itemsPayload.map(item => ({ ...item, RefNo: generatedRefNo }));
    const { error } = await supabaseClient.from('request').insert(payloadToInsert);
    if (error) throw error;

    // Generate & upload report PDF -- sama persis alurnya kayak versi web (script.js), dibungkus
    // try/catch sendiri: kalau ini gagal, request-nya TETAP TERKIRIM (udah di-insert di atas),
    // cuma reportnya aja yang gak kebuat.
    try {
      if (btn) btn.textContent = 'Membuat report PDF...';
      const pdfDoc = await generateRequestReportPdf({
        refNo: generatedRefNo,
        woNo: headerData.woNo,
        projectId: headerData.projectId,
        tanggalRequest: new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }),
        diajukanOleh: headerData.requestBy,
        diajukanOlehSub: (currentUser && currentUser.kualifikasi) || '',
        diajukanOlehQr: `QrCodeID=${(currentUser && currentUser.qrCodeId) || ''}|NoTransaksi=${generatedRefNo}`,
        status: 'Menunggu Review',
        keperluan: headerData.purpose,
        items: itemsPayload.map(it => ({ kode: itemCode(it) || (it.ItemGroup || ''), desk: it.ItemDescription, qty: it.QTY, unit: it.UNIT })),
        approvalHistory: [{ tanggal: new Date().toLocaleString('id-ID'), oleh: headerData.requestBy, keterangan: 'Request diajukan' }],
        disetujuiOleh: null,
      });
      const pdfBlob = reportPdfToBlob(pdfDoc);
      const uploadedPdf = await uploadReportPdfToDrive(pdfBlob, `REQ_${generatedRefNo.replace(/\//g, '-')}.pdf`);
      await supabaseClient.from('request').update({ ReportURL: uploadedPdf.directUrl, ReportFileID: uploadedPdf.fileId }).eq('RefNo', generatedRefNo);
    } catch (reportErr) {
      console.warn('Gagal membuat/upload report PDF:', reportErr);
    }

    // Reset Form
    document.getElementById('reqProjectID').value = '';
    document.getElementById('reqWoNo').value = '';
    document.getElementById('reqPurpose').value = '';
    document.getElementById('reqExpectedDate').value = '';
    document.getElementById('reqRefNo').value = '';

    const tbody = document.getElementById('datasheetBody');
    if (tbody) tbody.innerHTML = '';
    addRequestRow();
    loadRequestTableData();

  } catch (err) {
    console.error("Error Supabase:", err);
    alert("Gagal menyimpan data: " + err.message);
  } finally {
    if (btn) {
      btn.textContent = '🚀 Kirim Semua Item Request';
      btn.disabled = false;
    }
  }
}

// Trigger pembacaan opsi master saat section diswitch
const originalSwitchMainSection = window.switchMainSection || function(sectionId, btnEl) {
  document.querySelectorAll('.sidebar-nav-btn').forEach(btn => btn.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');

  document.querySelectorAll('.app-section').forEach(sec => sec.style.display = 'none');
  const targetSection = document.getElementById(sectionId);
  if (targetSection) {
    targetSection.style.display = 'flex';
  }
};

window.switchMainSection = function(sectionId, btnEl) {
  originalSwitchMainSection(sectionId, btnEl);
  
  // Jika buka menu Request, otomatis load opsi dropdown & isi tabel histori
  if (sectionId === 'sec-request') {
    const tbody = document.getElementById('datasheetBody');
    if (tbody && tbody.children.length === 0) addRequestRow();
    loadRequestTableData();
  }

  if (sectionId === 'sec-rfq') { loadRfqCreatePage(); }
};

function applyMenuAccess() {
  const picRaw = String(currentUser?.PIC || '').trim().toUpperCase();
  const authorRaw = String(currentUser?.Author || '').trim().toUpperCase();

  const picTokens = picRaw.split(',').map(s => s.trim()).filter(Boolean);
  const authorTokens = authorRaw.split(',').map(s => s.trim()).filter(Boolean);

  const isSuperAdmin = picTokens.includes('ALL') || picTokens.includes('*') || authorTokens.includes('ALL') || authorTokens.includes('*');

  // Helper matcher (support Inisial Singkat ala Fusion4 + String Legacy Lengkap)
  const matchPic = (...keys) => isSuperAdmin || keys.some(k => picTokens.includes(k.toUpperCase()));
  const matchAuthor = (...keys) => isSuperAdmin || keys.some(k => {
    const ku = k.toUpperCase();
    return authorTokens.some(a => a === ku || a.startsWith(ku + '-') || a.startsWith(ku + ' ') || a.includes(ku));
  });

  // 1. Master Resources (Inisial: MR / Input Master Resources)
  const btnMaster = document.getElementById('btnNavMaster') || document.querySelector('.sidebar-nav-btn[onclick*="sec-master"]');
  if (btnMaster) btnMaster.style.display = (matchPic('MR', 'INPUT MASTER RESOURCES')) ? 'flex' : 'none';

  // 2. Request (Inisial: REQ / Create Request / Review Request)
  const btnReq = document.getElementById('btnNavRequest') || document.querySelector('.sidebar-nav-btn[onclick*="sec-request"]');
  if (btnReq) btnReq.style.display = (matchPic('REQ', 'CREATE REQUEST', 'REVIEW REQUEST') || picTokens.some(t => t.startsWith('REQ-') || t.startsWith('REQUEST '))) ? 'flex' : 'none';

  // 3. Approval Request (Inisial: AR / RR / AR-101 / RR-014 / Approval Request / Review Request)
  const btnApproval = document.getElementById('btnNavApproval');
  if (btnApproval) btnApproval.style.display = (matchAuthor('AR', 'RR', 'APPROVAL REQUEST', 'REVIEW REQUEST') || authorTokens.some(t => t.startsWith('AR-') || t.startsWith('RR-'))) ? 'flex' : 'none';

  // 4. Vendor Pendaftaran (Inisial: AV / RV / Approval Vendor / Review Vendor)
  const btnVendor = document.getElementById('btnNavVendor');
  if (btnVendor) btnVendor.style.display = (matchAuthor('AV', 'RV', 'APPROVAL VENDOR', 'REVIEW VENDOR')) ? 'flex' : 'none';

  // 5. Approval Seleksi Vendor (Inisial: ASV / ASV-101 / Approval Seleksi Vendor)
  const btnApprovalRfq = document.getElementById('btnNavApprovalRfq');
  if (btnApprovalRfq) btnApprovalRfq.style.display = (matchAuthor('ASV', 'APPROVAL SELEKSI VENDOR') || authorTokens.some(t => t.startsWith('ASV-'))) ? 'flex' : 'none';

  // 6. Approval PO/SO (Inisial: APO / APO-101 / Approval PO/SO)
  const btnApprovalPo = document.getElementById('btnNavApprovalPo');
  if (btnApprovalPo) btnApprovalPo.style.display = (matchAuthor('APO', 'APPROVAL PO/SO') || authorTokens.some(t => t.startsWith('APO-'))) ? 'flex' : 'none';

  // 7. Buat RFQ (Inisial: RFQ / Create RFQ)
  const btnRfq = document.getElementById('btnNavRfq') || document.querySelector('.sidebar-nav-btn[onclick*="sec-rfq"]');
  if (btnRfq) btnRfq.style.display = (matchPic('RFQ', 'CREATE RFQ') || matchAuthor('RFQ')) ? 'flex' : 'none';

  // 8. Seleksi Vendor RFQ (Inisial: SVR / SRFQ / Create RFQ)
  const btnSvr = document.getElementById('btnNavRfqSelection') || document.querySelector('.sidebar-nav-btn[onclick*="sec-rfq-selection"]');
  if (btnSvr) btnSvr.style.display = (matchPic('SVR', 'SRFQ', 'CREATE RFQ')) ? 'flex' : 'none';

  // 9. Ajukan PO/SO (Inisial: PO / PO-101 / APO / Create RFQ)
  const btnPoSubmit = document.getElementById('btnNavPoSubmit') || document.querySelector('.sidebar-nav-btn[onclick*="sec-po-submit"]');
  if (btnPoSubmit) btnPoSubmit.style.display = (matchPic('PO', 'APO', 'CREATE RFQ') || picTokens.some(t => t.startsWith('PO-'))) ? 'flex' : 'none';

  // 10. Terima dari Vendor (Inisial: TV / TRV / Terima Vendor)
  const btnTv = document.getElementById('btnNavVendorReceiving') || document.querySelector('.sidebar-nav-btn[onclick*="sec-vendor-receiving"]');
  if (btnTv) btnTv.style.display = (matchPic('TV', 'TRV', 'TERIMA VENDOR')) ? 'flex' : 'none';

  // 11. View Report (Selalu terbuka / atau key VR)
  const btnVr = document.getElementById('btnNavViewReport');
  if (btnVr) btnVr.style.display = 'flex';

  // Otomatis klik tombol aktif pertama jika section aktif tersembunyi
  const visibleButtons = Array.from(document.querySelectorAll('.sidebar-menu .sidebar-nav-btn'))
    .filter(b => b.style.display !== 'none');
  const currentActive = document.querySelector('.sidebar-menu .sidebar-nav-btn.active');
  if (visibleButtons.length > 0 && (!currentActive || currentActive.style.display === 'none')) {
    visibleButtons[0].click();
  }
}

// ==========================================
// VIEW REPORT -- daftar report PDF di semua 6 tahap (Request s/d Terima End User)
// Sengaja belum ada restriksi PIC/akses ("kita set belakangan" -- akses menyusul).
// ==========================================

const VIEW_REPORT_CONFIG = {
  request: {
    title: '📄 Report Request',
    subtitle: 'Daftar transaksi Request beserta link report PDF-nya.',
    countLabel: 'Transaksi Request',
  },
  rfq: {
    title: '📄 Report RFQ',
    subtitle: 'Daftar RFQ yang sudah dikirim ke vendor beserta link report PDF-nya.',
    countLabel: 'RFQ',
  },
  vendorSelection: {
    title: '📄 Report Seleksi Vendor',
    subtitle: 'Daftar RFQ yang sudah diusulkan pemenangnya beserta link report Seleksi Vendor.',
    countLabel: 'Seleksi Vendor',
  },
  poso: {
    title: '📄 Report PO/SO',
    subtitle: 'Daftar Purchase Order / Service Order beserta link report PDF-nya.',
    countLabel: 'PO/SO',
  },
  siteReceiving: {
    title: '📄 Report Site Receiving',
    subtitle: 'Daftar penerimaan barang di site beserta link report PDF-nya.',
    countLabel: 'Site Receiving',
  },
  endUserReceiving: {
    title: '📄 Report End User Receiving',
    subtitle: 'Daftar serah-terima ke end user beserta link report PDF-nya.',
    countLabel: 'End User Receiving',
  },
};

let viewReportState = { category: 'request', rows: [] };

function pickReportDate(r) {
  return r.created_at || r.CreatedAt || r.ManagementApprovalDate || r.DATE_REQUEST || null;
}

async function loadViewReportPage(category, btnEl) {
  document.querySelectorAll('#viewReportTabs .tab-btn').forEach(b => {
    b.classList.toggle('active', btnEl ? b === btnEl : b.getAttribute('data-report-cat') === category);
  });

  const cfg = VIEW_REPORT_CONFIG[category] || {};
  const titleEl = document.getElementById('viewReportTitle');
  const subtitleEl = document.getElementById('viewReportSubtitle');
  if (titleEl) titleEl.textContent = cfg.title || 'Report';
  if (subtitleEl) subtitleEl.textContent = cfg.subtitle || '';

  const tbody = document.getElementById('viewReportTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#777;">Memuat data...</td></tr>';
  const searchEl = document.getElementById('viewReportSearch');
  if (searchEl) searchEl.value = '';

  try {
    let rows = [];

    if (category === 'request') {
      const { data, error } = await supabaseClient.from('request').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      const seen = new Set();
      (data || []).forEach(r => {
        if (!r.RefNo || seen.has(r.RefNo)) return;
        seen.add(r.RefNo);
        rows.push({ noTransaksi: r.RefNo, tanggal: r.DATE_REQUEST || pickReportDate(r), keterangan: r.Status || '-', reportUrl: r.ReportURL });
      });

    } else if (category === 'rfq') {
      const { data, error } = await supabaseClient.from('rfq').select('*').order('RFQID', { ascending: false });
      if (error) throw error;
      rows = (data || []).map(r => ({
        noTransaksi: r.NoRFQ, tanggal: pickReportDate(r),
        keterangan: r.CreatedBy ? `Dibuat oleh ${r.CreatedBy}` : '-',
        reportUrl: r.ReportURL,
      }));

    } else if (category === 'vendorSelection') {
      const { data, error } = await supabaseClient.from('rfq').select('*').order('RFQID', { ascending: false });
      if (error) throw error;
      rows = (data || [])
        .filter(r => r.SelectionReportURL)
        .map(r => ({ noTransaksi: r.NoRFQ, tanggal: pickReportDate(r), keterangan: 'Seleksi Vendor diusulkan', reportUrl: r.SelectionReportURL }));

    } else if (category === 'poso') {
      const { data, error } = await supabaseClient.from('purchaseOrder').select('*').order('POID', { ascending: false });
      if (error) throw error;
      rows = (data || []).map(r => ({
        noTransaksi: r.DocNumber, tanggal: pickReportDate(r),
        keterangan: r.DocType || '-', reportUrl: r.ReportURL,
      }));

    } else if (category === 'siteReceiving' || category === 'endUserReceiving') {
      const { data, error } = await supabaseClient.from(category).select('*').order('created_at', { ascending: false });
      if (error) throw error;
      const seen = new Set();
      (data || []).forEach(r => {
        if (!r.NoTransaksi || seen.has(r.NoTransaksi)) return;
        seen.add(r.NoTransaksi);
        rows.push({ noTransaksi: r.NoTransaksi, tanggal: pickReportDate(r), keterangan: r.LokasiNama || '-', reportUrl: r.ReportURL });
      });
    }

    viewReportState = { category, rows };
    renderViewReportTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:red;">Gagal memuat data: ${err.message}</td></tr>`;
  }
}

function renderViewReportTable() {
  const { rows, category } = viewReportState;
  const tbody = document.getElementById('viewReportTableBody');
  const countEl = document.getElementById('viewReportCount');
  if (!tbody) return;
  const keyword = (document.getElementById('viewReportSearch')?.value || '').toLowerCase().trim();
  const cfg = VIEW_REPORT_CONFIG[category] || {};

  const filtered = (rows || []).filter(r => !keyword || String(r.noTransaksi || '').toLowerCase().includes(keyword));

  if (countEl) countEl.textContent = `${filtered.length} ${cfg.countLabel || 'Transaksi'}`;

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#777;">Belum ada data.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(r => {
    let tgl = r.tanggal || '-';
    if (typeof tgl === 'string' && tgl.includes('T')) tgl = tgl.split('T')[0];
    let reportCell = '';
    if (category === 'request') {
      reportCell = `
        <div style="display:inline-flex; gap:6px; align-items:center;">
          ${r.reportUrl ? `<a href="${r.reportUrl}" target="_blank" rel="noopener" class="btn-logout-card" style="display:inline-flex;">📄 Lihat Report</a>` : `<span class="badge-unit" style="background:#F1EEE9;color:#a09a92;">Belum ada</span>`}
          <button type="button" class="btn-icon" onclick="regenerateRequestReport('${r.noTransaksi}', this)" title="Refresh / Generate Ulang PDF Report" style="padding:4px 8px; font-size:12px; border-radius:6px; background:#f4efe9; border:1px solid #dcd8cc; cursor:pointer;">🔄</button>
        </div>
      `;
    } else {
      reportCell = r.reportUrl
        ? `<a href="${r.reportUrl}" target="_blank" rel="noopener" class="btn-logout-card" style="display:inline-flex;">📄 Lihat Report</a>`
        : `<span class="badge-unit" style="background:#F1EEE9;color:#a09a92;">Belum ada</span>`;
    }
    return `
      <tr>
        <td><strong>${r.noTransaksi || '-'}</strong></td>
        <td>${tgl}</td>
        <td>${r.keterangan || '-'}</td>
        <td style="text-align:center;">${reportCell}</td>
      </tr>`;
  }).join('');
}

async function regenerateRequestReport(refno, btnEl) {
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = '⏳'; }
  try {
    showToast(`Meng-update PDF report untuk ${refno}...`, 'info');
    const uploaded = await refreshRequestReportPdf(refno);
    if (uploaded && uploaded.directUrl) {
      showToast(`PDF report ${refno} berhasil di-refresh!`, 'success');
      loadViewReportPage('request');
    } else {
      showToast(`Gagal update PDF report ${refno}.`, 'error');
    }
  } catch (e) {
    showToast(`Error: ${e.message}`, 'error');
  } finally {
    if (btnEl) { btnEl.disabled = false; btnEl.textContent = '🔄'; }
  }
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

async function loadApprovalList() {
  const tbody = document.getElementById('approvalTableBody');
  if (!tbody || !currentUser) return;
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">Memuat data approval...</td></tr>';

  try {
    // 1. Ambil data request_approval aktif (level Review atau Approval)
    const { data: apprList, error: apprErr } = await supabaseClient
      .from('request_approval')
      .select('*')
      .in('CurrentLevel', ['Review', 'Approval', 'review', 'approval'])
      .order('CreatedAt', { ascending: false });

    if (apprErr) throw apprErr;

    if (!apprList || apprList.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:#777;">Tidak ada Request yang menunggu approval.</td></tr>';
      return;
    }

    // 2. Ambil detail dari tabel request untuk data header (RefNo, WO, Purpose, RequestBy, Tanggal)
    const refNos = apprList.map(a => a.RefNo).filter(Boolean);
    const { data: reqList, error: reqErr } = await supabaseClient
      .from('request')
      .select('RefNo, PROJECTID, WO_NO, Purpose, RequestBy, DATE_REQUEST')
      .in('RefNo', refNos);

    if (reqErr) throw reqErr;

    // 3. Evaluasi Author dan PIC user saat ini
    const authorRaw = String(currentUser.Author || '').toUpperCase();
    const picRaw = String(currentUser.PIC || '').toUpperCase();
    const userTokens = [...authorRaw.split(','), ...picRaw.split(',')].map(s => s.trim()).filter(Boolean);
    const isSuperAdmin = userTokens.includes('ALL') || userTokens.includes('*');

    // 4. Filter item yang sesuai hak akses user
    const pendingList = apprList.filter(appr => {
      const proj = String(appr.ProjectID || '').trim();
      const projClean = proj.replace(/^0+/, ''); // misal: '014' -> '14'
      const lvl = String(appr.CurrentLevel || '').trim().toLowerCase();

      if (lvl === 'review') {
        if (isSuperAdmin) return true;
        return userTokens.some(t =>
          t === 'RR' || t === 'REVIEW REQUEST' ||
          t === 'RR-' + proj || (projClean && t === 'RR-' + projClean) ||
          t === 'REVIEW REQUEST ' + proj || (projClean && t === 'REVIEW REQUEST ' + projClean) ||
          (t.startsWith('RR-') && (t.endsWith(proj) || (projClean && t.endsWith(projClean)))) ||
          (t.startsWith('REVIEW REQUEST') && (t.includes(proj) || (projClean && t.includes(projClean))))
        );
      } else if (lvl === 'approval') {
        if (isSuperAdmin) return true;
        return userTokens.some(t =>
          t === 'AR' || t === 'APPROVAL REQUEST' ||
          t === 'AR-' + proj || (projClean && t === 'AR-' + projClean) ||
          t === 'APPROVAL REQUEST ' + proj || (projClean && t === 'APPROVAL REQUEST ' + projClean) ||
          (t.startsWith('AR-') && (t.endsWith(proj) || (projClean && t.endsWith(projClean)))) ||
          (t.startsWith('APPROVAL REQUEST') && (t.includes(proj) || (projClean && t.includes(projClean))))
        );
      }
      return false;
    }).map(appr => {
      const matchedReq = (reqList || []).find(r => r.RefNo === appr.RefNo) || {};
      return {
        refno: appr.RefNo,
        projectid: appr.ProjectID || matchedReq.PROJECTID || '-',
        currentlevel: appr.CurrentLevel,
        wo_no: matchedReq.WO_NO || '-',
        purpose: matchedReq.Purpose || '-',
        requestby: matchedReq.RequestBy || '-',
        daterequest: matchedReq.DATE_REQUEST || (appr.CreatedAt ? appr.CreatedAt.split('T')[0] : '-')
      };
    });

    if (pendingList.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:#777;">Tidak ada Request yang menunggu approval kamu.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    pendingList.forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <button class="btn-icon btn-toggle-detail" onclick="toggleApprovalDetail('${row.refno}', this)" title="Lihat Detail" style="margin-right:8px; background:#f2ede8; border:1px solid #ddd; border-radius:6px; cursor:pointer; font-size:16px; width:28px; height:28px; line-height:1; color:#e8562c; font-weight:700;">▸</button>
          <strong>${row.refno}</strong>
        </td>
        <td>${row.projectid || '-'}</td>
        <td>${row.wo_no || '-'}</td>
        <td>${row.purpose || '-'}</td>
        <td>${row.requestby || '-'}</td>
        <td>${row.daterequest || '-'}</td>
        <td><span class="badge-unit" style="background:#eef5fc; color:#1d6fa5; font-weight:600;">${row.currentlevel}</span></td>
        <td>
          <button class="btn-icon btn-icon-edit" onclick="approveRequest('${row.refno}')" title="Setujui">✔</button>
          <button class="btn-icon btn-icon-delete" onclick="rejectRequest('${row.refno}')" title="Tolak">✕</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Gagal memuat approval:', err);
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; color:red;">Gagal memuat data: ${err.message}</td></tr>`;
  }
}

async function approveRequest(refno) {
  if (!confirm(`Setujui Request ${refno}?`)) return;
  try {
    let rpcSuccess = false;
    let isReviewLevel = false;

    const { data: currAppr } = await supabaseClient.from('request_approval').select('*').eq('RefNo', refno).maybeSingle();
    if (!currAppr) throw new Error('Data request approval tidak ditemukan.');
    isReviewLevel = String(currAppr.CurrentLevel || '').toLowerCase() === 'review';

    try {
      const { error: rpcErr } = await supabaseClient.rpc('process_approval', {
        p_refno: refno, p_karyawan_id: currentUser.id, p_decision: 'Approve', p_reason: null
      });
      if (!rpcErr) rpcSuccess = true;
    } catch (e) {
      console.warn('RPC process_approval fallback to direct table update:', e);
    }

    if (!rpcSuccess) {
      if (isReviewLevel) {
        await supabaseClient.from('request_approval').update({
          CurrentLevel: 'Approval',
          ReviewedBy: String(currentUser.id),
          ReviewedAt: new Date().toISOString()
        }).eq('RefNo', refno);
        await supabaseClient.from('request').update({
          Status: 'Menunggu Approval Direktur'
        }).eq('RefNo', refno);
      } else {
        await supabaseClient.from('request_approval').update({
          CurrentLevel: 'Approved',
          ApprovedBy: String(currentUser.id),
          ApprovedAt: new Date().toISOString()
        }).eq('RefNo', refno);
        await supabaseClient.from('request').update({
          Status: 'Disetujui'
        }).eq('RefNo', refno);
      }
    }

    const nextStatus = isReviewLevel ? 'Menunggu Approval Direktur' : 'Disetujui';
    refreshRequestReportPdf(refno, nextStatus).catch(e => console.warn('Gagal refresh PDF request report:', e));

    showToast(`Request ${refno} berhasil disetujui!`, 'success');
    loadApprovalList();
  } catch (err) {
    showToast('Gagal: ' + err.message, 'error');
  }
}

async function rejectRequest(refno) {
  const reason = prompt(`Alasan penolakan Request ${refno}:`);
  if (reason === null) return;
  if (!reason.trim()) {
    alert('Harap masukkan alasan penolakan.');
    return;
  }
  try {
    let rpcSuccess = false;
    try {
      const { error: rpcErr } = await supabaseClient.rpc('process_approval', {
        p_refno: refno, p_karyawan_id: currentUser.id, p_decision: 'Reject', p_reason: reason
      });
      if (!rpcErr) rpcSuccess = true;
    } catch (e) {
      console.warn('RPC process_approval fallback to direct table update:', e);
    }

    if (!rpcSuccess) {
      await supabaseClient.from('request_approval').update({
        CurrentLevel: 'Rejected',
        RejectedBy: String(currentUser.id),
        RejectedAt: new Date().toISOString(),
        RejectReason: reason
      }).eq('RefNo', refno);
      await supabaseClient.from('request').update({
        Status: 'Ditolak'
      }).eq('RefNo', refno);
    }

    refreshRequestReportPdf(refno, 'Ditolak').catch(e => console.warn('Gagal refresh PDF request report:', e));

    showToast(`Request ${refno} ditolak.`, 'success');
    loadApprovalList();
  } catch (err) {
    showToast('Gagal: ' + err.message, 'error');
  }
}

async function toggleApprovalDetail(refno, btnEl) {
  const mainRow = btnEl.closest('tr');
  const nextRow = mainRow.nextElementSibling;

  if (nextRow && nextRow.classList.contains('detail-row')) {
    nextRow.remove();
    btnEl.textContent = '▸';
    return;
  }

  document.querySelectorAll('.detail-row').forEach(r => r.remove());
  document.querySelectorAll('.btn-toggle-detail').forEach(b => b.textContent = '▸');
  btnEl.textContent = '▾';

  const detailRow = document.createElement('tr');
  detailRow.className = 'detail-row';
  detailRow.innerHTML = `<td colspan="8" style="background:#faf8f5; padding:12px 24px;">Memuat detail item...</td>`;
  mainRow.after(detailRow);

  try {
    const { data, error } = await supabaseClient
      .from('request')
      .select('*')
      .eq('RefNo', refno);
    if (error) throw error;

    if (!data || data.length === 0) {
      detailRow.innerHTML = `<td colspan="8" style="text-align:center; color:#777;">Tidak ada detail item.</td>`;
      return;
    }

    const rowsHtml = data.map(item => `
      <tr>
        <td>${item.ItemGroup || '-'}</td>
        <td>${item.ItemDescription || '-'}</td>
        <td>${item.QTY ?? '-'}</td>
        <td>${item.UNIT || '-'}</td>
      </tr>
    `).join('');

    detailRow.innerHTML = `
      <td colspan="8" style="background:#faf8f5; padding:12px 24px;">
        <table class="data-table" style="width:100%; margin:0;">
          <thead>
            <tr><th>Kategori</th><th>Deskripsi Item</th><th>Qty</th><th>Unit</th></tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </td>
    `;
  } catch (err) {
    console.error('Gagal load detail item:', err);
    detailRow.innerHTML = `<td colspan="8" style="text-align:center; color:red;">Gagal memuat detail: ${err.message}</td>`;
  }
}

async function loadVendorList() {
  const tbody = document.getElementById('vendorTableBody');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Memuat data...</td></tr>';
  try {
    const { data, error } = await supabaseClient.rpc('get_pending_vendor_approvals', { p_karyawan_id: currentUser.id });
    if (error) throw error;

    if (!data || data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Tidak ada vendor menunggu approval.</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    data.forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${row.vendorname || '-'}</strong></td>
        <td>${row.catagory || '-'}</td>
        <td>${row.contactno || '-'}</td>
        <td>${row.email || '-'}</td>
        <td>${row.status}</td>
        <td>
          <button class="btn-icon btn-icon-edit" onclick="approveVendor(${row.vendorid})" title="Setujui">✓</button>
          <button class="btn-icon btn-icon-delete" onclick="rejectVendor(${row.vendorid})" title="Tolak">X</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Gagal memuat vendor:', err);
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:red;">Gagal memuat data: ${err.message}</td></tr>`;
  }
}

async function approveVendor(vendorId) {
  if (!confirm('Setujui vendor ini?')) return;
  try {
    const { error } = await supabaseClient.rpc('process_vendor_approval', {
      p_vendor_id: vendorId, p_karyawan_id: currentUser.id, p_decision: 'Approve'
    });
    if (error) throw error;
    showToast('Vendor berhasil diproses', 'success');
    loadVendorList();
  } catch (err) {
    showToast('Gagal memproses vendor: ' + err.message, 'error');
  }
}

let rfqRequestData = [];
let rfqVendorData = [];
let selectedRequestIds = new Set();
let selectedVendorIds = new Set();

async function loadRfqCreatePage() {
  const reqBody = document.getElementById('rfqRequestTableBody');
  const venBody = document.getElementById('rfqVendorTableBody');
  reqBody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Memuat data...</td></tr>';
  venBody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Memuat data...</td></tr>';
  selectedRequestIds = new Set();
  selectedVendorIds = new Set();
  try {
  const [
    { data: reqData, error: reqErr },
    { data: venData, error: venErr },
    { data: detailData, error: detErr },
    { data: rfqVenData, error: rfqVenErr },
    { data: rfqHeaderData, error: rfqHeaderErr },
    { data: allVendorData, error: allVenErr },
    { data: rfqQuoteData, error: rfqQuoteErr }
  ] = await Promise.all([
    supabaseClient.from('request').select('*').eq('Status', 'Approved'),
    supabaseClient.from('vendor').select('*').eq('Status', 'Approved'),
    supabaseClient.from('rfqDetail').select('RFQDetailID, RequestID, RFQID'),
    supabaseClient.from('rfqVendor').select('RFQID, VendorID, ConfirmationStatus, Status'),
    supabaseClient.from('rfq').select('RFQID, NoRFQ'),
    supabaseClient.from('vendor').select('VendorID, VendorName'),
    supabaseClient.from('rfqQuote').select('RFQDetailID, VendorID, Qty, IsSelected')
  ]);
  if (reqErr) throw reqErr;
  if (venErr) throw venErr;
  if (detErr) throw detErr;
  if (rfqVenErr) throw rfqVenErr;
  if (rfqHeaderErr) throw rfqHeaderErr;
  if (allVenErr) throw allVenErr;
  if (rfqQuoteErr) throw rfqQuoteErr;

    rfqRequestData = reqData || [];
    rfqVendorData = venData || [];

    const rfqIdToNoRFQ = {};
    (rfqHeaderData || []).forEach(r => { rfqIdToNoRFQ[r.RFQID] = r.NoRFQ; });

    const vendorIdToName = {};
    (allVendorData || []).forEach(v => { vendorIdToName[v.VendorID] = v.VendorName; });

    const rfqIdToVendorIds = {};
    (rfqVenData || []).forEach(rv => {
      if (!rfqIdToVendorIds[rv.RFQID]) rfqIdToVendorIds[rv.RFQID] = new Set();
      rfqIdToVendorIds[rv.RFQID].add(rv.VendorID);
    });

    const vendorStatusByKey = {};
    (rfqVenData || []).forEach(rv => {
      vendorStatusByKey[rv.RFQID + '|' + rv.VendorID] = {
        confirmationStatus: rv.ConfirmationStatus,
        status: rv.Status
      };
    });

    requestVendorInviteMap = {};
    requestRfqHistoryMap = {};
    (detailData || []).forEach(d => {
      const vendorSet = rfqIdToVendorIds[d.RFQID];
      if (!vendorSet) return;

      if (!requestVendorInviteMap[d.RequestID]) requestVendorInviteMap[d.RequestID] = new Set();
      vendorSet.forEach(vId => requestVendorInviteMap[d.RequestID].add(vId));

      if (!requestRfqHistoryMap[d.RequestID]) requestRfqHistoryMap[d.RequestID] = [];
      const vendorNames = Array.from(vendorSet).map(vId => vendorIdToName[vId] || `Vendor#${vId}`);
      const vendorStatusMap = {};
      vendorSet.forEach(vId => {
        vendorStatusMap[vId] = vendorStatusByKey[d.RFQID + '|' + vId] || null;
      });
      requestRfqHistoryMap[d.RequestID].push({
        noRFQ: rfqIdToNoRFQ[d.RFQID] || `RFQID-${d.RFQID}`,
        vendorIds: Array.from(vendorSet),
        vendorNames,
        vendorStatusMap
      });
    });

    // tambahan query di Promise.all: supabaseClient.from('rfqQuote').select('RFQDetailID, VendorID, Qty')
    // tambahan query rfqDetail select jadi: 'RFQDetailID, RequestID, RFQID'
    // tambahan query rfqVendor select jadi: 'RFQID, VendorID, ConfirmationStatus'

    const confirmedVendorKeySet = new Set();
    (rfqVenData || []).forEach(rv => {
      if (rv.ConfirmationStatus === 'Confirmed') {
        confirmedVendorKeySet.add(rv.RFQID + '|' + rv.VendorID);
      }
    });

    const detailIdToInfo = {};
    (detailData || []).forEach(rd => {
      detailIdToInfo[rd.RFQDetailID] = { RequestID: rd.RequestID, RFQID: rd.RFQID };
    });

    const confirmedQtyByRequest = {};
    (rfqQuoteData || []).forEach(q => {
      if (q.IsSelected !== 'Yes') return;
      const info = detailIdToInfo[q.RFQDetailID];
      if (!info) return;
      const key = info.RFQID + '|' + q.VendorID;
      if (!confirmedVendorKeySet.has(key)) return;
      confirmedQtyByRequest[info.RequestID] = (confirmedQtyByRequest[info.RequestID] || 0) + (Number(q.Qty) || 0);
    });

    requestRemainingQtyMap = {};
    rfqRequestData.forEach(r => {
      const confirmed = confirmedQtyByRequest[r.ID] || 0;
      requestRemainingQtyMap[r.ID] = Math.max((Number(r.QTY) || 0) - confirmed, 0);
    });

    renderRfqRequestTable();
    renderRfqVendorTable();
    document.getElementById('searchRfqRequest').value = '';
    document.getElementById('searchRfqVendor').value = '';
  } catch (err) {
    console.error('Gagal memuat data RFQ:', err);
    reqBody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:red;">Gagal memuat: ${err.message}</td></tr>`;
  }
}

function renderRfqRequestTable() {
  const keyword = (document.getElementById('searchRfqRequest')?.value || '').toLowerCase().trim();
  const reqBody = document.getElementById('rfqRequestTableBody');
  const filtered = rfqRequestData.filter(r => {
    if (!keyword) return true;
    const haystack = `${r.RefNo || ''} ${r.ItemDescription || ''}`.toLowerCase();
    return haystack.includes(keyword);
  });
  if (filtered.length === 0) {
    reqBody.innerHTML = '<tr><td colspan="7" style="text-align:center;">Tidak ada Request Approved.</td></tr>';
    return;
  }
  reqBody.innerHTML = '';
  filtered.forEach(r => {
    const tr = document.createElement('tr');          // <-- tambahkan ini
    const checked = selectedRequestIds.has(r.ID) ? 'checked' : '';
    const remainingVal = requestRemainingQtyMap[r.ID] !== undefined ? requestRemainingQtyMap[r.ID] : (Number(r.QTY) || 0);
    const isFulfilled = remainingVal <= 0;
    const isPartial = !isFulfilled && remainingVal < (Number(r.QTY) || 0);
    if (isFulfilled) selectedRequestIds.delete(r.ID);

    let sisaQtyText = `${remainingVal} ${r.UNIT || ''}`;
    if (isFulfilled) sisaQtyText = '<span class="badge bg-secondary">Terpenuhi</span>';
    else if (isPartial) sisaQtyText += ' <span class="text-warning" style="font-size:11px;">(sebagian terpenuhi)</span>';

    tr.innerHTML = `
      <td><input type="checkbox" class="chkRfqRequest" value="${r.ID}" ${checked} ${isFulfilled ? 'disabled' : ''}></td>
      <td>${r.RefNo || '-'}</td>
      <td>${r.ItemDescription || '-'}</td>
      <td>${r.QTY || '-'} ${r.UNIT || ''}</td>
      <td>${r.PROJECTID || '-'}</td>
      <td>${renderRfqHistoryCell(r.ID)}</td>
      <td>${sisaQtyText}</td>`;
    if (isFulfilled) tr.style.opacity = '0.5';
    reqBody.appendChild(tr);
  });
  
  reqBody.querySelectorAll('.chkRfqRequest').forEach(chk => {
    chk.addEventListener('change', () => {
      const id = Number(chk.value);
      if (chk.checked) selectedRequestIds.add(id); else selectedRequestIds.delete(id);
      renderRfqVendorTable();
    });
  });
}

let requestVendorInviteMap = {};
let requestRfqHistoryMap = {}; // { requestId: [{ noRFQ, vendorNames: [...] }, ...] }

function getExcludedVendorIds() {
  const excluded = new Set();
  selectedRequestIds.forEach(reqId => {
    const set = requestVendorInviteMap[reqId];
    if (set) set.forEach(vId => excluded.add(vId));
  });
  return excluded;
}

function getExclusionReason(vendorId) {
  const reasons = [];
  selectedRequestIds.forEach(reqId => {
    const history = requestRfqHistoryMap[reqId];
    if (!history) return;
    const reqItem = rfqRequestData.find(r => r.ID === reqId);
    history.forEach(h => {
      if (h.vendorIds.includes(vendorId)) {
        const info = h.vendorStatusMap ? h.vendorStatusMap[vendorId] : null;
        reasons.push(`${h.noRFQ} (Item: ${reqItem ? reqItem.RefNo : reqId})${formatVendorStatusLabel(info)}`);
      }
    });
  });
  return reasons.join(', ');
}

function formatVendorStatusLabel(info) {
  if (!info) return '';
  if (info.confirmationStatus === 'Confirmed') return ' - Menang & Terkonfirmasi';
  if (info.confirmationStatus === 'Rejected') return ' - Menang, Vendor Menolak';
  if (info.status === 'Tidak Terpilih') return ' - Tidak Terpilih';
  if (info.status === 'Approved') return ' - Menunggu Konfirmasi Vendor';
  if (info.status === 'Diusulkan') return ' - Menunggu Approval Management';
  if (info.confirmationStatus === 'Submitted') return ' - Menunggu Seleksi';
  if (info.confirmationStatus === 'Pending') return ' - Belum Kirim Penawaran';
  return '';
}

function renderRfqHistoryCell(requestId) {
  const history = requestRfqHistoryMap[requestId];
  if (!history || history.length === 0) return '<span style="color:#999;">Belum di-RFQ</span>';
  return history.map(h =>
    `<div style="font-size:12px; margin-bottom:2px;">${h.noRFQ} → ${h.vendorNames.join(', ')}</div>`
  ).join('');
}

function renderRfqVendorTable() {
  const keyword = (document.getElementById('searchRfqVendor')?.value || '').toLowerCase().trim();
  const venBody = document.getElementById('rfqVendorTableBody');
  const excludedVendorIds = getExcludedVendorIds();

  excludedVendorIds.forEach(vId => selectedVendorIds.delete(vId));

  const filtered = rfqVendorData.filter(v => {
    if (!keyword) return true;
    const haystack = `${v.VendorName || ''} ${v.Catagory || ''}`.toLowerCase();
    return haystack.includes(keyword);
  });

  if (filtered.length === 0) {
    venBody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Tidak ada vendor ditemukan.</td></tr>';
    return;
  }

  venBody.innerHTML = '';
  filtered.forEach(v => {
    const isExcluded = excludedVendorIds.has(v.VendorID);
    const tr = document.createElement('tr');

    if (isExcluded) {
      const reason = getExclusionReason(v.VendorID);
      tr.style.opacity = '0.5';
      tr.innerHTML = `
        <td><input type="checkbox" disabled title="Sudah diundang: ${reason}"></td>
        <td>${v.VendorName || '-'}<br><span style="color:#e8562c; font-size:11px;">Sudah diundang: ${reason}</span></td>
        <td>${v.Catagory || '-'}</td>
        <td>${v.Email || '-'}</td>`;
    } else {
      const checked = selectedVendorIds.has(v.VendorID) ? 'checked' : '';
      tr.innerHTML = `
        <td><input type="checkbox" class="chkRfqVendor" value="${v.VendorID}" ${checked}></td>
        <td>${v.VendorName || '-'}</td>
        <td>${v.Catagory || '-'}</td>
        <td>${v.Email || '-'}</td>`;
    }
    venBody.appendChild(tr);
  });

  venBody.querySelectorAll('.chkRfqVendor').forEach(chk => {
    chk.addEventListener('change', () => {
      const id = Number(chk.value);
      if (chk.checked) selectedVendorIds.add(id); else selectedVendorIds.delete(id);
    });
  });
}

document.getElementById('searchRfqRequest')?.addEventListener('input', renderRfqRequestTable);
document.getElementById('searchRfqVendor')?.addEventListener('input', renderRfqVendorTable);

async function submitRFQ() {
  const requestIds = Array.from(document.querySelectorAll('.chkRfqRequest:checked')).map(el => Number(el.value));
  const vendorIds = Array.from(document.querySelectorAll('.chkRfqVendor:checked')).map(el => Number(el.value));
  const notes = document.getElementById('rfqNotes').value;
  const deliveryPoint = document.getElementById('rfqDeliveryPoint')?.value.trim() || '';

  if (requestIds.length === 0) { showToast('Pilih minimal 1 item Request', 'error'); return; }
  if (vendorIds.length === 0) { showToast('Pilih minimal 1 vendor', 'error'); return; }

  const btn = document.getElementById('btnSubmitRfq');
  btn.disabled = true;
  btn.textContent = 'Memproses...';

  try {
    const { data, error } = await supabaseClient.rpc('create_rfq_and_invite', {
      p_request_ids: requestIds,
      p_vendor_ids: vendorIds,
      p_created_by: (currentUser && currentUser.nama) || 'User',
      p_notes: notes || null,
      p_delivery_point: deliveryPoint || null
    });
    if (error) throw error;

    for (const inv of data) {
      const link = `https://rovansyahriza-crv.github.io/SMMS-BIMA/rfq-quote.html?rfq=${inv.rfqid}&vendor=${inv.vendorid}`;
      try {
        await fetch(RFQ_EMAIL_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            action: "SEND_SIMPLE_EMAIL",
            to: inv.email,
            subject: `Undangan RFQ ${inv.norfq}`,
            body: `Anda diundang memberikan penawaran harga untuk RFQ ${inv.norfq}.\n\nBuka link berikut dan masukkan PIN Anda: ${inv.pin}\n\nLink: ${link}`
          })
        });
      } catch (emailErr) {
        console.warn('Gagal kirim email ke', inv.email, emailErr);
      }
    }

    try {
      btn.textContent = 'Membuat report PDF...';
      const rfqIdForReport = data[0]?.rfqid;
      const noRfqForReport = data[0]?.norfq;
      const deliveryPointForReport = deliveryPoint;

      const { data: rfqItemRows } = await supabaseClient
        .from('rfqDetail')
        .select('RFQDetailID, RequestID, ItemID, ItemDescription, Unit, Qty')
        .eq('RFQID', rfqIdForReport);

      const reqIdsForReport = [...new Set((rfqItemRows || []).map(r => r.RequestID))];
      const { data: reqRowsForReport } = await supabaseClient
        .from('request')
        .select('ID, RefNo, ItemGroup')
        .in('ID', reqIdsForReport.length ? reqIdsForReport : [0]);
      const reqInfoMap = {};
      (reqRowsForReport || []).forEach(r => { reqInfoMap[r.ID] = r; });

      const { data: rfqVendorRowsForReport } = await supabaseClient
        .from('rfqVendor')
        .select('VendorID, ConfirmationStatus, Status')
        .eq('RFQID', rfqIdForReport);
      const vendorStatusMap = {};
      (rfqVendorRowsForReport || []).forEach(v => { vendorStatusMap[v.VendorID] = v.ConfirmationStatus || v.Status || 'Menunggu'; });

      const { data: vendorRowsForReport } = await supabaseClient
        .from('vendor')
        .select('VendorID, VendorName')
        .in('VendorID', vendorIds);
      const vendorNameMap = {};
      (vendorRowsForReport || []).forEach(v => { vendorNameMap[v.VendorID] = v.VendorName; });

      const rfqPdfDoc = await generateRfqReportPdf({
        noRfq: noRfqForReport,
        tanggalRfq: new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }),
        createdBy: currentUser.nama,
        createdBySub: (currentUser && currentUser.kualifikasi) || '',
        createdByQr: `QrCodeID=${(currentUser && currentUser.qrCodeId) || ''}|NoTransaksi=${noRfqForReport}`,
        deliveryPoint: deliveryPointForReport,
        notes: notes || '',
        items: (rfqItemRows || []).map(rd => {
          const reqInfo = reqInfoMap[rd.RequestID] || {};
          return {
            noRequest: reqInfo.RefNo || '-',
            kode: itemCode({ ItemGroup: reqInfo.ItemGroup, ItemID: rd.ItemID }) || (reqInfo.ItemGroup || ''),
            desk: rd.ItemDescription,
            qty: rd.Qty,
            unit: rd.Unit,
          };
        }),
        vendors: vendorIds.map(vid => ({
          nama: vendorNameMap[vid] || `Vendor #${vid}`,
          email: (data.find(inv => Number(inv.vendorid) === vid) || {}).email || '-',
          status: vendorStatusMap[vid] || 'Menunggu',
        })),
      });
      const rfqPdfBlob = reportPdfToBlob(rfqPdfDoc);
      const uploadedRfqPdf = await uploadReportPdfToDrive(rfqPdfBlob, `RFQ_${String(noRfqForReport).replace(/\//g, '-')}.pdf`);
      await supabaseClient.from('rfq').update({ ReportURL: uploadedRfqPdf.directUrl, ReportFileID: uploadedRfqPdf.fileId, Status: 'Menunggu Penawaran Vendor' }).eq('RFQID', rfqIdForReport);

      // Update status item request terkait menjadi 'Dalam Proses RFQ' dan refresh PDF-nya
      await supabaseClient.from('request').update({ Status: 'Dalam Proses RFQ' }).in('ID', requestIds);
      const affectedRefNos = [...new Set((reqRowsForReport || []).map(r => r.RefNo).filter(Boolean))];
      for (const rNo of affectedRefNos) {
        refreshRequestReportPdf(rNo, 'Dalam Proses RFQ').catch(e => console.warn('Refresh request report on RFQ creation failed:', e));
      }
    } catch (reportErr) {
      console.warn('Gagal membuat/upload report PDF RFQ:', reportErr);
    }

    showToast(`RFQ ${data[0]?.norfq || ''} berhasil dibuat, ${data.length} vendor diundang`, 'success');
    document.getElementById('rfqNotes').value = '';
    loadRfqCreatePage();
  } catch (err) {
    showToast('Gagal membuat RFQ: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Buat RFQ & Kirim Undangan';
  }
}

// ============ SELEKSI VENDOR RFQ (Project Sponsor) ============

async function loadRfqSelectionPage() {
  const select = document.getElementById('selectRfqForSelection');
  select.innerHTML = '<option value="">-- Pilih RFQ --</option>';
  document.getElementById('rfqSelectionContent').innerHTML = '';

  const { data: submittedVendors, error } = await supabaseClient
    .from('rfqVendor')
    .select('RFQID, VendorID')
    .eq('ConfirmationStatus', 'Submitted')
    .eq('Status', 'Sent')
    .is('ManagementApproval', null);

  if (error) { showToast('Gagal memuat data RFQ: ' + error.message, 'error'); return; }
  if (!submittedVendors || submittedVendors.length === 0) return;

  const rfqIds = [...new Set(submittedVendors.map(r => r.RFQID))];
  const { data: rfqRows } = await supabaseClient.from('rfq').select('RFQID, NoRFQ').in('RFQID', rfqIds);

  (rfqRows || []).forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.RFQID;
    opt.textContent = r.NoRFQ || `RFQID ${r.RFQID}`;
    select.appendChild(opt);
  });
}

async function loadRfqSelectionDetail(rfqId) {
  const content = document.getElementById('rfqSelectionContent');
  if (!rfqId) { content.innerHTML = ''; return; }
  content.innerHTML = '<p>Memuat data perbandingan...</p>';

  const [
    { data: detailRows, error: detErr },
    { data: vendorRows, error: venErr },
    { data: quoteRows, error: quoErr },
    { data: termRows, error: terErr },
    { data: vendorMaster, error: vmErr }
  ] = await Promise.all([
    supabaseClient.from('rfqDetail').select('RFQDetailID, RequestID, ItemID, ItemDescription, Unit, Qty').eq('RFQID', rfqId),
    supabaseClient.from('rfqVendor').select('RFQVendorID, VendorID, ConfirmationStatus, ManagementApproval, Notes').eq('RFQID', rfqId).eq('ConfirmationStatus', 'Submitted'),
    supabaseClient.from('rfqQuote').select('RFQDetailID, VendorID, UnitPrice, Qty, VendorDeliveryDate'),
    supabaseClient.from('rfqVendorTerm').select('*').order('RFQVendorTermID', { ascending: true }),
    supabaseClient.from('vendor').select('VendorID, VendorName')
  ]);

  if (detErr || venErr || quoErr || terErr || vmErr) {
    content.innerHTML = '<p style="color:red;">Gagal memuat data.</p>';
    return;
  }

  const items = detailRows || [];
  const vendors = (vendorRows || []).filter(v => !v.ManagementApproval);
  if (vendors.length === 0) {
    content.innerHTML = '<p>Tidak ada vendor yang menunggu keputusan untuk RFQ ini.</p>';
    return;
  }

  const vendorIdToName = {};
  (vendorMaster || []).forEach(v => { vendorIdToName[v.VendorID] = v.VendorName; });

  const detailIds = items.map(i => String(i.RFQDetailID));
  const vendorIds = vendors.map(v => String(v.VendorID));

  const quoteMap = {};
  (quoteRows || []).forEach(q => {
    if (!detailIds.includes(String(q.RFQDetailID)) || !vendorIds.includes(String(q.VendorID))) return;
    quoteMap[q.RFQDetailID + '|' + q.VendorID] = q;
  });

  const rfqVendorIdToTerm = {};
  (termRows || [])
    .sort((a, b) => (Number(a.RFQVendorTermID) || 0) - (Number(b.RFQVendorTermID) || 0))
    .forEach(t => { 
      rfqVendorIdToTerm[t.RFQVendorID] = t;
      rfqVendorIdToTerm[String(t.RFQVendorID)] = t;
    });

  window._rfqSelectionState = { rfqId, items, vendors, quoteMap, vendorIdToName, termByRfqVendorId: rfqVendorIdToTerm };

  let html = '<div style="overflow-x:auto;"><table class="data-table" id="tableRfqCompare"><thead><tr>';
  html += '<th style="min-width:200px;">Item</th><th style="width:100px;">Qty</th>';
  vendors.forEach(v => { html += `<th style="min-width:180px; text-align:center;">${vendorIdToName[v.VendorID] || 'Vendor #' + v.VendorID}</th>`; });
  html += '</tr></thead><tbody>';

  const sortedItems = [...items].sort((a, b) => (a.ItemDescription || '').localeCompare(b.ItemDescription || ''));
  const descGroupCount = {};
  sortedItems.forEach(item => {
    const key = item.ItemDescription || '-';
    descGroupCount[key] = (descGroupCount[key] || 0) + 1;
  });
  const renderedDesc = new Set();

  sortedItems.forEach(item => {
    const key = item.ItemDescription || '-';
    const isFirstOfGroup = !renderedDesc.has(key);
    renderedDesc.add(key);

    html += '<tr style="background:#eaf7ea;">';
    if (isFirstOfGroup) {
      html += `<td rowspan="${descGroupCount[key]}" style="vertical-align:top;border-right:2px solid #c8dfc8; font-weight:700;">${key}</td>`;
    }
    html += `<td style="font-weight:600;">${item.Qty || '-'} ${item.Unit || ''}</td>`;
    vendors.forEach(v => {
      const q = quoteMap[item.RFQDetailID + '|' + v.VendorID];
      if (q) {
        const subtotal = (Number(q.UnitPrice) || 0) * (Number(q.Qty) || 0);
        let delivHtml = '';
        if (q.VendorDeliveryDate) {
          const d = new Date(q.VendorDeliveryDate);
          const dStr = isNaN(d.getTime()) ? String(q.VendorDeliveryDate) : d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
          delivHtml = `<div style="font-size:11.5px; color:#1B365D; margin-top:4px; font-weight:600;">🚚 Kirim: ${dStr}</div>`;
        }

        html += `<td style="text-align:center; padding:10px 8px;">
          <label style="display:block;cursor:pointer;">
            <input type="radio" name="item-${item.RFQDetailID}" value="${v.VendorID}" onchange="recalcVendorTotals()">
            <div style="font-size:13px; font-weight:600; color:#333;">Rp ${Number(q.UnitPrice).toLocaleString('id-ID')} x ${q.Qty}</div>
            <div style="font-size:13.5px; font-weight:800; color:#E04D23; margin-top:2px;">Rp ${subtotal.toLocaleString('id-ID')}</div>
            ${delivHtml}
          </label>
        </td>`;
      } else {
        html += '<td style="text-align:center;color:#aaa;">-</td>';
      }
    });
    html += '</tr>';
  });

  const rowsInfo = [
    { label: 'Mobilisasi', get: t => t ? Number(t.MobilisasiCost) || 0 : 0, money: true },
    { 
      label: 'Biaya Lain', 
      render: (t, v) => {
        const cost = t ? Number(t.OtherServiceCost) || 0 : 0;
        const desc = t && t.OtherServiceDescription ? t.OtherServiceDescription : '';
        let out = 'Rp ' + cost.toLocaleString('id-ID');
        if (desc) {
          out += `<div style="font-size:11.5px; color:#555; font-style:italic; margin-top:2px;">(${desc})</div>`;
        }
        return out;
      }
    },
    { label: 'PPN', get: t => t ? Number(t.PPNAmount) || 0 : 0, money: true },
    { label: 'Termin Pembayaran', get: t => t ? (t.PaymentTermType || '-') + (t.DPPercentage ? ' (DP ' + t.DPPercentage + '%)' : '') : '-', money: false },
    { label: 'Catatan Vendor', get: (t, v) => (v && v.Notes) ? v.Notes : (t && t.Notes ? t.Notes : '-'), money: false }
  ];
  rowsInfo.forEach(row => {
    html += `<tr><td colspan="2" style="font-weight:600;">${row.label}</td>`;
    vendors.forEach(v => {
      const term = rfqVendorIdToTerm[v.RFQVendorID] || rfqVendorIdToTerm[String(v.RFQVendorID)];
      let cellContent = '';
      if (row.render) {
        cellContent = row.render(term, v);
      } else {
        const val = row.get(term, v);
        cellContent = row.money ? 'Rp ' + Number(val).toLocaleString('id-ID') : val;
      }
      html += `<td style="text-align:center;">${cellContent}</td>`;
    });
    html += '</tr>';
  });

  html += '<tr style="font-weight:bold;background:#f5f5f5;"><td colspan="2">TOTAL</td>';
  vendors.forEach(v => {
    html += `<td id="total-${v.VendorID}" style="text-align:center; font-size:14px; color:#1B365D;">Rp 0</td>`;
  });
  html += '</tr>';

  html += '<tr style="background:#fde3d8;"><td colspan="2"><strong>Pilih</strong></td>';
  vendors.forEach(v => {
    html += `<td style="text-align:center;"><input type="checkbox" id="pilih-${v.VendorID}" disabled></td>`;
  });
  html += '</tr>';

  html += '</tbody></table></div>';

  html += `<div style="margin-top:16px;"><textarea id="selectionNotes" placeholder="Catatan (opsional)" style="width:100%;min-height:60px;padding:8px;"></textarea></div>`;
  html += `<button type="button" style="margin-top:12px;padding:10px 20px;background:#e05a2b;color:#fff;border:none;border-radius:6px;cursor:pointer;font-weight:700;" onclick="submitVendorSelection()">Usulkan Pemenang</button>`;

  content.innerHTML = html;
}

function recalcVendorTotals() {
  const state = window._rfqSelectionState;
  if (!state) return;
  const { items, vendors, quoteMap, termByRfqVendorId } = state;

  vendors.forEach(v => {
    let subtotal = 0;
    let assignedCount = 0;
    items.forEach(item => {
      const radio = document.querySelector(`input[name="item-${item.RFQDetailID}"]:checked`);
      if (radio && String(radio.value) === String(v.VendorID)) {
        const q = quoteMap[item.RFQDetailID + '|' + v.VendorID];
        if (q) subtotal += (Number(q.UnitPrice) || 0) * (Number(q.Qty) || 0);
        assignedCount++;
      }
    });

    const term = termByRfqVendorId[v.RFQVendorID];
    let total = subtotal;
    if (assignedCount > 0 && term) {
      total += Number(term.MobilisasiCost) || 0;
      total += Number(term.OtherServiceCost) || 0;
      total += Number(term.PPNAmount) || 0;
    }

    const totalCell = document.getElementById(`total-${v.VendorID}`);
    if (totalCell) totalCell.textContent = 'Rp ' + total.toLocaleString('id-ID');

    const pilihCheckbox = document.getElementById(`pilih-${v.VendorID}`);
    if (pilihCheckbox) {
      pilihCheckbox.disabled = assignedCount === 0;
      if (assignedCount === 0) pilihCheckbox.checked = false;
    }
  });
}

async function submitVendorSelection() {
  const state = window._rfqSelectionState;
  if (!state) { showToast('Data tidak ditemukan, silakan reload.', 'error'); return; }
  const { rfqId, items, vendors } = state;

  const pickedVendorIds = vendors.filter(v => {
    const cb = document.getElementById(`pilih-${v.VendorID}`);
    return cb && cb.checked;
  }).map(v => String(v.VendorID));

  if (pickedVendorIds.length === 0) {
    showToast('Belum ada vendor yang di-"pilih".', 'error');
    return;
  }

  const notes = document.getElementById('selectionNotes').value || null;

  try {
    for (const item of items) {
      const radio = document.querySelector(`input[name="item-${item.RFQDetailID}"]:checked`);
      const assignedVendorId = radio ? String(radio.value) : null;
      const winningVendorId = (assignedVendorId && pickedVendorIds.includes(assignedVendorId)) ? assignedVendorId : null;

      for (const v of vendors) {
        const isSelected = String(v.VendorID) === winningVendorId ? 'Yes' : 'No';
        await supabaseClient
          .from('rfqQuote')
          .update({ IsSelected: isSelected })
          .eq('RFQDetailID', String(item.RFQDetailID))
          .eq('VendorID', String(v.VendorID));
      }
    }

    for (const v of vendors) {
      const isPicked = pickedVendorIds.includes(String(v.VendorID));
      await supabaseClient
        .from('rfqVendor')
        .update({
          Status: isPicked ? 'Diusulkan' : 'Tidak Terpilih',
          Notes: isPicked ? notes : null
        })
        .eq('RFQVendorID', v.RFQVendorID);
    }

    try {
      const { data: rfqRowForReport } = await supabaseClient.from('rfq').select('NoRFQ').eq('RFQID', rfqId).maybeSingle();
      const noRfqForReport = rfqRowForReport ? rfqRowForReport.NoRFQ : `RFQID-${rfqId}`;

      const reportItems = [];
      const vendorReportTotals = {};
      pickedVendorIds.forEach(vid => { vendorReportTotals[vid] = 0; });

      items.forEach(item => {
        const radio = document.querySelector(`input[name="item-${item.RFQDetailID}"]:checked`);
        const assignedVendorId = radio ? String(radio.value) : null;
        const winningVendorId = (assignedVendorId && pickedVendorIds.includes(assignedVendorId)) ? assignedVendorId : null;
        const q = winningVendorId ? state.quoteMap[item.RFQDetailID + '|' + winningVendorId] : null;
        const hargaSatuan = q ? (Number(q.UnitPrice) || 0) : 0;
        const subtotal = q ? hargaSatuan * (Number(q.Qty) || 0) : 0;
        if (winningVendorId) vendorReportTotals[winningVendorId] = (vendorReportTotals[winningVendorId] || 0) + subtotal;

        reportItems.push({
          desk: item.ItemDescription,
          qty: item.Qty,
          unit: item.Unit,
          vendorPemenang: winningVendorId ? (state.vendorIdToName[winningVendorId] || `Vendor #${winningVendorId}`) : '-',
          hargaSatuan,
          subtotal,
        });
      });

      // Tambahkan biaya mobilisasi/service/PPN per vendor terpilih (sama seperti recalcVendorTotals)
      vendors.forEach(v => {
        const vid = String(v.VendorID);
        if (!pickedVendorIds.includes(vid)) return;
        const term = state.termByRfqVendorId[v.RFQVendorID];
        if (term) {
          vendorReportTotals[vid] = (vendorReportTotals[vid] || 0)
            + (Number(term.MobilisasiCost) || 0)
            + (Number(term.OtherServiceCost) || 0)
            + (Number(term.PPNAmount) || 0);
        }
      });

      const vsPdfDoc = await generateVendorSelectionReportPdf({
        noRfq: noRfqForReport,
        tanggalSeleksi: new Date().toLocaleString('id-ID'),
        diusulkanOleh: currentUser.nama,
        diusulkanOlehSub: (currentUser && currentUser.kualifikasi) || '',
        diusulkanOlehQr: `QrCodeID=${(currentUser && currentUser.qrCodeId) || ''}|NoTransaksi=${noRfqForReport}`,
        catatan: notes || '',
        items: reportItems,
        vendorSummary: pickedVendorIds.map(vid => ({
          nama: state.vendorIdToName[vid] || `Vendor #${vid}`,
          total: vendorReportTotals[vid] || 0,
        })),
      });
      const vsPdfBlob = reportPdfToBlob(vsPdfDoc);
      const uploadedVsPdf = await uploadReportPdfToDrive(vsPdfBlob, `SELEKSI_${String(noRfqForReport).replace(/\//g, '-')}.pdf`);
      await supabaseClient.from('rfq').update({ SelectionReportURL: uploadedVsPdf.directUrl, SelectionReportFileID: uploadedVsPdf.fileId }).eq('RFQID', rfqId);
    } catch (reportErr) {
      console.warn('Gagal membuat/upload report PDF Seleksi Vendor:', reportErr);
    }

    showToast('Seleksi vendor berhasil diusulkan, menunggu approval Management.', 'success');
    loadRfqSelectionPage();
  } catch (err) {
    showToast('Gagal mengusulkan seleksi: ' + err.message, 'error');
  }
}

// ============ APPROVAL SELEKSI VENDOR RFQ (Direktur) ============

async function loadApprovalRfqPage() {
  const tbody = document.getElementById('approvalRfqTableBody');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Memuat data...</td></tr>';

  const { data: rows, error } = await supabaseClient
    .from('rfqVendor')
    .select('RFQVendorID, RFQID, VendorID, Notes')
    .eq('Status', 'Diusulkan')
    .is('ManagementApproval', null);

  if (error) { tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:red;">Gagal memuat: ${error.message}</td></tr>`; return; }
  if (!rows || rows.length === 0) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Tidak ada yang menunggu approval.</td></tr>'; return; }

  const rfqIds = [...new Set(rows.map(r => r.RFQID))];
  const vendorIds = [...new Set(rows.map(r => r.VendorID))];

  const [{ data: rfqRows }, { data: vendorRows }, { data: quoteRows }, { data: detailRows }, { data: termRows }] = await Promise.all([
    supabaseClient.from('rfq').select('RFQID, NoRFQ, CreatedBy').in('RFQID', rfqIds),
    supabaseClient.from('vendor').select('VendorID, VendorName').in('VendorID', vendorIds),
    supabaseClient.from('rfqQuote').select('RFQDetailID, VendorID, UnitPrice, Qty, IsSelected'),
    supabaseClient.from('rfqDetail').select('RFQDetailID, RFQID').in('RFQID', rfqIds),
    supabaseClient.from('rfqVendorTerm').select('*')
  ]);

  const rfqIdToNoRFQ = {};
  const rfqIdToCreatedBy = {};
  (rfqRows || []).forEach(r => { rfqIdToNoRFQ[r.RFQID] = r.NoRFQ; rfqIdToCreatedBy[r.RFQID] = r.CreatedBy; });

  const vendorIdToName = {};
  (vendorRows || []).forEach(v => { vendorIdToName[v.VendorID] = v.VendorName; });

  const detailIdToRfqId = {};
  (detailRows || []).forEach(d => { detailIdToRfqId[d.RFQDetailID] = d.RFQID; });

  const rfqVendorIdToTerm = {};
  (termRows || []).forEach(t => { rfqVendorIdToTerm[t.RFQVendorID] = t; });

  tbody.innerHTML = '';
  rows.forEach(r => {
    let total = 0;
    (quoteRows || []).forEach(q => {
      if (String(q.VendorID) !== String(r.VendorID)) return;
      if (detailIdToRfqId[q.RFQDetailID] !== r.RFQID) return;
      if (q.IsSelected !== 'Yes') return;   // baris baru
      total += (Number(q.UnitPrice) || 0) * (Number(q.Qty) || 0);
    });
    const term = rfqVendorIdToTerm[r.RFQVendorID];
    if (term) {
      total += Number(term.MobilisasiCost) || 0;
      total += Number(term.OtherServiceCost) || 0;
      total += Number(term.PPNAmount) || 0;
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${rfqIdToNoRFQ[r.RFQID] || 'RFQID ' + r.RFQID}</td>
      <td>${vendorIdToName[r.VendorID] || 'Vendor #' + r.VendorID}</td>
      <td>Rp ${total.toLocaleString('id-ID')}</td>
      <td>${rfqIdToCreatedBy[r.RFQID] || '-'}</td>
      <td>
        <button type="button" style="padding:6px 12px;background:#2e7d32;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-right:4px;" onclick="approveVendorSelection(${r.RFQVendorID})">Approve</button>
        <button type="button" style="padding:6px 12px;background:#c62828;color:#fff;border:none;border-radius:4px;cursor:pointer;" onclick="rejectVendorSelection(${r.RFQVendorID})">Reject</button>
      </td>`;
    tbody.appendChild(tr);
  });
}

async function approveVendorSelection(rfqVendorId) {
  if (!confirm('Approve vendor ini sebagai pemenang RFQ?')) return;
  try {
    const approverName = currentUser?.nama || currentUser?.Name || currentUser?.Username || 'Direktur';
    const { data: rvRow } = await supabaseClient.from('rfqVendor').select('RFQID').eq('RFQVendorID', rfqVendorId).maybeSingle();

    const { error } = await supabaseClient
      .from('rfqVendor')
      .update({
        Status: 'Approved',
        ManagementApproval: 'Approved',
        ManagementApprovalBy: approverName,
        ManagementApprovalDate: new Date().toISOString()
      })
      .eq('RFQVendorID', rfqVendorId);
    if (error) throw error;

    if (rvRow && rvRow.RFQID) {
      await supabaseClient.from('rfqVendor').update({ Status: 'Tidak Terpilih' }).eq('RFQID', rvRow.RFQID).neq('RFQVendorID', rfqVendorId);
      await supabaseClient.from('rfq').update({ Status: 'Seleksi Vendor Disetujui' }).eq('RFQID', rvRow.RFQID);
    }

    showToast('Vendor berhasil di-approve.', 'success');

    sendRfqApprovalEmailToVendor(rfqVendorId).catch(e => console.warn('Gagal kirim email hasil seleksi ke vendor:', e.message));

    loadApprovalRfqPage();
  } catch (err) {
    showToast('Gagal approve: ' + err.message, 'error');
  }
}

async function sendRfqApprovalEmailToVendor(rfqVendorId) {
  const { data: rvRows, error: rvErr } = await supabaseClient
    .from('rfqVendor').select('RFQID, VendorID, PIN').eq('RFQVendorID', rfqVendorId);
  if (rvErr) throw rvErr;
  const rv = (rvRows || [])[0];
  if (!rv) return;

  const [{ data: rfqRows }, { data: vendorRows }] = await Promise.all([
    supabaseClient.from('rfq').select('NoRFQ').eq('RFQID', rv.RFQID),
    supabaseClient.from('vendor').select('VendorName, Email').eq('VendorID', rv.VendorID)
  ]);
  const rfqHeader = (rfqRows || [])[0];
  const vendorInfo = (vendorRows || [])[0];
  if (!vendorInfo) return;

  const noRFQ = rfqHeader ? rfqHeader.NoRFQ : '';
  const link = `https://rovansyahriza-crv.github.io/SMMS-BIMA/rfq-confirm.html?rfq=${rv.RFQID}&vendor=${rv.VendorID}`;
  const approverName = currentUser?.nama || currentUser?.Name || currentUser?.Username || 'Management';

  // 1. Email ke Vendor Terpilih
  if (vendorInfo.Email) {
    try {
      await fetch(RFQ_EMAIL_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "SEND_SIMPLE_EMAIL",
          to: vendorInfo.Email,
          subject: `Hasil Seleksi Vendor RFQ ${noRFQ}`,
          body: `Selamat, ${vendorInfo.VendorName} ditunjuk sebagai vendor terpilih untuk RFQ ${noRFQ}.\n\nBuka link berikut untuk melihat detail item dan mengonfirmasi kesediaan Anda:\n${link}\n\nMasukkan PIN Anda: ${rv.PIN}`
        })
      });
    } catch (e) {
      console.warn('Gagal kirim email ke vendor:', e.message);
    }
  }

  // 2. Email Notifikasi / Tembusan ke Admin Perusahaan (HO)
  if (HO_EMAIL) {
    try {
      await fetch(RFQ_EMAIL_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "SEND_SIMPLE_EMAIL",
          to: HO_EMAIL,
          subject: `[NOTIFIKASI APPROVAL] Hasil Seleksi Vendor RFQ ${noRFQ} - ${vendorInfo.VendorName}`,
          body: `Pemberitahuan SMMS BIMA:\n\nHasil seleksi vendor untuk RFQ ${noRFQ} telah DISETUJUI (APPROVED) oleh Management (${approverName}).\n\nVendor Terpilih: ${vendorInfo.VendorName} (${vendorInfo.Email || '-'})\nLink Konfirmasi Vendor: ${link}\nPIN: ${rv.PIN}\n\nSistem telah mengirimkan email undangan konfirmasi ke vendor. Menunggu respon kesediaan dari vendor sebelum penerbitan PO/SO.`
        })
      });
    } catch (e) {
      console.warn('Gagal kirim email notifikasi approval ke HO:', e.message);
    }
  }
}

async function rejectVendorSelection(rfqVendorId) {
  const reason = prompt('Alasan reject (opsional):') || null;
  try {
    const { error } = await supabaseClient
      .from('rfqVendor')
      .update({
        Status: 'Ditolak Management',
        ManagementApproval: 'Rejected',
        ManagementApprovalBy: currentUser?.Name || currentUser?.Username || 'System',
        ManagementApprovalDate: new Date().toISOString(),
        Notes: reason
      })
      .eq('RFQVendorID', rfqVendorId);
    if (error) throw error;
    showToast('Vendor berhasil ditolak.', 'success');
    loadApprovalRfqPage();
  } catch (err) {
    showToast('Gagal reject: ' + err.message, 'error');
  }
}

let selectedPoIds = new Set();

async function loadPoSubmitPage() {
  const tbody = document.getElementById('poSubmitTableBody');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:16px;">Memuat data...</td></tr>';
  selectedPoIds = new Set();
  try {
    const { data: poData, error: poErr } = await supabaseClient
      .from('purchaseOrder')
      .select('*')
      .eq('Status', 'Draft');
    if (poErr) throw poErr;

    if (!poData || poData.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:16px; color:#999;">Belum ada draft PO/SO.</td></tr>';
      return;
    }

    const rfqIds = [...new Set(poData.map(p => p.RFQID))];
    const vendorIds = [...new Set(poData.map(p => p.VendorID))];

    const [{ data: rfqData }, { data: vendorData }] = await Promise.all([
      supabaseClient.from('rfq').select('RFQID, NoRFQ').in('RFQID', rfqIds),
      supabaseClient.from('vendor').select('VendorID, VendorName').in('VendorID', vendorIds)
    ]);

    const rfqIdToNoRFQ = {};
    (rfqData || []).forEach(r => { rfqIdToNoRFQ[r.RFQID] = r.NoRFQ; });
    const vendorIdToName = {};
    (vendorData || []).forEach(v => { vendorIdToName[v.VendorID] = v.VendorName; });

    window._poSubmitData = poData;

    tbody.innerHTML = '';
    poData.forEach(po => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid #eee';
      tr.innerHTML = `
        <td style="padding:10px;"><input type="checkbox" class="chkPoSubmit" value="${po.POID}"></td>
        <td style="padding:10px;">${po.DocNumber || '-'}</td>
        <td style="padding:10px;"><span style="padding:2px 10px; border-radius:999px; font-size:12px; font-weight:700; background:${po.DocType === 'PO' ? '#D5F4E6' : '#FDEBD0'}; color:${po.DocType === 'PO' ? '#1E8449' : '#B9770E'};">${po.DocType}</span></td>
        <td style="padding:10px;">${rfqIdToNoRFQ[po.RFQID] || '-'}</td>
        <td style="padding:10px;">${vendorIdToName[po.VendorID] || '-'}</td>
        <td style="padding:10px;">Rp ${Number(po.TotalAmount || 0).toLocaleString('id-ID')}</td>
      `;
      tbody.appendChild(tr);
    });

    document.querySelectorAll('.chkPoSubmit').forEach(chk => {
      chk.addEventListener('change', () => {
        const id = Number(chk.value);
        if (chk.checked) selectedPoIds.add(id); else selectedPoIds.delete(id);
      });
    });

    document.getElementById('chkAllPoSubmit').onchange = (e) => {
      document.querySelectorAll('.chkPoSubmit').forEach(chk => {
        chk.checked = e.target.checked;
        chk.dispatchEvent(new Event('change'));
      });
    };
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:red; padding:16px;">Gagal memuat: ${err.message}</td></tr>`;
  }
}

async function submitPoForApproval() {
  if (selectedPoIds.size === 0) {
    showToast('Pilih minimal 1 PO/SO dulu.', 'error');
    return;
  }
  if (!confirm(`Ajukan ${selectedPoIds.size} PO/SO untuk approval Management?`)) return;

  try {
    const { error } = await supabaseClient
      .from('purchaseOrder')
      .update({
        Status: 'Menunggu Approval',
        SubmittedBy: currentUser?.nama || currentUser?.Username || 'System',
        SubmittedDate: new Date().toISOString()
      })
      .in('POID', Array.from(selectedPoIds));
    if (error) throw error;

    showToast('PO/SO berhasil diajukan untuk approval.', 'success');
    loadPoSubmitPage();
  } catch (err) {
    showToast('Gagal mengajukan: ' + err.message, 'error');
  }
}

async function loadApprovalPoPage() {
  const tbody = document.getElementById('approvalPoTableBody');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:16px;">Memuat data...</td></tr>';
  try {
    const { data: poData, error: poErr } = await supabaseClient
      .from('purchaseOrder')
      .select('*')
      .eq('Status', 'Menunggu Approval')
      .is('ManagementApproval', null);
    if (poErr) throw poErr;

    if (!poData || poData.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:16px; color:#999;">Tidak ada PO/SO yang menunggu approval.</td></tr>';
      return;
    }

    const rfqIds = [...new Set(poData.map(p => p.RFQID))];
    const vendorIds = [...new Set(poData.map(p => p.VendorID))];

    const [{ data: rfqData }, { data: vendorData }] = await Promise.all([
      supabaseClient.from('rfq').select('RFQID, NoRFQ').in('RFQID', rfqIds),
      supabaseClient.from('vendor').select('VendorID, VendorName').in('VendorID', vendorIds)
    ]);

    const rfqIdToNoRFQ = {};
    (rfqData || []).forEach(r => { rfqIdToNoRFQ[r.RFQID] = r.NoRFQ; });
    const vendorIdToName = {};
    (vendorData || []).forEach(v => { vendorIdToName[v.VendorID] = v.VendorName; });

    tbody.innerHTML = '';
    poData.forEach(po => {
      const tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid #eee';
      tr.innerHTML = `
        <td style="padding:10px;">${po.DocNumber || '-'}</td>
        <td style="padding:10px;"><span style="padding:2px 10px; border-radius:999px; font-size:12px; font-weight:700; background:${po.DocType === 'PO' ? '#D5F4E6' : '#FDEBD0'}; color:${po.DocType === 'PO' ? '#1E8449' : '#B9770E'};">${po.DocType}</span></td>
        <td style="padding:10px;">${rfqIdToNoRFQ[po.RFQID] || '-'}</td>
        <td style="padding:10px;">${vendorIdToName[po.VendorID] || '-'}</td>
        <td style="padding:10px;">Rp ${Number(po.TotalAmount || 0).toLocaleString('id-ID')}</td>
        <td style="padding:10px;">${po.SubmittedBy || '-'}</td>
        <td style="padding:10px;">
          <button onclick="approvePo(${po.POID})" style="padding:6px 12px; background:#e8562c; color:#fff; border:none; border-radius:6px; font-size:12px; font-weight:700; cursor:pointer; margin-right:6px;">Approve</button>
          <button onclick="rejectPo(${po.POID})" style="padding:6px 12px; background:#fff; color:#666; border:1.5px solid #e6ded9; border-radius:6px; font-size:12px; font-weight:700; cursor:pointer;">Reject</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:red; padding:16px;">Gagal memuat: ${err.message}</td></tr>`;
  }
}

async function approvePo(poId) {
  if (!confirm('Approve PO/SO ini?')) return;
  try {
    const approverName = currentUser?.nama || currentUser?.Username || 'Direktur';
    const { error } = await supabaseClient
      .from('purchaseOrder')
      .update({
        Status: 'Approved',
        ManagementApproval: 'Approved',
        ManagementApprovalBy: approverName,
        ManagementApprovalDate: new Date().toISOString()
      })
      .eq('POID', poId);
    if (error) throw error;

    // Update status RFQ dan Request terkait menjadi 'PO Diterbitkan' serta refresh PDF Request
    try {
      const { data: poRow } = await supabaseClient.from('purchaseOrder').select('RFQID').eq('POID', poId).maybeSingle();
      if (poRow && poRow.RFQID) {
        await supabaseClient.from('rfq').update({ Status: 'PO Diterbitkan' }).eq('RFQID', poRow.RFQID);
        const { data: rfqDetails } = await supabaseClient.from('rfqDetail').select('RequestID').eq('RFQID', poRow.RFQID);
        const reqIds = [...new Set((rfqDetails || []).map(d => d.RequestID).filter(Boolean))];
        if (reqIds.length > 0) {
          await supabaseClient.from('request').update({ Status: 'PO Diterbitkan' }).in('ID', reqIds);
          const { data: reqRows } = await supabaseClient.from('request').select('RefNo').in('ID', reqIds);
          const affectedRefNos = [...new Set((reqRows || []).map(r => r.RefNo).filter(Boolean))];
          for (const rNo of affectedRefNos) {
            refreshRequestReportPdf(rNo, 'PO Diterbitkan').catch(e => console.warn('Refresh request report on PO approval failed:', e));
          }
        }
      }
    } catch (linkErr) {
      console.warn('Gagal update status rfq/request terkait PO:', linkErr);
    }

    showToast('PO/SO berhasil di-approve.', 'success');
    loadApprovalPoPage();

    sendPoApprovalEmailDesktop(poId).catch(e => console.warn('Gagal kirim PO/SO ke vendor:', e.message));
  } catch (err) {
    showToast('Gagal approve: ' + err.message, 'error');
  }
}

async function rejectPo(poId) {
  const reason = prompt('Alasan penolakan (opsional):') || null;
  if (!confirm('Tolak PO/SO ini?')) return;
  try {
    const { error } = await supabaseClient
      .from('purchaseOrder')
      .update({
        Status: 'Ditolak Management',
        ManagementApproval: 'Rejected',
        ManagementApprovalBy: currentUser?.nama || currentUser?.Username || 'System',
        ManagementApprovalDate: new Date().toISOString(),
        Notes: reason
      })
      .eq('POID', poId);
    if (error) throw error;
    showToast('PO/SO berhasil ditolak.', 'success');
    loadApprovalPoPage();
  } catch (err) {
    showToast('Gagal reject: ' + err.message, 'error');
  }
}

async function loadVendorReceivingPage() {
  const selectEl = document.getElementById('selectPoForReceiving');
  selectEl.innerHTML = '<option value="">-- Pilih PO/SO --</option>';
  document.getElementById('poReceivingContent').innerHTML = '';

  try {
    const { data, error } = await supabaseClient
      .from('purchaseOrder')
      .select('POID, DocNumber, DocType, TotalAmount, VendorID')
      .eq('Status', 'Approved')
      .order('CreatedDate', { ascending: false });
    if (error) throw error;

    const poIds = (data || []).map(po => po.POID);
    let sisaByPoId = {};
    if (poIds.length > 0) {
      const { data: details } = await supabaseClient
        .from('purchaseOrderDetail')
        .select('POID, PODetailID, Qty')
        .in('POID', poIds);
      const { data: received } = await supabaseClient
        .from('vendorReceiving')
        .select('POID, PODetailID, QtyReceived')
        .in('POID', poIds);

      const receivedMap = {};
      (received || []).forEach(r => {
        receivedMap[r.PODetailID] = (receivedMap[r.PODetailID] || 0) + Number(r.QtyReceived || 0);
      });
      (details || []).forEach(d => {
        const sisa = Number(d.Qty || 0) - (receivedMap[d.PODetailID] || 0);
        sisaByPoId[d.POID] = (sisaByPoId[d.POID] || 0) + sisa;
      });
    }

    // PO/SO yang semua item-nya sudah diterima penuh (sisa <= 0) disembunyikan dari daftar
    const poBelumSelesai = (data || []).filter(po => (sisaByPoId[po.POID] || 0) > 0);

    const vendorIds = [...new Set(poBelumSelesai.map(po => po.VendorID).filter(Boolean))];
    let vendorMap = {};
    if (vendorIds.length > 0) {
      const { data: vendors } = await supabaseClient
        .from('vendor')
        .select('VendorID, VendorName')
        .in('VendorID', vendorIds);
      (vendors || []).forEach(v => vendorMap[v.VendorID] = v.VendorName);
    }

    poBelumSelesai.forEach(po => {
      const opt = document.createElement('option');
      opt.value = po.POID;
      opt.textContent = `${po.DocNumber} - ${vendorMap[po.VendorID] || 'Vendor'} (${po.DocType || ''})`;
      selectEl.appendChild(opt);
    });

    if (poBelumSelesai.length === 0) {
      selectEl.innerHTML = '<option value="">-- Semua PO/SO sudah diterima penuh --</option>';
    }
  } catch (err) {
    showToast('Gagal memuat daftar PO/SO: ' + err.message, 'error');
  }
}

async function loadPoReceivingDetail(poId) {
  const contentEl = document.getElementById('poReceivingContent');
  if (!poId) { contentEl.innerHTML = ''; return; }
  contentEl.innerHTML = '<p style="text-align:center;">Memuat detail item...</p>';

  try {
    const { data: details, error: detailError } = await supabaseClient
      .from('purchaseOrderDetail')
      .select('PODetailID, ItemDescription, Qty, Unit')
      .eq('POID', poId);
    if (detailError) throw detailError;

    const { data: receivedRows, error: recvError } = await supabaseClient
      .from('vendorReceiving')
      .select('PODetailID, QtyReceived')
      .eq('POID', poId);
    if (recvError) throw recvError;

    const receivedMap = {};
    (receivedRows || []).forEach(r => {
      receivedMap[r.PODetailID] = (receivedMap[r.PODetailID] || 0) + Number(r.QtyReceived || 0);
    });

    const itemsBelumSelesai = (details || []).map(d => {
      const alreadyReceived = receivedMap[d.PODetailID] || 0;
      const sisa = Number(d.Qty || 0) - alreadyReceived;
      return { ...d, alreadyReceived, sisa };
    }).filter(d => d.sisa > 0);

    if (itemsBelumSelesai.length === 0) {
      contentEl.innerHTML = '<p style="text-align:center; color:#777;">Semua item di PO/SO ini sudah diterima penuh dari vendor.</p>';
      return;
    }

    let rowsHtml = '';
    itemsBelumSelesai.forEach(d => {
      rowsHtml += `
        <tr data-podetailid="${d.PODetailID}" data-sisa="${d.sisa}">
          <td>${d.ItemDescription}</td>
          <td style="text-align:center;">${d.Qty} ${d.Unit || ''}</td>
          <td style="text-align:center;">${d.alreadyReceived}</td>
          <td style="text-align:center; font-weight:700;">${d.sisa}</td>
          <td><input type="number" class="input-qty-receive" min="0" max="${d.sisa}" step="1" style="width:90px; padding:6px 8px; border:1.5px solid #e6ded9; border-radius:6px;" placeholder="0"></td>
        </tr>`;
    });

    contentEl.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty PO</th>
            <th>Sudah Diterima</th>
            <th>Sisa</th>
            <th>Diterima Sekarang</th>
          </tr>
        </thead>
        <tbody id="poReceivingDetailBody">${rowsHtml}</tbody>
      </table>
      <label style="display:block; margin-top:16px; font-weight:600; font-size:13px;">No. Surat Jalan / DO dari Vendor</label>
      <input type="text" id="poReceivingVendorDocNumber" placeholder="Contoh: SJ-VENDOR-00123" style="width:100%; padding:10px; margin-top:6px; border:1.5px solid #e6ded9; border-radius:8px; box-sizing:border-box;">

      <label style="display:block; margin-top:16px; font-weight:600; font-size:13px;">Catatan (opsional)</label>
      <textarea id="poReceivingNotes" rows="2" style="width:100%; margin-top:6px; padding:10px; border:1.5px solid #e6ded9; border-radius:8px; box-sizing:border-box;"></textarea>
      <button onclick="submitVendorReceivingBatch(${poId})" style="margin-top:16px; background:#e8562c; color:#fff; border:none; padding:12px 20px; border-radius:8px; font-weight:700; cursor:pointer;">Simpan Penerimaan Barang</button>
    `;
  } catch (err) {
    contentEl.innerHTML = '';
    showToast('Gagal memuat detail PO: ' + err.message, 'error');
  }
}

async function submitVendorReceivingBatch(poId) {
  const rows = document.querySelectorAll('#poReceivingDetailBody tr');
  const notes = document.getElementById('poReceivingNotes')?.value || null;
  const vendorDocNumber = document.getElementById('poReceivingVendorDocNumber')?.value || null;
  const payload = [];

  for (const tr of rows) {
    const podetailId = Number(tr.dataset.podetailid);
    const sisa = Number(tr.dataset.sisa);
    const qtyInput = tr.querySelector('.input-qty-receive');
    const qty = Number(qtyInput.value);
    if (qty && qty > 0) {
      if (qty > sisa) {
        showToast(`Qty diterima tidak boleh lebih dari sisa (${sisa}).`, 'error');
        return;
      }
      payload.push({
        POID: poId,
        PODetailID: podetailId,
        QtyReceived: qty,
        ReceivedBy: (typeof currentUser !== 'undefined' && currentUser && (currentUser.nama || currentUser.Username)) || 'System',
        VendorDocNumber: vendorDocNumber,
        Notes: notes
      });
    }
  }

  if (payload.length === 0) {
    showToast('Isi minimal 1 qty yang diterima.', 'error');
    return;
  }

  try {
    const { error } = await supabaseClient.from('vendorReceiving').insert(payload);
    if (error) throw error;
    showToast('Penerimaan barang berhasil disimpan.', 'success');
    loadPoReceivingDetail(poId);
  } catch (err) {
    showToast('Gagal menyimpan: ' + err.message, 'error');
  }
}