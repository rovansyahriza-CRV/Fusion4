-- =====================================================================================
-- FIX FINAL: AUTO-GENERATE ID "karyawanTbl" & "paswordTbl" + RPC create_karyawan_full
-- Mengatasi error: null value in column "Id" of relation "karyawanTbl" violates not-null constraint
-- =====================================================================================

-- 1. Pasang Sequence Auto-Increment pada kolom "Id" di tabel "karyawanTbl" & "paswordTbl"
CREATE SEQUENCE IF NOT EXISTS "karyawanTbl_Id_seq";
SELECT setval('"karyawanTbl_Id_seq"', COALESCE((SELECT MAX("Id") FROM "karyawanTbl"), 0) + 1, false);
ALTER TABLE "karyawanTbl" ALTER COLUMN "Id" SET DEFAULT nextval('"karyawanTbl_Id_seq"');

CREATE SEQUENCE IF NOT EXISTS "paswordTbl_Id_seq";
SELECT setval('"paswordTbl_Id_seq"', COALESCE((SELECT MAX("Id") FROM "paswordTbl"), 0) + 1, false);
ALTER TABLE "paswordTbl" ALTER COLUMN "Id" SET DEFAULT nextval('"paswordTbl_Id_seq"');

-- 2. Pastikan kolom-kolom pendukung tersedia di "karyawanTbl"
ALTER TABLE "karyawanTbl" ADD COLUMN IF NOT EXISTS "Divisi" TEXT;
ALTER TABLE "karyawanTbl" ADD COLUMN IF NOT EXISTS "Departemen" TEXT;
ALTER TABLE "karyawanTbl" ADD COLUMN IF NOT EXISTS "Kualifikasi" TEXT;
ALTER TABLE "karyawanTbl" ADD COLUMN IF NOT EXISTS "Type" TEXT;
ALTER TABLE "karyawanTbl" ADD COLUMN IF NOT EXISTS "TglMasuk" DATE;
ALTER TABLE "karyawanTbl" ADD COLUMN IF NOT EXISTS "QrCodeId" TEXT;
ALTER TABLE "karyawanTbl" ADD COLUMN IF NOT EXISTS "DigitalPin" TEXT;
ALTER TABLE "karyawanTbl" ADD COLUMN IF NOT EXISTS "IsActive" BOOLEAN DEFAULT true;
ALTER TABLE "karyawanTbl" ADD COLUMN IF NOT EXISTS "FotoUrl" TEXT;
ALTER TABLE "karyawanTbl" ADD COLUMN IF NOT EXISTS "FotoFileId" TEXT;

-- 3. Pastikan kolom-kolom pendukung tersedia di "paswordTbl"
ALTER TABLE "paswordTbl" ADD COLUMN IF NOT EXISTS "Nama" TEXT;
ALTER TABLE "paswordTbl" ADD COLUMN IF NOT EXISTS "Password" TEXT;
ALTER TABLE "paswordTbl" ADD COLUMN IF NOT EXISTS "Author" TEXT;
ALTER TABLE "paswordTbl" ADD COLUMN IF NOT EXISTS "PIC" TEXT;
ALTER TABLE "paswordTbl" ADD COLUMN IF NOT EXISTS "QrCodeId" TEXT;

-- 4. Perbarui RPC create_karyawan_full (Penanganan Eksplisit & Robust)
DROP FUNCTION IF EXISTS create_karyawan_full(TEXT, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS create_karyawan_full(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION create_karyawan_full(
    p_nama TEXT,
    p_type TEXT DEFAULT NULL,
    p_kualifikasi TEXT DEFAULT NULL,
    p_departemen TEXT DEFAULT NULL,
    p_divisi TEXT DEFAULT NULL,
    p_tglmasuk TEXT DEFAULT NULL,
    p_password TEXT DEFAULT '12345',
    p_author TEXT DEFAULT NULL,
    p_pic TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS 
DECLARE
    v_new_id BIGINT;
    v_qrcodeid TEXT;
    v_digitalpin TEXT;
    v_clean_name TEXT;
    v_tgl_masuk DATE;
BEGIN
    v_clean_name := TRIM(p_nama);
    IF v_clean_name IS NULL OR v_clean_name = '' THEN
        RETURN jsonb_build_object(
            'status', 'ERROR',
            'message', 'Nama karyawan tidak boleh kosong.'
        );
    END IF;

    -- Konversi tanggal jika diberikan
    IF p_tglmasuk IS NOT NULL AND TRIM(p_tglmasuk) <> '' THEN
        BEGIN
            v_tgl_masuk := p_tglmasuk::DATE;
        EXCEPTION WHEN OTHERS THEN
            v_tgl_masuk := CURRENT_DATE;
        END;
    ELSE
        v_tgl_masuk := CURRENT_DATE;
    END IF;

    -- Dapatkan ID Baru secara eksplisit (Anti-Gagal)
    SELECT GREATEST(
        COALESCE((SELECT MAX("Id") FROM "karyawanTbl"), 0),
        COALESCE((SELECT MAX("Id") FROM "paswordTbl"), 0)
    ) + 1 INTO v_new_id;

    -- Update sequence agar tetap sinkron
    PERFORM setval('"karyawanTbl_Id_seq"', v_new_id, true);
    PERFORM setval('"paswordTbl_Id_seq"', v_new_id, true);

    -- Generate QrCodeId & Digital PIN unik
    v_qrcodeid := 'K-' || LPAD(v_new_id::TEXT, 4, '0');
    v_digitalpin := LPAD(FLOOR(RANDOM() * 900000 + 100000)::TEXT, 6, '0');

    -- INSERT ke karyawanTbl dengan "Id" eksplisit
    INSERT INTO "karyawanTbl" (
        "Id",
        "NamaPersonnel",
        "Type",
        "Kualifikasi",
        "Departemen",
        "Divisi",
        "TglMasuk",
        "QrCodeId",
        "DigitalPin",
        "IsActive"
    ) VALUES (
        v_new_id,
        v_clean_name,
        p_type,
        p_kualifikasi,
        p_departemen,
        p_divisi,
        v_tgl_masuk,
        v_qrcodeid,
        v_digitalpin,
        true
    );

    -- INSERT / UPSERT ke paswordTbl
    INSERT INTO "paswordTbl" (
        "Id",
        "Nama",
        "Password",
        "Author",
        "PIC",
        "QrCodeId"
    ) VALUES (
        v_new_id,
        v_clean_name,
        COALESCE(NULLIF(TRIM(p_password), ''), '12345'),
        p_author,
        p_pic,
        v_qrcodeid
    )
    ON CONFLICT ("Id") DO UPDATE
    SET "Nama" = EXCLUDED."Nama",
        "Password" = EXCLUDED."Password",
        "Author" = EXCLUDED."Author",
        "PIC" = EXCLUDED."PIC",
        "QrCodeId" = EXCLUDED."QrCodeId";

    RETURN jsonb_build_object(
        'status', 'SUCCESS',
        'message', 'Karyawan baru berhasil didaftarkan.',
        'id', v_new_id,
        'qrcodeid', v_qrcodeid,
        'digitalpin', v_digitalpin
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'status', 'ERROR',
        'message', SQLERRM
    );
END;
;

-- 5. Perbarui RPC update_karyawan_core
DROP FUNCTION IF EXISTS update_karyawan_core(BIGINT, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION update_karyawan_core(
    p_id BIGINT,
    p_departemen TEXT DEFAULT NULL,
    p_divisi TEXT DEFAULT NULL,
    p_author TEXT DEFAULT NULL,
    p_pic TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS 
BEGIN
    UPDATE "karyawanTbl"
    SET "Departemen" = p_departemen,
        "Divisi" = p_divisi
    WHERE "Id" = p_id;

    UPDATE "paswordTbl"
    SET "Author" = p_author,
        "PIC" = p_pic
    WHERE "Id" = p_id;

    RETURN jsonb_build_object(
        'status', 'SUCCESS',
        'message', 'Data karyawan berhasil diperbarui.'
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'status', 'ERROR',
        'message', SQLERRM
    );
END;
;

-- 6. Perbarui RPC list_karyawan_all
DROP FUNCTION IF EXISTS list_karyawan_all();

CREATE OR REPLACE FUNCTION list_karyawan_all()
RETURNS TABLE (
    id BIGINT,
    namapersonnel TEXT,
    type TEXT,
    kualifikasi TEXT,
    departemen TEXT,
    divisi TEXT,
    tglmasuk DATE,
    qrcodeid TEXT,
    digitalpin TEXT,
    isactive BOOLEAN,
    author TEXT,
    pic TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS 
BEGIN
    RETURN QUERY
    SELECT 
        k."Id" AS id,
        k."NamaPersonnel"::TEXT AS namapersonnel,
        k."Type"::TEXT AS type,
        k."Kualifikasi"::TEXT AS kualifikasi,
        k."Departemen"::TEXT AS departemen,
        k."Divisi"::TEXT AS divisi,
        k."TglMasuk"::DATE AS tglmasuk,
        k."QrCodeId"::TEXT AS qrcodeid,
        k."DigitalPin"::TEXT AS digitalpin,
        COALESCE(k."IsActive", true) AS isactive,
        p."Author"::TEXT AS author,
        p."PIC"::TEXT AS pic
    FROM "karyawanTbl" k
    LEFT JOIN "paswordTbl" p ON k."Id" = p."Id"
    ORDER BY k."Id" DESC;
END;
;
