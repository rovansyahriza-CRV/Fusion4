-- =====================================================================================
-- FITUR: ESTIMASI POTONGAN JAM KURANG (KHUSUS PEKERJA LAPANGAN 8/10/12 JAM)
-- Perubahan SQL: get_timesheet_bulanan() sekarang juga nyisipin "kategori" (dari
-- polaKerjaTbl."Kategori", misal "Pekerja Lapangan" / "Staff/PMT") ke field polaKerjaRef,
-- biar app.js bisa nge-gate fitur potongan jam kurang -- CUMA berlaku buat kontrak yang Pola
-- Kerja-nya Kategori = "Pekerja Lapangan" (8/10/12 Jam). Staff/PMT (Reguler = lumpsum, Rotasi
-- 3 Bulan = eksplisit "gaji penuh saat off, tanpa potongan") di luar cakupan.
--
-- Kebijakan potongan (dikonfirmasi bareng CRV, dihitung di app.js -> hitungPotonganJamKurang(),
-- BUKAN di RPC, karena cuma perlu data yang udah dikembalikan get_timesheet_bulanan):
-- 1. Target Jam Wajib Bulanan = PembagiJamKerja pola kerja (173 -- 40 jam/minggu dirata-ratain
--    setahun, angka yang sama dipakai buat tarif per jam, satu sumber angka).
-- 2. Jam Aktual Bulanan = total (Jam Regular + Jam Lembur Reguler) sebulan, DITAMBAH kredit
--    hari Cuti/Ijin APPROVED (dianggap "lunas" senilai JamNormalPerHari + JamLemburOtomatisPerHari
--    pola hari itu, karena cuti/ijin resmi gak boleh dipotong gajinya).
-- 3. Kekurangan Kasar = MAX(0, Jam Wajib Bulanan - Jam Aktual Bulanan).
-- 4. Surplus Jam Off = total Jam Lembur Hari Off sebulan (masuk pas hari libur/off) -- dipakai
--    NUTUP kekurangan dulu (netting) sebelum dipotong, biar karyawan yang udah masuk pas hari
--    off-nya gak double rugi. Surplus ini tetap dibayar penuh sebagai lembur hari off seperti
--    biasa, cuma pengaruh ke ada/nggaknya potongan.
-- 5. Kekurangan Bersih = MAX(0, Kekurangan Kasar - Surplus Jam Off) -- ini yang "dipotong",
--    pakai tarif flat (Gaji Pokok / PembagiJamKerja), TANPA multiplier.
-- STATUS: baru estimasi/cross-check di slip gaji (section "Ringkasan Jam Kerja" hal. 1, baris
-- merah "Kekurangan Jam"). BELUM otomatis ngurangin TotalPotongan/PenghasilanBruto/TakeHomePay
-- -- itu masih hasil RPC payroll utama yang terpisah dan belum disentuh fitur ini.
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
    v_jam_istirahat TIME;
    v_jam_pulang TIME;
    v_jam_masuk1_eff TIME;
    v_jam_masuk2_eff TIME;
    v_sesi_pagi_menit INT;
    v_sesi_siang_menit INT;
    v_jam_aktual_menit INT;
    v_jam_regular_menit INT;
    v_jam_lembur_reguler_menit INT;
    v_jam_lembur_off_menit INT;
    v_toleransi_telat CONSTANT INT := 15;
    v_jenis_kontrak TEXT;
    v_kategori_pola TEXT;
    v_jam_normal NUMERIC;
    v_jam_lembur_otomatis NUMERIC;
    v_pembagi_jam NUMERIC;
    v_mult_hari_kerja NUMERIC;
    v_mult_hari_off NUMERIC;
BEGIN
    SELECT "QrCodeId" INTO v_qrcode FROM "karyawanTbl" WHERE "Id" = p_karyawan_id LIMIT 1;
    IF v_qrcode IS NULL THEN
        RETURN '[]'::JSONB;
    END IF;

    SELECT kk."JenisKontrak", pk."Kategori", pk."JamNormalPerHari", pk."JamLemburOtomatisPerHari",
           pk."PembagiJamKerja", pk."MultiplierHariKerja", pk."MultiplierHariOff"
    INTO v_jenis_kontrak, v_kategori_pola, v_jam_normal, v_jam_lembur_otomatis, v_pembagi_jam, v_mult_hari_kerja, v_mult_hari_off
    FROM "kontrakKaryawanTbl" kk
    LEFT JOIN "polaKerjaTbl" pk ON pk."Id" = kk."PolaKerjaId"
    WHERE kk."KaryawanID" = p_karyawan_id
    ORDER BY kk."TanggalMulai" DESC NULLS LAST
    LIMIT 1;
    v_jam_normal := COALESCE(v_jam_normal, 8);
    v_jam_lembur_otomatis := COALESCE(v_jam_lembur_otomatis, 0);
    v_pembagi_jam := COALESCE(v_pembagi_jam, 173);
    v_mult_hari_kerja := COALESCE(v_mult_hari_kerja, 1.5);
    v_mult_hari_off := COALESCE(v_mult_hari_off, 2);

    v_tgl := v_periode_awal;
    WHILE v_tgl <= v_periode_akhir LOOP
        v_jenis := cek_jenis_hari(v_tgl, v_qrcode);

        SELECT * INTO v_absen FROM "absensiTbl"
        WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(v_qrcode)) AND "Tanggal" = v_tgl
        LIMIT 1;

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

        v_sesi_pagi_menit := 0;
        v_sesi_siang_menit := 0;
        v_jam_aktual_menit := 0;
        v_jam_regular_menit := 0;
        v_jam_lembur_reguler_menit := 0;
        v_jam_lembur_off_menit := 0;

        IF v_absen."Id" IS NOT NULL THEN
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
            v_jam_istirahat := (v_absen."JamIstirahat" AT TIME ZONE 'Asia/Makassar')::TIME;
            v_jam_masuk2 := (v_absen."JamMasuk2" AT TIME ZONE 'Asia/Makassar')::TIME;
            v_jam_pulang := (v_absen."JamPulang" AT TIME ZONE 'Asia/Makassar')::TIME;

            v_missing := ARRAY[]::TEXT[];
            IF v_absen."JamMasuk1" IS NULL THEN v_missing := array_append(v_missing, 'Masuk'); END IF;
            IF v_absen."JamIstirahat" IS NULL THEN v_missing := array_append(v_missing, 'Istirahat'); END IF;
            IF v_absen."JamMasuk2" IS NULL THEN v_missing := array_append(v_missing, 'Masuk Lagi'); END IF;
            IF v_absen."JamPulang" IS NULL THEN v_missing := array_append(v_missing, 'Pulang'); END IF;

            v_telat := ARRAY[]::TEXT[];
            IF v_jam_masuk1 IS NOT NULL THEN
                v_delay := ROUND(EXTRACT(EPOCH FROM (v_jam_masuk1 - v_tl_masuk1)) / 60);
                IF v_delay > v_toleransi_telat THEN
                    v_telat := array_append(v_telat, 'Masuk telat ' || v_delay || ' menit (limit ' || TO_CHAR(v_tl_masuk1, 'HH24:MI') || ')');
                END IF;
            END IF;
            IF v_jam_masuk2 IS NOT NULL THEN
                v_delay := ROUND(EXTRACT(EPOCH FROM (v_jam_masuk2 - v_tl_masuk2)) / 60);
                IF v_delay > v_toleransi_telat THEN
                    v_telat := array_append(v_telat, 'Masuk Lagi telat ' || v_delay || ' menit (limit ' || TO_CHAR(v_tl_masuk2, 'HH24:MI') || ')');
                END IF;
            END IF;

            v_jam_masuk1_eff := NULL;
            IF v_jam_masuk1 IS NOT NULL THEN
                v_jam_masuk1_eff := CASE
                    WHEN ROUND(EXTRACT(EPOCH FROM (v_jam_masuk1 - v_tl_masuk1)) / 60) > v_toleransi_telat THEN v_jam_masuk1
                    ELSE v_tl_masuk1
                END;
            END IF;
            v_jam_masuk2_eff := NULL;
            IF v_jam_masuk2 IS NOT NULL THEN
                v_jam_masuk2_eff := CASE
                    WHEN ROUND(EXTRACT(EPOCH FROM (v_jam_masuk2 - v_tl_masuk2)) / 60) > v_toleransi_telat THEN v_jam_masuk2
                    ELSE v_tl_masuk2
                END;
            END IF;

            IF v_jam_masuk1 IS NOT NULL AND v_jam_istirahat IS NOT NULL THEN
                v_sesi_pagi_menit := GREATEST(0, ROUND(EXTRACT(EPOCH FROM (LEAST(v_jam_istirahat, v_tl_istirahat) - v_jam_masuk1_eff)) / 60));
            END IF;
            IF v_jam_masuk2 IS NOT NULL AND v_jam_pulang IS NOT NULL THEN
                v_sesi_siang_menit := GREATEST(0, ROUND(EXTRACT(EPOCH FROM (LEAST(v_jam_pulang, v_tl_pulang) - v_jam_masuk2_eff)) / 60));
            END IF;
            v_jam_aktual_menit := v_sesi_pagi_menit + v_sesi_siang_menit;

            IF (v_jenis->>'jenis_hari') = 'HARI_OFF' THEN
                v_jam_lembur_off_menit := v_jam_aktual_menit;
            ELSE
                v_jam_regular_menit := LEAST(v_jam_aktual_menit, ROUND(v_jam_normal * 60));
                v_jam_lembur_reguler_menit := LEAST(GREATEST(v_jam_aktual_menit - ROUND(v_jam_normal * 60), 0), ROUND(v_jam_lembur_otomatis * 60));
            END IF;
        END IF;

        IF v_absen."Id" IS NOT NULL AND v_absen."Status" = 'CLOSED' THEN
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

            IF array_length(v_missing, 1) IS NOT NULL OR array_length(v_telat, 1) IS NOT NULL THEN
                v_status := 'KURANG_LENGKAP';
            ELSE
                v_status := 'HADIR_LENGKAP';
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
            'keterangan', v_keterangan,
            'jamAktualMenit', v_jam_aktual_menit,
            'jamRegularMenit', v_jam_regular_menit,
            'jamLemburRegulerMenit', v_jam_lembur_reguler_menit,
            'jamLemburOffMenit', v_jam_lembur_off_menit
        );

        v_tgl := v_tgl + INTERVAL '1 day';
    END LOOP;

    IF jsonb_array_length(v_hasil) > 0 THEN
        v_hasil := jsonb_set(v_hasil, '{0,polaKerjaRef}', jsonb_build_object(
            'kategori', v_kategori_pola,
            'jamNormalPerHari', v_jam_normal,
            'jamLemburOtomatisPerHari', v_jam_lembur_otomatis,
            'pembagiJamKerja', v_pembagi_jam,
            'multiplierHariKerja', v_mult_hari_kerja,
            'multiplierHariOff', v_mult_hari_off
        ));
    END IF;

    RETURN v_hasil;
END;
$function$;
