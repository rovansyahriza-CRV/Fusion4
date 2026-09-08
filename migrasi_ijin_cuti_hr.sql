-- =====================================================================================
-- MIGRASI MODUL IJIN CUTI MULTI-DAY & HR ACKNOWLEDGE
-- Fusion4 SmartGate & Virtual WALLET
-- =====================================================================================

-- 1. TAMBAH KOLOM SisaCuti PADA karyawanTbl
ALTER TABLE "karyawanTbl" 
  ADD COLUMN IF NOT EXISTS "SisaCuti" INT DEFAULT 12;

-- 2. TAMBAH KOLOM RENTANG WAKTU PADA pengajuan_ijin_lembur_tbl
ALTER TABLE "pengajuan_ijin_lembur_tbl"
  ADD COLUMN IF NOT EXISTS "tanggal_mulai" DATE,
  ADD COLUMN IF NOT EXISTS "tanggal_selesai" DATE,
  ADD COLUMN IF NOT EXISTS "jumlah_hari" INT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "jenis_cuti" TEXT DEFAULT 'CUTI_TAHUNAN',
  ADD COLUMN IF NOT EXISTS "surat_dokter_url" TEXT;


-- 3. FUNCTION RPC: GET SISA CUTI & STATUS CUTI AKTIF (get_sisa_cuti)
DROP FUNCTION IF EXISTS get_sisa_cuti(TEXT);
CREATE OR REPLACE FUNCTION get_sisa_cuti(p_qrcode TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_sisa INT := 12;
    v_active RECORD;
BEGIN
    SELECT COALESCE("SisaCuti", 12) INTO v_sisa
    FROM "karyawanTbl"
    WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcode))
    LIMIT 1;

    -- Cek pengajuan cuti yang sedang PENDING, PROPOSED, atau APPROVED hari ini
    SELECT * INTO v_active
    FROM "pengajuan_ijin_lembur_tbl"
    WHERE UPPER(TRIM("qrcodeid")) = UPPER(TRIM(p_qrcode))
      AND "tipe" = 'CUTI'
      AND "status" IN ('PENDING', 'PROPOSED', 'APPROVED')
      AND ("tanggal_selesai" >= CURRENT_DATE OR "tanggal" >= CURRENT_DATE)
    ORDER BY "id" DESC
    LIMIT 1;

    RETURN jsonb_build_object(
        'sisaCuti', v_sisa,
        'hasActiveCuti', (v_active.id IS NOT NULL),
        'activeStatus', v_active.status,
        'tanggalMulai', v_active.tanggal_mulai,
        'tanggalSelesai', v_active.tanggal_selesai,
        'jumlahHari', v_active.jumlah_hari,
        'jenisCuti', v_active.jenis_cuti
    );
END;
$$;


-- 4. FUNCTION RPC: SUBMIT PENGAJUAN CUTI (submit_pengajuan_cuti)
DROP FUNCTION IF EXISTS submit_pengajuan_cuti(TEXT, TEXT, DATE, DATE, TEXT, TEXT);
CREATE OR REPLACE FUNCTION submit_pengajuan_cuti(
    p_qrcode TEXT,
    p_jenis_cuti TEXT,
    p_tgl_mulai DATE,
    p_tgl_selesai DATE,
    p_alasan TEXT,
    p_surat_dokter_url TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_kar RECORD;
    v_hari INT;
    v_sisa INT;
    v_new_id BIGINT;
    v_supervisor_name TEXT;
    v_hr_name TEXT;
BEGIN
    IF p_tgl_mulai IS NULL OR p_tgl_selesai IS NULL THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Tanggal mulai dan selesai cuti wajib diisi.');
    END IF;

    IF p_tgl_selesai < p_tgl_mulai THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Tanggal selesai tidak boleh lebih awal dari tanggal mulai.');
    END IF;

    -- Hitung jumlah hari kalender kerja (inklusif)
    v_hari := (p_tgl_selesai - p_tgl_mulai) + 1;

    -- Ambil profil karyawan
    SELECT "Id", "NamaPersonnel", "Kualifikasi", "Lokasi", COALESCE("SisaCuti", 12) as sisa
    INTO v_kar
    FROM "karyawanTbl"
    WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcode))
    LIMIT 1;

    IF v_kar."Id" IS NULL THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Karyawan tidak ditemukan.');
    END IF;

    v_sisa := v_kar.sisa;

    -- Validasi kuota untuk Cuti Tahunan
    IF UPPER(TRIM(p_jenis_cuti)) = 'CUTI_TAHUNAN' THEN
        IF v_sisa < v_hari THEN
            RETURN jsonb_build_object(
                'status', 'ERROR', 
                'message', 'Sisa kuota cuti tahunan Anda tidak mencukupi (Sisa: ' || v_sisa || ' hari, diajukan: ' || v_hari || ' hari).'
            );
        END IF;
    END IF;

    -- Cek pengajuan cuti yang masih PENDING / PROPOSED pada periode yang sama
    IF EXISTS (
        SELECT 1 FROM "pengajuan_ijin_lembur_tbl"
        WHERE UPPER(TRIM("qrcodeid")) = UPPER(TRIM(p_qrcode))
          AND "tipe" = 'CUTI'
          AND "status" IN ('PENDING', 'PROPOSED')
    ) THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Anda masih memiliki pengajuan cuti yang sedang menunggu verifikasi.');
    END IF;

    -- Simpan pengajuan Cuti dengan 2 Level Approval (Level 1: Atasan, Level 2: HR)
    INSERT INTO "pengajuan_ijin_lembur_tbl" (
        "qrcodeid", "nama_karyawan", "jabatan", "lokasi", "tipe", "tanggal",
        "tanggal_mulai", "tanggal_selesai", "jumlah_hari", "jenis_cuti", "surat_dokter_url",
        "alasan", "status", "current_level", "total_levels", "level1_action", "level2_action",
        "created_at", "updated_at"
    )
    VALUES (
        UPPER(TRIM(p_qrcode)), v_kar."NamaPersonnel", v_kar."Kualifikasi", v_kar."Lokasi",
        'CUTI', p_tgl_mulai, p_tgl_mulai, p_tgl_selesai, v_hari, p_jenis_cuti, p_surat_dokter_url,
        p_alasan, 'PENDING', 1, 2, 'PROPOSE', 'APPROVE',
        NOW(), NOW()
    )
    RETURNING "id" INTO v_new_id;

    RETURN jsonb_build_object(
        'status', 'SUCCESS',
        'message', 'Pengajuan cuti (' || v_hari || ' hari) berhasil dikirim! Menunggu persetujuan Atasan Langsung.',
        'id', v_new_id,
        'jumlahHari', v_hari
    );
END;
$$;


-- 5. FUNCTION RPC: PROSES APPROVAL ACTION TERPADU (process_approval_action)
DROP FUNCTION IF EXISTS process_approval_action(BIGINT, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION process_approval_action(
    p_request_id BIGINT,
    p_user_qrcode TEXT,
    p_action TEXT,              -- 'PROPOSE', 'REVIEW', 'APPROVE', 'REJECT'
    p_catatan TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_req RECORD;
    v_approver RECORD;
    v_approver_name TEXT;
    v_approver_role TEXT;
    v_curr_date DATE;
BEGIN
    SELECT * INTO v_req FROM "pengajuan_ijin_lembur_tbl" WHERE "id" = p_request_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Pengajuan tidak ditemukan.');
    END IF;

    IF v_req.status IN ('APPROVED', 'REJECTED') THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Pengajuan sudah berstatus ' || v_req.status || ' dan tidak dapat diubah.');
    END IF;

    SELECT "NamaPersonnel", "Kualifikasi", TRIM("Author") as author_code
    INTO v_approver
    FROM "karyawanTbl"
    WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_user_qrcode))
    LIMIT 1;

    IF v_approver IS NULL THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Identitas otorisator tidak valid.');
    END IF;

    v_approver_name := v_approver."NamaPersonnel";
    v_approver_role := COALESCE(NULLIF(v_approver.author_code, ''), v_approver."Kualifikasi");

    -- 1. HANDLE REJECT
    IF UPPER(TRIM(p_action)) = 'REJECT' THEN
        UPDATE "pengajuan_ijin_lembur_tbl"
        SET "status" = 'REJECTED',
            "reject_reason" = p_catatan,
            "rejected_by" = v_approver_name || ' (' || v_approver_role || ')',
            "rejected_at" = NOW(),
            "updated_at" = NOW()
        WHERE "id" = p_request_id;

        RETURN jsonb_build_object('status', 'SUCCESS', 'message', 'Pengajuan telah ditolak.');
    END IF;

    -- 2. HANDLE APPROVAL LEVEL 1 (ATASAN LANGSUNG: PROPOSE)
    IF v_req.current_level = 1 THEN
        IF v_req.total_levels > 1 THEN
            -- Lanjut ke Level 2 (HR / Manajemen)
            UPDATE "pengajuan_ijin_lembur_tbl"
            SET "status" = 'PROPOSED',
                "current_level" = 2,
                "level1_by" = v_approver_name || ' (' || v_approver_role || ')',
                "level1_at" = NOW(),
                "level1_action" = 'PROPOSED',
                "level1_notes" = p_catatan,
                "updated_at" = NOW()
            WHERE "id" = p_request_id;

            RETURN jsonb_build_object('status', 'SUCCESS', 'message', 'Pengajuan berhasil di-Propose ke Level 2 (HRD).');
        ELSE
            -- Single Level Approval langsung Approve
            UPDATE "pengajuan_ijin_lembur_tbl"
            SET "status" = 'APPROVED',
                "level1_by" = v_approver_name || ' (' || v_approver_role || ')',
                "level1_at" = NOW(),
                "level1_action" = 'APPROVED',
                "level1_notes" = p_catatan,
                "updated_at" = NOW()
            WHERE "id" = p_request_id;

            RETURN jsonb_build_object('status', 'SUCCESS', 'message', 'Pengajuan telah disetujui.');
        END IF;

    -- 3. HANDLE APPROVAL LEVEL 2 (HRD / FINAL APPROVAL)
    ELSIF v_req.current_level = 2 THEN
        UPDATE "pengajuan_ijin_lembur_tbl"
        SET "status" = 'APPROVED',
            "level2_by" = v_approver_name || ' (' || v_approver_role || ')',
            "level2_at" = NOW(),
            "level2_action" = 'APPROVED',
            "level2_notes" = p_catatan,
            "updated_at" = NOW()
        WHERE "id" = p_request_id;

        -- JIKA TIPE CUTI: POTONG SALDO CUTI & GENERATE LOG ABSENSI
        IF v_req.tipe = 'CUTI' THEN
            -- A. Potong saldo kuota cuti jika Cuti Tahunan
            IF UPPER(TRIM(COALESCE(v_req.jenis_cuti, 'CUTI_TAHUNAN'))) = 'CUTI_TAHUNAN' THEN
                UPDATE "karyawanTbl"
                SET "SisaCuti" = GREATEST(0, COALESCE("SisaCuti", 12) - COALESCE(v_req.jumlah_hari, 1))
                WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(v_req.qrcodeid));
            END IF;

            -- B. Generate baris di absensiTbl untuk setiap tanggal cuti
            FOR v_curr_date IN 
                SELECT generate_series(
                    COALESCE(v_req.tanggal_mulai, v_req.tanggal),
                    COALESCE(v_req.tanggal_selesai, v_req.tanggal),
                    '1 day'::interval
                )::DATE 
            LOOP
                -- Insert log status cuti
                INSERT INTO "absensiTbl" ("Tanggal", "QrCodeId", "LokasiMasuk1", "Status")
                VALUES (v_curr_date, UPPER(TRIM(v_req.qrcodeid)), v_req.lokasi, 'CUTI');
            END LOOP;
        END IF;

        RETURN jsonb_build_object(
            'status', 'SUCCESS', 
            'message', 'Pengajuan Cuti telah disetujui resmi oleh HRD! Kuota cuti terpotong dan log absensi otomatis terisi.'
        );
    END IF;

    RETURN jsonb_build_object('status', 'ERROR', 'message', 'Tingkat otorisasi tidak valid.');
END;
$$;


-- 6. PERBARUI submit_absensi: TOLAK ABSENSI JIKA SEDANG DALAM JADWAL CUTI RESMI
-- (Mencegah tap tidak sengaja di HP SmartGate saat cuti)
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
    v_toleransi_pulang TIME;
    v_cuti RECORD;
BEGIN
    -- Tentukan Waktu Absen (WITA)
    v_now_wita := COALESCE(p_timestamp_offline, NOW());
    v_today := (v_now_wita AT TIME ZONE 'Asia/Makassar')::DATE;
    v_time_now := (v_now_wita AT TIME ZONE 'Asia/Makassar')::TIME;

    -- 1. Ambil data karyawan
    SELECT "Id", "NamaPersonnel", COALESCE("AuthCheck", FALSE)
    INTO v_kar_id, v_nama, v_auth_check
    FROM "karyawanTbl"
    WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcodeid))
    LIMIT 1;

    IF v_kar_id IS NULL THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Karyawan dengan QR ' || p_qrcodeid || ' tidak ditemukan.');
    END IF;

    -- 2. CEK APAKAH HARI INI SEDANG DALAM MASA CUTI RESMI
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

    -- 3. Validasi Password jika AuthCheck = TRUE
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

    -- 4. Ambil Lokasi ID & TimeLimit yang sesuai
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
            INSERT INTO "absensiTbl" ("Tanggal", "QrCodeId", "JamMasuk1", "LokasiMasuk1", "Status")
            VALUES (v_today, UPPER(TRIM(p_qrcodeid)), v_now_wita, p_lokasi, 'OPEN')
            RETURNING "Id" INTO v_new_id;
            v_slot_recorded := 'Jam Masuk 1';

        ELSIF v_time_now >= v_limit_istirahat AND v_time_now < v_toleransi_pulang THEN
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
        -- 7. SUDAH ADA RECORD HARI INI

        -- Jika status sudah CLOSED dan lewat jam pulang -> Lembur
        IF v_absen."Status" = 'CLOSED' AND v_time_now >= v_toleransi_pulang THEN
            RETURN jsonb_build_object(
                'status', 'NEED_VOUCHER',
                'message', 'Sesi reguler sudah CLOSED. Masukkan Voucher PIN untuk lembur.'
            );
        END IF;

        -- Window 1: Pagi
        IF v_time_now < v_limit_istirahat THEN
            IF v_absen."JamMasuk1" IS NOT NULL THEN
                RETURN jsonb_build_object(
                    'status', 'ERROR',
                    'message', '⚠️ ' || v_nama || ' sudah melakukan Absensi Masuk 1 pada pukul ' || TO_CHAR(v_absen."JamMasuk1" AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') || ' WITA.'
                );
            END IF;
        END IF;

        -- Window 2: Istirahat
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

        -- Window 3: Masuk 2
        IF v_time_now >= v_limit_masuk2 AND v_time_now < v_toleransi_pulang THEN
            IF v_absen."JamMasuk2" IS NOT NULL THEN
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
                        'message', '⚠️ ' || v_nama || ' sudah melakukan Absensi Masuk 2 pada pukul ' || TO_CHAR(v_absen."JamMasuk2" AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') || ' WITA. Jam Pulang dibuka pukul ' || TO_CHAR(v_limit_pulang, 'HH24:MI') || ' WITA.'
                    );
                END IF;
            ELSE
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

        -- Window 4: Pulang
        IF v_time_now >= v_toleransi_pulang THEN
            IF v_absen."JamPulang" IS NOT NULL THEN
                RETURN jsonb_build_object(
                    'status', 'ERROR',
                    'message', '⚠️ ' || v_nama || ' sudah melakukan Absensi Pulang pada pukul ' || TO_CHAR(v_absen."JamPulang" AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS') || ' WITA (Status: CLOSED).'
                );
            ELSE
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

        RETURN jsonb_build_object(
            'status', 'ERROR',
            'message', '⚠️ Tidak ada jadwal slot absensi yang sesuai saat ini.'
        );
    END IF;
END;
$$;