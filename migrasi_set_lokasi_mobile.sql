-- =====================================================================
-- SET LOKASI MOBILE -- petugas pemegang hak SL netapin titik geofence
-- langsung dari HP di site (set-lokasi.html). Sesuai Manual Operasional
-- Set Lokasi Fusion4 (Draft 0.1).
--
-- 1. lokasiTbl: + KodeLokasi (unik, auto LOK-xxx) + Project (kode operational.projects).
-- 2. lokasiLogTbl: riwayat tiap titik dari lapangan (siapa, kapan, akurasi, titik lama -> baru).
--    client_id unik = antrian offline yang ke-kirim 2x gak dobel.
-- 3. Login pakai PIN Digital Badge -> token sesi 30 hari (yang disimpan cuma hash-nya).
--    Antrian offline dikirim pakai token ini, jadi PIN gak pernah disimpan di HP.
--    Salah PIN 5x per HP = dikunci 15 menit.
-- 4. Hak: PIC berisi SL (atau ALL / *), atau Author ALL / * / ADMIN.
-- 5. Jam kerja lokasi baru = default 07:30 / 12:00 / 13:00 / 17:00. Update Titik gak nyentuh jam.
-- =====================================================================

-- ---------- 1. Kolom baru lokasiTbl ----------
ALTER TABLE public."lokasiTbl" ADD COLUMN IF NOT EXISTS "KodeLokasi" text;
ALTER TABLE public."lokasiTbl" ADD COLUMN IF NOT EXISTS "Project" text;

UPDATE public."lokasiTbl"
SET "KodeLokasi" = 'LOK-' || lpad("Id"::text, 3, '0')
WHERE "KodeLokasi" IS NULL OR btrim("KodeLokasi") = '';

CREATE UNIQUE INDEX IF NOT EXISTS "lokasiTbl_kodelokasi_uq" ON public."lokasiTbl" (upper("KodeLokasi"));

-- ---------- 2. Riwayat titik dari lapangan ----------
CREATE TABLE IF NOT EXISTS public."lokasiLogTbl" (
    "Id"          bigserial PRIMARY KEY,
    "ClientId"    text NOT NULL UNIQUE,
    "LokasiId"    bigint NOT NULL,
    "Aksi"        text NOT NULL,           -- BARU / UPDATE
    "Mode"        text,                    -- TENGAH / KELILING
    "KodeLokasi"  text,
    "NamaLokasi"  text,
    "Project"     text,
    "Latitude"    double precision,
    "Longitude"   double precision,
    "Radius"      integer,
    "LatLama"     double precision,
    "LngLama"     double precision,
    "RadiusLama"  integer,
    "Akurasi"     numeric,
    "Sampel"      integer,
    "Pojok"       jsonb,
    "PetugasId"   bigint,
    "PetugasNama" text,
    "WaktuAmbil"  timestamptz,
    "Via"         text,                    -- ONLINE / OFFLINE
    "DiterimaAt"  timestamptz NOT NULL DEFAULT now(),
    "Hasil"       jsonb
);
CREATE INDEX IF NOT EXISTS "lokasiLogTbl_lokasi_idx" ON public."lokasiLogTbl" ("LokasiId", "DiterimaAt" DESC);
ALTER TABLE public."lokasiLogTbl" ENABLE ROW LEVEL SECURITY;  -- tanpa policy: cuma lewat RPC

-- ---------- 3. Sesi & percobaan PIN ----------
CREATE TABLE IF NOT EXISTS operational.setlokasi_sessions (
    token_hash  bytea PRIMARY KEY,
    employee_id bigint NOT NULL,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS operational.setlokasi_pin_attempts (
    device_id    text PRIMARY KEY,
    attempts     integer NOT NULL,
    window_start timestamptz NOT NULL
);

-- ---------- 4. Helper ----------
CREATE OR REPLACE FUNCTION operational.setlokasi_punya_hak(p_id bigint)
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
              operational.tokens(COALESCE(NULLIF(btrim(p."PIC"), ''), p.pic)) && ARRAY['sl', 'all', '*']
              OR operational.tokens(p."Author") && ARRAY['all', '*', 'admin']
          )
    );
$$;

-- Data yang dibawa HP ke lapangan: daftar lokasi (buat Update Titik) + daftar project.
CREATE OR REPLACE FUNCTION operational.setlokasi_payload(p_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT jsonb_build_object(
        'id', k."Id",
        'nama', k."NamaPersonnel",
        'lokasi', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'id', l."Id",
                       'kode', l."KodeLokasi",
                       'nama', l."NamaLokasi",
                       'project', l."Project",
                       'lat', l."Latitude",
                       'lng', l."Longitude",
                       'radius', COALESCE(l."Radius", 100)
                   ) ORDER BY l."NamaLokasi")
            FROM public."lokasiTbl" l
            WHERE UPPER(TRIM(COALESCE(l."Status", 'ACTIVE'))) = 'ACTIVE'
        ), '[]'::jsonb),
        'projects', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('code', pr.code, 'name', pr.name) ORDER BY pr.code)
            FROM operational.projects pr
            WHERE pr.code IS NOT NULL
        ), '[]'::jsonb),
        'serverTime', now()
    )
    FROM public."karyawanTbl" k
    WHERE k."Id" = p_id;
$$;

CREATE OR REPLACE FUNCTION operational.setlokasi_sesi(p_token text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT s.employee_id
    FROM operational.setlokasi_sessions s
    WHERE s.token_hash = sha256(convert_to(COALESCE(p_token, ''), 'UTF8'))
      AND s.expires_at > now();
$$;

-- ---------- 5. Login PIN ----------
CREATE OR REPLACE FUNCTION public.setlokasi_login(p_pin text, p_device text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_device   text := left(COALESCE(NULLIF(btrim(p_device), ''), 'unknown'), 64);
    v_attempts integer;
    v_id       bigint;
    v_token    text;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('setlokasi-pin:' || v_device, 0));
    DELETE FROM operational.setlokasi_pin_attempts WHERE window_start < now() - interval '15 minutes';

    SELECT attempts INTO v_attempts FROM operational.setlokasi_pin_attempts WHERE device_id = v_device;
    IF COALESCE(v_attempts, 0) >= 5 THEN
        RETURN jsonb_build_object('status', 'LOCKED', 'message', 'Salah PIN 5x. Akses dikunci 15 menit.');
    END IF;

    IF p_pin ~ '^[0-9]{4,8}$' THEN
        SELECT k."Id" INTO v_id
        FROM public."karyawanTbl" k
        WHERE k."DigitalPIN" = p_pin::bigint AND COALESCE(k."IsActive", true)
        LIMIT 1;
    END IF;

    IF v_id IS NULL THEN
        INSERT INTO operational.setlokasi_pin_attempts VALUES (v_device, 1, now())
        ON CONFLICT (device_id) DO UPDATE SET attempts = operational.setlokasi_pin_attempts.attempts + 1
        RETURNING attempts INTO v_attempts;
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'PIN salah.', 'sisa', GREATEST(5 - v_attempts, 0));
    END IF;

    DELETE FROM operational.setlokasi_pin_attempts WHERE device_id = v_device;

    IF NOT operational.setlokasi_punya_hak(v_id) THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS',
            'message', 'Kamu belum punya hak Set Lokasi. Minta admin isi SL di kolom PIC.');
    END IF;

    v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    DELETE FROM operational.setlokasi_sessions WHERE expires_at < now();
    INSERT INTO operational.setlokasi_sessions (token_hash, employee_id, expires_at)
    VALUES (sha256(convert_to(v_token, 'UTF8')), v_id, now() + interval '30 days');

    RETURN operational.setlokasi_payload(v_id)
        || jsonb_build_object('status', 'OK', 'token', v_token, 'expiresAt', now() + interval '30 days');
END;
$$;

-- ---------- 6. Sync (perpanjang sesi + data terbaru) ----------
CREATE OR REPLACE FUNCTION public.setlokasi_sync(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_id bigint := operational.setlokasi_sesi(p_token);
BEGIN
    IF v_id IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis. Masukkan PIN lagi selagi ada sinyal.');
    END IF;
    IF NOT operational.setlokasi_punya_hak(v_id) THEN
        DELETE FROM operational.setlokasi_sessions WHERE employee_id = v_id;
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Hak Set Lokasi kamu sudah dicabut.');
    END IF;

    UPDATE operational.setlokasi_sessions
    SET expires_at = now() + interval '30 days'
    WHERE token_hash = sha256(convert_to(p_token, 'UTF8'));

    RETURN operational.setlokasi_payload(v_id)
        || jsonb_build_object('status', 'OK', 'expiresAt', now() + interval '30 days');
END;
$$;

-- ---------- 7. Simpan titik (online langsung / antrian offline) ----------
CREATE OR REPLACE FUNCTION public.setlokasi_simpan(
    p_token       text,
    p_client_id   text,
    p_aksi        text,             -- BARU / UPDATE
    p_lokasi_id   bigint,           -- wajib kalau UPDATE
    p_kode        text,             -- kosong = auto LOK-xxx
    p_nama        text,
    p_project     text,
    p_lat         double precision,
    p_lng         double precision,
    p_radius      integer,
    p_akurasi     numeric,
    p_sampel      integer,
    p_mode        text,             -- TENGAH / KELILING
    p_pojok       jsonb,
    p_waktu_ambil timestamptz,
    p_via         text              -- ONLINE / OFFLINE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_id      bigint := operational.setlokasi_sesi(p_token);
    v_petugas text;
    v_aksi    text := upper(btrim(COALESCE(p_aksi, '')));
    v_kode    text := upper(btrim(COALESCE(p_kode, '')));
    v_nama    text := btrim(COALESCE(p_nama, ''));
    v_project text := NULLIF(btrim(COALESCE(p_project, '')), '');
    v_lat_lama  double precision;
    v_lng_lama  double precision;
    v_rad_lama  integer;
    v_kode_lama text;
    v_lok_id  bigint;
    v_hasil   jsonb;
    v_prev    jsonb;
BEGIN
    IF v_id IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis. Masukkan PIN lagi selagi ada sinyal, lalu kirim ulang.');
    END IF;
    IF NOT operational.setlokasi_punya_hak(v_id) THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Hak Set Lokasi kamu sudah dicabut.');
    END IF;
    IF p_client_id IS NULL OR length(p_client_id) NOT BETWEEN 8 AND 64 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'ClientId tidak valid.');
    END IF;

    -- Idempotent: antrian yang ke-kirim ulang dapat hasil yang sama.
    PERFORM pg_advisory_xact_lock(hashtextextended('setlokasi-client:' || p_client_id, 0));
    SELECT "Hasil" INTO v_prev FROM public."lokasiLogTbl" WHERE "ClientId" = p_client_id;
    IF v_prev IS NOT NULL THEN
        RETURN v_prev || jsonb_build_object('duplikat', true);
    END IF;

    -- Validasi
    IF v_aksi NOT IN ('BARU', 'UPDATE') THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Tujuan harus Lokasi Baru atau Update Titik.');
    END IF;
    IF p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Koordinat tidak valid.');
    END IF;
    IF p_radius IS NULL OR p_radius NOT BETWEEN 50 AND 300 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Radius harus 50-300 m.');
    END IF;
    IF length(v_nama) < 3 OR length(v_nama) > 80 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Nama lokasi 3-80 karakter.');
    END IF;
    IF v_kode <> '' AND v_kode !~ '^[A-Z0-9][A-Z0-9_.-]{1,29}$' THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Kode lokasi cuma boleh huruf, angka, - _ . (2-30 karakter).');
    END IF;
    IF v_project IS NOT NULL AND NOT EXISTS (SELECT 1 FROM operational.projects WHERE code = v_project) THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Project tidak dikenal.');
    END IF;

    LOCK TABLE public."lokasiTbl" IN SHARE ROW EXCLUSIVE MODE;

    IF v_aksi = 'UPDATE' THEN
        SELECT "Latitude", "Longitude", "Radius"::integer, "KodeLokasi"
        INTO v_lat_lama, v_lng_lama, v_rad_lama, v_kode_lama
        FROM public."lokasiTbl" WHERE "Id" = p_lokasi_id;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'Lokasi yang mau di-update sudah tidak ada.');
        END IF;
        IF v_kode = '' THEN v_kode := upper(COALESCE(v_kode_lama, '')); END IF;
    END IF;

    IF v_kode <> '' AND EXISTS (
        SELECT 1 FROM public."lokasiTbl"
        WHERE upper("KodeLokasi") = v_kode AND "Id" IS DISTINCT FROM p_lokasi_id
    ) THEN
        RETURN jsonb_build_object('status', 'KODE_DIPAKAI', 'message', 'Kode ' || v_kode || ' sudah dipakai lokasi lain. Ubah kode lalu simpan ulang.');
    END IF;

    IF EXISTS (
        SELECT 1 FROM public."lokasiTbl"
        WHERE upper(btrim("NamaLokasi")) = upper(v_nama)
          AND UPPER(TRIM(COALESCE("Status", 'ACTIVE'))) = 'ACTIVE'
          AND (v_aksi = 'BARU' OR "Id" <> p_lokasi_id)
    ) THEN
        RETURN jsonb_build_object('status', 'NAMA_DIPAKAI', 'message', 'Nama "' || v_nama || '" sudah dipakai lokasi aktif lain. Pakai Update Titik atau ganti nama.');
    END IF;

    IF v_aksi = 'BARU' THEN
        SELECT COALESCE(MAX("Id"), 0) + 1 INTO v_lok_id FROM public."lokasiTbl";
        IF v_kode = '' THEN
            v_kode := 'LOK-' || lpad(v_lok_id::text, 3, '0');
            IF EXISTS (SELECT 1 FROM public."lokasiTbl" WHERE upper("KodeLokasi") = v_kode) THEN
                v_kode := v_kode || '-' || upper(substr(md5(random()::text), 1, 3));
            END IF;
        END IF;

        INSERT INTO public."lokasiTbl" ("Id", "NamaLokasi", "Latitude", "Longitude", "Radius", "Status", "Type", "CreateDate", "KodeLokasi", "Project")
        VALUES (v_lok_id, v_nama, p_lat, p_lng, p_radius, 'Active', 'LOCATION', to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), v_kode, v_project);

        INSERT INTO public."timeLimitTbl" ("Area", "JamMasuk1", "JamIstirahat", "JamMasuk2", "JamPulang")
        VALUES (v_lok_id, '07:30', '12:00', '13:00', '17:00')
        ON CONFLICT ("Area") DO NOTHING;
    ELSE
        v_lok_id := p_lokasi_id;
        UPDATE public."lokasiTbl"
        SET "NamaLokasi" = v_nama,
            "Latitude"   = p_lat,
            "Longitude"  = p_lng,
            "Radius"     = p_radius,
            "KodeLokasi" = NULLIF(v_kode, ''),
            "Project"    = COALESCE(v_project, "Project")
        WHERE "Id" = v_lok_id;
    END IF;

    SELECT "NamaPersonnel" INTO v_petugas FROM public."karyawanTbl" WHERE "Id" = v_id;

    v_hasil := jsonb_build_object(
        'status', 'OK',
        'aksi', v_aksi,
        'lokasiId', v_lok_id,
        'kode', NULLIF(v_kode, ''),
        'nama', v_nama,
        'radius', p_radius,
        'petugas', v_petugas,
        'diterimaAt', now(),
        'message', CASE WHEN v_aksi = 'BARU' THEN 'Lokasi baru aktif.' ELSE 'Titik lokasi diperbarui.' END
    );

    INSERT INTO public."lokasiLogTbl" (
        "ClientId", "LokasiId", "Aksi", "Mode", "KodeLokasi", "NamaLokasi", "Project",
        "Latitude", "Longitude", "Radius", "LatLama", "LngLama", "RadiusLama",
        "Akurasi", "Sampel", "Pojok", "PetugasId", "PetugasNama", "WaktuAmbil", "Via", "Hasil")
    VALUES (
        p_client_id, v_lok_id, v_aksi, upper(NULLIF(btrim(COALESCE(p_mode, '')), '')), NULLIF(v_kode, ''), v_nama, v_project,
        p_lat, p_lng, p_radius,
        v_lat_lama, v_lng_lama, v_rad_lama,
        p_akurasi, p_sampel, p_pojok, v_id, v_petugas,
        LEAST(COALESCE(p_waktu_ambil, now()), now()),
        CASE WHEN upper(COALESCE(p_via, '')) = 'OFFLINE' THEN 'OFFLINE' ELSE 'ONLINE' END,
        v_hasil);

    RETURN v_hasil;
END;
$$;

-- ---------- 8. Buat Kelola Lokasi (admin) ----------
-- Kode, Project, dan perubahan terakhir dari lapangan per lokasi.
CREATE OR REPLACE FUNCTION public.list_lokasi_lapangan_info()
RETURNS TABLE(id bigint, kodelokasi text, project text, lapangan_aksi text, lapangan_petugas text, lapangan_waktu timestamptz, lapangan_via text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT l."Id", l."KodeLokasi", l."Project", g."Aksi", g."PetugasNama", g."WaktuAmbil", g."Via"
    FROM public."lokasiTbl" l
    LEFT JOIN LATERAL (
        SELECT x."Aksi", x."PetugasNama", x."WaktuAmbil", x."Via"
        FROM public."lokasiLogTbl" x
        WHERE x."LokasiId" = l."Id"
        ORDER BY x."DiterimaAt" DESC
        LIMIT 1
    ) g ON true;
$$;

CREATE OR REPLACE FUNCTION public.set_lokasi_kode_project_secure(p_id bigint, p_kode text, p_project text, p_session_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_kode    text := upper(btrim(COALESCE(p_kode, '')));
    v_project text := NULLIF(btrim(COALESCE(p_project, '')), '');
BEGIN
    PERFORM operational.check_fusion_session(p_session_token, 'kl');

    IF v_kode = '' THEN v_kode := 'LOK-' || lpad(p_id::text, 3, '0'); END IF;
    IF v_kode !~ '^[A-Z0-9][A-Z0-9_.-]{1,29}$' THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Kode lokasi cuma boleh huruf, angka, - _ . (2-30 karakter).');
    END IF;
    IF EXISTS (SELECT 1 FROM public."lokasiTbl" WHERE upper("KodeLokasi") = v_kode AND "Id" <> p_id) THEN
        RETURN jsonb_build_object('status', 'KODE_DIPAKAI', 'message', 'Kode ' || v_kode || ' sudah dipakai lokasi lain.');
    END IF;
    IF v_project IS NOT NULL AND NOT EXISTS (SELECT 1 FROM operational.projects WHERE code = v_project) THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Project tidak dikenal.');
    END IF;

    UPDATE public."lokasiTbl" SET "KodeLokasi" = v_kode, "Project" = v_project WHERE "Id" = p_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'Lokasi tidak ditemukan.');
    END IF;
    RETURN jsonb_build_object('status', 'SUCCESS', 'kode', v_kode, 'project', v_project);
END;
$$;

-- Daftar project buat dropdown Kelola Lokasi.
CREATE OR REPLACE FUNCTION public.list_project_codes()
RETURNS TABLE(code text, name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT pr.code, pr.name FROM operational.projects pr WHERE pr.code IS NOT NULL ORDER BY pr.code;
$$;

-- ---------- 9. Hak eksekusi ----------
REVOKE ALL ON FUNCTION operational.setlokasi_punya_hak(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION operational.setlokasi_payload(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION operational.setlokasi_sesi(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE operational.setlokasi_sessions, operational.setlokasi_pin_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public."lokasiLogTbl" FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.setlokasi_login(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.setlokasi_sync(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.setlokasi_simpan(text, text, text, bigint, text, text, text, double precision, double precision, integer, numeric, integer, text, jsonb, timestamptz, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_lokasi_lapangan_info() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_lokasi_kode_project_secure(bigint, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_project_codes() TO anon, authenticated;
