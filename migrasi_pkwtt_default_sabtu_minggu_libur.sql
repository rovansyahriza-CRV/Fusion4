-- =====================================================================================
-- FIX: cek_jenis_hari() - DEFAULT PKWTT SABTU-MINGGU LIBUR
-- Bug: karyawan PKWTT gak pakai Pola Kerja sama sekali (PolaKerjaId selalu NULL di
-- kontrakKaryawanTbl), jadi default sebelumnya (Sabtu-Minggu Off = false) bikin Sabtu/Minggu
-- kehitung HARI_KERJA -> di timesheet bulanan/slip gaji kekirim "Tidak Hadir" tiap weekend,
-- padahal harusnya libur.
-- Fix: kalau kontraknya PKWTT dan gak ketemu Pola Kerja, default Sabtu-Minggu Off = TRUE
-- (Senin-Jumat kerja, Sabtu-Minggu libur). PKWT yang emang gak punya Pola Kerja ke-link
-- (data ganjil) tetep fallback ke false kayak sebelumnya, biar gak diam-diam nge-off-in hari
-- kerja tanpa sepengetahuan admin. Libur Nasional tetep default berlaku (true).
-- Sudah diverifikasi: Andy Siahaan (PKWTT) Agustus 2026 - Sabtu/Minggu skrg "Libur", PKWT
-- lain (Raka Ahmad Syahnanda, pola 10 Jam/Hari) gak kena, tetep "Tidak Hadir" kalau ga absen.
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.cek_jenis_hari(p_tanggal date, p_qrcode text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_dow INT;
    v_libur RECORD;
    v_sabtu_minggu_off BOOLEAN := false;
    v_libur_nasional_berlaku BOOLEAN := true;
    v_karyawan_id BIGINT;
    v_jenis_kontrak TEXT;
BEGIN
    v_dow := EXTRACT(DOW FROM p_tanggal);

    IF p_qrcode IS NOT NULL THEN
        SELECT k."Id" INTO v_karyawan_id FROM "karyawanTbl" k WHERE UPPER(TRIM(k."QrCodeId")) = UPPER(TRIM(p_qrcode)) LIMIT 1;
        IF v_karyawan_id IS NOT NULL THEN
            SELECT kk."JenisKontrak", pk."SabtuMingguOff", pk."LiburNasionalBerlaku"
            INTO v_jenis_kontrak, v_sabtu_minggu_off, v_libur_nasional_berlaku
            FROM "kontrakKaryawanTbl" kk
            LEFT JOIN "polaKerjaTbl" pk ON pk."Id" = kk."PolaKerjaId"
            WHERE kk."KaryawanID" = v_karyawan_id
            ORDER BY kk."TanggalMulai" DESC NULLS LAST
            LIMIT 1;

            IF v_sabtu_minggu_off IS NULL THEN
                -- Gak ada Pola Kerja ke-link ke kontrak ini (kasus umum: PKWTT emang gak pakai Pola Kerja
                -- sama sekali). Default PKWTT: Senin-Jumat kerja, Sabtu-Minggu libur. Selain PKWTT
                -- (kasus data ganjil, kontrak PKWT tapi Pola Kerja belum di-set), tetep fallback ke false
                -- kayak sebelumnya biar gak diam-diam nge-off-in hari kerja tanpa sepengetahuan admin.
                v_sabtu_minggu_off := (v_jenis_kontrak = 'PKWTT');
            END IF;
            IF v_libur_nasional_berlaku IS NULL THEN
                v_libur_nasional_berlaku := true;
            END IF;
        END IF;
    END IF;

    -- Cek Libur Nasional / Cuti Bersama dulu
    SELECT * INTO v_libur FROM "hariLiburTbl" WHERE "Tanggal" = p_tanggal;
    IF v_libur IS NOT NULL THEN
        IF v_libur_nasional_berlaku THEN
            RETURN jsonb_build_object('jenis_hari', 'HARI_OFF', 'alasan', v_libur."Jenis" || ': ' || v_libur."Keterangan");
        ELSE
            RETURN jsonb_build_object('jenis_hari', 'HARI_KERJA', 'alasan', v_libur."Keterangan" || ' -- tapi hari kerja normal sesuai Pola Kerja (rotasi terus-menerus)');
        END IF;
    END IF;

    -- Cek Sabtu/Minggu
    IF v_dow = 0 OR v_dow = 6 THEN
        IF v_sabtu_minggu_off THEN
            RETURN jsonb_build_object('jenis_hari', 'HARI_OFF', 'alasan', CASE WHEN v_dow = 0 THEN 'Hari Minggu (sesuai Pola Kerja)' ELSE 'Hari Sabtu (sesuai Pola Kerja)' END);
        ELSE
            RETURN jsonb_build_object('jenis_hari', 'HARI_KERJA', 'alasan', CASE WHEN v_dow = 0 THEN 'Hari Minggu, tapi hari kerja normal sesuai Pola Kerja orang ini' ELSE 'Hari Sabtu, tapi hari kerja normal sesuai Pola Kerja orang ini' END);
        END IF;
    END IF;

    RETURN jsonb_build_object('jenis_hari', 'HARI_KERJA', 'alasan', 'Hari kerja biasa');
END;
$function$;
