-- =====================================================================
-- Absen Sidik Jari (WebAuthn / passkey bawaan HP)
-- =====================================================================
-- Aturan:
--   * 1 orang = 1 sidik jari terdaftar (1 HP); 1 HP (device id Badge) = 1 orang.
--   * Daftar & absen wajib sesi Badge (token badge_login). Online-only.
--   * Sidik jari TIDAK pernah dikirim ke server -- yang disimpan cuma kunci
--     publik dari HP. Tanda tangan dicek di Edge Function "sidik-jari"
--     (pakai SUPABASE_DB_URL, memanggil fungsi operational.sj_* di bawah).
--   * Reset (ganti/hilang HP) oleh petugas dengan tag PIC FP / ALL / *,
--     atau Author ALL / * / ADMIN, lewat halaman enroll_fusion4 (login PIN).
--   * Semua kejadian (daftar, verifikasi absen, gagal, reset) di
--     operational.sidik_jari_log -- jadi sumber kolom "Metode" laporan.
-- =====================================================================

-- ---------- Tabel ----------
CREATE TABLE IF NOT EXISTS operational.sidik_jari (
    employee_id   bigint PRIMARY KEY,
    credential_id text NOT NULL UNIQUE,
    public_key    text NOT NULL,           -- COSE public key, base64url
    sign_count    bigint NOT NULL DEFAULT 0,
    transports    text,
    device        text NOT NULL UNIQUE,    -- fusion4BadgeDevice di HP itu
    device_label  text,                    -- mis. "Samsung SM-A155F"
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz
);

CREATE TABLE IF NOT EXISTS operational.sidik_jari_tantangan (
    employee_id bigint NOT NULL,
    jenis       text NOT NULL CHECK (jenis IN ('daftar', 'absen')),
    challenge   text NOT NULL,
    device      text NOT NULL,
    expires_at  timestamptz NOT NULL,
    PRIMARY KEY (employee_id, jenis)
);

CREATE TABLE IF NOT EXISTS operational.sidik_jari_log (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    waktu       timestamptz NOT NULL DEFAULT now(),
    employee_id bigint,
    aksi        text NOT NULL,             -- DAFTAR / VERIFIKASI / GAGAL / RESET
    oleh        bigint,                    -- petugas (RESET)
    device      text,
    device_label text,
    info        text
);
CREATE INDEX IF NOT EXISTS sidik_jari_log_emp ON operational.sidik_jari_log (employee_id, waktu);

ALTER TABLE operational.sidik_jari ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational.sidik_jari_tantangan ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational.sidik_jari_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON operational.sidik_jari, operational.sidik_jari_tantangan, operational.sidik_jari_log FROM PUBLIC, anon, authenticated;

-- ---------- Hak reset ----------
CREATE OR REPLACE FUNCTION operational.sidik_jari_boleh_reset(p_id bigint)
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
              operational.tokens(COALESCE(NULLIF(btrim(p."PIC"), ''), p.pic)) && ARRAY['fp', 'all', '*']
              OR operational.tokens(p."Author") && ARRAY['all', '*', 'admin']
          )
    );
$$;

-- Nama disamarkan untuk pesan "HP ini sudah dipakai ..." (Andi Saputra -> An*** S.)
CREATE OR REPLACE FUNCTION operational.sj_nama_samar(p_nama text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $$
    SELECT CASE WHEN btrim(COALESCE(p_nama, '')) = '' THEN 'orang lain'
        ELSE left(split_part(btrim(p_nama), ' ', 1), 2) || '***'
             || CASE WHEN split_part(btrim(p_nama), ' ', 2) <> ''
                     THEN ' ' || left(split_part(btrim(p_nama), ' ', 2), 1) || '.' ELSE '' END
        END;
$$;

-- ---------- Dipanggil Edge Function (bukan dari browser) ----------
-- Mulai daftar / absen: cek sesi + aturan 1 orang 1 HP, simpan tantangan (3 menit).
CREATE OR REPLACE FUNCTION operational.sj_mulai(p_token text, p_device text, p_jenis text, p_challenge text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_id     bigint := operational.badge_sesi(p_token);
    v_device text := left(btrim(COALESCE(p_device, '')), 64);
    v_kar    record;
    v_cred   operational.sidik_jari;
    v_lain   record;
BEGIN
    IF v_id IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi Badge habis. Buka Badge dan masukkan PIN lagi.');
    END IF;
    IF v_device = '' OR p_jenis NOT IN ('daftar', 'absen') OR length(COALESCE(p_challenge, '')) < 32 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Permintaan tidak lengkap.');
    END IF;
    SELECT k."NamaPersonnel" AS nama, upper(btrim(k."QrCodeId")) AS qr INTO v_kar FROM public."karyawanTbl" k WHERE k."Id" = v_id;
    SELECT * INTO v_cred FROM operational.sidik_jari WHERE employee_id = v_id;

    IF p_jenis = 'daftar' THEN
        IF v_cred.employee_id IS NOT NULL THEN
            RETURN jsonb_build_object('status', 'SUDAH_TERDAFTAR', 'diHpIni', v_cred.device = v_device,
                'perangkat', v_cred.device_label,
                'message', CASE WHEN v_cred.device = v_device THEN 'Sidik jari sudah aktif di HP ini.'
                                ELSE 'Sidik jari Anda sudah terdaftar di HP lain (' || COALESCE(v_cred.device_label, '-') || '). Minta reset ke HR/PIC dulu.' END);
        END IF;
        SELECT s.employee_id, k."NamaPersonnel" AS nama INTO v_lain
        FROM operational.sidik_jari s LEFT JOIN public."karyawanTbl" k ON k."Id" = s.employee_id
        WHERE s.device = v_device;
        IF v_lain.employee_id IS NOT NULL THEN
            RETURN jsonb_build_object('status', 'HP_DIPAKAI', 'pemilik', operational.sj_nama_samar(v_lain.nama),
                'message', 'HP ini sudah dipakai sidik jari ' || operational.sj_nama_samar(v_lain.nama) || '. 1 HP hanya untuk 1 orang.');
        END IF;
    ELSE
        IF v_cred.employee_id IS NULL THEN
            RETURN jsonb_build_object('status', 'BELUM_TERDAFTAR', 'message', 'Sidik jari belum didaftarkan. Daftarkan dulu dari Digital Badge.');
        END IF;
        IF v_cred.device <> v_device THEN
            RETURN jsonb_build_object('status', 'HP_LAIN', 'perangkat', v_cred.device_label,
                'message', 'Sidik jari Anda terdaftar di HP lain (' || COALESCE(v_cred.device_label, '-') || '). Di HP ini silakan pakai Scan Wajah, atau minta reset ke HR/PIC.');
        END IF;
    END IF;

    DELETE FROM operational.sidik_jari_tantangan WHERE expires_at < now() OR (employee_id = v_id AND jenis = p_jenis);
    INSERT INTO operational.sidik_jari_tantangan (employee_id, jenis, challenge, device, expires_at)
    VALUES (v_id, p_jenis, p_challenge, v_device, now() + interval '3 minutes');

    RETURN jsonb_build_object('status', 'OK', 'employeeId', v_id, 'qrCodeId', v_kar.qr, 'nama', v_kar.nama,
        'credentialId', v_cred.credential_id, 'transports', v_cred.transports);
END;
$$;

-- Ambil tantangan (sekali pakai) + kunci publik untuk verifikasi.
CREATE OR REPLACE FUNCTION operational.sj_tantangan_pakai(p_token text, p_jenis text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_id   bigint := operational.badge_sesi(p_token);
    v_t    operational.sidik_jari_tantangan;
    v_cred operational.sidik_jari;
BEGIN
    IF v_id IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi Badge habis. Buka Badge dan masukkan PIN lagi.');
    END IF;
    DELETE FROM operational.sidik_jari_tantangan WHERE employee_id = v_id AND jenis = p_jenis RETURNING * INTO v_t;
    IF v_t.employee_id IS NULL OR v_t.expires_at < now() THEN
        RETURN jsonb_build_object('status', 'TANTANGAN_HABIS', 'message', 'Waktu habis. Silakan coba lagi.');
    END IF;
    SELECT * INTO v_cred FROM operational.sidik_jari WHERE employee_id = v_id;
    RETURN jsonb_build_object('status', 'OK', 'employeeId', v_id, 'challenge', v_t.challenge, 'device', v_t.device,
        'credentialId', v_cred.credential_id, 'publicKey', v_cred.public_key, 'counter', v_cred.sign_count,
        'transports', v_cred.transports);
END;
$$;

-- Simpan pendaftaran yang tanda tangannya sudah dicek Edge Function.
CREATE OR REPLACE FUNCTION operational.sj_daftar_simpan(p_token text, p_device text, p_label text, p_credential_id text,
                                                        p_public_key text, p_counter bigint, p_transports text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_id     bigint := operational.badge_sesi(p_token);
    v_device text := left(btrim(COALESCE(p_device, '')), 64);
    v_label  text := NULLIF(left(btrim(COALESCE(p_label, '')), 80), '');
BEGIN
    IF v_id IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi Badge habis. Buka Badge dan masukkan PIN lagi.');
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('sidik-jari', 0));
    IF EXISTS (SELECT 1 FROM operational.sidik_jari WHERE employee_id = v_id) THEN
        RETURN jsonb_build_object('status', 'SUDAH_TERDAFTAR', 'message', 'Sidik jari Anda sudah terdaftar.');
    END IF;
    IF EXISTS (SELECT 1 FROM operational.sidik_jari WHERE device = v_device) THEN
        RETURN jsonb_build_object('status', 'HP_DIPAKAI', 'message', 'HP ini sudah dipakai sidik jari orang lain.');
    END IF;
    IF EXISTS (SELECT 1 FROM operational.sidik_jari WHERE credential_id = p_credential_id) THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Kunci sidik jari ini sudah dipakai.');
    END IF;
    INSERT INTO operational.sidik_jari (employee_id, credential_id, public_key, sign_count, transports, device, device_label)
    VALUES (v_id, p_credential_id, p_public_key, COALESCE(p_counter, 0), NULLIF(p_transports, ''), v_device, v_label);
    INSERT INTO operational.sidik_jari_log (employee_id, aksi, device, device_label) VALUES (v_id, 'DAFTAR', v_device, v_label);
    RETURN jsonb_build_object('status', 'OK', 'perangkat', v_label, 'message', 'Sidik jari aktif di HP ini.');
END;
$$;

-- Absen: tanda tangan sah -> perbarui counter + catat VERIFIKASI.
CREATE OR REPLACE FUNCTION operational.sj_verifikasi_ok(p_token text, p_credential_id text, p_counter bigint, p_device text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_id   bigint := operational.badge_sesi(p_token);
    v_cred operational.sidik_jari;
    v_kar  record;
BEGIN
    IF v_id IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi Badge habis. Buka Badge dan masukkan PIN lagi.');
    END IF;
    UPDATE operational.sidik_jari
    SET sign_count = GREATEST(sign_count, COALESCE(p_counter, 0)), last_used_at = now()
    WHERE employee_id = v_id AND credential_id = p_credential_id AND device = left(btrim(COALESCE(p_device, '')), 64)
    RETURNING * INTO v_cred;
    IF v_cred.employee_id IS NULL THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Sidik jari tidak terdaftar untuk HP ini.');
    END IF;
    SELECT k."NamaPersonnel" AS nama, upper(btrim(k."QrCodeId")) AS qr INTO v_kar FROM public."karyawanTbl" k WHERE k."Id" = v_id;
    INSERT INTO operational.sidik_jari_log (employee_id, aksi, device, device_label) VALUES (v_id, 'VERIFIKASI', v_cred.device, v_cred.device_label);
    RETURN jsonb_build_object('status', 'OK', 'nama', v_kar.nama, 'qrCodeId', v_kar.qr, 'perangkat', v_cred.device_label);
END;
$$;

CREATE OR REPLACE FUNCTION operational.sj_catat_gagal(p_token text, p_device text, p_info text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
    INSERT INTO operational.sidik_jari_log (employee_id, aksi, device, info)
    VALUES (operational.badge_sesi(p_token), 'GAGAL', left(COALESCE(p_device, ''), 64), left(COALESCE(p_info, ''), 300));
$$;

REVOKE ALL ON FUNCTION operational.sidik_jari_boleh_reset(bigint), operational.sj_nama_samar(text),
    operational.sj_mulai(text, text, text, text), operational.sj_tantangan_pakai(text, text),
    operational.sj_daftar_simpan(text, text, text, text, text, bigint, text),
    operational.sj_verifikasi_ok(text, text, bigint, text), operational.sj_catat_gagal(text, text, text)
    FROM PUBLIC, anon, authenticated;

-- ---------- Dipanggil browser ----------
-- Status untuk Badge & halaman absen (pakai sesi Badge).
CREATE OR REPLACE FUNCTION public.sidik_jari_status(p_token text, p_device text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_id   bigint := operational.badge_sesi(p_token);
    v_cred operational.sidik_jari;
BEGIN
    IF v_id IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED');
    END IF;
    SELECT * INTO v_cred FROM operational.sidik_jari WHERE employee_id = v_id;
    RETURN jsonb_build_object('status', 'OK',
        'terdaftar', v_cred.employee_id IS NOT NULL,
        'diHpIni', v_cred.employee_id IS NOT NULL AND v_cred.device = left(btrim(COALESCE(p_device, '')), 64),
        'hpDipakaiOrangLain', v_cred.employee_id IS NULL
            AND EXISTS (SELECT 1 FROM operational.sidik_jari s WHERE s.device = left(btrim(COALESCE(p_device, '')), 64)),
        'perangkat', v_cred.device_label,
        'sejak', v_cred.created_at);
END;
$$;

-- Daftar perangkat untuk petugas (halaman enroll, sesi enroll + hak FP).
CREATE OR REPLACE FUNCTION public.sidik_jari_perangkat(p_token text)
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
    IF NOT operational.sidik_jari_boleh_reset(v_id) THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Kamu belum punya hak Reset Sidik Jari (tag FP).');
    END IF;
    RETURN jsonb_build_object('status', 'OK', 'data', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'employeeId', s.employee_id, 'nama', k."NamaPersonnel", 'qrCodeId', k."QrCodeId",
                   'perangkat', s.device_label, 'didaftarkan', s.created_at, 'terakhirDipakai', s.last_used_at,
                   'absen30', (SELECT count(*) FROM operational.sidik_jari_log l
                               WHERE l.employee_id = s.employee_id AND l.aksi = 'VERIFIKASI' AND l.waktu > now() - interval '30 days'))
               ORDER BY k."NamaPersonnel")
        FROM operational.sidik_jari s LEFT JOIN public."karyawanTbl" k ON k."Id" = s.employee_id), '[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.sidik_jari_reset(p_token text, p_employee_id bigint, p_alasan text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_petugas bigint := operational.enroll_sesi(p_token);
    v_alasan  text := left(btrim(COALESCE(p_alasan, '')), 300);
    v_cred    operational.sidik_jari;
BEGIN
    IF v_petugas IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis. Masukkan PIN lagi.');
    END IF;
    IF NOT operational.sidik_jari_boleh_reset(v_petugas) THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Kamu belum punya hak Reset Sidik Jari (tag FP).');
    END IF;
    IF length(v_alasan) < 5 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Alasan reset wajib diisi (minimal 5 huruf).');
    END IF;
    DELETE FROM operational.sidik_jari WHERE employee_id = p_employee_id RETURNING * INTO v_cred;
    IF v_cred.employee_id IS NULL THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'Karyawan ini tidak punya sidik jari terdaftar.');
    END IF;
    DELETE FROM operational.sidik_jari_tantangan WHERE employee_id = p_employee_id;
    INSERT INTO operational.sidik_jari_log (employee_id, aksi, oleh, device, device_label, info)
    VALUES (p_employee_id, 'RESET', v_petugas, v_cred.device, v_cred.device_label, v_alasan);
    RETURN jsonb_build_object('status', 'OK', 'message', 'Sidik jari direset. Karyawan bisa daftar ulang di HP barunya.');
END;
$$;

REVOKE ALL ON FUNCTION public.sidik_jari_status(text, text), public.sidik_jari_perangkat(text),
    public.sidik_jari_reset(text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sidik_jari_status(text, text), public.sidik_jari_perangkat(text),
    public.sidik_jari_reset(text, bigint, text) TO anon, authenticated;

-- ---------- Login halaman enroll: petugas FP juga boleh masuk ----------
-- enroll_simpan_wajah tetap cek hak EN, jadi petugas FP saja tidak bisa simpan wajah.
DO $$
DECLARE
    v_cari text := 'IF NOT operational.enroll_punya_hak(v_id) THEN';
    v_ganti text := 'IF NOT (operational.enroll_punya_hak(v_id) OR operational.sidik_jari_boleh_reset(v_id)) THEN';
    v_ok_cari text := '''status'', ''OK'',';
    v_ok_ganti text := '''status'', ''OK'', ''hakEnroll'', operational.enroll_punya_hak(v_id), ''hakResetJari'', operational.sidik_jari_boleh_reset(v_id),';
    f text;
    v_def text;
BEGIN
    FOREACH f IN ARRAY ARRAY['public.enroll_login(text,text)', 'public.enroll_cek_sesi(text)'] LOOP
        v_def := pg_get_functiondef(f::regprocedure);
        CONTINUE WHEN position('sidik_jari_boleh_reset' IN v_def) > 0;  -- sudah dipatch
        IF position(v_cari IN v_def) = 0 OR position(v_ok_cari IN v_def) = 0 THEN
            RAISE EXCEPTION '% tidak sesuai yang diharapkan -- batalkan', f;
        END IF;
        v_def := replace(replace(v_def, v_cari, v_ganti), v_ok_cari, v_ok_ganti);
        v_def := replace(v_def, 'Kamu belum punya hak Enroll Wajah. Minta admin isi EN di kolom PIC.',
                                'Kamu belum punya hak Enroll Wajah / Reset Sidik Jari. Minta admin isi EN atau FP di kolom PIC.');
        EXECUTE v_def;
    END LOOP;

    -- Simpan wajah tanpa hak EN: jangan hapus sesi petugas FP (cukup tolak).
    v_def := pg_get_functiondef('public.enroll_simpan_wajah(text,text,jsonb,text)'::regprocedure);
    IF position('sidik_jari_boleh_reset' IN v_def) = 0 THEN
        v_cari := 'DELETE FROM operational.enroll_sessions WHERE employee_id = v_petugas;';
        IF position(v_cari IN v_def) = 0 THEN
            RAISE EXCEPTION 'enroll_simpan_wajah tidak sesuai yang diharapkan -- batalkan';
        END IF;
        v_def := replace(v_def, v_cari,
            'IF NOT operational.sidik_jari_boleh_reset(v_petugas) THEN ' || v_cari || ' END IF;');
        v_def := replace(v_def, '''Hak Enroll Wajah kamu sudah dicabut.''',
            '''Kamu tidak punya hak Enroll Wajah (tag EN).''');
        EXECUTE v_def;
    END IF;
END $$;

-- ---------------------------------------------------------------------
-- ROLLBACK: DROP FUNCTION public.sidik_jari_status(text,text), public.sidik_jari_perangkat(text),
--   public.sidik_jari_reset(text,bigint,text); hapus Edge Function "sidik-jari";
--   enroll_login/enroll_cek_sesi: jalankan ulang definisinya dari migrasi_enroll_wajah_login.sql.
-- ---------------------------------------------------------------------
