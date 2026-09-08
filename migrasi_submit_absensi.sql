-- =====================================================================================
-- PERBAIKAN FUNCTION RPC: SUBMIT_ABSENSI (FUSION4 SMARTGATE)
-- Memastikan pesan diawali dengan SUKSES: agar banner di HP tampil HIJAU (✅)
-- =====================================================================================

DROP FUNCTION IF EXISTS submit_absensi(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS submit_absensi(TEXT, TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS submit_absensi(TEXT, TEXT, TEXT, TIMESTAMP);

CREATE OR REPLACE FUNCTION submit_absensi(
    p_qrcodeid TEXT,
    p_lokasi TEXT,
    p_password TEXT DEFAULT '',
    p_timestamp_offline TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_kar_id BIGINT;
    v_nama TEXT;
    v_auth_check BOOLEAN;
    v_lokasi_id BIGINT;
    v_limit_masuk1 TIME := '07:30:00'::TIME;
    v_limit_istirahat TIME := '12:00:00'::TIME;
    v_limit_masuk2 TIME := '13:00:00'::TIME;
    v_limit_pulang TIME := '17:00:00'::TIME;
    v_now_wita TIMESTAMPTZ;
    v_time_now TIME;
    v_today DATE;
    v_absen RECORD;
    v_new_id BIGINT;
    v_slot_recorded TEXT;
    v_pw_db TEXT;
BEGIN
    -- 1. Ambil data karyawan
    SELECT "Id", "NamaPersonnel", COALESCE("AuthCheck", FALSE)
    INTO v_kar_id, v_nama, v_auth_check
    FROM "karyawanTbl"
    WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcodeid))
    LIMIT 1;

    IF v_kar_id IS NULL THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Karyawan dengan QR ' || p_qrcodeid || ' tidak ditemukan.');
    END IF;

    -- 2. Validasi Password jika AuthCheck = TRUE
    IF v_auth_check = TRUE THEN
        IF p_password IS NULL OR TRIM(p_password) = '' THEN
            RETURN jsonb_build_object('status', 'NEED_PASSWORD', 'message', 'BUTUH_PASSWORD');
        END IF;

        SELECT "PasswordHas" INTO v_pw_db
        FROM "paswordTbl"
        WHERE "Id" = v_kar_id
        LIMIT 1;

        IF v_pw_db IS NULL OR TRIM(v_pw_db) <> TRIM(p_password) THEN
            RETURN jsonb_build_object('status', 'ERROR', 'message', 'Password otorisasi salah.');
        END IF;
    END IF;

    -- 3. Ambil Lokasi ID & TimeLimit yang sesuai
    SELECT "Id" INTO v_lokasi_id
    FROM "lokasiTbl"
    WHERE UPPER(TRIM("NamaLokasi")) = UPPER(TRIM(p_lokasi))
    LIMIT 1;

    IF v_lokasi_id IS NOT NULL THEN
        SELECT 
            COALESCE("JamMasuk1", '07:30:00'::TIME),
            COALESCE("JamIstirahat", '12:00:00'::TIME),
            COALESCE("JamMasuk2", '13:00:00'::TIME),
            COALESCE("JamPulang", '17:00:00'::TIME)
        INTO v_limit_masuk1, v_limit_istirahat, v_limit_masuk2, v_limit_pulang
        FROM "timeLimitTbl"
        WHERE "Area" = v_lokasi_id
        LIMIT 1;
    END IF;

    -- 4. Tentukan Waktu Absen (Mendukung jam offline jika ada sync)
    v_now_wita := COALESCE(p_timestamp_offline, NOW());
    v_today := (v_now_wita AT TIME ZONE 'Asia/Makassar')::DATE;
    v_time_now := (v_now_wita AT TIME ZONE 'Asia/Makassar')::TIME;

    -- 5. Cek data absensi hari ini
    SELECT * INTO v_absen
    FROM "absensiTbl"
    WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcodeid))
      AND "Tanggal" = v_today
    ORDER BY "Id" DESC
    LIMIT 1;

    -- 6. Alur Pengisian Slot Absensi
    IF v_absen."Id" IS NULL THEN
        -- Belum ada record sama sekali hari ini
        IF v_time_now < v_limit_istirahat THEN
            INSERT INTO "absensiTbl" ("Tanggal", "QrCodeId", "JamMasuk1", "LokasiMasuk1", "Status")
            VALUES (v_today, UPPER(TRIM(p_qrcodeid)), v_now_wita, p_lokasi, 'OPEN')
            RETURNING "Id" INTO v_new_id;
            v_slot_recorded := 'Jam Masuk 1';

        ELSIF v_time_now >= v_limit_istirahat AND v_time_now < v_limit_pulang THEN
            INSERT INTO "absensiTbl" ("Tanggal", "QrCodeId", "JamMasuk2", "LokasiMasuk2", "Status")
            VALUES (v_today, UPPER(TRIM(p_qrcodeid)), v_now_wita, p_lokasi, 'OPEN')
            RETURNING "Id" INTO v_new_id;
            v_slot_recorded := 'Jam Masuk 2';

        ELSE
            INSERT INTO "absensiTbl" ("Tanggal", "QrCodeId", "JamPulang", "LokasiPulang", "Status")
            VALUES (v_today, UPPER(TRIM(p_qrcodeid)), v_now_wita, p_lokasi, 'CLOSED')
            RETURNING "Id" INTO v_new_id;
            v_slot_recorded := 'Jam Pulang';
        END IF;

        RETURN jsonb_build_object(
            'status', 'SUKSES',
            'message', 'SUKSES: Absensi ' || v_slot_recorded || ' (' || v_nama || ') berhasil tercatat!',
            'slot', v_slot_recorded,
            'waktu', TO_CHAR(v_now_wita AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS')
        );

    ELSE
        -- Sudah ada record hari ini
        -- Jika status sudah CLOSED dan lewat jam pulang -> Arahkan ke Lembur
        IF v_absen."Status" = 'CLOSED' AND v_time_now >= v_limit_pulang THEN
            RETURN jsonb_build_object(
                'status', 'NEED_VOUCHER',
                'message', 'Sesi reguler sudah CLOSED. Masukkan Voucher PIN untuk lembur.'
            );
        END IF;

        -- Slot 2: Istirahat
        IF v_absen."JamMasuk1" IS NOT NULL AND v_absen."JamIstirahat" IS NULL AND v_time_now >= (v_limit_istirahat - INTERVAL '30 minutes') AND v_time_now < v_limit_masuk2 THEN
            UPDATE "absensiTbl"
            SET "JamIstirahat" = v_now_wita,
                "LokasiIstirahat" = p_lokasi
            WHERE "Id" = v_absen."Id";
            v_slot_recorded := 'Jam Istirahat';

        -- Slot 3: Masuk 2
        ELSIF v_absen."JamMasuk2" IS NULL AND v_time_now >= v_limit_istirahat AND v_time_now < v_limit_pulang THEN
            UPDATE "absensiTbl"
            SET "JamMasuk2" = v_now_wita,
                "LokasiMasuk2" = p_lokasi
            WHERE "Id" = v_absen."Id";
            v_slot_recorded := 'Jam Masuk 2';

        -- Slot 4: Pulang
        ELSIF v_absen."JamPulang" IS NULL THEN
            UPDATE "absensiTbl"
            SET "JamPulang" = v_now_wita,
                "LokasiPulang" = p_lokasi,
                "Status" = 'CLOSED'
            WHERE "Id" = v_absen."Id";
            v_slot_recorded := 'Jam Pulang';

        ELSE
            -- Jika sudah lengkap
            RETURN jsonb_build_object(
                'status', 'SUKSES',
                'message', 'SUKSES: Absensi hari ini untuk ' || v_nama || ' sudah lengkap (' || COALESCE(v_absen."Status", 'CLOSED') || ').'
            );
        END IF;

        RETURN jsonb_build_object(
            'status', 'SUKSES',
            'message', 'SUKSES: Absensi ' || v_slot_recorded || ' (' || v_nama || ') berhasil tercatat!',
            'slot', v_slot_recorded,
            'waktu', TO_CHAR(v_now_wita AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS')
        );
    END IF;
END;
$$;