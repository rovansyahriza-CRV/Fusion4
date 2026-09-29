-- =====================================================================================
-- Jatah Off Rotasi per bulan + approver bisa ubah tanggal Cuti/Off.
-- Jalankan SETELAH migrasi_hak_off_pola_kerja.sql.
--
-- Jatah Off Rotasi:
-- - polaKerjaTbl.KuotaOffRotasiBulan (bisa diubah HR). Isi awal dari jam kerja per hari
--   (jam normal + lembur otomatis, sejalan dengan target 173 jam): 8 jam = 6 hari,
--   10 jam = 10 hari, 12 jam = 14 hari.
-- - Dihitung per bulan kalender: Off Rotasi yang pending + disetujui + yang diajukan.
-- - Kalau terlampaui TIDAK ditolak, cuma peringatan (ke karyawan saat mengajukan, dan
--   ke approver di antrean).
--
-- Ubah tanggal (Cuti & Off):
-- - Approver yang sedang memegang pengajuan (Cek HR / Level 1-3) bisa ubah tanggal
--   sebelum menyetujui. Catatan wajib. Tanggal asli yang diajukan karyawan disimpan
--   (tanggal_mulai_awal / tanggal_selesai_awal) + siapa & kapan mengubah.
-- - Off Periode: cuma geser tanggal mulai, tetap 14 hari.
-- - Validasi diulang: bentrok Cuti/Off, aturan 3 bulan Off Periode, saldo Cuti Tahunan.
-- - Saldo cuti dipotong sesuai jumlah hari yang akhirnya disetujui (sudah otomatis).
-- =====================================================================================

-- ---------- 1. Kolom ----------
ALTER TABLE "polaKerjaTbl"
    ADD COLUMN IF NOT EXISTS "KuotaOffRotasiBulan" INTEGER;

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM "polaKerjaTbl" WHERE "KuotaOffRotasiBulan" IS NOT NULL) THEN
        UPDATE "polaKerjaTbl"
        SET "KuotaOffRotasiBulan" = CASE
                WHEN COALESCE("JamNormalPerHari", 8) + COALESCE("JamLemburOtomatisPerHari", 0) <= 8 THEN 6
                WHEN COALESCE("JamNormalPerHari", 8) + COALESCE("JamLemburOtomatisPerHari", 0) <= 10 THEN 10
                ELSE 14 END
        WHERE "BolehOffRotasi";
    END IF;
END $$;

ALTER TABLE pengajuan_ijin_lembur_tbl
    ADD COLUMN IF NOT EXISTS tanggal_mulai_awal DATE,
    ADD COLUMN IF NOT EXISTS tanggal_selesai_awal DATE,
    ADD COLUMN IF NOT EXISTS tanggal_diubah_oleh TEXT,
    ADD COLUMN IF NOT EXISTS tanggal_diubah_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS tanggal_diubah_catatan TEXT;

-- ---------- 2. Hak off + jatah bulan ini ----------
CREATE OR REPLACE FUNCTION public.get_hak_off(p_qrcode text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
AS $function$
    SELECT jsonb_build_object(
        'offRotasi', COALESCE(x.rotasi, false),
        'offPeriode', COALESCE(x.periode, false),
        'polaKerja', x.pola,
        'kuotaOffRotasi', CASE WHEN x.rotasi THEN x.kuota END,
        'terpakaiBulanIni', (
            SELECT COALESCE(SUM(LEAST(p.tanggal_selesai, (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')::DATE)
                              - GREATEST(p.tanggal_mulai, date_trunc('month', CURRENT_DATE)::DATE) + 1), 0)
            FROM pengajuan_ijin_lembur_tbl p
            WHERE UPPER(TRIM(p.qrcodeid)) = UPPER(TRIM(p_qrcode))
              AND p.tipe = 'OFF' AND p.jenis_cuti = 'OFF_ROTASI' AND p.status <> 'REJECTED'
              AND p.tanggal_mulai <= (date_trunc('month', CURRENT_DATE) + INTERVAL '1 month - 1 day')::DATE
              AND p.tanggal_selesai >= date_trunc('month', CURRENT_DATE)::DATE
        )
    )
    FROM (SELECT 1) dummy
    LEFT JOIN LATERAL (
        SELECT pk."BolehOffRotasi" AS rotasi, pk."BolehOffPeriode" AS periode, pk."NamaPola" AS pola,
               pk."KuotaOffRotasiBulan" AS kuota
        FROM "karyawanTbl" k
        JOIN "kontrakKaryawanTbl" kk ON kk."KaryawanID" = k."Id"
        LEFT JOIN "polaKerjaTbl" pk ON pk."Id" = kk."PolaKerjaId"
        WHERE UPPER(TRIM(k."QrCodeId")) = UPPER(TRIM(p_qrcode))
          AND (kk."TanggalBerakhir" IS NULL OR kk."TanggalBerakhir" >= CURRENT_DATE)
        ORDER BY kk."TanggalMulai" DESC NULLS LAST
        LIMIT 1
    ) x ON true;
$function$;

-- ---------- 3. Cek jatah Off Rotasi untuk suatu rentang (per bulan kalender) ----------
CREATE OR REPLACE FUNCTION public.off_rotasi_kuota_info(p_qrcode text, p_mulai date, p_selesai date, p_exclude_id bigint DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
AS $function$
DECLARE
    v_kuota INT;
    v_bulan DATE; v_awal DATE; v_akhir DATE;
    v_terpakai INT; v_diajukan INT;
    v_pesan TEXT[] := ARRAY[]::TEXT[];
BEGIN
    v_kuota := (get_hak_off(p_qrcode)->>'kuotaOffRotasi')::INT;
    IF v_kuota IS NULL OR p_mulai IS NULL THEN
        RETURN jsonb_build_object('kuota', v_kuota, 'melebihi', false, 'peringatan', NULL);
    END IF;

    FOR v_bulan IN
        SELECT generate_series(date_trunc('month', p_mulai), date_trunc('month', COALESCE(p_selesai, p_mulai)), INTERVAL '1 month')::DATE
    LOOP
        v_awal := v_bulan;
        v_akhir := (v_bulan + INTERVAL '1 month - 1 day')::DATE;
        SELECT COALESCE(SUM(LEAST(tanggal_selesai, v_akhir) - GREATEST(tanggal_mulai, v_awal) + 1), 0) INTO v_terpakai
        FROM pengajuan_ijin_lembur_tbl
        WHERE UPPER(TRIM(qrcodeid)) = UPPER(TRIM(p_qrcode))
          AND tipe = 'OFF' AND jenis_cuti = 'OFF_ROTASI' AND status <> 'REJECTED'
          AND (p_exclude_id IS NULL OR id <> p_exclude_id)
          AND tanggal_mulai <= v_akhir AND tanggal_selesai >= v_awal;
        v_diajukan := LEAST(COALESCE(p_selesai, p_mulai), v_akhir) - GREATEST(p_mulai, v_awal) + 1;
        IF v_terpakai + v_diajukan > v_kuota THEN
            v_pesan := v_pesan || (TO_CHAR(v_bulan, 'MM/YYYY') || ': sudah ' || v_terpakai || ' + ini ' || v_diajukan
                                   || ' = ' || (v_terpakai + v_diajukan) || ' hari, jatah ' || v_kuota || ' hari');
        END IF;
    END LOOP;

    RETURN jsonb_build_object('kuota', v_kuota,
        'melebihi', array_length(v_pesan, 1) IS NOT NULL,
        'peringatan', CASE WHEN array_length(v_pesan, 1) IS NOT NULL
                           THEN 'Melebihi jatah Off Rotasi (' || array_to_string(v_pesan, '; ') || ')' END);
END;
$function$;

-- ---------- 4. Validasi tanggal Cuti/Off (dipakai submit Off & ubah tanggal) ----------
-- Return NULL kalau aman, atau pesan error.
CREATE OR REPLACE FUNCTION public.validasi_tanggal_cuti_off(
    p_qrcode text, p_tipe text, p_jenis text, p_mulai date, p_selesai date, p_exclude_id bigint DEFAULT NULL
)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
AS $function$
DECLARE
    v_bentrok RECORD;
    v_id BIGINT; v_tgl_masuk DATE; v_sisa INT;
    v_base DATE; v_boleh_mulai DATE;
BEGIN
    IF p_mulai IS NULL OR p_selesai IS NULL OR p_selesai < p_mulai THEN
        RETURN 'Tanggal selesai tidak boleh lebih awal dari tanggal mulai.';
    END IF;

    SELECT "tipe", "tanggal_mulai", "tanggal_selesai" INTO v_bentrok
    FROM "pengajuan_ijin_lembur_tbl"
    WHERE UPPER(TRIM("qrcodeid")) = UPPER(TRIM(p_qrcode))
      AND "tipe" IN ('CUTI', 'OFF')
      AND "status" <> 'REJECTED'
      AND (p_exclude_id IS NULL OR "id" <> p_exclude_id)
      AND "tanggal_mulai" <= p_selesai
      AND COALESCE("tanggal_selesai", "tanggal_mulai") >= p_mulai
    LIMIT 1;
    IF FOUND THEN
        RETURN 'Tanggal bentrok dengan ' || INITCAP(v_bentrok.tipe) || ' ' || TO_CHAR(v_bentrok.tanggal_mulai, 'DD/MM/YYYY')
            || ' s/d ' || TO_CHAR(COALESCE(v_bentrok.tanggal_selesai, v_bentrok.tanggal_mulai), 'DD/MM/YYYY') || '.';
    END IF;

    SELECT "Id", ("TglMasuk" AT TIME ZONE 'Asia/Makassar')::DATE, COALESCE("SisaCuti", 12)
    INTO v_id, v_tgl_masuk, v_sisa
    FROM "karyawanTbl" WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcode)) LIMIT 1;

    IF p_tipe = 'OFF' AND p_jenis = 'OFF_PERIODE' THEN
        SELECT MAX("tanggal_selesai") + 1 INTO v_base
        FROM "pengajuan_ijin_lembur_tbl"
        WHERE UPPER(TRIM("qrcodeid")) = UPPER(TRIM(p_qrcode))
          AND "tipe" = 'OFF' AND "jenis_cuti" = 'OFF_PERIODE' AND "status" = 'APPROVED'
          AND (p_exclude_id IS NULL OR "id" <> p_exclude_id);
        IF v_base IS NULL THEN
            SELECT MAX("TanggalMulai") INTO v_base FROM "kontrakKaryawanTbl" WHERE "KaryawanID" = v_id;
        END IF;
        v_base := COALESCE(v_base, v_tgl_masuk);
        IF v_base IS NOT NULL THEN
            v_boleh_mulai := (v_base + INTERVAL '3 months')::DATE;
            IF p_mulai < v_boleh_mulai THEN
                RETURN 'Off Periode baru bisa diambil setelah 3 bulan kerja (dihitung dari ' || TO_CHAR(v_base, 'DD/MM/YYYY')
                    || '). Paling cepat mulai ' || TO_CHAR(v_boleh_mulai, 'DD/MM/YYYY') || '.';
            END IF;
        END IF;
    END IF;

    IF p_tipe = 'CUTI' AND UPPER(TRIM(COALESCE(p_jenis, ''))) = 'CUTI_TAHUNAN' AND v_sisa < (p_selesai - p_mulai + 1) THEN
        RETURN 'Sisa kuota cuti tahunan tidak mencukupi (Sisa: ' || v_sisa || ' hari, diminta: ' || (p_selesai - p_mulai + 1) || ' hari).';
    END IF;

    RETURN NULL;
END;
$function$;

-- ---------- 5. Submit Off (hak + validasi + peringatan jatah) ----------
CREATE OR REPLACE FUNCTION public.submit_pengajuan_off(
    p_qrcode text, p_jenis_off text, p_tgl_mulai date, p_tgl_selesai date, p_alasan text DEFAULT ''::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_jenis TEXT := UPPER(TRIM(COALESCE(p_jenis_off, '')));
    v_selesai DATE := p_tgl_selesai;
    v_id BIGINT; v_nama TEXT; v_kualifikasi TEXT; v_hari INT; v_new_id BIGINT;
    v_error TEXT;
    v_kuota JSONB;
    v_l1_id BIGINT; v_l2_id BIGINT; v_l3_id BIGINT;
    v_rec RECORD;
    v_total_levels INT := 1;
    v_l1_label TEXT := 'Direktur (Auto-Approve)'; v_l1_auto BOOLEAN := TRUE; v_l1_approver BIGINT := NULL;
    v_l2_label TEXT := NULL; v_l2_auto BOOLEAN := FALSE; v_l2_approver BIGINT := NULL;
    v_l3_label TEXT := NULL; v_l3_auto BOOLEAN := FALSE; v_l3_approver BIGINT := NULL;
BEGIN
    IF v_jenis NOT IN ('OFF_ROTASI', 'OFF_PERIODE') THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Jenis off tidak dikenal.');
    END IF;
    -- Hak off dari Pola Kerja kontrak aktif
    IF NOT COALESCE((get_hak_off(p_qrcode)->>CASE WHEN v_jenis = 'OFF_PERIODE' THEN 'offPeriode' ELSE 'offRotasi' END)::boolean, false) THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message',
            CASE WHEN v_jenis = 'OFF_PERIODE' THEN 'Off Periode' ELSE 'Off Rotasi' END
            || ' tidak berlaku untuk kontrak / Pola Kerja Anda. Hubungi HR kalau ini keliru.');
    END IF;
    IF p_tgl_mulai IS NULL THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Tanggal mulai off wajib diisi.');
    END IF;
    IF v_jenis = 'OFF_PERIODE' THEN
        v_selesai := p_tgl_mulai + 13;
    END IF;

    SELECT "Id", "NamaPersonnel", "Kualifikasi", "AuthorizedById"
    INTO v_id, v_nama, v_kualifikasi, v_l1_id
    FROM "karyawanTbl"
    WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcode)) LIMIT 1;
    IF v_id IS NULL THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Karyawan tidak ditemukan.');
    END IF;

    IF EXISTS (
        SELECT 1 FROM "pengajuan_ijin_lembur_tbl"
        WHERE UPPER(TRIM("qrcodeid")) = UPPER(TRIM(p_qrcode)) AND "tipe" = 'OFF'
          AND "status" NOT IN ('APPROVED', 'REJECTED')
    ) THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Anda masih memiliki pengajuan off yang sedang menunggu persetujuan.');
    END IF;

    v_error := validasi_tanggal_cuti_off(p_qrcode, 'OFF', v_jenis, p_tgl_mulai, v_selesai, NULL);
    IF v_error IS NOT NULL THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', v_error);
    END IF;
    v_hari := (v_selesai - p_tgl_mulai) + 1;

    -- Jatah Off Rotasi: dihitung sebelum insert, cuma jadi peringatan
    IF v_jenis = 'OFF_ROTASI' THEN
        v_kuota := off_rotasi_kuota_info(p_qrcode, p_tgl_mulai, v_selesai, NULL);
    END IF;

    IF v_l1_id IS NOT NULL THEN
        SELECT "Id", "NamaPersonnel", "Kualifikasi", "AuthorizedById" INTO v_rec
        FROM "karyawanTbl" WHERE "Id" = v_l1_id;

        v_l1_approver := v_rec."Id";
        v_l1_label := v_rec."NamaPersonnel" || ' (' || COALESCE(v_rec."Kualifikasi", '-') || ')';
        v_l1_auto := (v_rec."Kualifikasi" ILIKE 'Direktur%');
        v_total_levels := 1;

        IF NOT v_l1_auto AND v_rec."AuthorizedById" IS NOT NULL THEN
            v_l2_id := v_rec."AuthorizedById";
            SELECT "Id", "NamaPersonnel", "Kualifikasi", "AuthorizedById" INTO v_rec
            FROM "karyawanTbl" WHERE "Id" = v_l2_id;

            v_l2_approver := v_rec."Id";
            v_l2_label := v_rec."NamaPersonnel" || ' (' || COALESCE(v_rec."Kualifikasi", '-') || ')';
            v_l2_auto := (v_rec."Kualifikasi" ILIKE 'Direktur%');
            v_total_levels := 2;

            IF NOT v_l2_auto AND v_rec."AuthorizedById" IS NOT NULL THEN
                v_l3_id := v_rec."AuthorizedById";
                SELECT "Id", "NamaPersonnel", "Kualifikasi", "AuthorizedById" INTO v_rec
                FROM "karyawanTbl" WHERE "Id" = v_l3_id;

                v_l3_approver := v_rec."Id";
                v_l3_label := v_rec."NamaPersonnel" || ' (' || COALESCE(v_rec."Kualifikasi", '-') || ')';
                v_l3_auto := (v_rec."Kualifikasi" ILIKE 'Direktur%');
                v_total_levels := 3;
            END IF;
        END IF;
    END IF;

    INSERT INTO "pengajuan_ijin_lembur_tbl" (
        "qrcodeid", "nama_pemohon", "kualifikasi", "tipe", "tanggal",
        "tanggal_mulai", "tanggal_selesai", "jumlah_hari", "jenis_cuti",
        "alasan", "status", "total_levels", "current_level",
        "hrcheck_target_role",
        "level1_target_role", "level1_approver_id", "level1_is_auto",
        "level2_target_role", "level2_approver_id", "level2_is_auto",
        "level3_target_role", "level3_approver_id", "level3_is_auto"
    ) VALUES (
        UPPER(TRIM(p_qrcode)), v_nama, v_kualifikasi, 'OFF', p_tgl_mulai,
        p_tgl_mulai, v_selesai, v_hari, v_jenis,
        NULLIF(TRIM(COALESCE(p_alasan, '')), ''), 'PENDING_HR_CHECK', v_total_levels, 0,
        'HR Operations / HR Admin',
        v_l1_label, v_l1_approver, v_l1_auto,
        v_l2_label, v_l2_approver, v_l2_auto,
        v_l3_label, v_l3_approver, v_l3_auto
    ) RETURNING "id" INTO v_new_id;

    RETURN jsonb_build_object('status', 'SUCCESS',
        'message', 'Pengajuan ' || CASE WHEN v_jenis = 'OFF_PERIODE' THEN 'Off Periode' ELSE 'Off Rotasi' END
                   || ' (' || v_hari || ' hari, ' || TO_CHAR(p_tgl_mulai, 'DD/MM') || ' s/d ' || TO_CHAR(v_selesai, 'DD/MM/YYYY')
                   || ') berhasil dikirim. Menunggu cek HR Admin sebelum lanjut ke approval.'
                   || COALESCE(' ⚠️ ' || (v_kuota->>'peringatan') || '. Approver akan melihat peringatan ini.', ''),
        'id', v_new_id, 'jumlahHari', v_hari, 'tanggalSelesai', v_selesai, 'total_levels', v_total_levels,
        'peringatanKuota', v_kuota->>'peringatan');
END;
$function$;

-- ---------- 6. Approver ubah tanggal Cuti/Off ----------
CREATE OR REPLACE FUNCTION public.ubah_tanggal_pengajuan(
    p_request_id bigint, p_user_qrcode text, p_tgl_mulai date, p_tgl_selesai date, p_catatan text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_req RECORD;
    v_my_id BIGINT; v_author TEXT; v_kualifikasi TEXT; v_nama TEXT;
    v_boleh BOOLEAN;
    v_selesai DATE := p_tgl_selesai;
    v_error TEXT;
    v_kuota JSONB;
BEGIN
    SELECT * INTO v_req FROM pengajuan_ijin_lembur_tbl WHERE id = p_request_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Pengajuan tidak ditemukan.');
    END IF;
    IF v_req.tipe NOT IN ('CUTI', 'OFF') THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Ubah tanggal cuma untuk pengajuan Cuti dan Off.');
    END IF;
    IF v_req.status IN ('APPROVED', 'REJECTED') THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Pengajuan sudah selesai diproses, tanggal tidak bisa diubah.');
    END IF;
    IF NULLIF(TRIM(COALESCE(p_catatan, '')), '') IS NULL THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Catatan alasan perubahan tanggal wajib diisi.');
    END IF;

    -- Cuma approver yang sedang memegang pengajuan ini (sama dengan antrean approval)
    SELECT "Id", TRIM("Author"), TRIM("Kualifikasi"), TRIM("NamaPersonnel")
    INTO v_my_id, v_author, v_kualifikasi, v_nama
    FROM "karyawanTbl" WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_user_qrcode)) LIMIT 1;
    v_boleh := v_my_id IS NOT NULL AND (
        (v_req.current_level = 0 AND UPPER(v_req.hrcheck_target_role) IN (UPPER(COALESCE(v_author, '')), UPPER(COALESCE(v_kualifikasi, '')), UPPER(COALESCE(v_nama, ''))))
        OR (v_req.current_level = 1 AND v_req.level1_approver_id = v_my_id)
        OR (v_req.current_level = 2 AND v_req.level2_approver_id = v_my_id)
        OR (v_req.current_level = 3 AND v_req.level3_approver_id = v_my_id));
    IF NOT v_boleh THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Anda bukan approver pengajuan ini di tahap sekarang.');
    END IF;

    IF p_tgl_mulai IS NULL THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Tanggal mulai wajib diisi.');
    END IF;
    IF v_req.tipe = 'OFF' AND v_req.jenis_cuti = 'OFF_PERIODE' THEN
        v_selesai := p_tgl_mulai + 13;
    END IF;

    v_error := validasi_tanggal_cuti_off(v_req.qrcodeid, v_req.tipe, v_req.jenis_cuti, p_tgl_mulai, v_selesai, v_req.id);
    IF v_error IS NOT NULL THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', v_error);
    END IF;

    UPDATE pengajuan_ijin_lembur_tbl SET
        tanggal_mulai_awal = COALESCE(tanggal_mulai_awal, tanggal_mulai),
        tanggal_selesai_awal = COALESCE(tanggal_selesai_awal, tanggal_selesai),
        tanggal = p_tgl_mulai,
        tanggal_mulai = p_tgl_mulai,
        tanggal_selesai = v_selesai,
        jumlah_hari = (v_selesai - p_tgl_mulai) + 1,
        tanggal_diubah_oleh = COALESCE(v_nama, p_user_qrcode) || CASE WHEN v_req.current_level = 0 THEN ' (Cek HR)' ELSE ' (Level ' || v_req.current_level || ')' END,
        tanggal_diubah_at = NOW(),
        tanggal_diubah_catatan = TRIM(p_catatan),
        updated_at = NOW()
    WHERE id = v_req.id;

    IF v_req.tipe = 'OFF' AND v_req.jenis_cuti = 'OFF_ROTASI' THEN
        v_kuota := off_rotasi_kuota_info(v_req.qrcodeid, p_tgl_mulai, v_selesai, v_req.id);
    END IF;

    RETURN jsonb_build_object('status', 'SUCCESS',
        'message', 'Tanggal diubah jadi ' || TO_CHAR(p_tgl_mulai, 'DD/MM/YYYY') || ' s/d ' || TO_CHAR(v_selesai, 'DD/MM/YYYY')
                   || ' (' || ((v_selesai - p_tgl_mulai) + 1) || ' hari). Lanjutkan approval seperti biasa.'
                   || COALESCE(' ⚠️ ' || (v_kuota->>'peringatan') || '.', ''));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.off_rotasi_kuota_info(text, date, date, bigint) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ubah_tanggal_pengajuan(bigint, text, date, date, text) TO anon, authenticated, service_role;

-- ---------- 7. Antrean approval: peringatan jatah + jejak perubahan tanggal ----------
DROP FUNCTION IF EXISTS public.get_pending_ijin_lembur_approvals_by_qrcode(text);
CREATE OR REPLACE FUNCTION public.get_pending_ijin_lembur_approvals_by_qrcode(p_qrcode text)
 RETURNS TABLE(id bigint, qrcodeid text, nama_pemohon text, kualifikasi text, tipe text, tanggal date, alasan text, durasi_jam numeric, lokasi text, status text, total_levels integer, current_level integer, required_action text, created_at timestamp with time zone, kategori_ijin text,
               jenis_cuti text, tanggal_mulai date, tanggal_selesai date, jumlah_hari integer,
               peringatan_kuota text, tanggal_mulai_awal date, tanggal_selesai_awal date, tanggal_diubah_oleh text, tanggal_diubah_catatan text)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_author TEXT;
    v_kualifikasi TEXT;
    v_nama TEXT;
    v_my_id BIGINT;
BEGIN
    SELECT "Id", TRIM("Author"), TRIM("Kualifikasi"), TRIM("NamaPersonnel")
    INTO v_my_id, v_author, v_kualifikasi, v_nama
    FROM "karyawanTbl"
    WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcode))
    LIMIT 1;

    RETURN QUERY
    SELECT
        p.id, p.qrcodeid, p.nama_pemohon, p.kualifikasi, p.tipe, p.tanggal, p.alasan, p.durasi_jam, p.lokasi,
        p.status, p.total_levels, p.current_level,
        CASE
            WHEN p.current_level = 0 THEN 'HR_CHECK'
            WHEN p.current_level = p.total_levels THEN 'APPROVE'
            WHEN p.current_level = 1 THEN 'PROPOSE'
            WHEN p.current_level = 2 THEN 'REVIEW'
            ELSE 'APPROVE'
        END AS required_action,
        p.created_at,
        p.kategori_ijin,
        CASE WHEN p.tipe IN ('CUTI', 'OFF') THEN p.jenis_cuti END,
        p.tanggal_mulai, p.tanggal_selesai, p.jumlah_hari,
        CASE WHEN p.tipe = 'OFF' AND p.jenis_cuti = 'OFF_ROTASI'
             THEN off_rotasi_kuota_info(p.qrcodeid, p.tanggal_mulai, p.tanggal_selesai, p.id)->>'peringatan' END,
        p.tanggal_mulai_awal, p.tanggal_selesai_awal, p.tanggal_diubah_oleh, p.tanggal_diubah_catatan
    FROM pengajuan_ijin_lembur_tbl p
    WHERE p.status NOT IN ('APPROVED', 'REJECTED')
      AND (
        (p.current_level = 0 AND (
            UPPER(p.hrcheck_target_role) = UPPER(COALESCE(v_author, '')) OR
            UPPER(p.hrcheck_target_role) = UPPER(COALESCE(v_kualifikasi, '')) OR
            UPPER(p.hrcheck_target_role) = UPPER(COALESCE(v_nama, ''))
        ))
        OR (p.current_level = 1 AND v_my_id IS NOT NULL AND p.level1_approver_id = v_my_id)
        OR (p.current_level = 2 AND v_my_id IS NOT NULL AND p.level2_approver_id = v_my_id)
        OR (p.current_level = 3 AND v_my_id IS NOT NULL AND p.level3_approver_id = v_my_id)
      )
    ORDER BY p.id DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_pending_ijin_lembur_approvals_by_qrcode(text) TO anon, authenticated, service_role;

-- ---------- 8. RPC Pola Kerja: simpan jatah Off Rotasi ----------
DROP FUNCTION IF EXISTS public.update_pola_kerja(bigint, numeric, numeric, numeric, boolean, boolean, text, numeric, text, numeric, boolean, boolean);
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
    p_boleh_off_periode boolean DEFAULT NULL,
    p_kuota_off_rotasi integer DEFAULT NULL
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
        "KuotaOffRotasiBulan" = p_kuota_off_rotasi,
        "Keterangan" = COALESCE(p_keterangan, "Keterangan")
    WHERE "Id" = p_id;
    RETURN jsonb_build_object('status', 'SUCCESS');
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('status', 'ERROR', 'message', SQLERRM);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.update_pola_kerja(bigint, numeric, numeric, numeric, boolean, boolean, text, numeric, text, numeric, boolean, boolean, integer) TO anon, authenticated, service_role;
