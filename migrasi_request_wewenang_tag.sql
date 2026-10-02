-- =====================================================================
-- S2 penyesuaian: wewenang approval request MURNI dari tag
-- =====================================================================
-- Diputuskan user 2026-10-02: review/approval hanya berdasarkan tag (RR/AR/ALL),
-- TIDAK berdasarkan jabatan (data karyawan masih data trial). Tag dibaca dari
-- paswordTbl (Author + PIC) dan karyawanTbl.Author -- sama dengan yang dibaca
-- daftar approval di SMMS & Digital Badge. Badge juga diubah: jabatan Direktur
-- tidak lagi dianggap super.
-- =====================================================================
CREATE OR REPLACE FUNCTION operational.request_boleh_proses(p_actor bigint, p_level text, p_project text, p_area text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_tokens text[];
    v_proj   text := btrim(COALESCE(p_project, ''));
    v_clean  text := ltrim(btrim(COALESCE(p_project, '')), '0');
    v_area   text := upper(btrim(COALESCE(p_area, '')));
    v_tg     text[];
    v_kode   text;
    v_nama   text;
BEGIN
    -- Tag dari paswordTbl (Author + PIC) dan karyawanTbl.Author -- sama dengan SMMS & Badge.
    SELECT array_agg(upper(btrim(t))) FILTER (WHERE btrim(t) <> '')
    INTO v_tokens
    FROM public."paswordTbl" p
    JOIN public."karyawanTbl" k ON k."Id" = p."Id"
    CROSS JOIN LATERAL regexp_split_to_table(
        COALESCE(p."Author", '') || ',' || COALESCE(NULLIF(btrim(p."PIC"), ''), p.pic, '') || ',' || COALESCE(k."Author", ''), ',') t
    WHERE p."Id" = p_actor AND COALESCE(p."IsActive", true) AND COALESCE(k."IsActive", true);

    IF v_tokens IS NULL THEN RETURN false; END IF;
    IF v_tokens && ARRAY['ALL', '*'] THEN RETURN true; END IF;

    IF lower(p_level) = 'review' THEN v_kode := 'RR'; v_nama := 'REVIEW REQUEST';
    ELSIF lower(p_level) = 'approval' THEN v_kode := 'AR'; v_nama := 'APPROVAL REQUEST';
    ELSE RETURN false;
    END IF;

    v_tg := array_remove(ARRAY[
        v_proj, NULLIF(v_clean, ''),
        CASE WHEN v_area <> '' THEN v_proj || v_area END,
        CASE WHEN v_area <> '' AND v_clean <> '' THEN v_clean || v_area END
    ], NULL);
    v_tg := array_remove(v_tg, '');

    RETURN EXISTS (
        SELECT 1 FROM unnest(v_tokens) t
        WHERE t = v_kode OR t = v_nama
           OR EXISTS (SELECT 1 FROM unnest(v_tg) g
                      WHERE t = v_kode || '-' || g
                         OR t = v_nama || ' ' || g
                         OR (t LIKE v_kode || '-%' AND right(t, length(g)) = g)
                         OR (t LIKE v_nama || '%' AND position(g IN t) > 0))
    );
END;
$$;
REVOKE ALL ON FUNCTION operational.request_boleh_proses(bigint, text, text, text) FROM PUBLIC, anon, authenticated;
