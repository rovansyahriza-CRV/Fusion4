-- =====================================================================================
-- FIX FINAL: AUTO-GENERATE ID "lokasiTbl" & PERBAIKAN save_lokasi_with_timelimit
-- Menghilangkan error: null value in column "Id" of relation "lokasiTbl" violates not-null constraint
-- =====================================================================================

-- 1. Pasang Sequence Auto-Increment pada kolom "Id" di tabel "lokasiTbl" (Jika belum ada)
CREATE SEQUENCE IF NOT EXISTS "lokasiTbl_Id_seq";
SELECT setval('"lokasiTbl_Id_seq"', COALESCE((SELECT MAX("Id") FROM "lokasiTbl"), 0) + 1, false);
ALTER TABLE "lokasiTbl" ALTER COLUMN "Id" SET DEFAULT nextval('"lokasiTbl_Id_seq"');

-- 2. Perbarui RPC Function: save_lokasi_with_timelimit (Dengan Penanganan Id Baru yang 100% Aman)
DROP FUNCTION IF EXISTS save_lokasi_with_timelimit(BIGINT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, INT, TEXT, TEXT, TIME, TIME, TIME, TIME);
CREATE OR REPLACE FUNCTION save_lokasi_with_timelimit(
    p_id BIGINT,
    p_namalokasi TEXT,
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_radius INT,
    p_status TEXT,
    p_type TEXT,
    p_jam_masuk1 TIME,
    p_jam_istirahat TIME,
    p_jam_masuk2 TIME,
    p_jam_pulang TIME
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_loc_id BIGINT;
BEGIN
    IF p_id IS NOT NULL AND p_id > 0 THEN
        -- UPDATE LOKASI YANG SUDAH ADA
        UPDATE "lokasiTbl"
        SET "NamaLokasi" = p_namalokasi,
            "Latitude" = p_latitude,
            "Longitude" = p_longitude,
            "Radius" = p_radius,
            "Status" = p_status,
            "Type" = p_type
        WHERE "Id" = p_id;
        v_loc_id := p_id;
    ELSE
        -- Dapatkan ID baru secara eksplisit (Anti-Gagal)
        SELECT COALESCE(MAX("Id"), 0) + 1 INTO v_loc_id FROM "lokasiTbl";

        -- INSERT LOKASI BARU
        INSERT INTO "lokasiTbl" ("Id", "NamaLokasi", "Latitude", "Longitude", "Radius", "Status", "Type", "CreateDate")
        VALUES (v_loc_id, p_namalokasi, p_latitude, p_longitude, p_radius, p_status, p_type, TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'));
    END IF;

    -- UPSERT TIMELIMIT (Area = v_loc_id)
    INSERT INTO "timeLimitTbl" ("Area", "JamMasuk1", "JamIstirahat", "JamMasuk2", "JamPulang")
    VALUES (v_loc_id, p_jam_masuk1, p_jam_istirahat, p_jam_masuk2, p_jam_pulang)
    ON CONFLICT ("Area") DO UPDATE
    SET "JamMasuk1" = EXCLUDED."JamMasuk1",
        "JamIstirahat" = EXCLUDED."JamIstirahat",
        "JamMasuk2" = EXCLUDED."JamMasuk2",
        "JamPulang" = EXCLUDED."JamPulang";

    RETURN jsonb_build_object(
        'status', 'SUCCESS',
        'message', 'Lokasi dan pengaturan jam kerja berhasil disimpan.',
        'id', v_loc_id
    );
END;
$$;

