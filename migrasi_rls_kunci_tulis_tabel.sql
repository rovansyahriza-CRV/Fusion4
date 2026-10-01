-- =====================================================================
-- Tahap 0a keamanan: kunci TULIS langsung (anon key) di 30 tabel public
-- =====================================================================
-- Masalah: tabel-tabel ini RLS-nya mati, jadi siapa pun yang punya anon key
-- (memang ada di source halaman) bisa INSERT/UPDATE/DELETE langsung lewat
-- REST API -- contoh: bikin/edit/hapus absen di absensiTbl tanpa wajah/GPS,
-- ubah data gaji, bikin voucher SPKL, ganti face descriptor.
--
-- Perbaikan: RLS dinyalakan + policy BACA saja (tampilan tetap jalan),
-- hak tulis anon/authenticated dicabut. Penulisan tetap jalan lewat RPC,
-- karena semua fungsi penulisnya SECURITY DEFINER milik postgres (owner
-- tabel -> tidak kena RLS). Sudah dicek 2026-10-01:
--   - kode browser: tidak ada insert/update/upsert/delete langsung ke 30 tabel ini
--   - log API 3 hari: tidak ada POST/PATCH/DELETE langsung ke 30 tabel ini
--   - fungsi penulis: semua SECURITY DEFINER, owner postgres; trigger juga
--
-- SENGAJA BELUM masuk (masih ditulis langsung dari browser, perlu dipindah
-- ke RPC dulu di tahap 0b): endUserReceiving, faceData, request, request_approval.
-- =====================================================================

DO $$
DECLARE
    t text;
    tbls text[] := ARRAY[
        'absensiTbl', 'aturanPesangonTbl', 'bpjsTbl', 'consumables', 'delivery',
        'departemenTbl', 'faceDescriptorTbl', 'hariLiburTbl', 'heavyEquipment',
        'kandidatRekrutmenTbl', 'masterGajiTbl', 'material', 'materialReturn',
        'overtimeTbl', 'payrollBulananTbl', 'pengajuan_ijin_lembur_tbl',
        'pindah_lokasi_tbl', 'polaKerjaTbl', 'ptkpTbl', 'requestIjinTbl',
        'requestLemburTbl', 'serviceOrder', 'siteReceiving', 'tarifPphTbl',
        'terTbl', 'timeLimitTbl', 'tools', 'vendorReceiving',
        'voucherIjinKeluarTbl', 'voucherPINTbl'
    ];
BEGIN
    FOREACH t IN ARRAY tbls LOOP
        IF to_regclass(format('public.%I', t)) IS NULL THEN
            RAISE EXCEPTION 'Tabel public.% tidak ditemukan -- batalkan migrasi', t;
        END IF;
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS baca_publik ON public.%I', t);
        EXECUTE format('CREATE POLICY baca_publik ON public.%I FOR SELECT TO anon, authenticated USING (true)', t);
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM anon, authenticated', t);
        EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', t);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- ROLLBACK (kalau ada fitur yang rusak): jalankan blok di bawah ini.
-- ---------------------------------------------------------------------
-- DO $$
-- DECLARE t text;
-- BEGIN
--     FOREACH t IN ARRAY ARRAY['absensiTbl', 'aturanPesangonTbl', 'bpjsTbl', 'consumables', 'delivery',
--         'departemenTbl', 'faceDescriptorTbl', 'hariLiburTbl', 'heavyEquipment', 'kandidatRekrutmenTbl',
--         'masterGajiTbl', 'material', 'materialReturn', 'overtimeTbl', 'payrollBulananTbl',
--         'pengajuan_ijin_lembur_tbl', 'pindah_lokasi_tbl', 'polaKerjaTbl', 'ptkpTbl', 'requestIjinTbl',
--         'requestLemburTbl', 'serviceOrder', 'siteReceiving', 'tarifPphTbl', 'terTbl', 'timeLimitTbl',
--         'tools', 'vendorReceiving', 'voucherIjinKeluarTbl', 'voucherPINTbl'] LOOP
--         EXECUTE format('DROP POLICY IF EXISTS baca_publik ON public.%I', t);
--         EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
--         EXECUTE format('GRANT ALL ON public.%I TO anon, authenticated', t);
--     END LOOP;
-- END $$;
