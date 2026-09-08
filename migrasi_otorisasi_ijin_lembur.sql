-- =====================================================================================
-- MIGRASI OTORISASI BERJENJANG (PROPOSE -> REVIEW -> APPROVED)
-- FUSION4 SMARTGATE: IJIN & LEMBUR (SPKL) DENGAN AUTO-GENERATE VOUCHER / KODE
-- =====================================================================================

-- 1. Pastikan kolom Author & AuthorizedBy ada di karyawanTbl
ALTER TABLE IF EXISTS "karyawanTbl" 
ADD COLUMN IF NOT EXISTS "Author" TEXT,
ADD COLUMN IF NOT EXISTS "AuthorizedBy" TEXT;

-- 2. Buat Tabel Utama Pengajuan Ijin & Lembur
CREATE TABLE IF NOT EXISTS pengajuan_ijin_lembur_tbl (
    id BIGSERIAL PRIMARY KEY,
    qrcodeid TEXT NOT NULL,                          -- QrCodeId pemohon
    nama_pemohon TEXT,                               -- Nama pemohon (snapshot)
    kualifikasi TEXT,                                -- Jabatan/Kualifikasi
    tipe TEXT NOT NULL CHECK (tipe IN ('IJIN', 'LEMBUR')),
    tanggal DATE NOT NULL DEFAULT CURRENT_DATE,
    alasan TEXT NOT NULL,
    durasi_jam NUMERIC(4,2) DEFAULT 0,               -- Durasi estimasi lembur
    lokasi TEXT,                                     -- Area / Site project
    
    -- Status & Level Tracking
    status TEXT NOT NULL DEFAULT 'PENDING_PROPOSE' 
        CHECK (status IN ('PENDING_PROPOSE', 'PROPOSED', 'REVIEWED', 'APPROVED', 'REJECTED')),
    total_levels INT NOT NULL DEFAULT 1 CHECK (total_levels BETWEEN 1 AND 3),
    current_level INT NOT NULL DEFAULT 1 CHECK (current_level BETWEEN 1 AND 3),
    
    -- Level 1 (Atasan Langsung)
    level1_target_role TEXT,                         -- Contoh: 'SupervisorA-015'
    level1_by TEXT,                                  -- Nama / QrCodeId yang memproses
    level1_at TIMESTAMPTZ,
    level1_action TEXT CHECK (level1_action IN ('PROPOSE', 'APPROVED', 'REJECTED')),
    level1_notes TEXT,
    
    -- Level 2 (Atasan Level 2, misal Superitendent)
    level2_target_role TEXT,                         -- Contoh: 'Superitendent-015'
    level2_by TEXT,
    level2_at TIMESTAMPTZ,
    level2_action TEXT CHECK (level2_action IN ('REVIEW', 'APPROVED', 'REJECTED')),
    level2_notes TEXT,
    
    -- Level 3 (Puncak, misal Project Sponsor / Direktur)
    level3_target_role TEXT,                         -- Contoh: 'Project Sponsor' / 'Direktur'
    level3_by TEXT,
    level3_at TIMESTAMPTZ,
    level3_action TEXT CHECK (level3_action IN ('APPROVED', 'REJECTED')),
    level3_notes TEXT,
    
    -- Penolakan (jika ada)
    reject_reason TEXT,
    rejected_by TEXT,
    rejected_at TIMESTAMPTZ,
    
    -- Output Voucher / Kode (HANYA terisi otomatis saat status = 'APPROVED')
    kode_ijin TEXT,                                  -- Format: IJIN-XXXX
    voucher_pin TEXT,                                -- Format: SPKL-XXXX
    is_used BOOLEAN NOT NULL DEFAULT FALSE,          -- True jika sudah dipakai saat absensi
    used_at TIMESTAMPTZ,
    
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexing untuk pencarian cepat
CREATE INDEX IF NOT EXISTS idx_pengajuan_qrcodeid ON pengajuan_ijin_lembur_tbl(qrcodeid);
CREATE INDEX IF NOT EXISTS idx_pengajuan_status ON pengajuan_ijin_lembur_tbl(status);
CREATE INDEX IF NOT EXISTS idx_pengajuan_kode_ijin ON pengajuan_ijin_lembur_tbl(kode_ijin);
CREATE INDEX IF NOT EXISTS idx_pengajuan_voucher_pin ON pengajuan_ijin_lembur_tbl(voucher_pin);

-- =====================================================================================
-- 3. FUNCTION: SUBMIT PENGAJUAN BARU & AUTO-CALCULATE LEVEL HIERARCHY
-- =====================================================================================
CREATE OR REPLACE FUNCTION submit_pengajuan_ijin_lembur(
    p_pemohon_qrcode TEXT,
    p_tipe TEXT,
    p_tanggal DATE,
    p_alasan TEXT,
    p_durasi_jam NUMERIC DEFAULT 0,
    p_lokasi TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_nama TEXT;
    v_kualifikasi TEXT;
    v_auth1 TEXT;
    v_auth2 TEXT := NULL;
    v_auth3 TEXT := NULL;
    v_total_levels INT := 1;
    v_init_status TEXT := 'PENDING_PROPOSE';
    v_new_id BIGINT;
BEGIN
    -- 1. Ambil data pemohon & AuthorizedBy pertama
    SELECT "NamaPersonnel", "Kualifikasi", TRIM("AuthorizedBy")
    INTO v_nama, v_kualifikasi, v_auth1
    FROM "karyawanTbl"
    WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_pemohon_qrcode))
    LIMIT 1;

    IF v_nama IS NULL THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Data karyawan tidak ditemukan.');
    END IF;

    IF v_auth1 IS NULL OR v_auth1 = '' THEN
        v_auth1 := 'Direktur';
    END IF;

    -- 2. Jika atasan langsung sudah Direktur (Puncak) -> LANGSUNG 1 LEVEL (APPROVE)
    IF UPPER(v_auth1) = 'DIREKTUR' THEN
        v_total_levels := 1;
        v_auth2 := NULL;
        v_auth3 := NULL;
    ELSE
        -- Cari Atasan Level 2
        SELECT TRIM("AuthorizedBy") INTO v_auth2
        FROM "karyawanTbl"
        WHERE (UPPER(TRIM("Author")) = UPPER(v_auth1) OR UPPER(TRIM("Kualifikasi")) = UPPER(v_auth1))
          AND TRIM("AuthorizedBy") IS NOT NULL 
          AND TRIM("AuthorizedBy") <> ''
          AND UPPER(TRIM("AuthorizedBy")) <> UPPER(v_auth1)
        LIMIT 1;

        IF v_auth2 IS NULL OR v_auth2 = '' THEN
            v_total_levels := 1;
        ELSIF UPPER(v_auth2) = 'DIREKTUR' THEN
            v_total_levels := 2;
            v_auth3 := NULL;
        ELSE
            -- Cari Atasan Level 3
            SELECT TRIM("AuthorizedBy") INTO v_auth3
            FROM "karyawanTbl"
            WHERE (UPPER(TRIM("Author")) = UPPER(v_auth2) OR UPPER(TRIM("Kualifikasi")) = UPPER(v_auth2))
              AND TRIM("AuthorizedBy") IS NOT NULL 
              AND TRIM("AuthorizedBy") <> ''
              AND UPPER(TRIM("AuthorizedBy")) <> UPPER(v_auth2)
            LIMIT 1;

            IF v_auth3 IS NOT NULL AND v_auth3 <> '' THEN
                v_total_levels := 3;
            ELSE
                v_total_levels := 2;
            END IF;
        END IF;
    END IF;

    -- 3. Insert pengajuan ke database
    INSERT INTO pengajuan_ijin_lembur_tbl (
        qrcodeid, nama_pemohon, kualifikasi, tipe, tanggal, alasan, durasi_jam, lokasi,
        status, total_levels, current_level,
        level1_target_role, level2_target_role, level3_target_role
    ) VALUES (
        UPPER(TRIM(p_pemohon_qrcode)), v_nama, v_kualifikasi, UPPER(TRIM(p_tipe)), p_tanggal, p_alasan, p_durasi_jam, p_lokasi,
        v_init_status, v_total_levels, 1,
        v_auth1, v_auth2, v_auth3
    ) RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'status', 'SUCCESS',
        'message', 'Pengajuan ' || p_tipe || ' berhasil dibuat.',
        'id', v_new_id,
        'total_levels', v_total_levels,
        'level1_target', v_auth1,
        'level2_target', v_auth2,
        'level3_target', v_auth3
    );
END;
$$;


-- =====================================================================================
-- 4. FUNCTION: PROSES APPROVAL ACTION (PROPOSE / REVIEW / APPROVE / REJECT)
-- =====================================================================================
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
    v_approver_role TEXT;
    v_approver_name TEXT;
    v_random_code TEXT;
    v_next_level INT;
    v_next_status TEXT;
    v_is_final BOOLEAN := FALSE;
BEGIN
    -- 1. Ambil data pengajuan
    SELECT * INTO v_req FROM pengajuan_ijin_lembur_tbl WHERE id = p_request_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Pengajuan tidak ditemukan.');
    END IF;

    IF v_req.status IN ('APPROVED', 'REJECTED') THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Pengajuan sudah berstatus ' || v_req.status || ' dan tidak dapat diubah.');
    END IF;

    -- 2. Ambil profil otorisator
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

    -- 3. Handle REJECT
    IF UPPER(TRIM(p_action)) = 'REJECT' THEN
        UPDATE pengajuan_ijin_lembur_tbl
        SET status = 'REJECTED',
            reject_reason = p_catatan,
            rejected_by = v_approver_name || ' (' || v_approver_role || ')',
            rejected_at = NOW(),
            updated_at = NOW()
        WHERE id = p_request_id;

        RETURN jsonb_build_object('status', 'SUCCESS', 'message', 'Pengajuan telah ditolak.');
    END IF;

    -- 4. Validasi kecocokan Level dan Aksi
    IF v_req.current_level = 1 THEN
        IF v_req.total_levels = 1 THEN
            v_is_final := TRUE;
            v_next_status := 'APPROVED';
        ELSE
            IF UPPER(TRIM(p_action)) <> 'PROPOSE' AND UPPER(TRIM(p_action)) <> 'APPROVE' THEN
                RETURN jsonb_build_object('status', 'ERROR', 'message', 'Aksi untuk level 1 harus Propose.');
            END IF;
            v_next_level := 2;
            v_next_status := 'PROPOSED';
        END IF;

        UPDATE pengajuan_ijin_lembur_tbl
        SET level1_by = v_approver_name || ' (' || v_approver_role || ')',
            level1_at = NOW(),
            level1_action = CASE WHEN v_is_final THEN 'APPROVED' ELSE 'PROPOSE' END,
            level1_notes = p_catatan
        WHERE id = p_request_id;

    ELSIF v_req.current_level = 2 THEN
        IF v_req.total_levels = 2 THEN
            v_is_final := TRUE;
            v_next_status := 'APPROVED';
        ELSE
            IF UPPER(TRIM(p_action)) <> 'REVIEW' AND UPPER(TRIM(p_action)) <> 'APPROVE' THEN
                RETURN jsonb_build_object('status', 'ERROR', 'message', 'Aksi untuk level 2 harus Review.');
            END IF;
            v_next_level := 3;
            v_next_status := 'REVIEWED';
        END IF;

        UPDATE pengajuan_ijin_lembur_tbl
        SET level2_by = v_approver_name || ' (' || v_approver_role || ')',
            level2_at = NOW(),
            level2_action = CASE WHEN v_is_final THEN 'APPROVED' ELSE 'REVIEW' END,
            level2_notes = p_catatan
        WHERE id = p_request_id;

    ELSIF v_req.current_level = 3 THEN
        v_is_final := TRUE;
        v_next_status := 'APPROVED';

        UPDATE pengajuan_ijin_lembur_tbl
        SET level3_by = v_approver_name || ' (' || v_approver_role || ')',
            level3_at = NOW(),
            level3_action = 'APPROVED',
            level3_notes = p_catatan
        WHERE id = p_request_id;
    END IF;

    -- 5. Jika Final Approval -> Generate Voucher / Kode
    IF v_is_final THEN
        v_random_code := UPPER(SUBSTRING(MD5(RANDOM()::TEXT || NOW()::TEXT) FROM 1 FOR 4));
        
        IF v_req.tipe = 'IJIN' THEN
            UPDATE pengajuan_ijin_lembur_tbl
            SET status = 'APPROVED',
                kode_ijin = 'IJIN-' || v_random_code,
                current_level = v_req.total_levels,
                updated_at = NOW()
            WHERE id = p_request_id;

            RETURN jsonb_build_object(
                'status', 'SUCCESS',
                'message', 'Pengajuan disetujui penuh! Kode Ijin diterbitkan: IJIN-' || v_random_code,
                'kode_ijin', 'IJIN-' || v_random_code,
                'final_approved', TRUE
            );
        ELSE
            UPDATE pengajuan_ijin_lembur_tbl
            SET status = 'APPROVED',
                voucher_pin = 'SPKL-' || v_random_code,
                current_level = v_req.total_levels,
                updated_at = NOW()
            WHERE id = p_request_id;

            RETURN jsonb_build_object(
                'status', 'SUCCESS',
                'message', 'Pengajuan disetujui penuh! Voucher PIN SPKL diterbitkan: SPKL-' || v_random_code,
                'voucher_pin', 'SPKL-' || v_random_code,
                'final_approved', TRUE
            );
        END IF;
    ELSE
        -- Update ke status intermediate (PROPOSED / REVIEWED)
        UPDATE pengajuan_ijin_lembur_tbl
        SET status = v_next_status,
            current_level = v_next_level,
            updated_at = NOW()
        WHERE id = p_request_id;

        RETURN jsonb_build_object(
            'status', 'SUCCESS',
            'message', 'Berhasil diproses ke level ' || v_next_level || ' (' || v_next_status || ').',
            'next_status', v_next_status,
            'next_level', v_next_level,
            'final_approved', FALSE
        );
    END IF;
END;
$$;


-- =====================================================================================
-- 5. FUNCTION: GET PENDING APPROVALS KHUSUS QRCODE LOGIN (UNTUK VIRTUAL WALLET & DESKTOP)
-- =====================================================================================
CREATE OR REPLACE FUNCTION get_pending_ijin_lembur_approvals_by_qrcode(p_qrcode TEXT)
RETURNS TABLE (
    id BIGINT,
    qrcodeid TEXT,
    nama_pemohon TEXT,
    kualifikasi TEXT,
    tipe TEXT,
    tanggal DATE,
    alasan TEXT,
    durasi_jam NUMERIC,
    lokasi TEXT,
    status TEXT,
    total_levels INT,
    current_level INT,
    required_action TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_author TEXT;
    v_kualifikasi TEXT;
    v_nama TEXT;
BEGIN
    -- Ambil data user
    SELECT TRIM("Author"), TRIM("Kualifikasi"), TRIM("NamaPersonnel")
    INTO v_author, v_kualifikasi, v_nama
    FROM "karyawanTbl"
    WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcode))
    LIMIT 1;

    RETURN QUERY
    SELECT 
        p.id,
        p.qrcodeid,
        p.nama_pemohon,
        p.kualifikasi,
        p.tipe,
        p.tanggal,
        p.alasan,
        p.durasi_jam,
        p.lokasi,
        p.status,
        p.total_levels,
        p.current_level,
        CASE 
            WHEN p.current_level = p.total_levels THEN 'APPROVE'
            WHEN p.current_level = 1 THEN 'PROPOSE'
            WHEN p.current_level = 2 THEN 'REVIEW'
            ELSE 'APPROVE'
        END AS required_action,
        p.created_at
    FROM pengajuan_ijin_lembur_tbl p
    WHERE p.status NOT IN ('APPROVED', 'REJECTED')
      AND (
        -- Cocok dengan Level 1
        (p.current_level = 1 AND (
            UPPER(p.level1_target_role) = UPPER(COALESCE(v_author, '')) OR
            UPPER(p.level1_target_role) = UPPER(COALESCE(v_kualifikasi, '')) OR
            UPPER(p.level1_target_role) = UPPER(COALESCE(v_nama, ''))
        ))
        OR
        -- Cocok dengan Level 2
        (p.current_level = 2 AND (
            UPPER(p.level2_target_role) = UPPER(COALESCE(v_author, '')) OR
            UPPER(p.level2_target_role) = UPPER(COALESCE(v_kualifikasi, '')) OR
            UPPER(p.level2_target_role) = UPPER(COALESCE(v_nama, ''))
        ))
        OR
        -- Cocok dengan Level 3
        (p.current_level = 3 AND (
            UPPER(p.level3_target_role) = UPPER(COALESCE(v_author, '')) OR
            UPPER(p.level3_target_role) = UPPER(COALESCE(v_kualifikasi, '')) OR
            UPPER(p.level3_target_role) = UPPER(COALESCE(v_nama, ''))
        ))
      )
    ORDER BY p.id DESC;
END;
$$;


-- =====================================================================================
-- 6. FUNCTION: GET VOUCHER AKTIF MILIK PEMOHON (UNTUK VIRTUAL WALLET DISPLAY)
-- =====================================================================================
CREATE OR REPLACE FUNCTION get_my_active_vouchers_by_qrcode(p_qrcode TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_ijin TEXT := '-';
    v_lembur TEXT := '-';
    v_ijin_locked BOOLEAN := FALSE;
    v_lembur_locked BOOLEAN := FALSE;
BEGIN
    -- 1. Ambil voucher Ijin aktif hari ini
    SELECT kode_ijin INTO v_ijin
    FROM pengajuan_ijin_lembur_tbl
    WHERE UPPER(TRIM(qrcodeid)) = UPPER(TRIM(p_qrcode))
      AND tipe = 'IJIN'
      AND status = 'APPROVED'
      AND is_used = FALSE
      AND tanggal = CURRENT_DATE
    ORDER BY id DESC
    LIMIT 1;

    -- 2. Ambil voucher Lembur aktif hari ini
    SELECT voucher_pin INTO v_lembur
    FROM pengajuan_ijin_lembur_tbl
    WHERE UPPER(TRIM(qrcodeid)) = UPPER(TRIM(p_qrcode))
      AND tipe = 'LEMBUR'
      AND status = 'APPROVED'
      AND is_used = FALSE
      AND tanggal = CURRENT_DATE
    ORDER BY id DESC
    LIMIT 1;

    -- 3. Cek apakah ada pengajuan pending (agar tombol di wallet lock/disable)
    IF EXISTS (
        SELECT 1 FROM pengajuan_ijin_lembur_tbl 
        WHERE UPPER(TRIM(qrcodeid)) = UPPER(TRIM(p_qrcode)) 
          AND tipe = 'IJIN' 
          AND status NOT IN ('APPROVED', 'REJECTED')
          AND tanggal = CURRENT_DATE
    ) THEN
        v_ijin_locked := TRUE;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pengajuan_ijin_lembur_tbl 
        WHERE UPPER(TRIM(qrcodeid)) = UPPER(TRIM(p_qrcode)) 
          AND tipe = 'LEMBUR' 
          AND status NOT IN ('APPROVED', 'REJECTED')
          AND tanggal = CURRENT_DATE
    ) THEN
        v_lembur_locked := TRUE;
    END IF;

    RETURN jsonb_build_object(
        'ijinVoucher', COALESCE(v_ijin, '-'),
        'lemburVoucher', COALESCE(v_lembur, '-'),
        'ijinLocked', v_ijin_locked,
        'lemburLocked', v_lembur_locked
    );
END;
$$;


-- =====================================================================================
-- 7. UPDATE RPC CHECK_IJIN_KELUAR_PENDING & SUBMIT_ABSENSI_LEMBUR (INTEGRASI ABSENSI)
-- =====================================================================================
CREATE OR REPLACE FUNCTION check_ijin_keluar_pending(p_qrcodeid TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_req RECORD;
BEGIN
    SELECT * INTO v_req
    FROM pengajuan_ijin_lembur_tbl
    WHERE UPPER(TRIM(qrcodeid)) = UPPER(TRIM(p_qrcodeid))
      AND tipe = 'IJIN'
      AND status = 'APPROVED'
      AND is_used = FALSE
      AND tanggal = CURRENT_DATE
    ORDER BY id DESC
    LIMIT 1;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'hasPending', TRUE,
            'kodeIjin', v_req.kode_ijin,
            'alasan', v_req.alasan
        );
    ELSE
        RETURN jsonb_build_object('hasPending', FALSE);
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION submit_ijin_keluar(
    p_qrcodeid TEXT,
    p_lokasi TEXT,
    p_kodeijin TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_req RECORD;
BEGIN
    SELECT * INTO v_req
    FROM pengajuan_ijin_lembur_tbl
    WHERE UPPER(TRIM(kode_ijin)) = UPPER(TRIM(p_kodeijin))
      AND UPPER(TRIM(qrcodeid)) = UPPER(TRIM(p_qrcodeid))
      AND is_used = FALSE
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Kode Ijin tidak valid atau sudah digunakan.');
    END IF;

    -- Tandai sudah terpakai
    UPDATE pengajuan_ijin_lembur_tbl
    SET is_used = TRUE,
        used_at = NOW(),
        lokasi = COALESCE(NULLIF(p_lokasi, ''), lokasi)
    WHERE id = v_req.id;

    -- Catat log absensi pulang ijin
    INSERT INTO "absensiTbl" ("QrCodeId", "Tanggal", "JamPulang", "Status")
    VALUES (UPPER(TRIM(p_qrcodeid)), CURRENT_DATE, TO_CHAR(NOW() AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS'), 'IJIN_PULANG');

    RETURN jsonb_build_object('status', 'SUCCESS', 'message', 'Ijin pulang berhasil tercatat.');
END;
$$;

CREATE OR REPLACE FUNCTION submit_absensi_lembur(
    p_qrcodeid TEXT,
    p_lokasi TEXT,
    p_pinvoucher TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_req RECORD;
BEGIN
    SELECT * INTO v_req
    FROM pengajuan_ijin_lembur_tbl
    WHERE UPPER(TRIM(voucher_pin)) = UPPER(TRIM(p_pinvoucher))
      AND is_used = FALSE
      AND status = 'APPROVED'
      AND tanggal = CURRENT_DATE
    LIMIT 1;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'NEED_VOUCHER', 'message', 'Voucher PIN belum aktif / salah. Coba lagi.');
    END IF;

    -- Tandai voucher sudah terpakai
    UPDATE pengajuan_ijin_lembur_tbl
    SET is_used = TRUE,
        used_at = NOW(),
        lokasi = COALESCE(NULLIF(p_lokasi, ''), lokasi)
    WHERE id = v_req.id;

    -- Catat log absensi lembur
    INSERT INTO "absensiTbl" ("QrCodeId", "Tanggal", "JamMasuk1", "Status")
    VALUES (UPPER(TRIM(p_qrcodeid)), CURRENT_DATE, TO_CHAR(NOW() AT TIME ZONE 'Asia/Makassar', 'HH24:MI:SS'), 'LEMBUR_MASUK');

    RETURN jsonb_build_object('status', 'SUCCESS', 'message', 'Absensi Lembur berhasil tercatat!');
END;
$$;

