-- =====================================================================
-- S1.1 langkah akhir: cabut verify_login dari anon
-- =====================================================================
-- Jalankan SETELAH SMMS app.js & monitoring.html versi fusion_login live.
-- verify_login tanpa batas percobaan -> password bisa ditebak terus kalau
-- dipanggil langsung. fusion_login tetap memanggilnya dari dalam (SECURITY
-- DEFINER, owner postgres), jadi login tetap jalan.
-- =====================================================================
REVOKE EXECUTE ON FUNCTION public.verify_login(bigint, text) FROM PUBLIC, anon, authenticated;

-- ROLLBACK:
-- GRANT EXECUTE ON FUNCTION public.verify_login(bigint, text) TO anon, authenticated;
