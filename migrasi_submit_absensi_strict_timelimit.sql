-- =====================================================================================
-- PERBAIKAN FUNCTION RPC: SUBMIT_ABSENSI (STRICT TIMELIMIT ENFORCEMENT)
-- 1. Mengunci Jam Pulang sebelum waktunya (kecuali punya Voucher Ijin Pulang)
-- 2. Proteksi Double Tap beruntun dalam hitungan detik
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
    v_kode_ijin TEXT;
    v_toleransi_pulang TIME;
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

    -- Toleransi jam pulang (misal boleh absen 15 menit sebelum jam pulang)
    v_toleransi_pulang := (v_limit_pulang - INTERVAL '15 minutes')::TIME;

    -- 4. Tentukan Waktu Absen (WITA)
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

    -- 6. ALUR PENGISIAN SLOT DENGAN VALIDASI WAKTU KETAT
    IF v_absen."Id" IS NULL THEN
        -- Belum ada record sama sekali hari ini
        IF v_time_now < v_limit_istirahat THEN
            -- Slot: Masuk 1 (Pagi)
            INSERT INTO "absensiTbl" ("Tanggal", "QrCodeId", "JamMasuk1", "LokasiMasuk1", "Status")
            VALUES (v_today, UPPER(TRIM(p_qrcodeid)), v_now_wita, p_lokasi, 'OPEN')
            RETURNING "Id" INTO v_new_id;
            v_slot_recorded := 'Jam Masuk 1';

        ELSIF v_time_now >= v_limit_istirahat AND v_time_now < v_toleransi_pulang THEN
            -- Slot: Masuk 2 (Siang)
            INSERT INTO "absensiTbl" ("Tanggal", "QrCodeId", "JamMasuk2", "LokasiMasuk2", "Status")
            VALUES (v_today, UPPER(TRIM(p_qrcodeid)), v_now_wita, p_lokasi, 'OPEN')
            RETURNING "Id" INTO v_new_id;
            v_slot_recorded := 'Jam Masuk 2';

        ELSE
            -- Slot: Pulang (Sore)
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
        -- SUDAH ADA RECORD HARI INI

        -- Jika status sudah CLOSED dan lewat jam pulang -> Arahkan ke Lembur
        IF v_absen."Status" = 'CLOSED' AND v_time_now >= v_toleransi_pulang THEN
            RETURN jsonb_build_object(
                'status', 'NEED_VOUCHER',
                'message', 'Sesi reguler sudah CLOSED. Masukkan Voucher PIN untuk lembur.'
            );
        END IF;

        -- Proteksi Tap Beruntun (Jika baru saja absen kurang dari 2 menit lalu)
        IF v_absen."JamMasuk2" IS NOT NULL AND (v_now_wita - v_absen."JamMasuk2") < INTERVAL '2 minutes' THEN
            RETURN jsonb_build_object(
                'status', 'SUKSES',
                'message', 'SUKSES: Absensi Jam Masuk 2 untuk ' || v_nama || ' baru saja tercatat (' || TO_CHAR(v_absen."JamMasuk2" AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') || ').'
            );
        END IF;

        IF v_absen."JamIstirahat" IS NOT NULL AND (v_now_wita - v_absen."JamIstirahat") < INTERVAL '2 minutes' THEN
            RETURN jsonb_build_object(
                'status', 'SUKSES',
                'message', 'SUKSES: Absensi Jam Istirahat untuk ' || v_nama || ' baru saja tercatat (' || TO_CHAR(v_absen."JamIstirahat" AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') || ').'
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
        ELSIF v_absen."JamMasuk2" IS NULL AND v_time_now >= v_limit_istirahat AND v_time_now < v_toleransi_pulang THEN
            UPDATE "absensiTbl"
            SET "JamMasuk2" = v_now_wita,
                "LokasiMasuk2" = p_lokasi
            WHERE "Id" = v_absen."Id";
            v_slot_recorded := 'Jam Masuk 2';

        -- Slot 4: Pulang
        ELSIF v_absen."JamPulang" IS NULL THEN
            -- CEK STRICT TIMELIMIT JAM PULANG:
            IF v_time_now < v_toleransi_pulang THEN
                -- Belum jam pulang! Cek apakah ada Voucher IJIN Pulang yang APPROVED
                SELECT "kode_ijin" INTO v_kode_ijin
                FROM "pengajuan_ijin_lembur_tbl"
                WHERE UPPER(TRIM("qrcodeid")) = UPPER(TRIM(p_qrcodeid))
                  AND "tipe" = 'IJIN'
                  AND "status" = 'APPROVED'
                  AND "is_used" = FALSE
                  AND "tanggal" = v_today
                LIMIT 1;

                IF v_kode_ijin IS NOT NULL THEN
                    -- Boleh pulang lebih awal karena ada Voucher Ijin
                    UPDATE "absensiTbl"
                    SET "JamPulang" = v_now_wita,
                        "LokasiPulang" = p_lokasi,
                        "Status" = 'CLOSED'
                    WHERE "Id" = v_absen."Id";

                    UPDATE "pengajuan_ijin_lembur_tbl"
                    SET "is_used" = TRUE,
                        "used_at" = v_now_wita
                    WHERE "kode_ijin" = v_kode_ijin;

                    v_slot_recorded := 'Jam Pulang (Voucher Ijin: ' || v_kode_ijin || ')';
                ELSE
                    -- Tolak karena belum jam pulang dan tidak punya voucher ijin
                    RETURN jsonb_build_object(
                        'status', 'ERROR',
                        'message', '⚠️ Belum waktunya Jam Pulang (' || TO_CHAR(v_limit_pulang, 'HH24:MI') || ' WITA). Jika ingin pulang mendahului, silakan ajukan Ijin Pulang di Virtual WALLET.'
                    );
                END IF;
            ELSE
                -- Sudah jam pulang reguler
                UPDATE "absensiTbl"
                SET "JamPulang" = v_now_wita,
                    "LokasiPulang" = p_lokasi,
                    "Status" = 'CLOSED'
                WHERE "Id" = v_absen."Id";
                v_slot_recorded := 'Jam Pulang';
            END IF;

        ELSE
            -- Jika sudah absen pulang lengkap
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