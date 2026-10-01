-- =====================================================================
-- S1.1 keamanan: login SMMS-BIMA pakai token sesi (fusion_login)
-- =====================================================================
-- Masalah: SMMS (app.js) & Monitoring Barang (monitoring.html) login lewat
-- verify_login langsung -> tanpa batas percobaan (password bisa ditebak terus)
-- dan server gak kasih sesi apa-apa, jadi RPC berikutnya gak bisa tahu siapa
-- yang manggil. Sinkron Author/PIC tiap buka halaman juga diam-diam gagal
-- (anon gak boleh baca paswordTbl).
--
-- Perbaikan:
-- 1. SMMS pindah ke fusion_login (sudah dipakai admin Fusion4): salah 5x per
--    akun dikunci 15 menit, keluar token sesi 8 jam.
-- 2. fusion_session_info(token): cek sesi + Author/PIC terbaru, sekalian
--    memperpanjang sesi 8 jam dari sekarang (dipanggil tiap buka halaman).
-- 3. fusion_logout(token): hapus sesi.
-- 4. operational.fusion_sesi(token): helper buat RPC tahap berikutnya
--    (balikin Id karyawan atau NULL, tanpa cek hak).
-- verify_login dicabut dari anon di file terpisah SETELAH halaman baru live
-- (migrasi_cabut_verify_login.sql).
-- =====================================================================

CREATE OR REPLACE FUNCTION operational.fusion_sesi(p_token text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT s.employee_id
    FROM operational.fusion_sessions s
    JOIN public."paswordTbl" p ON p."Id" = s.employee_id
    WHERE s.token_hash = sha256(convert_to(COALESCE(p_token, ''), 'UTF8'))
      AND s.expires_at > now()
      AND p."IsActive" = true
      AND s.credential_hash = sha256(convert_to(COALESCE(p."PasswordHas", ''), 'UTF8'));
$$;

CREATE OR REPLACE FUNCTION public.fusion_session_info(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_id bigint := operational.fusion_sesi(p_token);
    v_user jsonb;
BEGIN
    IF v_id IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;

    UPDATE operational.fusion_sessions
    SET expires_at = now() + interval '8 hours'
    WHERE token_hash = sha256(convert_to(p_token, 'UTF8'));

    SELECT jsonb_build_object(
               'id', k."Id",
               'nama', k."NamaPersonnel",
               'kualifikasi', k."Kualifikasi",
               'author', COALESCE(p."Author", ''),
               'pic', COALESCE(NULLIF(btrim(p."PIC"), ''), p.pic, '')
           )
    INTO v_user
    FROM public."karyawanTbl" k
    JOIN public."paswordTbl" p ON p."Id" = k."Id"
    WHERE k."Id" = v_id;

    RETURN jsonb_build_object('status', 'OK', 'user', v_user, 'expiresAt', now() + interval '8 hours');
END;
$$;

CREATE OR REPLACE FUNCTION public.fusion_logout(p_token text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
    WITH d AS (
        DELETE FROM operational.fusion_sessions
        WHERE token_hash = sha256(convert_to(COALESCE(p_token, ''), 'UTF8'))
        RETURNING 1
    )
    SELECT jsonb_build_object('status', 'OK', 'deleted', (SELECT count(*) FROM d));
$$;

REVOKE ALL ON FUNCTION operational.fusion_sesi(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fusion_session_info(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fusion_logout(text) TO anon, authenticated;
