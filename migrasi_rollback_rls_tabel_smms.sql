-- =====================================================================
-- Rollback sebagian tahap 0a (migrasi_rls_kunci_tulis_tabel.sql)
-- =====================================================================
-- 5 tabel ini ternyata DITULIS LANGSUNG dari browser oleh aplikasi SMMS-BIMA
-- (repo lain, database sama), jadi penguncian di tahap 0a membuat fiturnya gagal:
--   delivery, siteReceiving  -> delivery-to-site.html (kirim & terima di site)
--   materialReturn           -> end-user-receiving.html (pengembalian material)
--   vendorReceiving          -> app.js (terima barang dari vendor)
--   faceDescriptorTbl        -> enroll_fusion4.html versi SMMS
-- Blok ini mengembalikan 5 tabel itu ke kondisi sebelum 0a. 25 tabel lain tetap terkunci.
-- Penguncian yang benar menyusul: pindahkan penulisan SMMS ke RPC dulu.
-- =====================================================================

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['delivery', 'siteReceiving', 'materialReturn', 'vendorReceiving', 'faceDescriptorTbl'] LOOP
        EXECUTE format('DROP POLICY IF EXISTS baca_publik ON public.%I', t);
        EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
        EXECUTE format('GRANT ALL ON public.%I TO anon, authenticated', t);
    END LOOP;
END $$;
