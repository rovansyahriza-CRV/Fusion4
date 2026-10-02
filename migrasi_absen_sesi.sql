-- =====================================================================
-- Absen wajib sesi -- TAHAP A (catat saja, belum menolak)
-- =====================================================================
-- Masalah: submit_absensi & kawan-kawan percaya QrCodeId kiriman HP. Siapa pun
-- yang tahu QrCodeId orang lain bisa mengabsenkan dia tanpa wajah/GPS.
--
-- 1. Fungsi inti (submit_absensi, submit_absensi_lembur, submit_ijin_keluar,
--    submit_pindah_lokasi) dipindah ke schema operational (tidak bisa dipanggil
--    dari luar). Di public dibuat pintu depan dengan nama sama + p_token
--    (token sesi Badge hasil badge_login).
-- 2. operational.absen_cek_sesi: token harus milik orang yang diabsen.
--    Kalau tidak -> dicatat di operational.absen_sesi_log. Selama
--    operational.absen_sesi_setelan.wajib = false (Tahap A) absen TETAP jalan.
--    Tahap B cukup: UPDATE operational.absen_sesi_setelan SET wajib = true;
--    -> pintu depan balas status NEED_PIN, halaman minta PIN Badge.
-- 3. Absen offline: kunci offline per orang per HP (dibuat saat orangnya login
--    Badge online, 30 hari). submit_absensi_offline menerima p_kunci.
--    Kalau wajib & kunci tidak cocok -> masuk log offline sebagai DITOLAK
--    (TANPA_SESI), HR tetap bisa Terima Manual.
-- 4. submit_absensi: jam selalu jam server (p_timestamp_offline dari luar
--    diabaikan; jalur offline memanggil fungsi inti langsung dengan jam HP).
-- 5. submit_absensi_reguler (tidak dipakai halaman mana pun) dicabut.
-- =====================================================================

-- ---------- Tabel ----------
CREATE TABLE IF NOT EXISTS operational.absen_sesi_setelan (
    id    integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    wajib boolean NOT NULL DEFAULT false
);
INSERT INTO operational.absen_sesi_setelan (id, wajib) VALUES (1, false) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS operational.absen_sesi_log (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    waktu        timestamptz NOT NULL DEFAULT now(),
    rpc          text NOT NULL,
    qrcodeid     text,
    alasan       text NOT NULL,          -- TANPA_TOKEN / TOKEN_HABIS / BEDA_ORANG
    pemilik_sesi bigint,                 -- karyawanTbl.Id pemilik token (kalau ada)
    ditolak      boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS absen_sesi_log_waktu ON operational.absen_sesi_log (waktu);

CREATE TABLE IF NOT EXISTS operational.absen_offline_kunci (
    kunci_hash   bytea PRIMARY KEY,
    employee_id  bigint NOT NULL,
    device       text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS absen_offline_kunci_emp ON operational.absen_offline_kunci (employee_id);

ALTER TABLE operational.absen_sesi_setelan ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational.absen_sesi_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational.absen_offline_kunci ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON operational.absen_sesi_setelan, operational.absen_sesi_log, operational.absen_offline_kunci FROM PUBLIC, anon, authenticated;

-- ---------- Pindahkan fungsi inti ke operational ----------
DO $$
BEGIN
    IF to_regprocedure('operational.submit_absensi(text,text,text,timestamptz)') IS NULL THEN
        ALTER FUNCTION public.submit_absensi(text, text, text, timestamptz) SET SCHEMA operational;
    END IF;
    IF to_regprocedure('operational.submit_absensi_lembur(text,text,text)') IS NULL THEN
        ALTER FUNCTION public.submit_absensi_lembur(text, text, text) SET SCHEMA operational;
    END IF;
    IF to_regprocedure('operational.submit_ijin_keluar(text,text,text)') IS NULL THEN
        ALTER FUNCTION public.submit_ijin_keluar(text, text, text) SET SCHEMA operational;
    END IF;
    IF to_regprocedure('operational.submit_pindah_lokasi(text,text,text,text)') IS NULL THEN
        ALTER FUNCTION public.submit_pindah_lokasi(text, text, text, text) SET SCHEMA operational;
    END IF;
END $$;

-- Fungsi inti menyebut tabel tanpa schema -> kunci search_path-nya.
ALTER FUNCTION operational.submit_absensi(text, text, text, timestamptz) SET search_path TO public, pg_temp;
ALTER FUNCTION operational.submit_absensi_lembur(text, text, text) SET search_path TO public, pg_temp;
ALTER FUNCTION operational.submit_ijin_keluar(text, text, text) SET search_path TO public, pg_temp;
ALTER FUNCTION operational.submit_pindah_lokasi(text, text, text, text) SET search_path TO public, pg_temp;
REVOKE ALL ON FUNCTION operational.submit_absensi(text, text, text, timestamptz),
                       operational.submit_absensi_lembur(text, text, text),
                       operational.submit_ijin_keluar(text, text, text),
                       operational.submit_pindah_lokasi(text, text, text, text)
    FROM PUBLIC, anon, authenticated;

-- Jalur offline memanggil fungsi inti langsung (pakai jam HP), bukan pintu depan.
DO $$
DECLARE
    v_def text := pg_get_functiondef('public._absen_offline_eksekusi(text,timestamptz,double precision,double precision,boolean)'::regprocedure);
BEGIN
    IF position('public.submit_absensi(' IN v_def) > 0 THEN
        EXECUTE replace(v_def, 'public.submit_absensi(', 'operational.submit_absensi(');
    ELSIF position('operational.submit_absensi(' IN v_def) = 0 THEN
        RAISE EXCEPTION '_absen_offline_eksekusi tidak memanggil submit_absensi seperti yang diharapkan -- batalkan';
    END IF;
END $$;

-- ---------- Cek sesi ----------
-- Hasil: 'OK' (token milik orang itu), 'LOG' (tidak cocok, dicatat, tetap jalan),
-- atau alasan penolakan (TANPA_TOKEN / TOKEN_HABIS / BEDA_ORANG) kalau wajib.
CREATE OR REPLACE FUNCTION operational.absen_cek_sesi(p_rpc text, p_qrcodeid text, p_token text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_pemilik bigint := operational.badge_sesi(p_token);
    v_qr      text;
    v_alasan  text;
    v_wajib   boolean := COALESCE((SELECT wajib FROM operational.absen_sesi_setelan WHERE id = 1), false);
BEGIN
    IF v_pemilik IS NOT NULL THEN
        SELECT upper(btrim(k."QrCodeId")) INTO v_qr FROM public."karyawanTbl" k WHERE k."Id" = v_pemilik;
        IF v_qr = upper(btrim(COALESCE(p_qrcodeid, ''))) THEN
            RETURN 'OK';
        END IF;
    END IF;
    v_alasan := CASE WHEN btrim(COALESCE(p_token, '')) = '' THEN 'TANPA_TOKEN'
                     WHEN v_pemilik IS NULL THEN 'TOKEN_HABIS'
                     ELSE 'BEDA_ORANG' END;
    INSERT INTO operational.absen_sesi_log (rpc, qrcodeid, alasan, pemilik_sesi, ditolak)
    VALUES (p_rpc, left(upper(btrim(COALESCE(p_qrcodeid, ''))), 50), v_alasan, v_pemilik, v_wajib);
    RETURN CASE WHEN v_wajib THEN v_alasan ELSE 'LOG' END;
END;
$$;

CREATE OR REPLACE FUNCTION operational.absen_butuh_pin(p_alasan text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $$
    SELECT jsonb_build_object('status', 'NEED_PIN', 'alasan', p_alasan,
        'message', CASE WHEN p_alasan = 'BEDA_ORANG'
                        THEN 'PIN yang dipakai bukan milik karyawan ini. Masukkan PIN Badge karyawan yang absen.'
                        ELSE 'Masukkan PIN Badge untuk melanjutkan absen.' END);
$$;

REVOKE ALL ON FUNCTION operational.absen_cek_sesi(text, text, text), operational.absen_butuh_pin(text) FROM PUBLIC, anon, authenticated;

-- ---------- Pintu depan (nama sama, + p_token) ----------
CREATE OR REPLACE FUNCTION public.submit_absensi(p_qrcodeid text, p_lokasi text, p_password text DEFAULT '',
                                                 p_timestamp_offline timestamptz DEFAULT NULL, p_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_cek text := operational.absen_cek_sesi('submit_absensi', p_qrcodeid, p_token);
BEGIN
    IF v_cek NOT IN ('OK', 'LOG') THEN RETURN operational.absen_butuh_pin(v_cek); END IF;
    -- Jam selalu jam server; absen offline lewat submit_absensi_offline.
    RETURN operational.submit_absensi(p_qrcodeid, p_lokasi, p_password, NULL);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_absensi_lembur(p_qrcodeid text, p_lokasi text, p_pinvoucher text, p_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_cek text := operational.absen_cek_sesi('submit_absensi_lembur', p_qrcodeid, p_token);
BEGIN
    IF v_cek NOT IN ('OK', 'LOG') THEN RETURN operational.absen_butuh_pin(v_cek); END IF;
    RETURN operational.submit_absensi_lembur(p_qrcodeid, p_lokasi, p_pinvoucher);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_ijin_keluar(p_qrcodeid text, p_lokasi text, p_kodeijin text, p_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_cek text := operational.absen_cek_sesi('submit_ijin_keluar', p_qrcodeid, p_token);
BEGIN
    IF v_cek NOT IN ('OK', 'LOG') THEN RETURN operational.absen_butuh_pin(v_cek); END IF;
    RETURN operational.submit_ijin_keluar(p_qrcodeid, p_lokasi, p_kodeijin);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_pindah_lokasi(p_qrcode text, p_lokasi_tujuan text, p_alasan text DEFAULT '',
                                                       p_lokasi_lama text DEFAULT '', p_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_cek text := operational.absen_cek_sesi('submit_pindah_lokasi', p_qrcode, p_token);
BEGIN
    IF v_cek NOT IN ('OK', 'LOG') THEN RETURN operational.absen_butuh_pin(v_cek); END IF;
    RETURN operational.submit_pindah_lokasi(p_qrcode, p_lokasi_tujuan, p_alasan, p_lokasi_lama);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_absensi(text, text, text, timestamptz, text),
                       public.submit_absensi_lembur(text, text, text, text),
                       public.submit_ijin_keluar(text, text, text, text),
                       public.submit_pindah_lokasi(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_absensi(text, text, text, timestamptz, text),
                          public.submit_absensi_lembur(text, text, text, text),
                          public.submit_ijin_keluar(text, text, text, text),
                          public.submit_pindah_lokasi(text, text, text, text, text) TO anon, authenticated;

-- ---------- Kunci absen offline ----------
-- Dipanggil Badge/halaman absen saat online & sudah login PIN. Satu kunci per
-- orang per HP (device), berlaku 30 hari, maks 5 HP per orang.
CREATE OR REPLACE FUNCTION public.absen_offline_kunci_buat(p_token text, p_device text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_id     bigint := operational.badge_sesi(p_token);
    v_device text := left(COALESCE(NULLIF(btrim(p_device), ''), 'unknown'), 64);
    v_kunci  text;
    v_qr     text;
BEGIN
    IF v_id IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi Badge habis.');
    END IF;
    SELECT upper(btrim(k."QrCodeId")) INTO v_qr FROM public."karyawanTbl" k WHERE k."Id" = v_id;

    DELETE FROM operational.absen_offline_kunci
    WHERE expires_at < now() OR (employee_id = v_id AND device = v_device);
    DELETE FROM operational.absen_offline_kunci
    WHERE kunci_hash IN (SELECT kunci_hash FROM operational.absen_offline_kunci WHERE employee_id = v_id
                         ORDER BY created_at DESC OFFSET 4);

    v_kunci := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO operational.absen_offline_kunci (kunci_hash, employee_id, device, expires_at)
    VALUES (sha256(convert_to(v_kunci, 'UTF8')), v_id, v_device, now() + interval '30 days');

    RETURN jsonb_build_object('status', 'OK', 'kunci', v_kunci, 'qrCodeId', v_qr, 'expiresAt', now() + interval '30 days');
END;
$$;

REVOKE ALL ON FUNCTION public.absen_offline_kunci_buat(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.absen_offline_kunci_buat(text, text) TO anon, authenticated;

-- ---------- submit_absensi_offline + p_kunci ----------
DROP FUNCTION IF EXISTS public.submit_absensi_offline(text, text, timestamptz, double precision, double precision, text);

CREATE OR REPLACE FUNCTION public.submit_absensi_offline(p_client_id text, p_qrcodeid text, p_waktu_hp timestamptz,
                                                         p_lat double precision DEFAULT NULL, p_lng double precision DEFAULT NULL,
                                                         p_device_info text DEFAULT '', p_kunci text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
    v_log     public.absensi_offline_log;
    v_r       jsonb;
    v_pemilik bigint;
    v_qr      text;
    v_alasan  text;
    v_wajib   boolean := COALESCE((SELECT wajib FROM operational.absen_sesi_setelan WHERE id = 1), false);
BEGIN
    IF COALESCE(TRIM(p_client_id), '') = '' OR COALESCE(TRIM(p_qrcodeid), '') = '' OR p_waktu_hp IS NULL THEN
        RETURN jsonb_build_object('status', 'DITOLAK', 'kode', 'DATA_TIDAK_LENGKAP', 'message', 'Data antrian offline tidak lengkap.');
    END IF;

    -- Kunci per client_id biar 2 sync barengan (mis. 2 tab) gak dobel eksekusi.
    PERFORM pg_advisory_xact_lock(hashtext('absen_offline:' || p_client_id));

    SELECT * INTO v_log FROM public.absensi_offline_log WHERE client_id = p_client_id;
    IF v_log.id IS NOT NULL THEN
        RETURN jsonb_build_object('status', v_log.status, 'kode', v_log.kode_tolak, 'message', v_log.pesan,
                                  'slot', v_log.slot, 'nama', v_log.nama, 'duplikat', TRUE);
    END IF;

    -- Kunci offline harus milik orang yang diabsen.
    SELECT o.employee_id INTO v_pemilik FROM operational.absen_offline_kunci o
    WHERE o.kunci_hash = sha256(convert_to(COALESCE(p_kunci, ''), 'UTF8')) AND o.expires_at > now();
    IF v_pemilik IS NOT NULL THEN
        SELECT upper(btrim(k."QrCodeId")) INTO v_qr FROM public."karyawanTbl" k WHERE k."Id" = v_pemilik;
    END IF;
    IF v_qr IS NOT NULL AND v_qr = upper(btrim(p_qrcodeid)) THEN
        UPDATE operational.absen_offline_kunci SET last_used_at = now()
        WHERE kunci_hash = sha256(convert_to(p_kunci, 'UTF8'));
    ELSE
        v_alasan := CASE WHEN btrim(COALESCE(p_kunci, '')) = '' THEN 'TANPA_TOKEN'
                         WHEN v_pemilik IS NULL THEN 'TOKEN_HABIS' ELSE 'BEDA_ORANG' END;
        INSERT INTO operational.absen_sesi_log (rpc, qrcodeid, alasan, pemilik_sesi, ditolak)
        VALUES ('submit_absensi_offline', left(upper(btrim(p_qrcodeid)), 50), v_alasan, v_pemilik, v_wajib);
    END IF;

    IF v_alasan IS NOT NULL AND v_wajib THEN
        v_r := jsonb_build_object('status', 'DITOLAK', 'kode', 'TANPA_SESI',
            'message', 'Absen offline tanpa kunci HP yang sah. Minta HR untuk Terima Manual bila absen ini benar.');
    ELSE
        v_r := public._absen_offline_eksekusi(p_qrcodeid, p_waktu_hp, p_lat, p_lng, FALSE);
    END IF;

    INSERT INTO public.absensi_offline_log (
        client_id, qrcodeid, nama, tanggal, waktu_hp, lat, lng, lokasi, jarak_m, device_info, status, kode_tolak, slot, pesan
    ) VALUES (
        p_client_id, UPPER(TRIM(p_qrcodeid)), v_r->>'nama', (p_waktu_hp AT TIME ZONE 'Asia/Makassar')::DATE, p_waktu_hp,
        p_lat, p_lng, v_r->>'lokasi', (v_r->>'jarak')::INT, LEFT(COALESCE(p_device_info, ''), 300),
        v_r->>'status', v_r->>'kode', v_r->>'slot', v_r->>'message'
    );
    RETURN v_r;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_absensi_offline(text, text, timestamptz, double precision, double precision, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_absensi_offline(text, text, timestamptz, double precision, double precision, text, text) TO anon, authenticated;

-- ---------- Cabut yang tidak dipakai ----------
DO $$
BEGIN
    IF to_regprocedure('public.submit_absensi_reguler(text,text,timestamptz)') IS NOT NULL THEN
        REVOKE EXECUTE ON FUNCTION public.submit_absensi_reguler(text, text, timestamptz) FROM PUBLIC, anon, authenticated;
    END IF;
END $$;

-- ---------------------------------------------------------------------
-- PANTAU TAHAP A:
--   SELECT rpc, alasan, count(*), max(waktu) FROM operational.absen_sesi_log
--   WHERE waktu > now() - interval '3 days' GROUP BY 1, 2 ORDER BY 3 DESC;
-- TAHAP B (tegakkan):  UPDATE operational.absen_sesi_setelan SET wajib = true;
-- Batal tegakkan:      UPDATE operational.absen_sesi_setelan SET wajib = false;
-- ---------------------------------------------------------------------
