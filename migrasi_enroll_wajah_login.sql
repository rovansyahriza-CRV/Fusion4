-- =====================================================================
-- Tahap 0b keamanan: enroll wajah wajib login + kunci faceData
-- =====================================================================
-- Masalah: enroll_fusion4.html tanpa login, dan RPC save_face_descriptor /
-- enroll_face bisa dipanggil siapa saja -> data wajah orang lain bisa
-- ditimpa wajah sendiri, lalu absen atas nama orang itu. Tabel faceData juga
-- RLS-nya mati (bisa ditulis langsung pakai anon key).
--
-- Perbaikan:
-- 1. Login PIN Digital Badge -> token sesi 7 hari (disimpan cuma hash-nya).
--    PIN dicek di DigitalPIN maupun DigitalPin (108/123 karyawan isinya beda).
--    Salah PIN 5x per HP = dikunci 15 menit.
-- 2. Hak enroll: PIC berisi EN (atau ALL / *), atau Author ALL / * / ADMIN.
-- 3. Simpan wajah cuma lewat enroll_simpan_wajah(token, ...). QrCodeId harus
--    ada di karyawanTbl. Enroll ulang boleh, tapi tercatat (descriptor lama
--    ikut disimpan di log, jadi bisa dikembalikan kalau ada yang iseng).
-- 4. save_face_descriptor & enroll_face dicabut dari anon; faceData dikunci
--    total (semua pembacanya RPC SECURITY DEFINER).
-- =====================================================================

-- ---------- 1. Sesi & log ----------
CREATE TABLE IF NOT EXISTS operational.enroll_sessions (
    token_hash  bytea PRIMARY KEY,
    employee_id bigint NOT NULL,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operational.face_enroll_log (
    id              bigserial PRIMARY KEY,
    qrcodeid        text NOT NULL,
    nama            text,
    aksi            text NOT NULL,          -- BARU / TIMPA
    descriptor_lama jsonb,
    petugas_id      bigint,
    petugas_nama    text,
    device          text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS face_enroll_log_qr_idx ON operational.face_enroll_log (qrcodeid, created_at DESC);

-- ---------- 2. Helper ----------
-- Cari karyawan aktif dari PIN. DigitalPIN (angka) didahulukan, lalu DigitalPin (teks).
CREATE OR REPLACE FUNCTION operational.karyawan_id_by_pin(p_pin text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT k."Id"
    FROM public."karyawanTbl" k
    WHERE p_pin ~ '^[0-9]{4,8}$'
      AND COALESCE(k."IsActive", true)
      AND (k."DigitalPIN" = p_pin::bigint OR btrim(k."DigitalPin") = p_pin)
    ORDER BY (k."DigitalPIN" = p_pin::bigint) DESC
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION operational.enroll_punya_hak(p_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public."paswordTbl" p
        JOIN public."karyawanTbl" k ON k."Id" = p."Id"
        WHERE p."Id" = p_id
          AND COALESCE(p."IsActive", true)
          AND COALESCE(k."IsActive", true)
          AND (
              operational.tokens(COALESCE(NULLIF(btrim(p."PIC"), ''), p.pic)) && ARRAY['en', 'all', '*']
              OR operational.tokens(p."Author") && ARRAY['all', '*', 'admin']
          )
    );
$$;

CREATE OR REPLACE FUNCTION operational.enroll_sesi(p_token text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT s.employee_id
    FROM operational.enroll_sessions s
    WHERE s.token_hash = sha256(convert_to(COALESCE(p_token, ''), 'UTF8'))
      AND s.expires_at > now();
$$;

-- ---------- 3. Login / cek sesi / logout ----------
CREATE OR REPLACE FUNCTION public.enroll_login(p_pin text, p_device text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    -- Tabel percobaan PIN dipakai bareng Set Lokasi, dibedakan prefix.
    v_device   text := 'enroll:' || left(COALESCE(NULLIF(btrim(p_device), ''), 'unknown'), 64);
    v_attempts integer;
    v_id       bigint;
    v_token    text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('enroll-pin:' || v_device, 0));
    DELETE FROM operational.setlokasi_pin_attempts WHERE window_start < now() - interval '15 minutes';

    SELECT attempts INTO v_attempts FROM operational.setlokasi_pin_attempts WHERE device_id = v_device;
    IF COALESCE(v_attempts, 0) >= 5 THEN
        RETURN jsonb_build_object('status', 'LOCKED', 'message', 'Salah PIN 5x. Akses dikunci 15 menit.');
    END IF;

    v_id := operational.karyawan_id_by_pin(btrim(COALESCE(p_pin, '')));

    IF v_id IS NULL THEN
        INSERT INTO operational.setlokasi_pin_attempts VALUES (v_device, 1, now())
        ON CONFLICT (device_id) DO UPDATE SET attempts = operational.setlokasi_pin_attempts.attempts + 1
        RETURNING attempts INTO v_attempts;
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'PIN salah.', 'sisa', GREATEST(5 - v_attempts, 0));
    END IF;

    DELETE FROM operational.setlokasi_pin_attempts WHERE device_id = v_device;

    IF NOT operational.enroll_punya_hak(v_id) THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS',
            'message', 'Kamu belum punya hak Enroll Wajah. Minta admin isi EN di kolom PIC.');
    END IF;

    v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    DELETE FROM operational.enroll_sessions WHERE expires_at < now();
    INSERT INTO operational.enroll_sessions (token_hash, employee_id, expires_at)
    VALUES (sha256(convert_to(v_token, 'UTF8')), v_id, now() + interval '7 days');

    RETURN jsonb_build_object(
        'status', 'OK',
        'token', v_token,
        'nama', (SELECT k."NamaPersonnel" FROM public."karyawanTbl" k WHERE k."Id" = v_id),
        'expiresAt', now() + interval '7 days'
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.enroll_cek_sesi(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_id bigint := operational.enroll_sesi(p_token);
BEGIN
    IF v_id IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis. Masukkan PIN lagi.');
    END IF;
    IF NOT operational.enroll_punya_hak(v_id) THEN
        DELETE FROM operational.enroll_sessions WHERE employee_id = v_id;
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Hak Enroll Wajah kamu sudah dicabut.');
    END IF;
    RETURN jsonb_build_object(
        'status', 'OK',
        'nama', (SELECT k."NamaPersonnel" FROM public."karyawanTbl" k WHERE k."Id" = v_id)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.enroll_logout(p_token text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
    WITH d AS (
        DELETE FROM operational.enroll_sessions
        WHERE token_hash = sha256(convert_to(COALESCE(p_token, ''), 'UTF8'))
        RETURNING 1
    )
    SELECT jsonb_build_object('status', 'OK', 'deleted', (SELECT count(*) FROM d));
$$;

-- ---------- 4. Simpan wajah ----------
CREATE OR REPLACE FUNCTION public.enroll_simpan_wajah(
    p_token      text,
    p_qrcode     text,
    p_descriptor jsonb,
    p_device     text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_petugas  bigint := operational.enroll_sesi(p_token);
    v_qr       text := upper(btrim(COALESCE(p_qrcode, '')));
    v_nama     text;
    v_lama     jsonb;
    v_ada      boolean;
    v_aksi     text;
BEGIN
    IF v_petugas IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis. Masukkan PIN lagi.');
    END IF;
    IF NOT operational.enroll_punya_hak(v_petugas) THEN
        DELETE FROM operational.enroll_sessions WHERE employee_id = v_petugas;
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Hak Enroll Wajah kamu sudah dicabut.');
    END IF;

    SELECT k."NamaPersonnel" INTO v_nama
    FROM public."karyawanTbl" k
    WHERE upper(btrim(k."QrCodeId")) = v_qr AND COALESCE(k."IsActive", true)
    LIMIT 1;
    IF v_qr = '' OR v_nama IS NULL THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'QrCodeId tidak terdaftar di data karyawan aktif.');
    END IF;

    IF jsonb_typeof(p_descriptor) IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_descriptor) <> 128
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_descriptor) e WHERE jsonb_typeof(e) <> 'number') THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Data wajah tidak valid (harus 128 angka).');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('enroll-face:' || v_qr, 0));
    SELECT true, f."Descriptor" INTO v_ada, v_lama FROM public."faceData" f WHERE f."QrCodeId" = v_qr;
    v_aksi := CASE WHEN COALESCE(v_ada, false) THEN 'TIMPA' ELSE 'BARU' END;

    INSERT INTO public."faceData" ("QrCodeId", "Nama", "Descriptor", "UpdatedAt")
    VALUES (v_qr, v_nama, p_descriptor, now())
    ON CONFLICT ("QrCodeId") DO UPDATE
    SET "Nama" = EXCLUDED."Nama",
        "Descriptor" = EXCLUDED."Descriptor",
        "UpdatedAt" = now();

    INSERT INTO operational.face_enroll_log (qrcodeid, nama, aksi, descriptor_lama, petugas_id, petugas_nama, device)
    VALUES (v_qr, v_nama, v_aksi, v_lama, v_petugas,
            (SELECT k."NamaPersonnel" FROM public."karyawanTbl" k WHERE k."Id" = v_petugas),
            left(COALESCE(p_device, ''), 64));

    RETURN jsonb_build_object(
        'status', 'OK',
        'aksi', v_aksi,
        'nama', v_nama,
        'qrCodeId', v_qr,
        'message', CASE WHEN v_aksi = 'TIMPA'
                        THEN 'Wajah ' || v_nama || ' diperbarui (data lama tersimpan di log).'
                        ELSE 'Wajah ' || v_nama || ' berhasil didaftarkan.' END
    );
END;
$$;

-- ---------- 5. Hak eksekusi ----------
REVOKE ALL ON FUNCTION operational.karyawan_id_by_pin(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION operational.enroll_punya_hak(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION operational.enroll_sesi(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON operational.enroll_sessions, operational.face_enroll_log FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enroll_login(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enroll_cek_sesi(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enroll_logout(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enroll_simpan_wajah(text, text, jsonb, text) TO anon, authenticated;

-- RPC lama tanpa login: cabut dari publik (fungsinya dibiarkan ada, buat rollback).
REVOKE EXECUTE ON FUNCTION public.save_face_descriptor(text, text, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enroll_face(text, jsonb, text, text) FROM PUBLIC, anon, authenticated;

-- ---------- 6. Kunci tabel faceData ----------
ALTER TABLE public."faceData" ENABLE ROW LEVEL SECURITY;   -- tanpa policy: cuma lewat RPC
REVOKE ALL ON public."faceData" FROM anon, authenticated;

-- ---------------------------------------------------------------------
-- ROLLBACK (kalau enroll bermasalah):
-- ---------------------------------------------------------------------
-- GRANT EXECUTE ON FUNCTION public.save_face_descriptor(text, text, jsonb, text) TO anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.enroll_face(text, jsonb, text, text) TO anon, authenticated;
-- ALTER TABLE public."faceData" DISABLE ROW LEVEL SECURITY;
-- GRANT ALL ON public."faceData" TO anon, authenticated;
