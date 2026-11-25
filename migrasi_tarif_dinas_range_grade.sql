-- Tarif Perjalanan Dinas per RENTANG GRADE (contoh: Grade 1 - 3 = satu tarif).
-- Grade karyawan tetap di karyawanTbl.Grade; angka di dalamnya yang dicocokkan ("3", "G3", "Grade 3" semuanya = 3).
-- Baris lama tanpa GradeMin (teks bebas) tetap dicocokkan lewat teks Grade, jadi tidak ada data yang rusak.

ALTER TABLE public."tarifPerjalananDinasTbl" ADD COLUMN IF NOT EXISTS "GradeMin" integer;
ALTER TABLE public."tarifPerjalananDinasTbl" ADD COLUMN IF NOT EXISTS "GradeMax" integer;
ALTER TABLE public."tarifPerjalananDinasTbl" DROP CONSTRAINT IF EXISTS tarif_dinas_grade_range;
ALTER TABLE public."tarifPerjalananDinasTbl" ADD CONSTRAINT tarif_dinas_grade_range
  CHECK ("GradeMin" IS NULL OR ("GradeMin" >= 0 AND ("GradeMax" IS NULL OR "GradeMax" >= "GradeMin")));

CREATE OR REPLACE FUNCTION public.pd_cari_tarif(p_grade text, p_jarak numeric)
RETURNS public."tarifPerjalananDinasTbl"
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
    WITH g AS (SELECT NULLIF(btrim(p_grade), '') AS teks,
                      (regexp_match(COALESCE(p_grade, ''), '[0-9]+'))[1]::integer AS angka)
    SELECT t.* FROM public."tarifPerjalananDinasTbl" t, g
    WHERE t."IsAktif"
      AND g.teks IS NOT NULL
      AND (
            (t."GradeMin" IS NOT NULL AND g.angka IS NOT NULL
               AND g.angka >= t."GradeMin" AND g.angka <= COALESCE(t."GradeMax", t."GradeMin"))
         OR (t."GradeMin" IS NULL AND UPPER(btrim(t."Grade")) = UPPER(g.teks))
      )
      AND COALESCE(p_jarak, 0) >= t."JarakMinKm"
      AND (t."JarakMaxKm" IS NULL OR COALESCE(p_jarak, 0) < t."JarakMaxKm")
    ORDER BY t."JarakMinKm" DESC, t."Id" DESC
    LIMIT 1
$function$;

DROP FUNCTION IF EXISTS public.simpan_tarif_perjalanan_dinas_secure(bigint, text, numeric, numeric, numeric, numeric, text, boolean, text);

CREATE OR REPLACE FUNCTION public.simpan_tarif_perjalanan_dinas_secure(
    p_id bigint, p_grade_min integer, p_grade_max integer, p_jarak_min numeric, p_jarak_max numeric,
    p_uang_harian numeric, p_uang_penginapan numeric, p_keterangan text DEFAULT NULL, p_is_aktif boolean DEFAULT true,
    p_session_token text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
    v_gmin  integer := p_grade_min;
    v_gmax  integer := COALESCE(p_grade_max, p_grade_min);
    v_label text;
    v_min   numeric := COALESCE(p_jarak_min, 0);
    v_bentrok record;
    v_id    bigint;
BEGIN
    PERFORM operational.check_fusion_session(p_session_token, 'kb');

    IF v_gmin IS NULL OR v_gmin < 0 OR v_gmin > 99 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Grade dari wajib diisi (angka 0-99).');
    END IF;
    IF v_gmax < v_gmin OR v_gmax > 99 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Grade sampai tidak boleh lebih kecil dari Grade dari.');
    END IF;
    IF v_min < 0 OR (p_jarak_max IS NOT NULL AND p_jarak_max <= v_min) THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Jarak maks harus lebih besar dari jarak min (kosongkan untuk tanpa batas).');
    END IF;
    IF COALESCE(p_uang_harian, 0) < 0 OR COALESCE(p_uang_penginapan, 0) < 0 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Nominal tidak boleh negatif.');
    END IF;

    v_label := CASE WHEN v_gmax = v_gmin THEN v_gmin::text ELSE v_gmin || '-' || v_gmax END;

    -- Tarif aktif yang rentang Grade DAN rentang jaraknya sama-sama tumpang tindih tidak boleh ada.
    IF COALESCE(p_is_aktif, true) THEN
        SELECT "Id", "Grade", "JarakMinKm", "JarakMaxKm" INTO v_bentrok
        FROM public."tarifPerjalananDinasTbl"
        WHERE "IsAktif" AND "GradeMin" IS NOT NULL
          AND (p_id IS NULL OR "Id" <> p_id)
          AND "GradeMin" <= v_gmax AND v_gmin <= COALESCE("GradeMax", "GradeMin")
          AND "JarakMinKm" < COALESCE(p_jarak_max, 'Infinity'::numeric)
          AND v_min < COALESCE("JarakMaxKm", 'Infinity'::numeric)
        LIMIT 1;
        IF FOUND THEN
            RETURN jsonb_build_object('status', 'BENTROK', 'message',
                'Bentrok dengan tarif Grade ' || v_bentrok."Grade" || ' untuk jarak ' || v_bentrok."JarakMinKm" || ' - '
                || COALESCE(v_bentrok."JarakMaxKm"::text, 'tanpa batas') || ' km.');
        END IF;
    END IF;

    IF p_id IS NULL THEN
        INSERT INTO public."tarifPerjalananDinasTbl" ("Grade", "GradeMin", "GradeMax", "JarakMinKm", "JarakMaxKm", "UangHarian", "UangPenginapan", "Keterangan", "IsAktif")
        VALUES (v_label, v_gmin, v_gmax, v_min, p_jarak_max, COALESCE(p_uang_harian, 0), COALESCE(p_uang_penginapan, 0), NULLIF(btrim(p_keterangan), ''), COALESCE(p_is_aktif, true))
        RETURNING "Id" INTO v_id;
    ELSE
        UPDATE public."tarifPerjalananDinasTbl"
        SET "Grade" = v_label, "GradeMin" = v_gmin, "GradeMax" = v_gmax, "JarakMinKm" = v_min, "JarakMaxKm" = p_jarak_max,
            "UangHarian" = COALESCE(p_uang_harian, 0), "UangPenginapan" = COALESCE(p_uang_penginapan, 0),
            "Keterangan" = NULLIF(btrim(p_keterangan), ''), "IsAktif" = COALESCE(p_is_aktif, true)
        WHERE "Id" = p_id
        RETURNING "Id" INTO v_id;
        IF v_id IS NULL THEN
            RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'Tarif tidak ditemukan.');
        END IF;
    END IF;

    RETURN jsonb_build_object('status', 'SUCCESS', 'id', v_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.simpan_tarif_perjalanan_dinas_secure(bigint, integer, integer, numeric, numeric, numeric, numeric, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.simpan_tarif_perjalanan_dinas_secure(bigint, integer, integer, numeric, numeric, numeric, numeric, text, boolean, text) TO anon, authenticated, service_role;
