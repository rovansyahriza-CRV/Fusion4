-- =====================================================================================
-- ABSEN OFFLINE (HP pribadi) -- buat site blank spot
-- Tanggal: 2026-09-29
-- =====================================================================================
-- ALUR:
-- 1. Pas online, Digital Badge / halaman Absen manggil get_offline_pack(qr) -> HP nyimpen
--    wajah DIA SENDIRI + daftar lokasi aktif (radius geofence). Tanpa data orang lain.
-- 2. Pas offline, HP cek geofence + wajah 1:1 lokal, lalu simpan antrian (jam asli HP).
-- 3. Begitu ada sinyal, antrian dikirim ke submit_absensi_offline(). Server cek ulang:
--      - jam HP tidak boleh lebih maju dari jam server (toleransi 5 menit)
--      - tanggal absen HARUS sama dengan tanggal sync (WITA)  -> kalau beda: DITOLAK
--        kode BEDA_HARI, HR bisa "Terima Manual" dari Monitoring > Log Offline
--      - GPS dicek ulang ke radius lokasi aktif
--      - karyawan AuthCheck / lembur SPKL / butuh password -> DITOLAK (butuh internet)
--    Lolos semua -> diteruskan ke submit_absensi() pakai jam asli HP (slot tetap
--    ditentukan server). SEMUA hasil (diterima / ditolak) dicatat di absensi_offline_log.
-- 4. client_id (UUID dari HP) bikin sync idempotent: kirim ulang = jawaban yang sama,
--    gak dobel absen.
-- =====================================================================================

CREATE TABLE IF NOT EXISTS public.absensi_offline_log (
    id            BIGSERIAL PRIMARY KEY,
    client_id     TEXT NOT NULL UNIQUE,
    qrcodeid      TEXT NOT NULL,
    nama          TEXT,
    tanggal       DATE NOT NULL,                 -- tanggal absen (WITA, dari jam HP)
    waktu_hp      TIMESTAMPTZ NOT NULL,          -- jam absen asli di HP
    waktu_sync    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lat           DOUBLE PRECISION,
    lng           DOUBLE PRECISION,
    lokasi        TEXT,
    jarak_m       INT,
    device_info   TEXT,
    status        TEXT NOT NULL,                 -- DITERIMA / DITOLAK / DITERIMA_MANUAL
    kode_tolak    TEXT,                          -- BEDA_HARI / JAM_HP_MAJU / LUAR_RADIUS / BUTUH_INTERNET / TIDAK_DIKENAL / DITOLAK_SERVER
    slot          TEXT,
    pesan         TEXT,
    diproses_oleh BIGINT,                        -- Id karyawan HR yang Terima Manual
    diproses_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS absensi_offline_log_tanggal_idx ON public.absensi_offline_log (tanggal);
CREATE INDEX IF NOT EXISTS absensi_offline_log_qr_idx ON public.absensi_offline_log (UPPER(TRIM(qrcodeid)));

-- Tabel cuma boleh diakses lewat RPC di bawah.
ALTER TABLE public.absensi_offline_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.absensi_offline_log FROM anon, authenticated;


-- -------------------------------------------------------------------------------------
-- 1. PAKET OFFLINE: wajah sendiri + daftar lokasi aktif
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_offline_pack(p_qrcode TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_kar RECORD;
    v_descriptor JSONB;
    v_lokasi JSONB;
BEGIN
    SELECT "QrCodeId", "NamaPersonnel", "Kualifikasi", COALESCE("AuthCheck", FALSE) AS auth_check
    INTO v_kar
    FROM "karyawanTbl"
    WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcode))
      AND COALESCE("IsActive", TRUE)
    LIMIT 1;

    IF v_kar."QrCodeId" IS NULL THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'Karyawan tidak ditemukan / tidak aktif.');
    END IF;

    SELECT "Descriptor" INTO v_descriptor
    FROM "faceData"
    WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcode)) AND "Descriptor" IS NOT NULL
    ORDER BY "UpdatedAt" DESC NULLS LAST
    LIMIT 1;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'nama', l."NamaLokasi",
               'lat', l."Latitude",
               'lng', l."Longitude",
               'radius', COALESCE(l."Radius", 100)
           ) ORDER BY l."NamaLokasi"), '[]'::JSONB)
    INTO v_lokasi
    FROM "lokasiTbl" l
    WHERE UPPER(TRIM(COALESCE(l."Status", 'ACTIVE'))) = 'ACTIVE'
      AND l."Latitude" IS NOT NULL AND l."Longitude" IS NOT NULL;

    RETURN jsonb_build_object(
        'status', 'OK',
        'qrCodeId', UPPER(TRIM(v_kar."QrCodeId")),
        'nama', v_kar."NamaPersonnel",
        'kualifikasi', v_kar."Kualifikasi",
        'needAuth', v_kar.auth_check,
        'descriptor', v_descriptor,
        'lokasi', v_lokasi,
        'serverTime', NOW()
    );
END;
$function$;


-- -------------------------------------------------------------------------------------
-- 2. INTI: validasi + teruskan ke submit_absensi (dipakai sync & Terima Manual HR)
--    p_abaikan_tanggal = TRUE cuma buat Terima Manual (cek "hari yang sama" dilewati).
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._absen_offline_eksekusi(
    p_qrcodeid TEXT,
    p_waktu_hp TIMESTAMPTZ,
    p_lat DOUBLE PRECISION,
    p_lng DOUBLE PRECISION,
    p_abaikan_tanggal BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_nama TEXT;
    v_auth BOOLEAN;
    v_tgl DATE;
    v_today DATE;
    v_loc_nama TEXT;
    v_loc_radius INT;
    v_loc_jarak INT;
    v_res JSONB;
    v_res_status TEXT;
    v_status TEXT := 'DITOLAK';
    v_kode TEXT;
    v_pesan TEXT;
    v_slot TEXT;
BEGIN
    v_tgl := (p_waktu_hp AT TIME ZONE 'Asia/Makassar')::DATE;
    v_today := (NOW() AT TIME ZONE 'Asia/Makassar')::DATE;

    SELECT "NamaPersonnel", COALESCE("AuthCheck", FALSE)
    INTO v_nama, v_auth
    FROM "karyawanTbl"
    WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcodeid))
      AND COALESCE("IsActive", TRUE)
    LIMIT 1;

    -- Lokasi terdekat (rumus sama dengan find_nearest_location)
    IF p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
        SELECT l."NamaLokasi",
               COALESCE(l."Radius", 100)::INT,
               ROUND(6371000 * 2 * ASIN(SQRT(
                   POWER(SIN(RADIANS(p_lat - l."Latitude") / 2), 2) +
                   COS(RADIANS(p_lat)) * COS(RADIANS(l."Latitude")) *
                   POWER(SIN(RADIANS(p_lng - l."Longitude") / 2), 2)
               )))::INT AS jarak
        INTO v_loc_nama, v_loc_radius, v_loc_jarak
        FROM "lokasiTbl" l
        WHERE UPPER(TRIM(COALESCE(l."Status", 'ACTIVE'))) = 'ACTIVE'
          AND l."Latitude" IS NOT NULL AND l."Longitude" IS NOT NULL
        ORDER BY 3 ASC
        LIMIT 1;
    END IF;

    IF v_nama IS NULL THEN
        v_kode := 'TIDAK_DIKENAL';
        v_pesan := 'Karyawan ' || COALESCE(p_qrcodeid, '-') || ' tidak ditemukan / tidak aktif.';
    ELSIF p_waktu_hp > NOW() + INTERVAL '5 minutes' THEN
        v_kode := 'JAM_HP_MAJU';
        v_pesan := 'Jam HP lebih maju dari jam server (' ||
                   TO_CHAR(p_waktu_hp AT TIME ZONE 'Asia/Makassar', 'DD/MM HH24:MI') || ' vs ' ||
                   TO_CHAR(NOW() AT TIME ZONE 'Asia/Makassar', 'DD/MM HH24:MI') || ' WITA).';
    ELSIF NOT p_abaikan_tanggal AND v_tgl <> v_today THEN
        v_kode := 'BEDA_HARI';
        v_pesan := 'Absen offline tanggal ' || TO_CHAR(v_tgl, 'DD/MM/YYYY') ||
                   ' baru tersinkron tanggal ' || TO_CHAR(v_today, 'DD/MM/YYYY') ||
                   '. Menunggu Terima Manual dari HR.';
    ELSIF v_auth THEN
        v_kode := 'BUTUH_INTERNET';
        v_pesan := 'Karyawan dengan password otorisasi (AuthCheck) wajib absen online.';
    ELSIF v_loc_nama IS NULL THEN
        v_kode := 'LUAR_RADIUS';
        v_pesan := 'Koordinat GPS tidak terbaca saat absen offline.';
    ELSIF v_loc_jarak > v_loc_radius THEN
        v_kode := 'LUAR_RADIUS';
        v_pesan := 'Di luar radius ' || v_loc_nama || ' (' || v_loc_jarak || 'm dari batas ' || v_loc_radius || 'm).';
    ELSE
        v_res := public.submit_absensi(p_qrcodeid, v_loc_nama, '', p_waktu_hp);
        v_res_status := UPPER(COALESCE(v_res->>'status', ''));
        v_pesan := v_res->>'message';

        IF v_res_status = 'SUKSES' THEN
            v_status := 'DITERIMA';
            v_slot := v_res->>'slot';
        ELSIF v_res_status = 'NEED_VOUCHER' THEN
            v_kode := 'BUTUH_INTERNET';
            v_pesan := 'Sesi reguler sudah CLOSED. Absen lembur (PIN SPKL) wajib online.';
        ELSIF v_res_status = 'NEED_PASSWORD' THEN
            v_kode := 'BUTUH_INTERNET';
            v_pesan := 'Butuh password otorisasi, wajib absen online.';
        ELSE
            v_kode := 'DITOLAK_SERVER';
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'status', v_status,
        'kode', v_kode,
        'message', v_pesan,
        'slot', v_slot,
        'nama', v_nama,
        'tanggal', v_tgl,
        'lokasi', v_loc_nama,
        'jarak', v_loc_jarak
    );
END;
$function$;

REVOKE ALL ON FUNCTION public._absen_offline_eksekusi(TEXT, TIMESTAMPTZ, DOUBLE PRECISION, DOUBLE PRECISION, BOOLEAN) FROM PUBLIC, anon, authenticated;


-- -------------------------------------------------------------------------------------
-- 3. SYNC dari HP (idempotent per client_id)
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_absensi_offline(
    p_client_id TEXT,
    p_qrcodeid TEXT,
    p_waktu_hp TIMESTAMPTZ,
    p_lat DOUBLE PRECISION DEFAULT NULL,
    p_lng DOUBLE PRECISION DEFAULT NULL,
    p_device_info TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_log public.absensi_offline_log;
    v_r JSONB;
BEGIN
    IF COALESCE(TRIM(p_client_id), '') = '' OR COALESCE(TRIM(p_qrcodeid), '') = '' OR p_waktu_hp IS NULL THEN
        RETURN jsonb_build_object('status', 'DITOLAK', 'kode', 'DATA_TIDAK_LENGKAP', 'message', 'Data antrian offline tidak lengkap.');
    END IF;

    -- Kunci per client_id biar 2 sync barengan (mis. 2 tab) gak dobel eksekusi.
    PERFORM pg_advisory_xact_lock(hashtext('absen_offline:' || p_client_id));

    SELECT * INTO v_log FROM public.absensi_offline_log WHERE client_id = p_client_id;
    IF v_log.id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'status', v_log.status, 'kode', v_log.kode_tolak, 'message', v_log.pesan,
            'slot', v_log.slot, 'nama', v_log.nama, 'duplikat', TRUE
        );
    END IF;

    v_r := public._absen_offline_eksekusi(p_qrcodeid, p_waktu_hp, p_lat, p_lng, FALSE);

    INSERT INTO public.absensi_offline_log (
        client_id, qrcodeid, nama, tanggal, waktu_hp, lat, lng, lokasi, jarak_m,
        device_info, status, kode_tolak, slot, pesan
    ) VALUES (
        p_client_id, UPPER(TRIM(p_qrcodeid)), v_r->>'nama',
        (p_waktu_hp AT TIME ZONE 'Asia/Makassar')::DATE, p_waktu_hp, p_lat, p_lng,
        v_r->>'lokasi', (v_r->>'jarak')::INT, LEFT(COALESCE(p_device_info, ''), 300),
        v_r->>'status', v_r->>'kode', v_r->>'slot', v_r->>'message'
    );

    RETURN v_r;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_offline_pack(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_absensi_offline(TEXT, TEXT, TIMESTAMPTZ, DOUBLE PRECISION, DOUBLE PRECISION, TEXT) TO anon, authenticated;


-- -------------------------------------------------------------------------------------
-- 4. HR: daftar log offline (Monitoring > Log Offline) -- butuh PIC MAE
--    p_tanggal NULL = 500 data terbaru semua tanggal.
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.list_absensi_offline_log_secure(p_tanggal DATE, p_session_token TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_rows JSONB;
BEGIN
    PERFORM operational.check_fusion_session(p_session_token, 'mae');

    SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.waktu_hp DESC), '[]'::JSONB)
    INTO v_rows
    FROM (
        SELECT g.id, g.qrcodeid, COALESCE(g.nama, k."NamaPersonnel") AS nama, g.tanggal,
               g.waktu_hp, g.waktu_sync, g.lokasi, g.jarak_m, g.lat, g.lng, g.device_info,
               g.status, g.kode_tolak, g.slot, g.pesan, g.diproses_at,
               hr."NamaPersonnel" AS diproses_oleh_nama
        FROM public.absensi_offline_log g
        LEFT JOIN "karyawanTbl" k ON UPPER(TRIM(k."QrCodeId")) = g.qrcodeid
        LEFT JOIN "karyawanTbl" hr ON hr."Id" = g.diproses_oleh
        WHERE p_tanggal IS NULL OR g.tanggal = p_tanggal
        ORDER BY g.waktu_hp DESC
        LIMIT 500
    ) x;

    RETURN v_rows;
END;
$function$;


-- -------------------------------------------------------------------------------------
-- 5. HR: Terima Manual (cuma buat yang ditolak karena BEDA_HARI) -- butuh PIC MAE
--    Semua cek lain (jam HP, radius, AuthCheck, slot) tetap jalan, pakai jam asli HP.
-- -------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.terima_manual_absensi_offline_secure(p_id BIGINT, p_session_token TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_actor BIGINT;
    v_log public.absensi_offline_log;
    v_r JSONB;
    v_ok BOOLEAN;
BEGIN
    v_actor := operational.check_fusion_session(p_session_token, 'mae');

    SELECT * INTO v_log FROM public.absensi_offline_log WHERE id = p_id FOR UPDATE;
    IF v_log.id IS NULL THEN
        RAISE EXCEPTION 'Data log offline tidak ditemukan.';
    END IF;
    IF v_log.status <> 'DITOLAK' OR COALESCE(v_log.kode_tolak, '') <> 'BEDA_HARI' THEN
        RAISE EXCEPTION 'Hanya data yang ditolak karena beda hari yang bisa diterima manual.';
    END IF;

    v_r := public._absen_offline_eksekusi(v_log.qrcodeid, v_log.waktu_hp, v_log.lat, v_log.lng, TRUE);
    v_ok := (v_r->>'status') = 'DITERIMA';

    UPDATE public.absensi_offline_log
    SET status = CASE WHEN v_ok THEN 'DITERIMA_MANUAL' ELSE 'DITOLAK' END,
        kode_tolak = CASE WHEN v_ok THEN NULL ELSE v_r->>'kode' END,
        slot = v_r->>'slot',
        pesan = CASE WHEN v_ok THEN v_r->>'message'
                     ELSE 'Terima Manual gagal: ' || COALESCE(v_r->>'message', '-') END,
        lokasi = COALESCE(v_r->>'lokasi', lokasi),
        jarak_m = COALESCE((v_r->>'jarak')::INT, jarak_m),
        diproses_oleh = v_actor,
        diproses_at = NOW()
    WHERE id = p_id;

    RETURN v_r;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.list_absensi_offline_log_secure(DATE, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.terima_manual_absensi_offline_secure(BIGINT, TEXT) TO anon, authenticated;
