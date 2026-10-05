-- ============================================================================
-- FIX: Pengajuan Off (Rotasi / Periode) dari Digital Badge selalu gagal
-- Tanggal: 2026-10-05
-- ============================================================================
-- Error di Digital Badge saat "Ajukan Off ke Atasan":
--   new row for relation "pengajuan_ijin_lembur_tbl" violates check constraint
--   "pengajuan_ijin_lembur_tbl_tipe_check"
--
-- Penyebab: migrasi_pengajuan_off.sql menyimpan Off sebagai tipe = 'OFF', tapi
-- CHECK constraint tipe tidak ikut diperluas -- masih IJIN/LEMBUR/CUTI saja
-- (kasus yang sama dengan Cuti di migrasi_fix_cuti_author_chain.sql).
-- -> Constraint diperluas untuk mengizinkan 'OFF'.
--
-- Efek samping approval Off (insert status 'OFF' ke absensiTbl) aman: absensiTbl
-- tidak punya CHECK constraint.
-- ============================================================================

ALTER TABLE "pengajuan_ijin_lembur_tbl"
  DROP CONSTRAINT pengajuan_ijin_lembur_tbl_tipe_check,
  ADD CONSTRAINT pengajuan_ijin_lembur_tbl_tipe_check
    CHECK (tipe = ANY (ARRAY['IJIN'::text, 'LEMBUR'::text, 'CUTI'::text, 'OFF'::text]));
