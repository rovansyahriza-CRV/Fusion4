-- =====================================================================================
-- Pengajuan OFF (Off Rotasi & Off Periode 2 minggu) lewat Digital Badge.
--
-- Alur sama dengan Cuti: karyawan ajukan -> Cek HR Admin -> Level 1..3 (AuthorizedById,
-- Direktur auto-approve) -> APPROVED. Disimpan di pengajuan_ijin_lembur_tbl dengan
-- tipe = 'OFF' dan jenis di kolom jenis_cuti ('OFF_ROTASI' / 'OFF_PERIODE').
--
-- Aturan:
-- - OFF_ROTASI  : rentang bebas, keputusan di approver.
-- - OFF_PERIODE : dikunci 14 hari, baru boleh setelah >= 3 bulan kerja sejak Off Periode
--                 terakhir (atau sejak mulai kontrak terbaru / TglMasuk kalau belum pernah).
-- - Tidak boleh bentrok dengan Cuti/Off yang pending atau sudah disetujui.
-- - Tidak memotong saldo cuti.
--
-- Setelah APPROVED:
-- - absensiTbl diisi Status 'OFF' per tanggal (tampil di Monitoring), tanpa menimpa hari
--   yang sudah ada scan asli.
-- - cek_jenis_hari() menganggap tanggal itu HARI_OFF -> timesheet "LIBUR (Off ...)",
--   dan kalau dipanggil masuk, lemburnya dihitung tarif hari OFF.
-- - Scan absen di hari off tetap bisa (baris penanda OFF dibuang saat scan pertama).
-- - Lembur dari Digital Badge sekarang deteksi jenis hari otomatis (sebelumnya selalu
--   HARI_KERJA).
-- =====================================================================================

-- ---------- 1. Submit pengajuan OFF ----------
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
    v_id BIGINT; v_nama TEXT; v_kualifikasi TEXT; v_tgl_masuk DATE; v_hari INT; v_new_id BIGINT;
    v_base DATE; v_boleh_mulai DATE;
    v_bentrok RECORD;
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
    IF p_tgl_mulai IS NULL THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Tanggal mulai off wajib diisi.');
    END IF;
    -- Off Periode dikunci 14 hari
    IF v_jenis = 'OFF_PERIODE' THEN
        v_selesai := p_tgl_mulai + 13;
    END IF;
    IF v_selesai IS NULL OR v_selesai < p_tgl_mulai THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Tanggal selesai tidak boleh lebih awal dari tanggal mulai.');
    END IF;
    v_hari := (v_selesai - p_tgl_mulai) + 1;

    SELECT "Id", "NamaPersonnel", "Kualifikasi", "AuthorizedById", ("TglMasuk" AT TIME ZONE 'Asia/Makassar')::DATE
    INTO v_id, v_nama, v_kualifikasi, v_l1_id, v_tgl_masuk
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

    -- Bentrok dengan Cuti/Off yang pending atau sudah disetujui
    SELECT "tipe", "tanggal_mulai", "tanggal_selesai" INTO v_bentrok
    FROM "pengajuan_ijin_lembur_tbl"
    WHERE UPPER(TRIM("qrcodeid")) = UPPER(TRIM(p_qrcode))
      AND "tipe" IN ('CUTI', 'OFF')
      AND "status" <> 'REJECTED'
      AND "tanggal_mulai" <= v_selesai
      AND COALESCE("tanggal_selesai", "tanggal_mulai") >= p_tgl_mulai
    LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message',
            'Tanggal bentrok dengan ' || INITCAP(v_bentrok.tipe) || ' ' || TO_CHAR(v_bentrok.tanggal_mulai, 'DD/MM/YYYY')
            || ' s/d ' || TO_CHAR(COALESCE(v_bentrok.tanggal_selesai, v_bentrok.tanggal_mulai), 'DD/MM/YYYY') || '.');
    END IF;

    -- Off Periode: minimal 3 bulan kerja sejak Off Periode terakhir / mulai kontrak / TglMasuk
    IF v_jenis = 'OFF_PERIODE' THEN
        SELECT MAX("tanggal_selesai") + 1 INTO v_base
        FROM "pengajuan_ijin_lembur_tbl"
        WHERE UPPER(TRIM("qrcodeid")) = UPPER(TRIM(p_qrcode))
          AND "tipe" = 'OFF' AND "jenis_cuti" = 'OFF_PERIODE' AND "status" = 'APPROVED';
        IF v_base IS NULL THEN
            SELECT MAX("TanggalMulai") INTO v_base FROM "kontrakKaryawanTbl" WHERE "KaryawanID" = v_id;
        END IF;
        v_base := COALESCE(v_base, v_tgl_masuk);
        IF v_base IS NOT NULL THEN
            v_boleh_mulai := (v_base + INTERVAL '3 months')::DATE;
            IF p_tgl_mulai < v_boleh_mulai THEN
                RETURN jsonb_build_object('status', 'ERROR', 'message',
                    'Off Periode baru bisa diambil setelah 3 bulan kerja (dihitung dari ' || TO_CHAR(v_base, 'DD/MM/YYYY')
                    || '). Paling cepat mulai ' || TO_CHAR(v_boleh_mulai, 'DD/MM/YYYY') || '.');
            END IF;
        END IF;
    END IF;

    -- Rantai approval berbasis ID (AuthorizedById), sama dengan Cuti.
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
                   || ') berhasil dikirim. Menunggu cek HR Admin sebelum lanjut ke approval.',
        'id', v_new_id, 'jumlahHari', v_hari, 'tanggalSelesai', v_selesai, 'total_levels', v_total_levels);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.submit_pengajuan_off(text, text, date, date, text) TO anon, authenticated, service_role;

-- ---------- 2. Approval final: tandai absensi OFF ----------
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
        -- Ijin pribadi = potong 1 hari hak cuti. Ijin hak UU (kategori lain) tidak dipotong.
        -- Ijin lama (sebelum ada kategori) kategori_ijin-nya NULL, tidak dipotong.
        IF v_req.kategori_ijin = 'PRIBADI' THEN
            UPDATE "karyawanTbl"
            SET "SisaCuti" = GREATEST(0, COALESCE("SisaCuti", 12) - 1)
            WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(v_req.qrcodeid));
        END IF;

        INSERT INTO "absensiTbl" ("Tanggal", "QrCodeId", "LokasiMasuk1", "Status")
        VALUES (v_req.tanggal, UPPER(TRIM(v_req.qrcodeid)), NULLIF(v_req.lokasi, ''), 'IJIN')
        ON CONFLICT ("Tanggal", "QrCodeId") DO UPDATE SET "Status" = EXCLUDED."Status";

    ELSIF v_req.tipe = 'OFF' THEN
        -- Penanda OFF per tanggal (tampil di Monitoring). Hari yang sudah ada scan asli
        -- tidak ditimpa. Saldo cuti tidak dipotong.
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

    -- LEMBUR sengaja tidak menyentuh absensiTbl -- karyawan tetap masuk kerja normal,
    -- jadi status attendance hari itu tidak boleh ketimpa jadi "LEMBUR".
END;
$function$;

-- ---------- 3. Jenis hari: tanggal Off yang disetujui = HARI_OFF ----------
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
    v_off_jenis TEXT;
BEGIN
    v_dow := EXTRACT(DOW FROM p_tanggal);

    IF p_qrcode IS NOT NULL THEN
        -- Off yang sudah disetujui (Off Rotasi / Off Periode) selalu hari OFF
        SELECT "jenis_cuti" INTO v_off_jenis
        FROM "pengajuan_ijin_lembur_tbl"
        WHERE UPPER(TRIM("qrcodeid")) = UPPER(TRIM(p_qrcode))
          AND "tipe" = 'OFF' AND "status" = 'APPROVED'
          AND p_tanggal BETWEEN "tanggal_mulai" AND "tanggal_selesai"
        ORDER BY "id" DESC
        LIMIT 1;
        IF v_off_jenis IS NOT NULL THEN
            RETURN jsonb_build_object('jenis_hari', 'HARI_OFF',
                'alasan', CASE WHEN v_off_jenis = 'OFF_PERIODE' THEN 'Off Periode (disetujui)' ELSE 'Off Rotasi (disetujui)' END);
        END IF;

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

-- ---------- 4. Scan absen di hari Off (dipanggil masuk) ----------
-- Baris penanda OFF (tanpa scan) dibuang dulu, jadi scan pertama diproses seperti hari
-- baru (termasuk jalur Security). Jenis hari tetap OFF lewat cek_jenis_hari().
DO $$
DECLARE target regprocedure; definition text;
BEGIN
    target := 'public.submit_absensi(text,text,text,timestamptz)'::regprocedure;
    definition := pg_get_functiondef(target);
    IF position('Baris penanda OFF' in definition) = 0 THEN
        IF position('-- SKENARIO KHUSUS: KARYAWAN KUALIFIKASI' in definition) = 0 THEN
            RAISE EXCEPTION 'Definisi submit_absensi tidak sesuai perkiraan; tidak ada perubahan.';
        END IF;
        definition := replace(definition, '-- SKENARIO KHUSUS: KARYAWAN KUALIFIKASI',
'-- Baris penanda OFF (hasil approval Off, belum ada scan): buang supaya scan pertama
    -- dicatat seperti hari baru. Jenis hari tetap OFF lewat cek_jenis_hari().
    IF v_absen."Id" IS NOT NULL AND v_absen."Status" = ''OFF''
       AND v_absen."JamMasuk1" IS NULL AND v_absen."JamIstirahat" IS NULL
       AND v_absen."JamMasuk2" IS NULL AND v_absen."JamPulang" IS NULL THEN
        DELETE FROM "absensiTbl" WHERE "Id" = v_absen."Id";
        SELECT * INTO v_absen
        FROM "absensiTbl"
        WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_qrcodeid))
          AND "Tanggal" = v_today
        ORDER BY "Id" DESC
        LIMIT 1;
    END IF;

    -- SKENARIO KHUSUS: KARYAWAN KUALIFIKASI');
        EXECUTE definition;
    END IF;
END $$;

-- ---------- 5. Lembur dari Digital Badge: jenis hari otomatis ----------
-- Badge kirim p_jenis_hari = NULL -> server tentukan dari cek_jenis_hari() (hari Off
-- yang disetujui ikut kebaca HARI_OFF). Form admin tetap kirim pilihan eksplisit.
DO $$
DECLARE target regprocedure; definition text;
BEGIN
    target := 'public.submit_pengajuan_ijin_lembur(text,text,date,text,numeric,text,text,text)'::regprocedure;
    definition := pg_get_functiondef(target);
    IF position('cek_jenis_hari(p_tanggal, p_pemohon_qrcode)' in definition) = 0 THEN
        IF position('p_lokasi, p_jenis_hari, v_kategori_ijin' in definition) = 0 THEN
            RAISE EXCEPTION 'Definisi submit_pengajuan_ijin_lembur tidak sesuai perkiraan; tidak ada perubahan.';
        END IF;
        definition := replace(definition, 'p_lokasi, p_jenis_hari, v_kategori_ijin',
            'p_lokasi, COALESCE(p_jenis_hari, CASE WHEN UPPER(TRIM(p_tipe)) = ''LEMBUR'' THEN cek_jenis_hari(p_tanggal, p_pemohon_qrcode)->>''jenis_hari'' END, ''HARI_KERJA''), v_kategori_ijin');
        EXECUTE definition;
    END IF;
END $$;

-- ---------- 6. Antrean approval: ikut kirim jenis & rentang tanggal ----------
-- (dipakai kartu approval Cuti/Off di Digital Badge & SmartGate; sebelumnya jumlah hari
-- Cuti selalu tampil "1 Hari" karena kolom ini tidak ikut dikirim)
DROP FUNCTION IF EXISTS public.get_pending_ijin_lembur_approvals_by_qrcode(text);
CREATE OR REPLACE FUNCTION public.get_pending_ijin_lembur_approvals_by_qrcode(p_qrcode text)
 RETURNS TABLE(id bigint, qrcodeid text, nama_pemohon text, kualifikasi text, tipe text, tanggal date, alasan text, durasi_jam numeric, lokasi text, status text, total_levels integer, current_level integer, required_action text, created_at timestamp with time zone, kategori_ijin text,
               jenis_cuti text, tanggal_mulai date, tanggal_selesai date, jumlah_hari integer)
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
        p.tanggal_mulai, p.tanggal_selesai, p.jumlah_hari
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
