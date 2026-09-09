-- =====================================================================================
-- Fusion4 SmartGate — Migrasi Workflow Employee Request Berjenjang (3-Level Lifecycle)
-- Level 1 (Atasan/PM: AER-xxx) ➔ Level 2 (HRD: PER) ➔ Level 3 (Direksi: APER)
-- =====================================================================================

-- 1. Pastikan kolom-kolom tracking audit trail tersedia di "employeeRequestTbl"
ALTER TABLE "employeeRequestTbl" ADD COLUMN IF NOT EXISTS "Divisi" TEXT;
ALTER TABLE "employeeRequestTbl" ADD COLUMN IF NOT EXISTS "AerApprovedBy" TEXT;
ALTER TABLE "employeeRequestTbl" ADD COLUMN IF NOT EXISTS "AerApprovedAt" TIMESTAMPTZ;
ALTER TABLE "employeeRequestTbl" ADD COLUMN IF NOT EXISTS "AerNotes" TEXT;
ALTER TABLE "employeeRequestTbl" ADD COLUMN IF NOT EXISTS "HrdProcessedBy" TEXT;
ALTER TABLE "employeeRequestTbl" ADD COLUMN IF NOT EXISTS "HrdProcessedAt" TIMESTAMPTZ;
ALTER TABLE "employeeRequestTbl" ADD COLUMN IF NOT EXISTS "HrdNotes" TEXT;
ALTER TABLE "employeeRequestTbl" ADD COLUMN IF NOT EXISTS "AperApprovedBy" TEXT;
ALTER TABLE "employeeRequestTbl" ADD COLUMN IF NOT EXISTS "AperApprovedAt" TIMESTAMPTZ;
ALTER TABLE "employeeRequestTbl" ADD COLUMN IF NOT EXISTS "AperNotes" TEXT;

-- 2. Index untuk performa
CREATE INDEX IF NOT EXISTS "idx_emp_req_status" ON "employeeRequestTbl"("Status");
CREATE INDEX IF NOT EXISTS "idx_emp_req_tgl" ON "employeeRequestTbl"("TanggalRequest" DESC);
CREATE INDEX IF NOT EXISTS "idx_emp_req_project" ON "employeeRequestTbl"("ProjectCode");

-- 3. DROP RPC lama agar tidak terjadi konflik return type
DROP FUNCTION IF EXISTS list_employee_requests(TEXT);
DROP FUNCTION IF EXISTS list_employee_requests();
DROP FUNCTION IF EXISTS submit_employee_request CASCADE;
DROP FUNCTION IF EXISTS process_employee_request_approval CASCADE;
DROP FUNCTION IF EXISTS process_employee_request_step CASCADE;

-- 4. RPC 1: List all requests with multi-tier audit trail
CREATE OR REPLACE FUNCTION list_employee_requests(p_status TEXT DEFAULT NULL)
RETURNS TABLE (
    id INT,
    requestno TEXT,
    tanggalrequest DATE,
    pemohonid INT,
    pemohonnama TEXT,
    divisi TEXT,
    departemen TEXT,
    projectcode TEXT,
    lokasisite TEXT,
    posisijabatan TEXT,
    jumlahorang INT,
    tanggaldibutuhkan DATE,
    durasikerja TEXT,
    jeniskelamin TEXT,
    pendidikanminimal TEXT,
    pengalamanminimal TEXT,
    kualifikasikhusus TEXT,
    alasanpermintaan TEXT,
    status TEXT,
    aer_approved_by TEXT,
    aer_approved_at TIMESTAMPTZ,
    aer_notes TEXT,
    hrd_processed_by TEXT,
    hrd_processed_at TIMESTAMPTZ,
    hrd_notes TEXT,
    aper_approved_by TEXT,
    aper_approved_at TIMESTAMPTZ,
    aper_notes TEXT,
    createdat TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        r."Id" AS id,
        r."RequestNo" AS requestno,
        r."TanggalRequest" AS tanggalrequest,
        r."PemohonId" AS pemohonid,
        r."PemohonNama" AS pemohonnama,
        r."Divisi" AS divisi,
        r."Departemen" AS departemen,
        r."ProjectCode" AS projectcode,
        r."LokasiSite" AS lokasisite,
        r."PosisiJabatan" AS posisijabatan,
        r."JumlahOrang" AS jumlahorang,
        r."TanggalDibutuhkan" AS tanggaldibutuhkan,
        r."DurasiKerja" AS durasikerja,
        r."JenisKelamin" AS jeniskelamin,
        r."PendidikanMinimal" AS pendidikanminimal,
        r."PengalamanMinimal" AS pengalamanminimal,
        r."KualifikasiKhusus" AS kualifikasikhusus,
        r."AlasanPermintaan" AS alasanpermintaan,
        r."Status" AS status,
        r."AerApprovedBy" AS aer_approved_by,
        r."AerApprovedAt" AS aer_approved_at,
        r."AerNotes" AS aer_notes,
        r."HrdProcessedBy" AS hrd_processed_by,
        r."HrdProcessedAt" AS hrd_processed_at,
        r."HrdNotes" AS hrd_notes,
        r."AperApprovedBy" AS aper_approved_by,
        r."AperApprovedAt" AS aper_approved_at,
        r."AperNotes" AS aper_notes,
        r."CreatedAt" AS createdat
    FROM "employeeRequestTbl" r
    WHERE (
        p_status IS NULL OR p_status = '' OR p_status = 'ALL' 
        OR UPPER(r."Status") = UPPER(p_status)
        OR (p_status = 'PENDING' AND (r."Status" LIKE 'PENDING%' OR r."Status" = 'PROSES_HRD'))
        OR (p_status = 'REJECTED' AND r."Status" LIKE 'REJECTED%')
    )
    ORDER BY r."CreatedAt" DESC;
END;
$$;

-- 5. RPC 2: Submit new request with initial status PENDING_AER
CREATE OR REPLACE FUNCTION submit_employee_request(
    p_pemohon_id INT,
    p_pemohon_nama TEXT,
    p_divisi TEXT,
    p_departemen TEXT,
    p_project_code TEXT,
    p_lokasi_site TEXT,
    p_posisi_jabatan TEXT,
    p_jumlah_orang INT,
    p_tanggal_dibutuhkan DATE,
    p_durasi_kerja TEXT,
    p_jenis_kelamin TEXT,
    p_pendidikan TEXT,
    p_pengalaman TEXT,
    p_kualifikasi TEXT,
    p_alasan TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_req_no TEXT;
    v_new_id INT;
    v_count INT;
BEGIN
    SELECT COUNT(*) + 1 INTO v_count 
    FROM "employeeRequestTbl" 
    WHERE "TanggalRequest" = CURRENT_DATE;

    v_req_no := 'REQ-' || TO_CHAR(CURRENT_DATE, 'YYYYMMDD') || '-' || LPAD(v_count::TEXT, 3, '0');

    INSERT INTO "employeeRequestTbl" (
        "RequestNo", "TanggalRequest", "PemohonId", "PemohonNama",
        "Divisi", "Departemen", "ProjectCode", "LokasiSite", "PosisiJabatan",
        "JumlahOrang", "TanggalDibutuhkan", "DurasiKerja",
        "JenisKelamin", "PendidikanMinimal", "PengalamanMinimal",
        "KualifikasiKhusus", "AlasanPermintaan", "Status", "CreatedAt", "UpdatedAt"
    ) VALUES (
        v_req_no, CURRENT_DATE, p_pemohon_id, p_pemohon_nama,
        p_divisi, p_departemen, p_project_code, p_lokasi_site, p_posisi_jabatan,
        COALESCE(p_jumlah_orang, 1), p_tanggal_dibutuhkan, p_durasi_kerja,
        COALESCE(p_jenis_kelamin, 'Laki-laki / Perempuan'), p_pendidikan, p_pengalaman,
        p_kualifikasi, p_alasan, 'PENDING_AER', NOW(), NOW()
    )
    RETURNING "Id" INTO v_new_id;

    RETURN jsonb_build_object(
        'success', true,
        'id', v_new_id,
        'requestNo', v_req_no,
        'message', 'Permintaan karyawan berhasil diajukan dengan nomor ' || v_req_no || '. Menunggu persetujuan Atasan/PM (AER).'
    );
END;
$$;

-- 6. RPC 3: Process Multi-Tier Step (AER ➔ PER/HRD ➔ APER/Direksi)
CREATE OR REPLACE FUNCTION process_employee_request_step(
    p_id INT,
    p_actor_name TEXT,
    p_step_action TEXT, -- 'AER_APPROVE', 'AER_REJECT', 'HRD_PROCEED_BOD', 'HRD_UPDATE', 'APER_APPROVE', 'APER_REJECT'
    p_notes TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_new_status TEXT;
    v_msg TEXT;
BEGIN
    IF p_step_action = 'AER_APPROVE' THEN
        v_new_status := 'PROSES_HRD';
        v_msg := 'Permintaan disetujui oleh Atasan/PM (AER) dan diteruskan ke Tim HRD (PER) untuk proses rekrutmen.';
        UPDATE "employeeRequestTbl"
        SET "Status" = v_new_status,
            "AerApprovedBy" = p_actor_name,
            "AerApprovedAt" = NOW(),
            "AerNotes" = p_notes,
            "UpdatedAt" = NOW()
        WHERE "Id" = p_id;

    ELSIF p_step_action = 'AER_REJECT' THEN
        v_new_status := 'REJECTED_AER';
        v_msg := 'Permintaan ditolak oleh Atasan/PM (AER).';
        UPDATE "employeeRequestTbl"
        SET "Status" = v_new_status,
            "AerApprovedBy" = p_actor_name,
            "AerApprovedAt" = NOW(),
            "AerNotes" = p_notes,
            "UpdatedAt" = NOW()
        WHERE "Id" = p_id;

    ELSIF p_step_action = 'HRD_PROCEED_BOD' THEN
        v_new_status := 'PENDING_APER';
        v_msg := 'Proses seleksi HRD selesai. Berkas diajukan ke Direksi / BOD (APER) untuk persetujuan final.';
        UPDATE "employeeRequestTbl"
        SET "Status" = v_new_status,
            "HrdProcessedBy" = p_actor_name,
            "HrdProcessedAt" = NOW(),
            "HrdNotes" = p_notes,
            "UpdatedAt" = NOW()
        WHERE "Id" = p_id;

    ELSIF p_step_action = 'HRD_UPDATE' THEN
        v_new_status := 'PROSES_HRD';
        v_msg := 'Catatan rekrutmen HRD berhasil diperbarui.';
        UPDATE "employeeRequestTbl"
        SET "HrdProcessedBy" = p_actor_name,
            "HrdProcessedAt" = NOW(),
            "HrdNotes" = p_notes,
            "UpdatedAt" = NOW()
        WHERE "Id" = p_id;

    ELSIF p_step_action = 'APER_APPROVE' THEN
        v_new_status := 'FULFILLED';
        v_msg := 'Permintaan resmi disetujui oleh Direksi / BOD (APER). Posisi siap didaftarkan menjadi Karyawan Baru.';
        UPDATE "employeeRequestTbl"
        SET "Status" = v_new_status,
            "AperApprovedBy" = p_actor_name,
            "AperApprovedAt" = NOW(),
            "AperNotes" = p_notes,
            "UpdatedAt" = NOW()
        WHERE "Id" = p_id;

    ELSIF p_step_action = 'APER_REJECT' THEN
        v_new_status := 'REJECTED_APER';
        v_msg := 'Permintaan ditolak oleh Direksi / BOD (APER).';
        UPDATE "employeeRequestTbl"
        SET "Status" = v_new_status,
            "AperApprovedBy" = p_actor_name,
            "AperApprovedAt" = NOW(),
            "AperNotes" = p_notes,
            "UpdatedAt" = NOW()
        WHERE "Id" = p_id;

    ELSE
        -- Fallback generic status update
        v_new_status := UPPER(p_step_action);
        v_msg := 'Status berhasil diubah menjadi ' || v_new_status;
        UPDATE "employeeRequestTbl"
        SET "Status" = v_new_status,
            "UpdatedAt" = NOW()
        WHERE "Id" = p_id;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'id', p_id,
        'status', v_new_status,
        'message', v_msg
    );
END;
$$;

-- 7. Backwards-compatibility wrapper
CREATE OR REPLACE FUNCTION process_employee_request_approval(
    p_id INT,
    p_approved_by TEXT,
    p_status TEXT,
    p_catatan TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN process_employee_request_step(p_id, p_approved_by, p_status, p_catatan);
END;
$$;

GRANT EXECUTE ON FUNCTION list_employee_requests TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION submit_employee_request TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_employee_request_step TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_employee_request_approval TO anon, authenticated, service_role;

-- 8. RPC Khusus Digital Badge: Ambil antrean approval permintaan karyawan berdasarkan QR Code Approver
DROP FUNCTION IF EXISTS get_pending_employee_requests_by_qrcode(TEXT);

CREATE OR REPLACE FUNCTION get_pending_employee_requests_by_qrcode(p_qrcode TEXT)
RETURNS TABLE (
    id INT,
    requestno TEXT,
    tanggalrequest DATE,
    pemohonid INT,
    pemohonnama TEXT,
    divisi TEXT,
    departemen TEXT,
    projectcode TEXT,
    lokasisite TEXT,
    posisijabatan TEXT,
    jumlahorang INT,
    tanggaldibutuhkan DATE,
    durasikerja TEXT,
    jeniskelamin TEXT,
    pendidikanminimal TEXT,
    pengalamanminimal TEXT,
    kualifikasikhusus TEXT,
    alasanpermintaan TEXT,
    status TEXT,
    stage TEXT,
    createdat TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_author TEXT := '';
    v_user_nama TEXT := '';
BEGIN
    -- 1. Identifikasi Author user berdasarkan QR Code / ID
    SELECT 
        COALESCE(p."Author", ''),
        COALESCE(k."NamaPersonnel", p."Nama", '')
    INTO v_user_author, v_user_nama
    FROM "karyawanTbl" k
    LEFT JOIN "paswordTbl" p ON k."Id" = p."Id"
    WHERE k."QrCodeId" = p_qrcode 
       OR p."QrCodeId" = p_qrcode
       OR k."Id"::TEXT = p_qrcode
       OR p."Id"::TEXT = p_qrcode;

    IF v_user_author IS NULL OR v_user_author = '' THEN
        RETURN;
    END IF;

    v_user_author := UPPER(v_user_author);

    -- 2. Query tiket Level 1 (AER) jika user memiliki otorisasi AER
    IF v_user_author LIKE '%AER%' OR v_user_author LIKE '%ALL%' OR v_user_author LIKE '%ADMIN%' THEN
        RETURN QUERY
        SELECT 
            r."Id" AS id,
            r."RequestNo" AS requestno,
            r."TanggalRequest" AS tanggalrequest,
            r."PemohonId" AS pemohonid,
            r."PemohonNama" AS pemohonnama,
            r."Divisi" AS divisi,
            r."Departemen" AS departemen,
            r."ProjectCode" AS projectcode,
            r."LokasiSite" AS lokasisite,
            r."PosisiJabatan" AS posisijabatan,
            r."JumlahOrang" AS jumlahorang,
            r."TanggalDibutuhkan" AS tanggaldibutuhkan,
            r."DurasiKerja" AS durasikerja,
            r."JenisKelamin" AS jeniskelamin,
            r."PendidikanMinimal" AS pendidikanminimal,
            r."PengalamanMinimal" AS pengalamanminimal,
            r."KualifikasiKhusus" AS kualifikasikhusus,
            r."AlasanPermintaan" AS alasanpermintaan,
            r."Status" AS status,
            'AER'::TEXT AS stage,
            r."CreatedAt" AS createdat
        FROM "employeeRequestTbl" r
        WHERE (r."Status" = 'PENDING_AER' OR r."Status" = 'PENDING')
          AND (
              v_user_author LIKE '%AER-ALL%' 
              OR v_user_author = 'AER' 
              OR v_user_author LIKE '%,AER,%'
              OR v_user_author LIKE 'AER,%'
              OR v_user_author LIKE '%,AER'
              OR v_user_author LIKE '%ALL%'
              OR v_user_author LIKE '%ADMIN%'
              OR (r."ProjectCode" IS NOT NULL AND v_user_author LIKE '%AER-' || UPPER(TRIM(r."ProjectCode")) || '%')
          )
        ORDER BY r."CreatedAt" ASC;
    END IF;

    -- 3. Query tiket Level 3 (APER) jika user memiliki otorisasi APER / BOD / Direksi
    IF v_user_author LIKE '%APER%' OR v_user_author LIKE '%BOD%' OR v_user_author LIKE '%DIR%' OR v_user_author LIKE '%ALL%' OR v_user_author LIKE '%ADMIN%' THEN
        RETURN QUERY
        SELECT 
            r."Id" AS id,
            r."RequestNo" AS requestno,
            r."TanggalRequest" AS tanggalrequest,
            r."PemohonId" AS pemohonid,
            r."PemohonNama" AS pemohonnama,
            r."Divisi" AS divisi,
            r."Departemen" AS departemen,
            r."ProjectCode" AS projectcode,
            r."LokasiSite" AS lokasisite,
            r."PosisiJabatan" AS posisijabatan,
            r."JumlahOrang" AS jumlahorang,
            r."TanggalDibutuhkan" AS tanggaldibutuhkan,
            r."DurasiKerja" AS durasikerja,
            r."JenisKelamin" AS jeniskelamin,
            r."PendidikanMinimal" AS pendidikanminimal,
            r."PengalamanMinimal" AS pengalamanminimal,
            r."KualifikasiKhusus" AS kualifikasikhusus,
            r."AlasanPermintaan" AS alasanpermintaan,
            r."Status" AS status,
            'APER'::TEXT AS stage,
            r."CreatedAt" AS createdat
        FROM "employeeRequestTbl" r
        WHERE r."Status" = 'PENDING_APER'
        ORDER BY r."CreatedAt" ASC;
    END IF;
END;
$$;

-- 9. RPC Eksekusi Approval/Reject dari Digital Badge via QR Code
DROP FUNCTION IF EXISTS process_employee_request_step_by_qrcode(TEXT, INT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION process_employee_request_step_by_qrcode(
    p_qrcode TEXT,
    p_id INT,
    p_step_action TEXT,
    p_notes TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_actor_name TEXT := '';
BEGIN
    -- Dapatkan nama approver dari QrCodeId
    SELECT COALESCE(k."NamaPersonnel", p."Nama", 'Approver')
    INTO v_actor_name
    FROM "karyawanTbl" k
    LEFT JOIN "paswordTbl" p ON k."Id" = p."Id"
    WHERE k."QrCodeId" = p_qrcode 
       OR p."QrCodeId" = p_qrcode
       OR k."Id"::TEXT = p_qrcode
       OR p."Id"::TEXT = p_qrcode;

    IF v_actor_name IS NULL OR v_actor_name = '' THEN
        v_actor_name := 'Approver (' || p_qrcode || ')';
    END IF;

    RETURN process_employee_request_step(p_id, v_actor_name, p_step_action, p_notes);
END;
$$;

GRANT EXECUTE ON FUNCTION get_pending_employee_requests_by_qrcode(TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_employee_request_step_by_qrcode(TEXT, INT, TEXT, TEXT) TO anon, authenticated, service_role;
