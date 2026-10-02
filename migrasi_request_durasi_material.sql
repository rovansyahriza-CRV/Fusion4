-- =====================================================================
-- Request: Material & Consumables tanpa durasi
-- =====================================================================
-- Durasi > 0 dipakai server untuk membedakan Service Order (sewa) dari PO
-- (create PO dari RFQ: Duration > 0 -> SO). Item Material / Consumables bukan sewa,
-- jadi Duration & DurUnit selalu dikosongkan di request_buat -- walau dikirim dari tab
-- SMMS lama yang belum mengunci kolomnya.
-- =====================================================================
DO $$
DECLARE
    v_def  text := pg_get_functiondef('public.request_buat(text,jsonb,jsonb)'::regprocedure);
    v_grp  text := $g$lower(COALESCE(NULLIF(it->>'ItemGroup', ''), 'Material')) IN ('material', 'consumables')$g$;
    v_dur  text := $o$CASE WHEN (it->>'Duration') ~ '^[0-9]+(\.[0-9]+)?$' THEN (it->>'Duration')::numeric END,$o$;
    v_unit text := $o$left(COALESCE(it->>'DurUnit', ''), 40),$o$;
BEGIN
    IF position('''consumables''' IN v_def) > 0 THEN RETURN; END IF;  -- sudah dipatch
    IF position(v_dur IN v_def) = 0 OR position(v_unit IN v_def) = 0 THEN
        RAISE EXCEPTION 'request_buat tidak sesuai yang diharapkan -- batalkan';
    END IF;
    v_def := replace(v_def, v_dur, 'CASE WHEN ' || v_grp || $o$ THEN NULL WHEN (it->>'Duration') ~ '^[0-9]+(\.[0-9]+)?$' THEN (it->>'Duration')::numeric END,$o$);
    v_def := replace(v_def, v_unit, 'CASE WHEN ' || v_grp || $o$ THEN '' ELSE left(COALESCE(it->>'DurUnit', ''), 40) END,$o$);
    EXECUTE v_def;
END $$;
