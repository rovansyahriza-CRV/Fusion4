-- =====================================================================================
-- FIX: Voucher PIN SPKL (lembur) tidak pernah terbit + absen lembur pakai PIN gagal
-- Tanggal: 2026-10-01
-- =====================================================================================
-- MASALAH 1: sejak alur approval baru (Cek HR -> L1..L3, Direktur auto-approve),
--   process_approval_action cuma menerbitkan kode_ijin (IJN-xxxxxx) untuk IJIN.
--   Penerbitan voucher_pin (SPKL-xxxx) untuk LEMBUR ketinggalan -> semua LEMBUR
--   APPROVED punya voucher_pin NULL, di Otorisasi > Voucher tampil "-".
--   FIX: terbitkan PIN di apply_pengajuan_final_side_effects() -- fungsi ini dipanggil
--   di SEMUA jalur final approve (manual & auto-approve Direktur), jadi cukup 1 tempat.
--   + backfill PIN untuk LEMBUR APPROVED yang masih kosong.
--
-- MASALAH 2: submit_absensi_lembur() pasti gagal:
--   - INSERT baris baru ke absensiTbl, padahal baris hari itu sudah ada (PIN cuma
--     diminta setelah Absen Pulang) -> bentrok UNIQUE ("Tanggal","QrCodeId").
--   - "JamMasuk1" (timestamptz) diisi teks 'HH24:MI:SS'.
--   - Tanggal pakai CURRENT_DATE (UTC), bukan WITA -> 00:00-08:00 WITA salah hari.
--   - PIN bisa dipakai siapa saja (tidak dicek pemiliknya).
--   FIX: tanggal WITA, PIN wajib milik karyawan yang scan, tandai voucher terpakai,
--   catat "Lembur SPKL-xxx mulai HH:MM WITA @ lokasi" di kolom Catatan absensi hari itu.
--
-- Payroll TIDAK terdampak: nilai lembur dihitung dari durasi_jam SPKL yang APPROVED.
-- =====================================================================================

-- PIN unik di antara voucher yang belum terpakai.
CREATE OR REPLACE FUNCTION public._generate_voucher_spkl(p_request_id BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_pin TEXT;
BEGIN
    LOOP
        v_pin := 'SPKL-' || UPPER(SUBSTRING(MD5(RANDOM()::TEXT || p_request_id::TEXT || CLOCK_TIMESTAMP()::TEXT), 1, 6));
        EXIT WHEN NOT EXISTS (
            SELECT 1 FROM "pengajuan_ijin_lembur_tbl"
            WHERE UPPER(TRIM("voucher_pin")) = v_pin AND COALESCE("is_used", FALSE) = FALSE
        );
    END LOOP;
    RETURN v_pin;
END;
$function$;

REVOKE ALL ON FUNCTION public._generate_voucher_spkl(BIGINT) FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION public.apply_pengajuan_final_side_effects(p_request_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_req RECORD;
    v_curr_date DATE;
BEGIN
    SELECT * INTO v_req FROM "pengajuan_ijin_lembur_tbl" WHERE "id" = p_request_id;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF v_req.tipe = 'CUTI' THEN
        IF UPPER(TRIM(COALESCE(v_req.jenis_cuti, 'CUTI_TAHUNAN'))) = 'CUTI_TAHUNAN' THEN
            UPDATE "karyawanTbl"
            SET "SisaCuti" = GREATEST(0, COALESCE("SisaCuti", 12) - COALESCE(v_req.jumlah_hari, 1))
            WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(v_req.qrcodeid));
        END IF;

        FOR v_curr_date IN
            SELECT generate_series(
                COALESCE(v_req.tanggal_mulai, v_req.tanggal),
                COALESCE(v_req.tanggal_selesai, v_req.tanggal),
                '1 day'::interval
            )::DATE
        LOOP
            INSERT INTO "absensiTbl" ("Tanggal", "QrCodeId", "LokasiMasuk1", "Status")
            VALUES (v_curr_date, UPPER(TRIM(v_req.qrcodeid)), NULLIF(v_req.lokasi, ''), 'CUTI')
            ON CONFLICT ("Tanggal", "QrCodeId") DO UPDATE SET "Status" = EXCLUDED."Status";
        END LOOP;

    ELSIF v_req.tipe = 'IJIN' THEN
        IF v_req.kategori_ijin = 'PRIBADI' THEN
            UPDATE "karyawanTbl"
            SET "SisaCuti" = GREATEST(0, COALESCE("SisaCuti", 12) - 1)
            WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(v_req.qrcodeid));
        END IF;

        INSERT INTO "absensiTbl" ("Tanggal", "QrCodeId", "LokasiMasuk1", "Status")
        VALUES (v_req.tanggal, UPPER(TRIM(v_req.qrcodeid)), NULLIF(v_req.lokasi, ''), 'IJIN')
        ON CONFLICT ("Tanggal", "QrCodeId") DO UPDATE SET "Status" = EXCLUDED."Status";

    ELSIF v_req.tipe = 'LEMBUR' THEN
        -- Terbitkan Voucher PIN SPKL (dipakai scan absen lembur setelah Absen Pulang).
        IF v_req.voucher_pin IS NULL THEN
            UPDATE "pengajuan_ijin_lembur_tbl"
            SET "voucher_pin" = public._generate_voucher_spkl(p_request_id),
                "is_used" = FALSE
            WHERE "id" = p_request_id;
        END IF;

    ELSIF v_req.tipe = 'OFF' THEN
        FOR v_curr_date IN
            SELECT generate_series(v_req.tanggal_mulai, v_req.tanggal_selesai, '1 day'::interval)::DATE
        LOOP
            INSERT INTO "absensiTbl" ("Tanggal", "QrCodeId", "Status")
            VALUES (v_curr_date, UPPER(TRIM(v_req.qrcodeid)), 'OFF')
            ON CONFLICT ("Tanggal", "QrCodeId") DO UPDATE SET "Status" = EXCLUDED."Status"
            WHERE "absensiTbl"."JamMasuk1" IS NULL AND "absensiTbl"."JamIstirahat" IS NULL
              AND "absensiTbl"."JamMasuk2" IS NULL AND "absensiTbl"."JamPulang" IS NULL;
        END LOOP;
    END IF;
END;
$function$;


-- Backfill: LEMBUR yang sudah APPROVED tapi belum punya PIN.
UPDATE "pengajuan_ijin_lembur_tbl"
SET "voucher_pin" = public._generate_voucher_spkl("id"),
    "is_used" = COALESCE("is_used", FALSE)
WHERE "tipe" = 'LEMBUR' AND "status" = 'APPROVED' AND "voucher_pin" IS NULL;


CREATE OR REPLACE FUNCTION public.submit_absensi_lembur(p_qrcodeid text, p_lokasi text, p_pinvoucher text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_req RECORD;
    v_today DATE := (NOW() AT TIME ZONE 'Asia/Makassar')::DATE;
    v_jam TEXT := TO_CHAR(NOW() AT TIME ZONE 'Asia/Makassar', 'HH24:MI');
    v_catatan TEXT;
    v_absen_id BIGINT;
BEGIN
    SELECT * INTO v_req
    FROM "pengajuan_ijin_lembur_tbl"
    WHERE UPPER(TRIM("voucher_pin")) = UPPER(TRIM(p_pinvoucher))
      AND UPPER(TRIM("qrcodeid")) = UPPER(TRIM(p_qrcodeid))
      AND "tipe" = 'LEMBUR'
      AND "status" = 'APPROVED'
      AND COALESCE("is_used", FALSE) = FALSE
      AND "tanggal" = v_today
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'NEED_VOUCHER',
            'message', 'Voucher PIN belum aktif / salah / bukan untuk Anda atau hari ini. Coba lagi.');
    END IF;

    UPDATE "pengajuan_ijin_lembur_tbl"
    SET "is_used" = TRUE,
        "used_at" = NOW(),
        "lokasi" = COALESCE(NULLIF(p_lokasi, ''), "lokasi"),
        "updated_at" = NOW()
    WHERE "id" = v_req.id;

    v_catatan := 'Lembur ' || v_req.voucher_pin || ' mulai ' || v_jam || ' WITA' ||
                 COALESCE(' @ ' || NULLIF(p_lokasi, ''), '');

    UPDATE "absensiTbl"
    SET "Catatan" = CONCAT_WS(' | ', NULLIF("Catatan", ''), v_catatan)
    WHERE "Tanggal" = v_today AND UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcodeid))
    RETURNING "Id" INTO v_absen_id;

    IF v_absen_id IS NULL THEN
        INSERT INTO "absensiTbl" ("Tanggal", "QrCodeId", "Status", "Catatan")
        VALUES (v_today, UPPER(TRIM(p_qrcodeid)), 'LEMBUR', v_catatan)
        ON CONFLICT ("Tanggal", "QrCodeId") DO NOTHING;
    END IF;

    RETURN jsonb_build_object('status', 'SUCCESS',
        'message', 'Absensi Lembur (' || v_req.voucher_pin || ') tercatat mulai jam ' || v_jam || ' WITA.');
END;
$function$;
