-- ============================================================================
-- FIX: Pengajuan Cuti gagal total + approval berjenjang Ijin/Lembur/Cuti
-- Tanggal: 2026-09-15
-- ============================================================================
-- Ditemukan saat audit sistem approval level Ijin/Cuti/Lembur (Author/AuthorizedBy
-- di karyawanTbl). Tiga bug terpisah, semuanya diperbaiki lewat migrasi ini:
--
-- 1) submit_pengajuan_cuti() selalu ERROR ("column Lokasi does not exist")
--    karena baca karyawanTbl."Lokasi" (kolom itu tidak pernah ada) dan insert ke
--    kolom nama_karyawan/jabatan (nama kolom yang benar: nama_pemohon/kualifikasi).
--    Fungsi ini juga TIDAK PERNAH pakai rantai Author/AuthorizedBy sama sekali --
--    cuma hardcode "2 level: Atasan lalu HR" tanpa pernah isi level1_target_role/
--    level2_target_role, jadi walau berhasil submit, request-nya tidak akan pernah
--    muncul di daftar pending siapa pun.
--    -> Ditulis ulang supaya identik pola-nya dengan submit_pengajuan_ijin_lembur:
--       baca AuthorizedBy pemohon, cari approver via Author/Kualifikasi, rantai
--       sampai 3 level, berhenti di "Direktur" atau kalau AuthorizedBy kosong.
--
-- 2) CHECK constraint pengajuan_ijin_lembur_tbl_tipe_check cuma mengizinkan
--    'IJIN' dan 'LEMBUR' -- 'CUTI' tidak pernah ditambahkan. Jadi bahkan setelah
--    (1) diperbaiki, insert cuti akan tetap gagal kena constraint ini.
--    -> Constraint diperluas untuk mengizinkan 'CUTI' juga.
--
-- 3) process_approval_action() (versi 4-argumen: request_id, qrcode, action, catatan):
--    a. Efek samping approval Cuti (potong SisaCuti + auto-isi absensiTbl status
--       'CUTI') cuma ada di cabang "current_level = 2" -- padahal sekarang Cuti
--       bisa selesai di level 1, 2, ATAU 3 tergantung rantai Author/AuthorizedBy
--       pemohon. Kalau selesai di level 1 atau 3, efek sampingnya tidak pernah
--       jalan. -> Blok efek samping CUTI diduplikasi ke ketiga titik "approval
--       final" (level 1 kalau total_levels=1, level 2 kalau total_levels=2,
--       level 3 selalu final).
--    b. BUG LAMA (tidak terkait Cuti, ditemukan saat testing): kode nulis
--       level1_action = 'PROPOSED' dan level2_action = 'PROPOSED', padahal
--       CHECK constraint tabel cuma izinkan level1_action IN ('PROPOSE',
--       'APPROVED','REJECTED') dan level2_action IN ('REVIEW','APPROVED',
--       'REJECTED'). Ini artinya SEMUA pengajuan Ijin/Lembur yang butuh 2-3
--       level approval (bukan cuma Cuti) GAGAL TOTAL begitu di-propose ke level
--       berikutnya -- baru ketahuan sekarang karena kebetulan belum pernah ada
--       yang mencoba approve request 2-level lewat UI. -> Diperbaiki jadi
--       'PROPOSE' (level1) dan 'REVIEW' (level2), sesuai constraint.
--
-- Sudah diuji end-to-end pakai data dummy (rantai 1-level & 2-level, quota
-- kurang, duplicate pending, reject) lalu semua data dummy dihapus bersih --
-- tidak menyentuh data karyawan/pengajuan asli.
-- ============================================================================

-- 1. Izinkan 'CUTI' di kolom tipe
ALTER TABLE "pengajuan_ijin_lembur_tbl"
  DROP CONSTRAINT pengajuan_ijin_lembur_tbl_tipe_check,
  ADD CONSTRAINT pengajuan_ijin_lembur_tbl_tipe_check
    CHECK (tipe = ANY (ARRAY['IJIN'::text, 'LEMBUR'::text, 'CUTI'::text]));

-- 2. submit_pengajuan_cuti -- lihat migrasi "fix_submit_pengajuan_cuti_author_chain"
--    yang sudah diterapkan langsung ke database (isi lengkap ada di riwayat
--    migrasi Supabase, project nhmpwjriextmbotmvvbu).

-- 3. process_approval_action(bigint,text,text,text) -- lihat migrasi
--    "generalize_cuti_final_approval_side_effects" dan
--    "fix_level_action_value_mismatch" yang sudah diterapkan langsung ke database.

-- ============================================================================
-- CATATAN PENTING (belum diperbaiki, perlu keputusan bisnis):
-- Fallback default kalau AuthorizedBy kosong adalah string "Direktur" (exact
-- match, case-insensitive) terhadap kolom Author/Kualifikasi/NamaPersonnel.
-- Sampai saat ini TIDAK ADA karyawan yang Kualifikasi atau Author-nya PERSIS
-- "Direktur" (yang ada "Direktur Utama" / "Direktur Operasional"). Akibatnya,
-- semua pengajuan yang jatuh ke level "Direktur" (termasuk beberapa Ijin/Lembur
-- asli yang sudah ada) TIDAK MUNCUL di daftar pending siapa pun sampai ada
-- karyawan yang Author atau Kualifikasi-nya diisi persis "Direktur".
-- ============================================================================
