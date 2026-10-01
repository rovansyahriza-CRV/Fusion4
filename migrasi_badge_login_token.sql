-- =====================================================================
-- S1.2 keamanan: login PIN Digital Badge dicek di server + token sesi
-- =====================================================================
-- Masalah:
-- - get_digital_badge_by_pin tanpa batas percobaan (PIN 6 digit bisa ditebak).
-- - Fallback di browser query karyawanTbl langsung, dan QrCodeId (tercetak di
--   badge fisik) diterima sebagai PIN.
-- - digital-badge.html?QrCodeId=xxx auto-login: PIN dibaca dari tabel tanpa
--   diketik -> siapa pun yang tahu QrCodeId bisa buka Badge orang lain.
-- - 108/123 karyawan isi DigitalPIN (angka) != DigitalPin (teks); RPC cuma cek
--   DigitalPIN, jadi mereka selama ini masuk lewat fallback.
--
-- Perbaikan:
-- 1. badge_login(pin, device): PIN dicek di DigitalPIN maupun DigitalPin
--    (operational.karyawan_id_by_pin), salah 5x per HP dikunci 15 menit,
--    keluar token sesi 12 jam (disimpan cuma hash-nya).
-- 2. badge_sesi_info(token): buka ulang Badge di tab yang sama tanpa ketik PIN
--    (pengganti auto-login ?QrCodeId=), sesi diperpanjang 12 jam.
-- 3. badge_logout(token).
-- 4. setlokasi_login ikut terima kedua kolom PIN.
-- get_digital_badge_by_pin dicabut dari anon di langkah terpisah setelah
-- halaman baru live + app desktop SMMS dibangun ulang.
-- =====================================================================

CREATE TABLE IF NOT EXISTS operational.badge_sessions (
    token_hash  bytea PRIMARY KEY,
    employee_id bigint NOT NULL,
    device      text,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS badge_sessions_emp_idx ON operational.badge_sessions (employee_id);

CREATE OR REPLACE FUNCTION operational.badge_sesi(p_token text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT s.employee_id
    FROM operational.badge_sessions s
    JOIN public."karyawanTbl" k ON k."Id" = s.employee_id
    WHERE s.token_hash = sha256(convert_to(COALESCE(p_token, ''), 'UTF8'))
      AND s.expires_at > now()
      AND COALESCE(k."IsActive", true);
$$;

-- Data kartu Badge (bentuknya sama dengan get_digital_badge_by_pin, + fotoFileId).
CREATE OR REPLACE FUNCTION operational.badge_payload(p_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT jsonb_build_object(
        'valid', true,
        'qrCodeId', k."QrCodeId",
        'nama', k."NamaPersonnel",
        'kualifikasi', k."Kualifikasi",
        'fotoUrl', COALESCE(NULLIF(k."FotoURL", ''), k."FotoUrl"),
        'fotoFileId', COALESCE(NULLIF(k."FotoFileID", ''), k."FotoFileId")
    )
    FROM public."karyawanTbl" k
    WHERE k."Id" = p_id;
$$;

CREATE OR REPLACE FUNCTION public.badge_login(p_pin text, p_device text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_device   text := 'badge:' || left(COALESCE(NULLIF(btrim(p_device), ''), 'unknown'), 64);
    v_attempts integer;
    v_id       bigint;
    v_token    text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('badge-pin:' || v_device, 0));
    DELETE FROM operational.setlokasi_pin_attempts WHERE window_start < now() - interval '15 minutes';

    SELECT attempts INTO v_attempts FROM operational.setlokasi_pin_attempts WHERE device_id = v_device;
    IF COALESCE(v_attempts, 0) >= 5 THEN
        RETURN jsonb_build_object('valid', false, 'status', 'LOCKED',
            'message', 'Salah PIN 5x. Badge dikunci 15 menit di HP ini.');
    END IF;

    v_id := operational.karyawan_id_by_pin(btrim(COALESCE(p_pin, '')));

    IF v_id IS NULL THEN
        INSERT INTO operational.setlokasi_pin_attempts VALUES (v_device, 1, now())
        ON CONFLICT (device_id) DO UPDATE SET attempts = operational.setlokasi_pin_attempts.attempts + 1
        RETURNING attempts INTO v_attempts;
        RETURN jsonb_build_object('valid', false, 'status', 'INVALID',
            'message', 'PIN tidak ditemukan.', 'sisa', GREATEST(5 - v_attempts, 0));
    END IF;

    DELETE FROM operational.setlokasi_pin_attempts WHERE device_id = v_device;

    v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    DELETE FROM operational.badge_sessions WHERE expires_at < now();
    INSERT INTO operational.badge_sessions (token_hash, employee_id, device, expires_at)
    VALUES (sha256(convert_to(v_token, 'UTF8')), v_id, left(COALESCE(p_device, ''), 64), now() + interval '12 hours');

    RETURN operational.badge_payload(v_id)
        || jsonb_build_object('status', 'OK', 'token', v_token, 'expiresAt', now() + interval '12 hours');
END;
$$;

CREATE OR REPLACE FUNCTION public.badge_sesi_info(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_id bigint := operational.badge_sesi(p_token);
BEGIN
    IF v_id IS NULL THEN
        RETURN jsonb_build_object('valid', false, 'status', 'SESSION_EXPIRED', 'message', 'Sesi Badge habis. Masukkan PIN lagi.');
    END IF;
    UPDATE operational.badge_sessions
    SET expires_at = now() + interval '12 hours'
    WHERE token_hash = sha256(convert_to(p_token, 'UTF8'));
    RETURN operational.badge_payload(v_id)
        || jsonb_build_object('status', 'OK', 'expiresAt', now() + interval '12 hours');
END;
$$;

CREATE OR REPLACE FUNCTION public.badge_logout(p_token text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
    WITH d AS (
        DELETE FROM operational.badge_sessions
        WHERE token_hash = sha256(convert_to(COALESCE(p_token, ''), 'UTF8'))
        RETURNING 1
    )
    SELECT jsonb_build_object('status', 'OK', 'deleted', (SELECT count(*) FROM d));
$$;

REVOKE ALL ON operational.badge_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION operational.badge_sesi(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION operational.badge_payload(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.badge_login(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.badge_sesi_info(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.badge_logout(text) TO anon, authenticated;

-- ---------- setlokasi_login: terima DigitalPIN maupun DigitalPin ----------
DO $$
DECLARE
    v_def text := pg_get_functiondef('public.setlokasi_login(text, text)'::regprocedure);
    v_new text;
BEGIN
    IF v_def LIKE '%btrim(k."DigitalPin") = p_pin%' THEN
        RETURN;  -- sudah dipatch
    END IF;
    v_new := replace(v_def,
        'WHERE k."DigitalPIN" = p_pin::bigint AND COALESCE(k."IsActive", true)',
        'WHERE (k."DigitalPIN" = p_pin::bigint OR btrim(k."DigitalPin") = p_pin) AND COALESCE(k."IsActive", true)');
    IF v_new = v_def THEN
        RAISE EXCEPTION 'Anchor PIN di setlokasi_login tidak ditemukan -- batalkan, cek definisi live.';
    END IF;
    EXECUTE v_new;
END $$;
