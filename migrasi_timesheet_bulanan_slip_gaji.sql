-- =====================================================================================
-- FITUR BARU: TIMESHEET BULANAN (LAMPIRAN HALAMAN 2 SLIP GAJI)
-- 1. get_timesheet_bulanan(p_karyawan_id, p_bulan, p_tahun) -> JSONB array per-tanggal
--    Dipakai app.js -> generateSlipPdf() buat render halaman 2 (timesheet) di PDF slip gaji.
-- 2. Referensi TimeLimit lokasi buat deteksi: tidak absen sebagian slot, telat masuk/masuk
--    lagi, atau pulang lebih cepat dari jadwal.
-- 3. Cek Ijin/Cuti APPROVED dari pengajuan_ijin_lembur_tbl buat keterangan CUTI/IJIN.
-- Sudah diverifikasi: kasus real Anelka Bugihadinata Hariyono (KaryawanId 14) 31 Agustus 2026
-- -> "Tidak absen: Masuk, Istirahat; Masuk Lagi telat 207 menit (limit 13:00)"
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.get_timesheet_bulanan(p_karyawan_id bigint, p_bulan integer, p_tahun integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_qrcode TEXT;
    v_periode_awal DATE := make_date(p_tahun, p_bulan, 1);
    v_periode_akhir DATE := (make_date(p_tahun, p_bulan, 1) + INTERVAL '1 month - 1 day')::DATE;
    v_hari_nama TEXT[] := ARRAY['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
    v_tgl DATE;
    v_jenis JSONB;
    v_absen RECORD;
    v_izin RECORD;
    v_status TEXT;
    v_keterangan TEXT;
    v_hasil JSONB := '[]'::JSONB;
    v_lokasi_id BIGINT;
    v_tl_masuk1 TIME;
    v_tl_istirahat TIME;
    v_tl_masuk2 TIME;
    v_tl_pulang TIME;
    v_missing TEXT[];
    v_telat TEXT[];
    v_parts TEXT[];
    v_delay INT;
    v_jam_masuk1 TIME;
    v_jam_masuk2 TIME;
    v_jam_pulang TIME;
BEGIN
    SELECT "QrCodeId" INTO v_qrcode FROM "karyawanTbl" WHERE "Id" = p_karyawan_id LIMIT 1;
    IF v_qrcode IS NULL THEN
        RETURN '[]'::JSONB;
    END IF;

    v_tgl := v_periode_awal;
    WHILE v_tgl <= v_periode_akhir LOOP
        v_jenis := cek_jenis_hari(v_tgl, v_qrcode);

        SELECT * INTO v_absen FROM "absensiTbl"
        WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(v_qrcode)) AND "Tanggal" = v_tgl
        LIMIT 1;

        -- Cek pengajuan Cuti/Ijin yang APPROVED dan overlap tanggal ini (cuti multi-hari pakai
        -- tanggal_mulai/tanggal_selesai, ijin lama masih single "tanggal").
        SELECT * INTO v_izin FROM "pengajuan_ijin_lembur_tbl"
        WHERE UPPER(TRIM(qrcodeid)) = UPPER(TRIM(v_qrcode))
          AND tipe IN ('CUTI', 'IJIN')
          AND status = 'APPROVED'
          AND (
                (tanggal_mulai IS NOT NULL AND tanggal_selesai IS NOT NULL AND v_tgl BETWEEN tanggal_mulai AND tanggal_selesai)
                OR (tanggal_mulai IS NULL AND tanggal = v_tgl)
              )
        ORDER BY id DESC
        LIMIT 1;

        IF v_absen."Id" IS NOT NULL THEN
            -- Ambil TimeLimit dari lokasi yang kepakai pas absen hari itu (default balik ke jam standar kalau gak ketemu).
            v_lokasi_id := NULL;
            SELECT l."Id" INTO v_lokasi_id
            FROM "lokasiTbl" l
            WHERE UPPER(TRIM(l."NamaLokasi")) = UPPER(TRIM(COALESCE(v_absen."LokasiMasuk1", v_absen."LokasiIstirahat", v_absen."LokasiMasuk2", v_absen."LokasiPulang", '')))
            LIMIT 1;

            v_tl_masuk1 := '07:30:00'::TIME;
            v_tl_istirahat := '12:00:00'::TIME;
            v_tl_masuk2 := '13:00:00'::TIME;
            v_tl_pulang := '17:00:00'::TIME;
            IF v_lokasi_id IS NOT NULL THEN
                SELECT COALESCE("JamMasuk1", v_tl_masuk1), COALESCE("JamIstirahat", v_tl_istirahat),
                       COALESCE("JamMasuk2", v_tl_masuk2), COALESCE("JamPulang", v_tl_pulang)
                INTO v_tl_masuk1, v_tl_istirahat, v_tl_masuk2, v_tl_pulang
                FROM "timeLimitTbl" WHERE "Area" = v_lokasi_id LIMIT 1;
            END IF;

            v_jam_masuk1 := (v_absen."JamMasuk1" AT TIME ZONE 'Asia/Makassar')::TIME;
            v_jam_masuk2 := (v_absen."JamMasuk2" AT TIME ZONE 'Asia/Makassar')::TIME;
            v_jam_pulang := (v_absen."JamPulang" AT TIME ZONE 'Asia/Makassar')::TIME;

            -- Slot yang gak keisi sama sekali
            v_missing := ARRAY[]::TEXT[];
            IF v_absen."JamMasuk1" IS NULL THEN v_missing := array_append(v_missing, 'Masuk'); END IF;
            IF v_absen."JamIstirahat" IS NULL THEN v_missing := array_append(v_missing, 'Istirahat'); END IF;
            IF v_absen."JamMasuk2" IS NULL THEN v_missing := array_append(v_missing, 'Masuk Lagi'); END IF;
            IF v_absen."JamPulang" IS NULL THEN v_missing := array_append(v_missing, 'Pulang'); END IF;

            -- Telat masuk / masuk lagi, atau pulang lebih cepat dari jadwal TimeLimit lokasi
            v_telat := ARRAY[]::TEXT[];
            IF v_jam_masuk1 IS NOT NULL THEN
                v_delay := ROUND(EXTRACT(EPOCH FROM (v_jam_masuk1 - v_tl_masuk1)) / 60);
                IF v_delay > 0 THEN
                    v_telat := array_append(v_telat, 'Masuk telat ' || v_delay || ' menit (limit ' || TO_CHAR(v_tl_masuk1, 'HH24:MI') || ')');
                END IF;
            END IF;
            IF v_jam_masuk2 IS NOT NULL THEN
                v_delay := ROUND(EXTRACT(EPOCH FROM (v_jam_masuk2 - v_tl_masuk2)) / 60);
                IF v_delay > 0 THEN
                    v_telat := array_append(v_telat, 'Masuk Lagi telat ' || v_delay || ' menit (limit ' || TO_CHAR(v_tl_masuk2, 'HH24:MI') || ')');
                END IF;
            END IF;
            IF v_jam_pulang IS NOT NULL THEN
                v_delay := ROUND(EXTRACT(EPOCH FROM (v_tl_pulang - v_jam_pulang)) / 60);
                IF v_delay > 0 THEN
                    v_telat := array_append(v_telat, 'Pulang cepat ' || v_delay || ' menit (limit ' || TO_CHAR(v_tl_pulang, 'HH24:MI') || ')');
                END IF;
            END IF;
        END IF;

        IF v_absen."Id" IS NOT NULL AND v_absen."Status" = 'CLOSED' THEN
            v_status := 'HADIR_LENGKAP';
            v_parts := ARRAY[]::TEXT[];
            IF (v_jenis->>'jenis_hari') = 'HARI_OFF' THEN
                v_parts := array_append(v_parts, 'Masuk di hari libur/off');
            END IF;
            IF array_length(v_missing, 1) IS NOT NULL THEN
                v_parts := array_append(v_parts, 'Tidak absen: ' || array_to_string(v_missing, ', '));
            END IF;
            IF array_length(v_telat, 1) IS NOT NULL THEN
                v_parts := v_parts || v_telat;
            END IF;
            v_keterangan := CASE WHEN array_length(v_parts, 1) IS NULL THEN '-' ELSE array_to_string(v_parts, '; ') END;
        ELSIF v_absen."Id" IS NOT NULL THEN
            v_status := 'PARSIAL';
            v_parts := ARRAY['Kurang scan: ' || array_to_string(v_missing, ', ')];
            IF array_length(v_telat, 1) IS NOT NULL THEN
                v_parts := v_parts || v_telat;
            END IF;
            v_keterangan := array_to_string(v_parts, '; ');
        ELSIF v_izin.id IS NOT NULL THEN
            v_status := CASE WHEN v_izin.tipe = 'CUTI' THEN 'CUTI' ELSE 'IJIN' END;
            v_keterangan := COALESCE(NULLIF(v_izin.jenis_cuti, ''), NULLIF(v_izin.alasan, ''), v_izin.tipe);
        ELSIF (v_jenis->>'jenis_hari') = 'HARI_OFF' THEN
            v_status := 'LIBUR';
            v_keterangan := v_jenis->>'alasan';
        ELSE
            v_status := 'TIDAK_HADIR';
            v_keterangan := 'Tidak ada catatan absensi/ijin';
        END IF;

        v_hasil := v_hasil || jsonb_build_object(
            'tanggal', TO_CHAR(v_tgl, 'YYYY-MM-DD'),
            'tanggalDisplay', TO_CHAR(v_tgl, 'DD'),
            'hari', v_hari_nama[EXTRACT(DOW FROM v_tgl)::INT + 1],
            'jenisHari', v_jenis->>'jenis_hari',
            'jamMasuk1', TO_CHAR(v_absen."JamMasuk1" AT TIME ZONE 'Asia/Makassar', 'HH24:MI'),
            'jamIstirahat', TO_CHAR(v_absen."JamIstirahat" AT TIME ZONE 'Asia/Makassar', 'HH24:MI'),
            'jamMasuk2', TO_CHAR(v_absen."JamMasuk2" AT TIME ZONE 'Asia/Makassar', 'HH24:MI'),
            'jamPulang', TO_CHAR(v_absen."JamPulang" AT TIME ZONE 'Asia/Makassar', 'HH24:MI'),
            'status', v_status,
            'keterangan', v_keterangan
        );

        v_tgl := v_tgl + INTERVAL '1 day';
    END LOOP;

    RETURN v_hasil;
END;
$function$;
