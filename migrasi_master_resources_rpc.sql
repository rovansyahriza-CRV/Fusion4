-- =====================================================================
-- Master Resources (SMMS): tambah / ubah / hapus lewat RPC
-- =====================================================================
-- 0a (2026-10-01) mengunci tulis anon ke material, consumables, heavyEquipment,
-- tools, serviceOrder -- tapi app.js menulis ke tabel itu langsung (nama tabel
-- lewat variabel, kelewat saat pindai). Akibatnya "permission denied for table".
-- Pengganti: RPC dengan sesi login SMMS (fusion_login) + hak yang sama dengan
-- currentUser.canInputMaster di app.js: PIC berisi MR / "Input Master Resources"
-- / ALL / *, atau Author berisi ALL.
-- =====================================================================

CREATE OR REPLACE FUNCTION operational.master_resource_boleh(p_actor bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public."paswordTbl" p
        WHERE p."Id" = p_actor
          AND (
            EXISTS (SELECT 1 FROM unnest(string_to_array(lower(COALESCE(p."PIC", '')), ',')) t
                    WHERE btrim(t) IN ('all', '*', 'mr', 'input master resources'))
            OR EXISTS (SELECT 1 FROM unnest(string_to_array(lower(COALESCE(p."Author", '')), ',')) t
                       WHERE btrim(t) = 'all')
          )
    );
$$;

CREATE OR REPLACE FUNCTION public.resource_simpan(p_token text, p_kategori text, p_id bigint,
                                                  p_group text, p_spec text, p_size text, p_unit text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_actor bigint := operational.fusion_sesi(p_token);
    v_tabel text := CASE p_kategori
        WHEN 'Material' THEN 'material' WHEN 'Consumables' THEN 'consumables'
        WHEN 'HeavyEquipment' THEN 'heavyEquipment' WHEN 'Tools' THEN 'tools'
        WHEN 'ServiceOrder' THEN 'serviceOrder' END;
    v_id bigint;
BEGIN
    IF v_actor IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;
    IF NOT operational.master_resource_boleh(v_actor) THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Anda tidak memiliki hak akses Input Master Resources (tag MR).');
    END IF;
    IF v_tabel IS NULL THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Kategori tidak dikenal.');
    END IF;
    IF btrim(COALESCE(p_spec, '')) = '' THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Spesifikasi wajib diisi.');
    END IF;

    IF p_id IS NULL THEN
        EXECUTE format('INSERT INTO public.%I ("Group", "Specification", "Size", "Unit") VALUES ($1, $2, $3, $4) RETURNING "ID"', v_tabel)
            INTO v_id
            USING left(btrim(COALESCE(p_group, '')), 200), left(btrim(p_spec), 500),
                  left(btrim(COALESCE(p_size, '')), 200), left(btrim(COALESCE(p_unit, '')), 50);
    ELSE
        EXECUTE format('UPDATE public.%I SET "Group" = $1, "Specification" = $2, "Size" = $3, "Unit" = $4 WHERE "ID" = $5 RETURNING "ID"', v_tabel)
            INTO v_id
            USING left(btrim(COALESCE(p_group, '')), 200), left(btrim(p_spec), 500),
                  left(btrim(COALESCE(p_size, '')), 200), left(btrim(COALESCE(p_unit, '')), 50), p_id;
        IF v_id IS NULL THEN
            RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'Data tidak ditemukan.');
        END IF;
    END IF;
    RETURN jsonb_build_object('status', 'OK', 'id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.resource_hapus(p_token text, p_kategori text, p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_actor bigint := operational.fusion_sesi(p_token);
    v_tabel text := CASE p_kategori
        WHEN 'Material' THEN 'material' WHEN 'Consumables' THEN 'consumables'
        WHEN 'HeavyEquipment' THEN 'heavyEquipment' WHEN 'Tools' THEN 'tools'
        WHEN 'ServiceOrder' THEN 'serviceOrder' END;
    v_id bigint;
BEGIN
    IF v_actor IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;
    IF NOT operational.master_resource_boleh(v_actor) THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Anda tidak memiliki hak akses Input Master Resources (tag MR).');
    END IF;
    IF v_tabel IS NULL THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Kategori tidak dikenal.');
    END IF;
    EXECUTE format('DELETE FROM public.%I WHERE "ID" = $1 RETURNING "ID"', v_tabel) INTO v_id USING p_id;
    IF v_id IS NULL THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'Data tidak ditemukan.');
    END IF;
    RETURN jsonb_build_object('status', 'OK');
END;
$$;

REVOKE ALL ON FUNCTION operational.master_resource_boleh(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resource_simpan(text, text, bigint, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resource_hapus(text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resource_simpan(text, text, bigint, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resource_hapus(text, text, bigint) TO anon, authenticated;

-- ROLLBACK: DROP FUNCTION public.resource_simpan(text, text, bigint, text, text, text, text);
--           DROP FUNCTION public.resource_hapus(text, text, bigint);
--           DROP FUNCTION operational.master_resource_boleh(bigint);
