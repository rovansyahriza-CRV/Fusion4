-- =====================================================================================
-- MASTER FACE DESCRIPTOR SCHEMA & RPC (SUPABASE)
-- Menjamin Face Enrollment tersimpan langsung & real-time di Supabase
-- =====================================================================================

-- 1. Buat Tabel Khusus Penyimpanan Vector Descriptors Wajah (Jika belum ada)
CREATE TABLE IF NOT EXISTS "faceDescriptorTbl" (
    "Id" SERIAL PRIMARY KEY,
    "QrCodeId" TEXT NOT NULL UNIQUE,
    "NamaPersonnel" TEXT,
    "Descriptor" JSONB NOT NULL,
    "FotoURL" TEXT,
    "UpdatedAt" TIMESTAMPTZ DEFAULT NOW()
);

-- 2. RPC: Simpan / Update Vector Wajah (save_face_descriptor)
CREATE OR REPLACE FUNCTION save_face_descriptor(
    p_qrcode TEXT,
    p_nama TEXT,
    p_descriptor JSONB,
    p_fotourl TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO "faceDescriptorTbl" ("QrCodeId", "NamaPersonnel", "Descriptor", "FotoURL", "UpdatedAt")
    VALUES (UPPER(TRIM(p_qrcode)), p_nama, p_descriptor, p_fotourl, NOW())
    ON CONFLICT ("QrCodeId") DO UPDATE
    SET "NamaPersonnel" = EXCLUDED."NamaPersonnel",
        "Descriptor" = EXCLUDED."Descriptor",
        "FotoURL" = COALESCE(EXCLUDED."FotoURL", "faceDescriptorTbl"."FotoURL"),
        "UpdatedAt" = NOW();

    -- Update FotoURL di karyawanTbl jika ada
    IF p_fotourl IS NOT NULL AND p_fotourl <> '' THEN
        UPDATE "karyawanTbl"
        SET "FotoURL" = p_fotourl
        WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcode));
    END IF;

    RETURN jsonb_build_object(
        'status', 'SUCCESS',
        'message', 'Vector wajah berhasil disimpan di Supabase.'
    );
END;
$$;

-- 3. RPC: Ambil Seluruh Data Wajah (get_all_face_data)
CREATE OR REPLACE FUNCTION get_all_face_data()
RETURNS TABLE (
    nama TEXT,
    fotourl TEXT,
    qrcodeid TEXT,
    descriptor JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COALESCE(k."NamaPersonnel", f."NamaPersonnel")::TEXT AS nama,
        COALESCE(k."FotoURL", f."FotoURL", '')::TEXT AS fotourl,
        f."QrCodeId"::TEXT AS qrcodeid,
        f."Descriptor" AS descriptor
    FROM "faceDescriptorTbl" f
    LEFT JOIN "karyawanTbl" k ON UPPER(TRIM(k."QrCodeId")) = UPPER(TRIM(f."QrCodeId"))
    ORDER BY nama ASC;
END;
$$;

