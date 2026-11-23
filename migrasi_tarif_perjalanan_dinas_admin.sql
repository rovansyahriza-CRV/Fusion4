-- =====================================================================
-- Kelola Tarif Perjalanan Dinas & Grade karyawan dari portal SmartGate
-- (menu Kompensasi & Benefit -> tab "Tarif Perjalanan Dinas").
-- Butuh migrasi_perjalanan_dinas.sql sudah jalan.
--
-- Tulis lewat RPC *_secure (sesi login admin Fusion4, PIC "KB" atau "ALL"),
-- dipanggil portal lewat fusionAdminRpc(). Baca langsung dari tabel (policy baca publik).
-- =====================================================================

-- Tambah / ubah satu baris tarif. p_id NULL = baris baru.
CREATE OR REPLACE FUNCTION public.simpan_tarif_perjalanan_dinas_secure(
    p_id              bigint,
    p_grade           text,
    p_jarak_min       numeric,
    p_jarak_max       numeric,
    p_uang_harian     numeric,
    p_uang_penginapan numeric,
    p_keterangan      text DEFAULT NULL,
    p_is_aktif        boolean DEFAULT true,
    p_session_token   text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_grade text := UPPER(btrim(COALESCE(p_grade, '')));
    v_min   numeric := COALESCE(p_jarak_min, 0);
    v_bentrok record;
    v_id    bigint;
BEGIN
    PERFORM operational.check_fusion_session(p_session_token, 'kb');

    IF v_grade = '' OR length(v_grade) > 20 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Grade wajib diisi (maks 20 karakter).');
    END IF;
    IF v_min < 0 OR (p_jarak_max IS NOT NULL AND p_jarak_max <= v_min) THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Jarak maks harus lebih besar dari jarak min (kosongkan untuk tanpa batas).');
    END IF;
    IF COALESCE(p_uang_harian, 0) < 0 OR COALESCE(p_uang_penginapan, 0) < 0 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Nominal tidak boleh negatif.');
    END IF;

    -- Rentang jarak aktif dalam satu Grade tidak boleh tumpang tindih.
    IF COALESCE(p_is_aktif, true) THEN
        SELECT "Id", "JarakMinKm", "JarakMaxKm" INTO v_bentrok
        FROM public."tarifPerjalananDinasTbl"
        WHERE "IsAktif" AND UPPER(btrim("Grade")) = v_grade
          AND (p_id IS NULL OR "Id" <> p_id)
          AND "JarakMinKm" < COALESCE(p_jarak_max, 'Infinity'::numeric)
          AND v_min < COALESCE("JarakMaxKm", 'Infinity'::numeric)
        LIMIT 1;
        IF FOUND THEN
            RETURN jsonb_build_object('status', 'BENTROK', 'message',
                'Rentang jarak bentrok dengan tarif Grade ' || v_grade || ' ' || v_bentrok."JarakMinKm" || ' - '
                || COALESCE(v_bentrok."JarakMaxKm"::text, 'tanpa batas') || ' km.');
        END IF;
    END IF;

    IF p_id IS NULL THEN
        INSERT INTO public."tarifPerjalananDinasTbl" ("Grade", "JarakMinKm", "JarakMaxKm", "UangHarian", "UangPenginapan", "Keterangan", "IsAktif")
        VALUES (v_grade, v_min, p_jarak_max, COALESCE(p_uang_harian, 0), COALESCE(p_uang_penginapan, 0), NULLIF(btrim(p_keterangan), ''), COALESCE(p_is_aktif, true))
        RETURNING "Id" INTO v_id;
    ELSE
        UPDATE public."tarifPerjalananDinasTbl"
        SET "Grade" = v_grade, "JarakMinKm" = v_min, "JarakMaxKm" = p_jarak_max,
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
$$;
REVOKE ALL ON FUNCTION public.simpan_tarif_perjalanan_dinas_secure(bigint, text, numeric, numeric, numeric, numeric, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.simpan_tarif_perjalanan_dinas_secure(bigint, text, numeric, numeric, numeric, numeric, text, boolean, text) TO anon, authenticated, service_role;

-- Hapus tarif. Pengajuan lama tetap aman: nilainya sudah disalin (snapshot) ke perjalanan_dinas_detail.
CREATE OR REPLACE FUNCTION public.hapus_tarif_perjalanan_dinas_secure(p_id bigint, p_session_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    PERFORM operational.check_fusion_session(p_session_token, 'kb');
    DELETE FROM public."tarifPerjalananDinasTbl" WHERE "Id" = p_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'Tarif tidak ditemukan.');
    END IF;
    RETURN jsonb_build_object('status', 'SUCCESS');
END;
$$;
REVOKE ALL ON FUNCTION public.hapus_tarif_perjalanan_dinas_secure(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.hapus_tarif_perjalanan_dinas_secure(bigint, text) TO anon, authenticated, service_role;

-- Set Grade satu karyawan (kosong = hapus grade).
CREATE OR REPLACE FUNCTION public.set_grade_karyawan_secure(p_id bigint, p_grade text, p_session_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_grade text := NULLIF(UPPER(btrim(COALESCE(p_grade, ''))), '');
BEGIN
    PERFORM operational.check_fusion_session(p_session_token, 'kb');
    IF length(v_grade) > 20 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Grade maks 20 karakter.');
    END IF;
    UPDATE public."karyawanTbl" SET "Grade" = v_grade WHERE "Id" = p_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'Karyawan tidak ditemukan.');
    END IF;
    RETURN jsonb_build_object('status', 'SUCCESS', 'grade', v_grade);
END;
$$;
REVOKE ALL ON FUNCTION public.set_grade_karyawan_secure(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_grade_karyawan_secure(bigint, text, text) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
