-- =====================================================================================
-- PERBAIKAN FUNCTION RPC: SUBMIT_ABSENSI (STRICT WINDOW CHECK)
-- Menolak scan ulang jika sudah absen pada window time yang sama
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

    -- 6. JIKA BELUM ADA RECORD SAMA SEKALI HARI INI
    IF v_absen."Id" IS NULL THEN
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
        -- 7. SUDAH ADA RECORD HARI INI -- CEK STATUS & WINDOW TIME DENGAN KETAT

        -- A. Jika Status sudah CLOSED dan lewat jam pulang -> Lembur
        IF v_absen."Status" = 'CLOSED' AND v_time_now >= v_toleransi_pulang THEN
            RETURN jsonb_build_object(
                'status', 'NEED_VOUCHER',
                'message', 'Sesi reguler sudah CLOSED. Masukkan Voucher PIN untuk lembur.'
            );
        END IF;

        -- B. Window 1: Pagi (Sebelum Jam Istirahat)
        IF v_time_now < v_limit_istirahat THEN
            IF v_absen."JamMasuk1" IS NOT NULL THEN
                RETURN jsonb_build_object(
                    'status', 'ERROR',
                    'message', '⚠️ ' || v_nama || ' sudah melakukan Absensi Masuk 1 pada pukul ' || TO_CHAR(v_absen."JamMasuk1" AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') || ' WITA.'
                );
            END IF;
        END IF;

        -- C. Window 2: Istirahat (Jam Istirahat s/d Jam Masuk 2)
        IF v_time_now >= (v_limit_istirahat - INTERVAL '30 minutes') AND v_time_now < v_limit_masuk2 THEN
            IF v_absen."JamIstirahat" IS NOT NULL THEN
                RETURN jsonb_build_object(
                    'status', 'ERROR',
                    'message', '⚠️ ' || v_nama || ' sudah melakukan Absensi Istirahat pada pukul ' || TO_CHAR(v_absen."JamIstirahat" AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') || ' WITA.'
                );
            ELSE
                -- Catat Istirahat
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

        -- D. Window 3: Siang / Masuk 2 (Jam Masuk 2 s/d Sebelum Jam Pulang)
        IF v_time_now >= v_limit_masuk2 AND v_time_now < v_toleransi_pulang THEN
            IF v_absen."JamMasuk2" IS NOT NULL THEN
                -- Cek apakah ada Voucher Ijin Pulang untuk mendahului pulang
                SELECT "kode_ijin" INTO v_kode_ijin
                FROM "pengajuan_ijin_lembur_tbl"
                WHERE UPPER(TRIM("qrcodeid")) = UPPER(TRIM(p_qrcodeid))
                  AND "tipe" = 'IJIN'
                  AND "status" = 'APPROVED'
                  AND "is_used" = FALSE
                  AND "tanggal" = v_today
                LIMIT 1;

                IF v_kode_ijin IS NOT NULL THEN
                    -- Pulang lebih awal dengan Voucher Ijin
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
                    -- SUDAH MASUK 2 & BELUM WAKTUNYA PULANG -> TOLAK
                    RETURN jsonb_build_object(
                        'status', 'ERROR',
                        'message', '⚠️ ' || v_nama || ' sudah melakukan Absensi Masuk 2 pada pukul ' || TO_CHAR(v_absen."JamMasuk2" AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') || ' WITA. Jam Pulang dibuka pukul ' || TO_CHAR(v_limit_pulang, 'HH24:MI') || ' WITA.'
                    );
                END IF;
            ELSE
                -- Belum Masuk 2 -> Catat Masuk 2
                UPDATE "absensiTbl"
                SET "JamMasuk2" = v_now_wita,
                    "LokasiMasuk2" = p_lokasi
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

        -- E. Window 4: Sore / Pulang (Mulai toleransi pulang s/d malam)
        IF v_time_now >= v_toleransi_pulang THEN
            IF v_absen."JamPulang" IS NOT NULL THEN
                RETURN jsonb_build_object(
                    'status', 'ERROR',
                    'message', '⚠️ ' || v_nama || ' sudah melakukan Absensi Pulang pada pukul ' || TO_CHAR(v_absen."JamPulang" AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') || ' WITA (Status: CLOSED).'
                );
            ELSE
                -- Catat Pulang Normal
                UPDATE "absensiTbl"
                SET "JamPulang" = v_now_wita,
                    "LokasiPulang" = p_lokasi,
                    "Status" = 'CLOSED'
                WHERE "Id" = v_absen."Id";
                v_slot_recorded := 'Jam Pulang';

                RETURN jsonb_build_object(
                    'status', 'SUKSES',
                    'message', 'SUKSES: Absensi ' || v_slot_recorded || ' (' || v_nama || ') berhasil tercatat!',
                    'slot', v_slot_recorded,
                    'waktu', TO_CHAR(v_now_wita AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS')
                );
            END IF;
        END IF;

        -- Fallback info
        RETURN jsonb_build_object(
            'status', 'ERROR',
            'message', '⚠️ Tidak ada jadwal slot absensi yang sesuai saat ini.'
        );
    END IF;
END;
$$;