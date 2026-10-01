-- =====================================================================
-- S2 langkah akhir: kunci request & request_approval (jalankan SETELAH
-- SMMS app.js, delivery-to-site, end-user-receiving, reportPdf.js & Badge
-- versi RPC live). Baca tetap boleh (daftar request, monitoring, PDF).
-- =====================================================================
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['request', 'request_approval'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS baca_publik ON public.%I', t);
        EXECUTE format('CREATE POLICY baca_publik ON public.%I FOR SELECT TO anon, authenticated USING (true)', t);
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM anon, authenticated', t);
        EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', t);
    END LOOP;
END $$;

-- RPC lama yang percaya Id/QrCodeId kiriman browser (bisa approve atas nama orang lain).
REVOKE EXECUTE ON FUNCTION public.process_approval(text, bigint, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.process_approval_by_qrcode(text, text, text, text) FROM PUBLIC, anon, authenticated;

-- ROLLBACK:
-- DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['request','request_approval'] LOOP
--   EXECUTE format('DROP POLICY IF EXISTS baca_publik ON public.%I', t);
--   EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
--   EXECUTE format('GRANT ALL ON public.%I TO anon, authenticated', t); END LOOP; END $$;
-- GRANT EXECUTE ON FUNCTION public.process_approval(text, bigint, text, text) TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.process_approval_by_qrcode(text, text, text, text) TO anon, authenticated;
