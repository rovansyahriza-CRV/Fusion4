-- =====================================================================================
-- Hak pengajuan Off diatur per Pola Kerja.
--
-- - polaKerjaTbl: BolehOffRotasi / BolehOffPeriode (dicentang HR di menu Pola Kerja).
--   Isi awal: Pekerja Lapangan & Pekerja Lapangan Lumpsum -> Off Rotasi;
--   pola "Rotasi 3 Bulan ..." -> Off Periode; lainnya tidak punya hak off.
-- - Hak dibaca dari kontrak AKTIF terbaru karyawan (belum berakhir). PKWTT tanpa pola,
--   kontrak tanpa Pola Kerja, atau belum punya kontrak = tidak bisa ajukan Off.
-- - get_hak_off(qrcode) dipakai Digital Badge untuk tampil/sembunyikan tombol Off.
-- - submit_pengajuan_off menolak jenis off yang tidak jadi hak karyawan.
-- =====================================================================================

ALTER TABLE "polaKerjaTbl"
    ADD COLUMN IF NOT EXISTS "BolehOffRotasi" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS "BolehOffPeriode" BOOLEAN NOT NULL DEFAULT false;

-- Isi awal (sekali saja, cuma kalau belum ada pola yang dicentang)
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM "polaKerjaTbl" WHERE "BolehOffRotasi" OR "BolehOffPeriode") THEN
        UPDATE "polaKerjaTbl" SET "BolehOffRotasi" = true
        WHERE "Kategori" IN ('Pekerja Lapangan', 'Pekerja Lapangan Lumpsum');
        UPDATE "polaKerjaTbl" SET "BolehOffPeriode" = true
        WHERE "NamaPola" ILIKE 'Rotasi%';
    END IF;
END $$;

-- ---------- Hak off karyawan ----------
CREATE OR REPLACE FUNCTION public.get_hak_off(p_qrcode text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
AS $function$
    SELECT jsonb_build_object(
        'offRotasi', COALESCE(x.rotasi, false),
        'offPeriode', COALESCE(x.periode, false),
        'polaKerja', x.pola
    )
    FROM (SELECT 1) dummy
    LEFT JOIN LATERAL (
        SELECT pk."BolehOffRotasi" AS rotasi, pk."BolehOffPeriode" AS periode, pk."NamaPola" AS pola
        FROM "karyawanTbl" k
        JOIN "kontrakKaryawanTbl" kk ON kk."KaryawanID" = k."Id"
        LEFT JOIN "polaKerjaTbl" pk ON pk."Id" = kk."PolaKerjaId"
        WHERE UPPER(TRIM(k."QrCodeId")) = UPPER(TRIM(p_qrcode))
          AND (kk."TanggalBerakhir" IS NULL OR kk."TanggalBerakhir" >= CURRENT_DATE)
        ORDER BY kk."TanggalMulai" DESC NULLS LAST
        LIMIT 1
    ) x ON true;
$function$;

GRANT EXECUTE ON FUNCTION public.get_hak_off(text) TO anon, authenticated, service_role;

-- ---------- Submit Off: tolak kalau bukan haknya ----------
DO $$
DECLARE target regprocedure; definition text;
BEGIN
    target := 'public.submit_pengajuan_off(text,text,date,date,text)'::regprocedure;
    definition := pg_get_functiondef(target);
    IF position('get_hak_off(p_qrcode)' in definition) = 0 THEN
        IF position('    IF p_tgl_mulai IS NULL THEN' in definition) = 0 THEN
            RAISE EXCEPTION 'Definisi submit_pengajuan_off tidak sesuai perkiraan; tidak ada perubahan.';
        END IF;
        definition := replace(definition, '    IF p_tgl_mulai IS NULL THEN',
'    -- Hak off dari Pola Kerja kontrak aktif
    IF NOT COALESCE((get_hak_off(p_qrcode)->>CASE WHEN v_jenis = ''OFF_PERIODE'' THEN ''offPeriode'' ELSE ''offRotasi'' END)::boolean, false) THEN
        RETURN jsonb_build_object(''status'', ''ERROR'', ''message'',
            CASE WHEN v_jenis = ''OFF_PERIODE'' THEN ''Off Periode'' ELSE ''Off Rotasi'' END
            || '' tidak berlaku untuk kontrak / Pola Kerja Anda. Hubungi HR kalau ini keliru.'');
    END IF;
    IF p_tgl_mulai IS NULL THEN');
        EXECUTE definition;
    END IF;
END $$;

-- ---------- RPC Pola Kerja: simpan centang hak off ----------
DROP FUNCTION IF EXISTS public.update_pola_kerja(bigint, numeric, numeric, numeric, boolean, boolean, text, numeric, text, numeric);
CREATE OR REPLACE FUNCTION public.update_pola_kerja(
    p_id bigint,
    p_pembagi_jam numeric,
    p_multiplier_hari_kerja numeric,
    p_multiplier_hari_off numeric,
    p_sabtu_minggu_off boolean DEFAULT false,
    p_libur_nasional_berlaku boolean DEFAULT true,
    p_keterangan text DEFAULT NULL::text,
    p_multiplier_lembur_lanjut numeric DEFAULT NULL::numeric,
    p_mode_lembur_off text DEFAULT 'PER_JAM',
    p_pembagi_hari numeric DEFAULT NULL::numeric,
    p_boleh_off_rotasi boolean DEFAULT NULL,
    p_boleh_off_periode boolean DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    UPDATE "polaKerjaTbl" SET
        "PembagiJamKerja" = p_pembagi_jam,
        "MultiplierHariKerja" = p_multiplier_hari_kerja,
        "MultiplierLemburLanjut" = p_multiplier_lembur_lanjut,
        "MultiplierHariOff" = p_multiplier_hari_off,
        "ModeLemburOff" = COALESCE(p_mode_lembur_off, 'PER_JAM'),
        "PembagiHariKerja" = p_pembagi_hari,
        "SabtuMingguOff" = p_sabtu_minggu_off,
        "LiburNasionalBerlaku" = p_libur_nasional_berlaku,
        "BolehOffRotasi" = COALESCE(p_boleh_off_rotasi, "BolehOffRotasi"),
        "BolehOffPeriode" = COALESCE(p_boleh_off_periode, "BolehOffPeriode"),
        "Keterangan" = COALESCE(p_keterangan, "Keterangan")
    WHERE "Id" = p_id;
    RETURN jsonb_build_object('status', 'SUCCESS');
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('status', 'ERROR', 'message', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.update_pola_kerja(bigint, numeric, numeric, numeric, boolean, boolean, text, numeric, text, numeric, boolean, boolean) TO anon, authenticated, service_role;
