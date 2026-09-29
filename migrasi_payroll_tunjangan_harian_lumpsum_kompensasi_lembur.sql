-- =====================================================================================
-- Payroll: tunjangan harian, kontrak Lumpsum Pekerja Lapangan, THP include Uang
-- Kompensasi PKWT, dan tarif lembur jam pertama / jam berikutnya.
--
-- 1. Tunjangan Transport, Makan, Kehadiran bisa dipilih BULANAN (nominal tetap) atau
--    HARIAN (nominal x hari hadir). Hari hadir = hari ada scan masuk (JamMasuk1).
--    Cuti tidak dihitung hadir (baris absensi Cuti tidak punya JamMasuk1), jadi tunjangan
--    harian tidak dibayar di hari cuti -- gaji pokok tetap utuh.
--    Tunjangan HARIAN = tunjangan tidak tetap, jadi TIDAK ikut dasar upah lembur, BPJS,
--    dan Uang Kompensasi. Tunjangan BULANAN tetap ikut (sama seperti sebelumnya).
-- 2. Kategori Pola Kerja baru "Pekerja Lapangan Lumpsum" (8 / 10 / 12 jam): gaji all-in,
--    tanpa lembur otomatis & lembur hari kerja. Lembur hanya dibayar kalau dipanggil masuk
--    di hari OFF (lewat Otorisasi Lembur).
-- 3. Kontrak PKWT bisa dicentang "THP include Uang Kompensasi": tiap bulan dibayar
--    1/12 x upah (gaji pokok + tunjangan tetap), ditambahkan ke THP.
-- 4. Lembur hari kerja dihitung per hari: jam ke-1 x Multiplier Jam Pertama, jam ke-2 dst
--    x Multiplier Jam Berikutnya (PP 35/2021). Lembur hari OFF bisa PER_JAM (jam x tarif
--    per jam x multiplier) atau PER_HARI (hari x upah harian x multiplier, upah harian =
--    upah / Pembagi Hari Kerja).
--
-- Nilai lama dipertahankan: Multiplier Jam Berikutnya diisi sama dengan multiplier yang
-- sekarang, jadi hasil payroll belum berubah sampai HR mengisi angka baru (mis. 2) di
-- menu Pola Kerja & Tarif Lembur.
-- =====================================================================================

-- ---------- 1. Kolom baru ----------
ALTER TABLE "kontrakKaryawanTbl"
    ADD COLUMN IF NOT EXISTS "TunjanganKehadiran" NUMERIC,
    ADD COLUMN IF NOT EXISTS "ModeTunjanganTransport" TEXT NOT NULL DEFAULT 'BULANAN',
    ADD COLUMN IF NOT EXISTS "ModeTunjanganMakan" TEXT NOT NULL DEFAULT 'BULANAN',
    ADD COLUMN IF NOT EXISTS "ModeTunjanganKehadiran" TEXT NOT NULL DEFAULT 'BULANAN',
    ADD COLUMN IF NOT EXISTS "ThpIncludeKompensasi" BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
    ALTER TABLE "kontrakKaryawanTbl" ADD CONSTRAINT kontrak_mode_tunjangan_chk CHECK (
        "ModeTunjanganTransport" IN ('BULANAN', 'HARIAN')
        AND "ModeTunjanganMakan" IN ('BULANAN', 'HARIAN')
        AND "ModeTunjanganKehadiran" IN ('BULANAN', 'HARIAN'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "polaKerjaTbl"
    ADD COLUMN IF NOT EXISTS "MultiplierLemburLanjut" NUMERIC,
    ADD COLUMN IF NOT EXISTS "ModeLemburOff" TEXT NOT NULL DEFAULT 'PER_JAM',
    ADD COLUMN IF NOT EXISTS "PembagiHariKerja" NUMERIC,
    ADD COLUMN IF NOT EXISTS "LemburHariKerjaDibayar" BOOLEAN NOT NULL DEFAULT true;

DO $$ BEGIN
    ALTER TABLE "polaKerjaTbl" ADD CONSTRAINT pola_mode_lembur_off_chk CHECK ("ModeLemburOff" IN ('PER_JAM', 'PER_HARI'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Nilai awal: jam berikutnya = multiplier lama (hasil payroll tidak berubah diam-diam),
-- upah harian pakai 21 hari (5 hari kerja/minggu) atau 25 hari (6-7 hari kerja/minggu).
UPDATE "polaKerjaTbl" SET "MultiplierLemburLanjut" = "MultiplierHariKerja" WHERE "MultiplierLemburLanjut" IS NULL;
UPDATE "polaKerjaTbl" SET "PembagiHariKerja" = CASE WHEN "SabtuMingguOff" THEN 21 ELSE 25 END WHERE "PembagiHariKerja" IS NULL;

ALTER TABLE "payrollBulananTbl"
    ADD COLUMN IF NOT EXISTS "TunjanganKehadiran" NUMERIC,
    ADD COLUMN IF NOT EXISTS "HariLemburOff" INTEGER,
    ADD COLUMN IF NOT EXISTS "UangKompensasiPkwt" NUMERIC;

-- ---------- 2. Pola Kerja Pekerja Lapangan Lumpsum ----------
INSERT INTO "polaKerjaTbl" ("Kategori", "NamaPola", "JamNormalPerHari", "JamLemburOtomatisPerHari", "Keterangan",
                            "PembagiJamKerja", "MultiplierHariKerja", "MultiplierLemburLanjut", "MultiplierHariOff",
                            "SabtuMingguOff", "LiburNasionalBerlaku", "ModeLemburOff", "PembagiHariKerja", "LemburHariKerjaDibayar")
SELECT 'Pekerja Lapangan Lumpsum', v.nama, v.jam, 0,
       'Lumpsum all-in ' || v.jam || ' jam/hari. Tanpa lembur hari kerja; lembur hanya kalau dipanggil masuk di hari OFF.',
       173, 1.5, 2, 2, false, true, 'PER_JAM', 25, false
FROM (VALUES ('8 Jam/Hari (Lumpsum)', 8), ('10 Jam/Hari (Lumpsum)', 10), ('12 Jam/Hari (Lumpsum)', 12)) AS v(nama, jam)
WHERE NOT EXISTS (
    SELECT 1 FROM "polaKerjaTbl" p WHERE p."Kategori" = 'Pekerja Lapangan Lumpsum' AND p."NamaPola" = v.nama
);

-- ---------- 3. RPC Pola Kerja ----------
DROP FUNCTION IF EXISTS public.update_pola_kerja(bigint, numeric, numeric, numeric, boolean, boolean, text);
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
    p_pembagi_hari numeric DEFAULT NULL::numeric
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
        "Keterangan" = COALESCE(p_keterangan, "Keterangan")
    WHERE "Id" = p_id;
    RETURN jsonb_build_object('status', 'SUCCESS');
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('status', 'ERROR', 'message', SQLERRM);
END;
$function$;

-- ---------- 4. RPC Kontrak ----------
DROP FUNCTION IF EXISTS public.create_kontrak_karyawan(bigint, text, text, date, date, numeric, text, text, numeric, numeric, numeric, numeric, bigint);
CREATE OR REPLACE FUNCTION public.create_kontrak_karyawan(
    p_karyawanid bigint, p_jeniskontrak text, p_nomorkontrak text, p_tanggalmulai date, p_tanggalberakhir date,
    p_gajipokok numeric, p_filekontrakurl text, p_filekontrakfileid text,
    p_tunjangan_jabatan numeric DEFAULT NULL, p_tunjangan_transport numeric DEFAULT NULL,
    p_tunjangan_makan numeric DEFAULT NULL, p_tunjangan_lain numeric DEFAULT NULL,
    p_pola_kerja_id bigint DEFAULT NULL,
    p_tunjangan_kehadiran numeric DEFAULT NULL,
    p_mode_tj_transport text DEFAULT 'BULANAN', p_mode_tj_makan text DEFAULT 'BULANAN',
    p_mode_tj_kehadiran text DEFAULT 'BULANAN',
    p_thp_include_kompensasi boolean DEFAULT false
)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id bigint;
begin
  insert into "kontrakKaryawanTbl"
    ("KaryawanID", "JenisKontrak", "NomorKontrak", "TanggalMulai", "TanggalBerakhir", "GajiPokok", "FileKontrakURL", "FileKontrakFileID",
     "TunjanganJabatan", "TunjanganTransport", "TunjanganMakan", "TunjanganLain", "PolaKerjaId",
     "TunjanganKehadiran", "ModeTunjanganTransport", "ModeTunjanganMakan", "ModeTunjanganKehadiran", "ThpIncludeKompensasi")
  values
    (p_karyawanid, p_jeniskontrak, p_nomorkontrak, p_tanggalmulai, p_tanggalberakhir, p_gajipokok, p_filekontrakurl, p_filekontrakfileid,
     p_tunjangan_jabatan, p_tunjangan_transport, p_tunjangan_makan, p_tunjangan_lain, p_pola_kerja_id,
     p_tunjangan_kehadiran, COALESCE(p_mode_tj_transport, 'BULANAN'), COALESCE(p_mode_tj_makan, 'BULANAN'),
     COALESCE(p_mode_tj_kehadiran, 'BULANAN'), COALESCE(p_thp_include_kompensasi, false) AND p_jeniskontrak = 'PKWT')
  returning "Id" into v_id;

  return v_id;
end;
$function$;

DROP FUNCTION IF EXISTS public.update_kontrak_karyawan(bigint, bigint, text, text, date, date, numeric, text, text, numeric, numeric, numeric, numeric, bigint);
CREATE OR REPLACE FUNCTION public.update_kontrak_karyawan(
    p_id bigint, p_karyawanid bigint, p_jeniskontrak text, p_nomorkontrak text, p_tanggalmulai date, p_tanggalberakhir date,
    p_gajipokok numeric, p_filekontrakurl text, p_filekontrakfileid text,
    p_tunjangan_jabatan numeric DEFAULT NULL, p_tunjangan_transport numeric DEFAULT NULL,
    p_tunjangan_makan numeric DEFAULT NULL, p_tunjangan_lain numeric DEFAULT NULL,
    p_pola_kerja_id bigint DEFAULT NULL,
    p_tunjangan_kehadiran numeric DEFAULT NULL,
    p_mode_tj_transport text DEFAULT 'BULANAN', p_mode_tj_makan text DEFAULT 'BULANAN',
    p_mode_tj_kehadiran text DEFAULT 'BULANAN',
    p_thp_include_kompensasi boolean DEFAULT false
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update "kontrakKaryawanTbl"
  set "KaryawanID" = p_karyawanid,
      "JenisKontrak" = p_jeniskontrak,
      "NomorKontrak" = p_nomorkontrak,
      "TanggalMulai" = p_tanggalmulai,
      "TanggalBerakhir" = p_tanggalberakhir,
      "GajiPokok" = p_gajipokok,
      "FileKontrakURL" = p_filekontrakurl,
      "FileKontrakFileID" = p_filekontrakfileid,
      "TunjanganJabatan" = p_tunjangan_jabatan,
      "TunjanganTransport" = p_tunjangan_transport,
      "TunjanganMakan" = p_tunjangan_makan,
      "TunjanganLain" = p_tunjangan_lain,
      "PolaKerjaId" = p_pola_kerja_id,
      "TunjanganKehadiran" = p_tunjangan_kehadiran,
      "ModeTunjanganTransport" = COALESCE(p_mode_tj_transport, 'BULANAN'),
      "ModeTunjanganMakan" = COALESCE(p_mode_tj_makan, 'BULANAN'),
      "ModeTunjanganKehadiran" = COALESCE(p_mode_tj_kehadiran, 'BULANAN'),
      "ThpIncludeKompensasi" = COALESCE(p_thp_include_kompensasi, false) AND p_jeniskontrak = 'PKWT'
  where "Id" = p_id;
end;
$function$;

DROP FUNCTION IF EXISTS public.list_kontrak_karyawan_full();
CREATE OR REPLACE FUNCTION public.list_kontrak_karyawan_full()
 RETURNS TABLE(id bigint, karyawanid bigint, namakaryawan text, jeniskontrak text, nomorkontrak text, tanggalmulai date, tanggalberakhir date, gajipokok numeric, filekontrakurl text, filekontrakfileid text, tunjanganjabatan numeric, tunjangantransport numeric, tunjanganmakan numeric, tunjanganlain numeric, polakerjaid bigint, polakerjanama text, polakerjakategori text,
               tunjangankehadiran numeric, modetjtransport text, modetjmakan text, modetjkehadiran text, thpincludekompensasi boolean)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select kk."Id", kk."KaryawanID", k."NamaPersonnel", kk."JenisKontrak", kk."NomorKontrak",
         kk."TanggalMulai", kk."TanggalBerakhir", kk."GajiPokok", kk."FileKontrakURL", kk."FileKontrakFileID",
         kk."TunjanganJabatan", kk."TunjanganTransport", kk."TunjanganMakan", kk."TunjanganLain",
         kk."PolaKerjaId", pk."NamaPola", pk."Kategori",
         kk."TunjanganKehadiran", kk."ModeTunjanganTransport", kk."ModeTunjanganMakan", kk."ModeTunjanganKehadiran",
         kk."ThpIncludeKompensasi"
  from "kontrakKaryawanTbl" kk
  left join "karyawanTbl" k on k."Id" = kk."KaryawanID"
  left join "polaKerjaTbl" pk on pk."Id" = kk."PolaKerjaId"
  order by kk."TanggalBerakhir" asc nulls last;
$function$;

GRANT EXECUTE ON FUNCTION public.update_pola_kerja(bigint, numeric, numeric, numeric, boolean, boolean, text, numeric, text, numeric) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_kontrak_karyawan(bigint, text, text, date, date, numeric, text, text, numeric, numeric, numeric, numeric, bigint, numeric, text, text, text, boolean) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_kontrak_karyawan(bigint, bigint, text, text, date, date, numeric, text, text, numeric, numeric, numeric, numeric, bigint, numeric, text, text, text, boolean) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_kontrak_karyawan_full() TO anon, authenticated, service_role;

-- ---------- 5. Proses Payroll Bulanan ----------
CREATE OR REPLACE FUNCTION public.proses_payroll_bulanan(p_bulan integer, p_tahun integer, p_processed_by text DEFAULT 'System'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_periode_awal DATE := make_date(p_tahun, p_bulan, 1);
    v_periode_akhir DATE := (make_date(p_tahun, p_bulan, 1) + INTERVAL '1 month - 1 day')::DATE;
    v_kontrak RECORD;
    v_pola RECORD;
    v_fallback_pola RECORD;
    v_hadir RECORD;
    v_lembur RECORD;
    v_harian RECORD;
    v_jenis_hari JSONB;
    v_jam_oto_kerja NUMERIC; v_jam_oto_off NUMERIC;
    v_jam_man_kerja NUMERIC; v_jam_man_off NUMERIC;
    v_hari_hadir INT;
    v_hari_lembur_off INT;
    v_auto_per_hari NUMERIC;
    v_lembur_kerja_dibayar BOOLEAN;
    v_pembagi NUMERIC; v_pembagi_hari NUMERIC;
    v_mult_jam1 NUMERIC; v_mult_lanjut NUMERIC; v_mult_off NUMERIC;
    v_mode_off TEXT;
    v_tj_transport NUMERIC; v_tj_makan NUMERIC; v_tj_kehadiran NUMERIC;
    v_upah_tetap NUMERIC;
    v_upah_per_jam NUMERIC;
    v_upah_harian NUMERIC;
    v_nilai_lembur NUMERIC;
    v_kompensasi NUMERIC;
    v_bruto NUMERIC;
    v_ptkp TEXT;
    v_kategori_ter TEXT;
    v_tarif_ter NUMERIC;
    v_pph21 NUMERIC;
    v_bpjs_row RECORD;
    v_total_bpjs_karyawan NUMERIC; v_total_bpjs_perusahaan NUMERIC;
    v_bpjs_kesehatan NUMERIC; v_jht NUMERIC; v_jp NUMERIC;
    v_base NUMERIC;
    v_total_potongan NUMERIC;
    v_thp NUMERIC;
    v_count INT := 0;
BEGIN
    -- Pola default fallback (dipakai kalau kontrak gak ada Pola Kerja ter-link, misal PKWTT yang tetap dapet lembur manual)
    SELECT * INTO v_fallback_pola FROM "polaKerjaTbl" WHERE "NamaPola" = 'Reguler (Senin-Jumat, Sabtu-Minggu Libur)' LIMIT 1;

    CREATE TEMP TABLE IF NOT EXISTS tmp_payroll_lembur_harian (tgl DATE, jenis TEXT, jam NUMERIC) ON COMMIT DROP;

    FOR v_kontrak IN
        SELECT kk.*, k."NamaPersonnel", k."Divisi" AS kdivisi, k."Departemen" AS kdept, k."Kualifikasi" AS kkual,
               k."StatusPernikahan", k."JumlahAnak", k."QrCodeId"
        FROM "kontrakKaryawanTbl" kk
        JOIN "karyawanTbl" k ON k."Id" = kk."KaryawanID"
        WHERE kk."TanggalMulai" <= v_periode_akhir
          AND (kk."TanggalBerakhir" IS NULL OR kk."TanggalBerakhir" >= v_periode_awal)
    LOOP
        -- Pola Kerja punya orang ini (kalau ada)
        IF v_kontrak."PolaKerjaId" IS NOT NULL THEN
            SELECT * INTO v_pola FROM "polaKerjaTbl" WHERE "Id" = v_kontrak."PolaKerjaId";
        ELSE
            v_pola := v_fallback_pola;
        END IF;
        v_pembagi := COALESCE(v_pola."PembagiJamKerja", 173);
        v_pembagi_hari := COALESCE(NULLIF(v_pola."PembagiHariKerja", 0), 25);
        v_mult_jam1 := COALESCE(v_pola."MultiplierHariKerja", 0);
        v_mult_lanjut := COALESCE(v_pola."MultiplierLemburLanjut", v_mult_jam1);
        v_mult_off := COALESCE(v_pola."MultiplierHariOff", 0);
        v_mode_off := COALESCE(v_pola."ModeLemburOff", 'PER_JAM');
        v_lembur_kerja_dibayar := COALESCE(v_pola."LemburHariKerjaDibayar", true);
        v_auto_per_hari := CASE WHEN v_kontrak."PolaKerjaId" IS NOT NULL AND v_lembur_kerja_dibayar
                                THEN COALESCE(v_pola."JamLemburOtomatisPerHari", 0) ELSE 0 END;

        TRUNCATE tmp_payroll_lembur_harian;

        -- Hari hadir (scan masuk) & lembur otomatis dari Absensi
        v_hari_hadir := 0; v_jam_oto_kerja := 0; v_jam_oto_off := 0;
        FOR v_hadir IN
            SELECT "Tanggal" FROM "absensiTbl"
            WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(v_kontrak."QrCodeId"))
              AND "Tanggal" BETWEEN v_periode_awal AND v_periode_akhir
              AND "JamMasuk1" IS NOT NULL
        LOOP
            v_hari_hadir := v_hari_hadir + 1;
            IF v_auto_per_hari > 0 THEN
                v_jenis_hari := cek_jenis_hari(v_hadir."Tanggal", v_kontrak."QrCodeId");
                IF (v_jenis_hari->>'jenis_hari') = 'HARI_OFF' THEN
                    v_jam_oto_off := v_jam_oto_off + v_auto_per_hari;
                    INSERT INTO tmp_payroll_lembur_harian VALUES (v_hadir."Tanggal", 'HARI_OFF', v_auto_per_hari);
                ELSE
                    v_jam_oto_kerja := v_jam_oto_kerja + v_auto_per_hari;
                    INSERT INTO tmp_payroll_lembur_harian VALUES (v_hadir."Tanggal", 'HARI_KERJA', v_auto_per_hari);
                END IF;
            END IF;
        END LOOP;

        -- Lembur manual (approved) dari Otorisasi Lembur. Lumpsum: cuma hari OFF yang dibayar.
        v_jam_man_kerja := 0; v_jam_man_off := 0;
        FOR v_lembur IN
            SELECT tanggal, durasi_jam, jenis_hari FROM pengajuan_ijin_lembur_tbl
            WHERE UPPER(TRIM(qrcodeid)) = UPPER(TRIM(v_kontrak."QrCodeId"))
              AND tipe = 'LEMBUR' AND status = 'APPROVED'
              AND tanggal BETWEEN v_periode_awal AND v_periode_akhir
        LOOP
            IF v_lembur.jenis_hari = 'HARI_OFF' THEN
                v_jam_man_off := v_jam_man_off + COALESCE(v_lembur.durasi_jam, 0);
                INSERT INTO tmp_payroll_lembur_harian VALUES (v_lembur.tanggal, 'HARI_OFF', COALESCE(v_lembur.durasi_jam, 0));
            ELSIF v_lembur_kerja_dibayar THEN
                v_jam_man_kerja := v_jam_man_kerja + COALESCE(v_lembur.durasi_jam, 0);
                INSERT INTO tmp_payroll_lembur_harian VALUES (v_lembur.tanggal, 'HARI_KERJA', COALESCE(v_lembur.durasi_jam, 0));
            END IF;
        END LOOP;

        -- Tunjangan: BULANAN = nominal tetap, HARIAN = nominal x hari hadir
        v_tj_transport := COALESCE(v_kontrak."TunjanganTransport", 0)
                          * CASE WHEN v_kontrak."ModeTunjanganTransport" = 'HARIAN' THEN v_hari_hadir ELSE 1 END;
        v_tj_makan := COALESCE(v_kontrak."TunjanganMakan", 0)
                      * CASE WHEN v_kontrak."ModeTunjanganMakan" = 'HARIAN' THEN v_hari_hadir ELSE 1 END;
        v_tj_kehadiran := COALESCE(v_kontrak."TunjanganKehadiran", 0)
                          * CASE WHEN v_kontrak."ModeTunjanganKehadiran" = 'HARIAN' THEN v_hari_hadir ELSE 1 END;

        -- Upah tetap (dasar lembur, BPJS, Uang Kompensasi): gaji pokok + tunjangan tetap.
        -- Tunjangan HARIAN tidak ikut karena termasuk tunjangan tidak tetap.
        v_upah_tetap := COALESCE(v_kontrak."GajiPokok", 0) + COALESCE(v_kontrak."TunjanganJabatan", 0)
                      + COALESCE(v_kontrak."TunjanganLain", 0)
                      + CASE WHEN v_kontrak."ModeTunjanganTransport" = 'HARIAN' THEN 0 ELSE v_tj_transport END
                      + CASE WHEN v_kontrak."ModeTunjanganMakan" = 'HARIAN' THEN 0 ELSE v_tj_makan END
                      + CASE WHEN v_kontrak."ModeTunjanganKehadiran" = 'HARIAN' THEN 0 ELSE v_tj_kehadiran END;
        v_upah_per_jam := CASE WHEN v_pembagi > 0 THEN v_upah_tetap / v_pembagi ELSE 0 END;
        v_upah_harian := v_upah_tetap / v_pembagi_hari;

        -- Nilai Lembur Rupiah, dihitung per tanggal.
        -- Hari kerja: jam ke-1 x Multiplier Jam Pertama, sisanya x Multiplier Jam Berikutnya.
        -- Hari OFF  : PER_JAM = jam x tarif/jam x Multiplier OFF; PER_HARI = 1 hari x upah harian x Multiplier OFF.
        v_nilai_lembur := 0; v_hari_lembur_off := 0;
        FOR v_harian IN
            SELECT tgl, jenis, SUM(jam) AS jam FROM tmp_payroll_lembur_harian GROUP BY tgl, jenis HAVING SUM(jam) > 0
        LOOP
            IF v_harian.jenis = 'HARI_OFF' THEN
                v_hari_lembur_off := v_hari_lembur_off + 1;
                IF v_mode_off = 'PER_HARI' THEN
                    v_nilai_lembur := v_nilai_lembur + v_upah_harian * v_mult_off;
                ELSE
                    v_nilai_lembur := v_nilai_lembur + v_harian.jam * v_upah_per_jam * v_mult_off;
                END IF;
            ELSE
                v_nilai_lembur := v_nilai_lembur
                    + LEAST(v_harian.jam, 1) * v_upah_per_jam * v_mult_jam1
                    + GREATEST(v_harian.jam - 1, 0) * v_upah_per_jam * v_mult_lanjut;
            END IF;
        END LOOP;

        v_bruto := COALESCE(v_kontrak."GajiPokok", 0) + COALESCE(v_kontrak."TunjanganJabatan", 0)
                 + COALESCE(v_kontrak."TunjanganLain", 0)
                 + v_tj_transport + v_tj_makan + v_tj_kehadiran + v_nilai_lembur;

        -- Uang Kompensasi PKWT dicicil bulanan (1/12 upah), kalau dicentang di kontrak
        v_kompensasi := CASE WHEN v_kontrak."JenisKontrak" = 'PKWT' AND COALESCE(v_kontrak."ThpIncludeKompensasi", false)
                             THEN v_upah_tetap / 12 ELSE 0 END;

        -- PTKP
        IF v_kontrak."StatusPernikahan" IS NOT NULL THEN
            v_ptkp := (CASE WHEN LOWER(TRIM(v_kontrak."StatusPernikahan")) = 'menikah' THEN 'K' ELSE 'TK' END)
                      || '/' || LEAST(GREATEST(COALESCE(v_kontrak."JumlahAnak"::INT, 0), 0), 3);
        ELSE
            v_ptkp := NULL;
        END IF;
        v_kategori_ter := CASE
            WHEN v_ptkp IN ('TK/0','TK/1','K/0') THEN 'A'
            WHEN v_ptkp IN ('TK/2','TK/3','K/1','K/2') THEN 'B'
            WHEN v_ptkp = 'K/3' THEN 'C'
            ELSE 'A'
        END;

        v_tarif_ter := NULL;
        SELECT COALESCE("TarifPersen", 0) INTO v_tarif_ter FROM "terTbl"
        WHERE "Kategori" = v_kategori_ter AND v_bruto >= "PenghasilanBrutoMin"
          AND ("PenghasilanBrutoMax" IS NULL OR v_bruto <= "PenghasilanBrutoMax")
        LIMIT 1;
        v_pph21 := v_bruto * (COALESCE(v_tarif_ter,0) / 100);

        -- BPJS (basis upah tetap, TANPA lembur & tunjangan harian)
        v_total_bpjs_karyawan := 0; v_total_bpjs_perusahaan := 0; v_bpjs_kesehatan := 0; v_jht := 0; v_jp := 0;
        FOR v_bpjs_row IN SELECT * FROM "bpjsTbl" WHERE "IsAktif" = true LOOP
            v_base := CASE WHEN v_bpjs_row."BatasUpahMax" IS NOT NULL THEN LEAST(v_upah_tetap, v_bpjs_row."BatasUpahMax") ELSE v_upah_tetap END;
            v_total_bpjs_karyawan := v_total_bpjs_karyawan + (v_base * COALESCE(v_bpjs_row."PersenKaryawan",0) / 100);
            v_total_bpjs_perusahaan := v_total_bpjs_perusahaan + (v_base * COALESCE(v_bpjs_row."PersenPerusahaan",0) / 100);
            IF v_bpjs_row."Program" = 'BPJS Kesehatan' THEN v_bpjs_kesehatan := v_base * COALESCE(v_bpjs_row."PersenKaryawan",0) / 100; END IF;
            IF v_bpjs_row."Program" = 'JHT' THEN v_jht := v_base * COALESCE(v_bpjs_row."PersenKaryawan",0) / 100; END IF;
            IF v_bpjs_row."Program" = 'JP' THEN v_jp := v_base * COALESCE(v_bpjs_row."PersenKaryawan",0) / 100; END IF;
        END LOOP;

        v_total_potongan := v_total_bpjs_karyawan + v_pph21;
        v_thp := v_bruto - v_total_potongan + v_kompensasi;

        INSERT INTO "payrollBulananTbl" (
            "Bulan","Tahun","KaryawanId","NamaKaryawan","Divisi","Departemen","Kualifikasi","JenisKontrak","StatusPTKP",
            "GajiPokok","TunjanganJabatan","TunjanganTransport","TunjanganMakan","TunjanganKehadiran","TunjanganLain",
            "JumlahHariHadir","JamLemburOtomatisKerja","JamLemburOtomatisOff","JamLemburManualKerja","JamLemburManualOff",
            "HariLemburOff","NilaiLembur","PenghasilanBruto","BpjsKesehatanKaryawan","JhtKaryawan","JpKaryawan",
            "TotalBpjsKaryawan","TotalBpjsPerusahaan","Pph21","TotalPotongan","UangKompensasiPkwt","TakeHomePay","ProcessedBy"
        ) VALUES (
            p_bulan, p_tahun, v_kontrak."KaryawanID", v_kontrak."NamaPersonnel", v_kontrak.kdivisi, v_kontrak.kdept, v_kontrak.kkual,
            v_kontrak."JenisKontrak", v_ptkp,
            v_kontrak."GajiPokok", v_kontrak."TunjanganJabatan", v_tj_transport, v_tj_makan, v_tj_kehadiran, v_kontrak."TunjanganLain",
            v_hari_hadir, v_jam_oto_kerja, v_jam_oto_off, v_jam_man_kerja, v_jam_man_off,
            v_hari_lembur_off, v_nilai_lembur, v_bruto, v_bpjs_kesehatan, v_jht, v_jp,
            v_total_bpjs_karyawan, v_total_bpjs_perusahaan, v_pph21, v_total_potongan, v_kompensasi, v_thp, p_processed_by
        )
        ON CONFLICT ("Bulan","Tahun","KaryawanId") DO UPDATE SET
            "NamaKaryawan" = EXCLUDED."NamaKaryawan", "Divisi" = EXCLUDED."Divisi", "Departemen" = EXCLUDED."Departemen",
            "Kualifikasi" = EXCLUDED."Kualifikasi", "JenisKontrak" = EXCLUDED."JenisKontrak", "StatusPTKP" = EXCLUDED."StatusPTKP",
            "GajiPokok" = EXCLUDED."GajiPokok", "TunjanganJabatan" = EXCLUDED."TunjanganJabatan",
            "TunjanganTransport" = EXCLUDED."TunjanganTransport", "TunjanganMakan" = EXCLUDED."TunjanganMakan",
            "TunjanganKehadiran" = EXCLUDED."TunjanganKehadiran",
            "TunjanganLain" = EXCLUDED."TunjanganLain", "JumlahHariHadir" = EXCLUDED."JumlahHariHadir",
            "JamLemburOtomatisKerja" = EXCLUDED."JamLemburOtomatisKerja", "JamLemburOtomatisOff" = EXCLUDED."JamLemburOtomatisOff",
            "JamLemburManualKerja" = EXCLUDED."JamLemburManualKerja", "JamLemburManualOff" = EXCLUDED."JamLemburManualOff",
            "HariLemburOff" = EXCLUDED."HariLemburOff",
            "NilaiLembur" = EXCLUDED."NilaiLembur", "PenghasilanBruto" = EXCLUDED."PenghasilanBruto",
            "BpjsKesehatanKaryawan" = EXCLUDED."BpjsKesehatanKaryawan", "JhtKaryawan" = EXCLUDED."JhtKaryawan", "JpKaryawan" = EXCLUDED."JpKaryawan",
            "TotalBpjsKaryawan" = EXCLUDED."TotalBpjsKaryawan", "TotalBpjsPerusahaan" = EXCLUDED."TotalBpjsPerusahaan",
            "Pph21" = EXCLUDED."Pph21", "TotalPotongan" = EXCLUDED."TotalPotongan",
            "UangKompensasiPkwt" = EXCLUDED."UangKompensasiPkwt", "TakeHomePay" = EXCLUDED."TakeHomePay",
            "ProcessedAt" = now(), "ProcessedBy" = EXCLUDED."ProcessedBy";

        v_count := v_count + 1;
    END LOOP;

    RETURN jsonb_build_object('status', 'SUCCESS', 'jumlah_karyawan_diproses', v_count);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('status', 'ERROR', 'message', SQLERRM);
END;
$function$;
