-- =====================================================================================
-- PERBAIKAN FINAL RPC: list_lokasi_with_timelimit & save_lokasi_with_timelimit
-- Fusion4 SmartGate - Sinkronisasi Akurat Jam Kerja Lokasi
-- =====================================================================================

-- 1. FUNCTION RPC: LIST LOKASI BESERTA TIMELIMIT (Tipe Data 100% Cocok)
DROP FUNCTION IF EXISTS list_lokasi_with_timelimit();
CREATE OR REPLACE FUNCTION list_lokasi_with_timelimit()
RETURNS TABLE (
    id BIGINT,
    namalokasi TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    radius INT,
    status TEXT,
    type TEXT,
    createdate TEXT,
    jammasuk1 TIME,
    jamistirahat TIME,
    jammasuk2 TIME,
    jampulang TIME
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        l."Id" AS id,
        l."NamaLokasi"::TEXT AS namalokasi,
        l."Latitude" AS latitude,
        l."Longitude" AS longitude,
        COALESCE(l."Radius", 100)::INT AS radius,
        l."Status"::TEXT AS status,
        l."Type"::TEXT AS type,
        l."CreateDate"::TEXT AS createdate,
        COALESCE(t."JamMasuk1", '07:30:00'::TIME) AS jammasuk1,
        COALESCE(t."JamIstirahat", '12:00:00'::TIME) AS jamistirahat,
        COALESCE(t."JamMasuk2", '13:00:00'::TIME) AS jammasuk2,
        COALESCE(t."JamPulang", '17:00:00'::TIME) AS jampulang
    FROM "lokasiTbl" l
    LEFT JOIN "timeLimitTbl" t ON t."Area" = l."Id"
    ORDER BY l."NamaLokasi" ASC;
END;
$$;


-- 2. FUNCTION RPC: SIMPAN / UPDATE LOKASI BESERTA TIMELIMIT
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
        -- UPDATE LOKASI
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
        -- INSERT LOKASI BARU
        INSERT INTO "lokasiTbl" ("NamaLokasi", "Latitude", "Longitude", "Radius", "Status", "Type", "CreateDate")
        VALUES (p_namalokasi, p_latitude, p_longitude, p_radius, p_status, p_type, TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
        RETURNING "Id" INTO v_loc_id;
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