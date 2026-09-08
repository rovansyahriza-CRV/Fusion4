-- =====================================================================================
-- PERBAIKAN LOGIKA JAM PULANG STRICT & TRIGGER SPKL LEMBUR
-- Fusion4 SmartGate & Virtual WALLET
-- =====================================================================================

DROP FUNCTION IF EXISTS submit_absensi(TEXT, TEXT, TEXT, TIMESTAMPTZ);
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
    v_cuti RECORD;
BEGIN
    -- 1. Tentukan Waktu Absen (WITA)
    v_now_wita := COALESCE(p_timestamp_offline, NOW());
    v_today := (v_now_wita AT TIME ZONE 'Asia/Makassar')::DATE;
    v_time_now := (v_now_wita AT TIME ZONE 'Asia/Makassar')::TIME;

    -- 2. Ambil data karyawan
    SELECT "Id", "NamaPersonnel", COALESCE("AuthCheck", FALSE)
    INTO v_kar_id, v_nama, v_auth_check
    FROM "karyawanTbl"
    WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcodeid))
    LIMIT 1;

    IF v_kar_id IS NULL THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Karyawan dengan QR ' || p_qrcodeid || ' tidak ditemukan.');
    END IF;

    -- 3. Cek apakah sedang dalam masa Cuti resmi yang APPROVED
    SELECT * INTO v_cuti
    FROM "pengajuan_ijin_lembur_tbl"
    WHERE UPPER(TRIM("qrcodeid")) = UPPER(TRIM(p_qrcodeid))
      AND "tipe" = 'CUTI'
      AND "status" = 'APPROVED'
      AND v_today BETWEEN "tanggal_mulai" AND "tanggal_selesai"
    LIMIT 1;

    IF v_cuti.id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'status', 'ERROR',
            'message', 'ℹ️ ' || v_nama || ' sedang dalam masa Cuti resmi (' || TO_CHAR(v_cuti.tanggal_mulai, 'DD/MM/YYYY') || ' s/d ' || TO_CHAR(v_cuti.tanggal_selesai, 'DD/MM/YYYY') || '). Hubungi HR jika masuk kerja lebih awal.'
        );
    END IF;

    -- 4. Validasi Password jika AuthCheck = TRUE
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

    -- 5. Ambil Lokasi ID & TimeLimit yang sesuai
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

    -- 6. Cek data absensi hari ini
    SELECT * INTO v_absen
    FROM "absensiTbl"
    WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcodeid))
      AND "Tanggal" = v_today
    ORDER BY "Id" DESC
    LIMIT 1;

    -- ---------------------------------------------------------------------------------
    -- SKENARIO A: BELUM ADA RECORD SAMA SEKALI HARI INI
    -- ---------------------------------------------------------------------------------
    IF v_absen."Id" IS NULL THEN
        -- Slot Pagi
        IF v_time_now < v_limit_istirahat THEN
            INSERT INTO "absensiTbl" ("Tanggal", "QrCodeId", "JamMasuk1", "LokasiMasuk1", "Status")
            VALUES (v_today, UPPER(TRIM(p_qrcodeid)), v_now_wita, p_lokasi, 'OPEN')
            RETURNING "Id" INTO v_new_id;
            v_slot_recorded := 'Jam Masuk 1';

        -- Slot Siang (Masuk 2)
        ELSIF v_time_now >= v_limit_istirahat AND v_time_now < v_limit_pulang THEN
            INSERT INTO "absensiTbl" ("Tanggal", "QrCodeId", "JamMasuk2", "LokasiMasuk2", "Status")
            VALUES (v_today, UPPER(TRIM(p_qrcodeid)), v_now_wita, p_lokasi, 'OPEN')
            RETURNING "Id" INTO v_new_id;
            v_slot_recorded := 'Jam Masuk 2';

        -- Slot Pulang (Tepat atau lewat jam pulang)
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

    -- ---------------------------------------------------------------------------------
    -- SKENARIO B: SUDAH ADA RECORD HARI INI
    -- ---------------------------------------------------------------------------------
    ELSE
        -- WINDOW 1: Pagi (v_time_now < v_limit_istirahat)
        IF v_time_now < v_limit_istirahat THEN
            IF v_absen."JamMasuk1" IS NOT NULL THEN
                RETURN jsonb_build_object(
                    'status', 'ERROR',
                    'message', '⚠️ ' || v_nama || ' sudah melakukan Absensi Masuk 1 pada pukul ' || TO_CHAR(v_absen."JamMasuk1" AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') || ' WITA.'
                );
            ELSE
                UPDATE "absensiTbl"
                SET "JamMasuk1" = v_now_wita,
                    "LokasiMasuk1" = p_lokasi,
                    "Status" = 'OPEN'
                WHERE "Id" = v_absen."Id";
                v_slot_recorded := 'Jam Masuk 1';

                RETURN jsonb_build_object(
                    'status', 'SUKSES',
                    'message', 'SUKSES: Absensi ' || v_slot_recorded || ' (' || v_nama || ') berhasil tercatat!',
                    'slot', v_slot_recorded,
                    'waktu', TO_CHAR(v_now_wita AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS')
                );
            END IF;
        END IF;

        -- WINDOW 2: Istirahat (v_limit_istirahat - 30m s/d v_limit_masuk2)
        IF v_time_now >= (v_limit_istirahat - INTERVAL '30 minutes') AND v_time_now < v_limit_masuk2 THEN
            IF v_absen."JamIstirahat" IS NOT NULL THEN
                RETURN jsonb_build_object(
                    'status', 'ERROR',
                    'message', '⚠️ ' || v_nama || ' sudah melakukan Absensi Istirahat pada pukul ' || TO_CHAR(v_absen."JamIstirahat" AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') || ' WITA.'
                );
            ELSE
                UPDATE "absensiTbl"
                SET "JamIstirahat" = v_now_wita,
                    "LokasiIstirahat" = p_lokasi
                WHERE "Id" = v_absen."Id";
                v_slot_recorded := 'Jam Istirahat';

                RETURN jsonb_build_object(
                    'status', 'SUKSES',
                    'message', 'SUKSES: Absensi ' || v_slot_recorded || ' (' || v_nama || ') berhasil tercatat!',
                    'slot', v_slot_recorded,
                    'waktu', TO_CHAR(v_now_wita AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS')
                );
            END IF;
        END IF;

        -- WINDOW 3: Masuk 2 (v_limit_masuk2 s/d v_limit_pulang)
        -- Di jam ini BELUM BOLEH pulang kecuali punya Voucher Ijin Keluar/Pulang Awal yang valid
        IF v_time_now >= v_limit_masuk2 AND v_time_now < v_limit_pulang THEN
            IF v_absen."JamMasuk2" IS NOT NULL THEN
                -- Cek apakah memiliki Voucher IJIN Pulang Awal
                SELECT "kode_ijin" INTO v_kode_ijin
                FROM "pengajuan_ijin_lembur_tbl"
                WHERE UPPER(TRIM("qrcodeid")) = UPPER(TRIM(p_qrcodeid))
                  AND "tipe" = 'IJIN'
                  AND "status" = 'APPROVED'
                  AND "is_used" = FALSE
                  AND "tanggal" = v_today
                LIMIT 1;

                IF v_kode_ijin IS NOT NULL THEN
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

                    RETURN jsonb_build_object(
                        'status', 'SUKSES',
                        'message', 'SUKSES: Absensi ' || v_slot_recorded || ' (' || v_nama || ') berhasil tercatat!',
                        'slot', v_slot_recorded,
                        'waktu', TO_CHAR(v_now_wita AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS')
                    );
                ELSE
                    RETURN jsonb_build_object(
                        'status', 'ERROR',
                        'message', '⚠️ ' || v_nama || ' sudah melakukan Absensi Masuk 2 pada pukul ' || TO_CHAR(v_absen."JamMasuk2" AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') || ' WITA. Jam Pulang dibuka tepat pukul ' || TO_CHAR(v_limit_pulang, 'HH24:MI') || ' WITA.'
                    );
                END IF;
            ELSE
                UPDATE "absensiTbl"
                SET "JamMasuk2" = v_now_wita,
                    "LokasiMasuk2" = p_lokasi,
                    "Status" = 'OPEN'
                WHERE "Id" = v_absen."Id";
                v_slot_recorded := 'Jam Masuk 2';

                RETURN jsonb_build_object(
                    'status', 'SUKSES',
                    'message', 'SUKSES: Absensi ' || v_slot_recorded || ' (' || v_nama || ') berhasil tercatat!',
                    'slot', v_slot_recorded,
                    'waktu', TO_CHAR(v_now_wita AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS')
                );
            END IF;
        END IF;

        -- WINDOW 4: Jam Pulang & Lembur (v_time_now >= v_limit_pulang)
        IF v_time_now >= v_limit_pulang THEN
            -- 1. JIKA BELUM ABSEN PULANG (JamPulang IS NULL) -> CATAT JAM PULANG & CLOSE SESI REGULER
            IF v_absen."JamPulang" IS NULL THEN
                UPDATE "absensiTbl"
                SET "JamPulang" = v_now_wita,
                    "LokasiPulang" = p_lokasi,
                    "Status" = 'CLOSED'
                WHERE "Id" = v_absen."Id";
                v_slot_recorded := 'Jam Pulang';

                RETURN jsonb_build_object(
                    'status', 'SUKSES',
                    'message', 'SUKSES: Absensi ' || v_slot_recorded || ' (' || v_nama || ') berhasil tercatat! Sesi reguler hari ini selesai.',
                    'slot', v_slot_recorded,
                    'waktu', TO_CHAR(v_now_wita AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS')
                );

            -- 2. JIKA SUDAH ABSEN PULANG (JamPulang IS NOT NULL) DAN SCAN KEMBALI -> MINTA PIN SPKL LEMBUR
            ELSE
                RETURN jsonb_build_object(
                    'status', 'NEED_VOUCHER',
                    'message', 'Sesi reguler sudah CLOSED (Absen Pulang: ' || TO_CHAR(v_absen."JamPulang" AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') || ' WITA). Masukkan PIN SPKL untuk absensi lembur.'
                );
            END IF;
        END IF;

        RETURN jsonb_build_object(
            'status', 'ERROR',
            'message', '⚠️ Tidak ada jadwal slot absensi yang sesuai saat ini.'
        );
    END IF;
END;
$$;