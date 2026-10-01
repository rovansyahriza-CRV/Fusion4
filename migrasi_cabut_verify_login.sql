-- =====================================================================
-- S1 langkah akhir: cabut RPC login lama (tanpa batas percobaan) dari anon
-- =====================================================================
-- - verify_login: dipakai SMMS lama -> sekarang fusion_login (salah 5x dikunci).
-- - get_digital_badge_by_pin: dipakai Badge lama -> sekarang badge_login.
-- Dua-duanya bisa ditebak terus tanpa batas kalau dipanggil langsung.
-- fusion_login & op_login tetap memanggil verify_login dari dalam (SECURITY
-- DEFINER, owner postgres), jadi login web Fusion4/SMMS/Operational tetap jalan.
-- Aplikasi desktop SMMS (Electron, salinan lama) dipensiunkan 2026-10-01 --
-- semua pakai web -- jadi login di app desktop itu memang berhenti.
-- =====================================================================
REVOKE EXECUTE ON FUNCTION public.verify_login(bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_digital_badge_by_pin(text) FROM PUBLIC, anon, authenticated;

-- ROLLBACK:
-- GRANT EXECUTE ON FUNCTION public.verify_login(bigint, text) TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.get_digital_badge_by_pin(text) TO anon, authenticated;
