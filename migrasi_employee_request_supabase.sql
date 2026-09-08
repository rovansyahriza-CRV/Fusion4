-- =====================================================================================
-- Fusion4 SmartGate — Migrasi Tabel & RPC "Employee Request" (Permintaan Karyawan)
-- Author: "Employee Request"
-- Updated: Auto-Drop existing RPCs & Auto-Add "Divisi" column
-- =====================================================================================

-- 1. Buat Tabel jika belum ada
CREATE TABLE IF NOT EXISTS "employeeRequestTbl" (
    "Id" SERIAL PRIMARY KEY,
    "RequestNo" TEXT UNIQUE NOT NULL,
    "TanggalRequest" DATE DEFAULT CURRENT_DATE,
    "PemohonId" INT REFERENCES "karyawanTbl"("Id") ON DELETE SET NULL,
    "PemohonNama" TEXT NOT NULL,
    "Divisi" TEXT, -- Finance, Operation, Human Resources, Supply Chains, Bussiness Development
    "Departemen" TEXT,
    "ProjectCode" TEXT,
    "LokasiSite" TEXT NOT NULL,
    "PosisiJabatan" TEXT NOT NULL, -- Qualification / Position
    "JumlahOrang" INT DEFAULT 1,
    "TanggalDibutuhkan" DATE,
    "DurasiKerja" TEXT, -- misal: 'PKWT 3 Bulan', 'PKWT 6 Bulan', 'PKWT 1 Tahun', 'Project-Based', 'Permanen (PKWTT)', 'Harian Lepas'
    "JenisKelamin" TEXT DEFAULT 'Laki-laki / Perempuan',
    "PendidikanMinimal" TEXT, -- misal: 'SMA/SMK', 'D3', 'S1'
    "PengalamanMinimal" TEXT, -- misal: 'Fresh Graduate', '1-2 Tahun', '3-5 Tahun', '> 5 Tahun'
    "KualifikasiKhusus" TEXT, -- Sertifikat (Welder, K3, Rigger), dll
    "AlasanPermintaan" TEXT, -- 'Proyek Baru', 'Penggantian Karyawan Resign', 'Tambahan Beban Kerja', 'Backfill'
    "Status" TEXT DEFAULT 'PENDING', -- 'PENDING', 'APPROVED', 'REJECTED', 'IN PROGRESS', 'FULFILLED'
    "ApprovedBy" TEXT,
    "ApprovedAt" TIMESTAMPTZ,
    "CatatanApproval" TEXT,
    "CreatedAt" TIMESTAMPTZ DEFAULT NOW(),
    "UpdatedAt" TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Tambahkan kolom "Divisi" secara aman jika belum ada
ALTER TABLE "employeeRequestTbl" ADD COLUMN IF NOT EXISTS "Divisi" TEXT;

-- 3. Index untuk performa query
CREATE INDEX IF NOT EXISTS "idx_emp_req_status" ON "employeeRequestTbl"("Status");
CREATE INDEX IF NOT EXISTS "idx_emp_req_tgl" ON "employeeRequestTbl"("TanggalRequest" DESC);
CREATE INDEX IF NOT EXISTS "idx_emp_req_divisi" ON "employeeRequestTbl"("Divisi");

-- 4. Enable RLS & Hak Akses
ALTER TABLE "employeeRequestTbl" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "emp_req_all_policy" ON "employeeRequestTbl";
CREATE POLICY "emp_req_all_policy" ON "employeeRequestTbl" FOR ALL USING (true) WITH CHECK (true);
GRANT ALL ON "employeeRequestTbl" TO anon, authenticated, service_role;
GRANT ALL ON SEQUENCE "employeeRequestTbl_Id_seq" TO anon, authenticated, service_role;

-- 5. DROP RPC lama agar tidak konflik tipe data
DROP FUNCTION IF EXISTS list_employee_requests(TEXT);
DROP FUNCTION IF EXISTS list_employee_requests();
DROP FUNCTION IF EXISTS submit_employee_request CASCADE;
DROP FUNCTION IF EXISTS process_employee_request_approval CASCADE;
DROP FUNCTION IF EXISTS delete_employee_request CASCADE;

-- 6. RPC 1: List all requests with optional status filter
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
    approvedby TEXT,
    approvedat TIMESTAMPTZ,
    catatanapproval TEXT,
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
        r."ApprovedBy" AS approvedby,
        r."ApprovedAt" AS approvedat,
        r."CatatanApproval" AS catatanapproval,
        r."CreatedAt" AS createdat
    FROM "employeeRequestTbl" r
    WHERE (p_status IS NULL OR p_status = '' OR p_status = 'ALL' OR UPPER(r."Status") = UPPER(p_status))
    ORDER BY r."CreatedAt" DESC;
END;
$$;

-- 7. RPC 2: Submit new employee request
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
        p_kualifikasi, p_alasan, 'PENDING', NOW(), NOW()
    )
    RETURNING "Id" INTO v_new_id;

    RETURN jsonb_build_object(
        'success', true,
        'id', v_new_id,
        'requestNo', v_req_no,
        'message', 'Permintaan karyawan berhasil diajukan dengan nomor ' || v_req_no
    );
END;
$$;

-- 8. RPC 3: Approve / Reject / Update Status employee request
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
    UPDATE "employeeRequestTbl"
    SET 
        "Status" = UPPER(p_status),
        "ApprovedBy" = p_approved_by,
        "ApprovedAt" = NOW(),
        "CatatanApproval" = p_catatan,
        "UpdatedAt" = NOW()
    WHERE "Id" = p_id;

    RETURN jsonb_build_object(
        'success', true,
        'id', p_id,
        'status', UPPER(p_status),
        'message', 'Status permintaan karyawan berhasil diperbarui menjadi ' || UPPER(p_status)
    );
END;
$$;

-- 9. RPC 4: Delete request
CREATE OR REPLACE FUNCTION delete_employee_request(p_id INT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    DELETE FROM "employeeRequestTbl" WHERE "Id" = p_id;
    RETURN jsonb_build_object('success', true, 'message', 'Permintaan karyawan berhasil dihapus');
END;
$$;

GRANT EXECUTE ON FUNCTION list_employee_requests TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION submit_employee_request TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION process_employee_request_approval TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION delete_employee_request TO anon, authenticated, service_role;