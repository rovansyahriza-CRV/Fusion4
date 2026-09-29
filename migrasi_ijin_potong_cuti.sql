-- =====================================================================================
-- Ijin memotong hak cuti 1 hari penuh, kecuali ijin yang jadi hak karyawan sesuai UU.
--
-- - Kolom baru pengajuan_ijin_lembur_tbl.kategori_ijin (khusus tipe IJIN).
-- - Saat ijin APPROVED final: kategori PRIBADI -> SisaCuti dikurangi 1 (min 0).
--   Kategori hak UU (UU 13/2003 Pasal 93 ayat 2 & 4, tetap berlaku setelah UU Cipta Kerja)
--   tidak memotong cuti:
--     SAKIT             sakit dengan surat dokter (termasuk haid hari 1-2 yang sakit)
--     NIKAH             karyawan menikah
--     NIKAHKAN_ANAK     menikahkan anak
--     KHITAN_BAPTIS     mengkhitankan / membaptiskan anak
--     ISTRI_MELAHIRKAN  istri melahirkan atau keguguran
--     DUKA_INTI         suami/istri, orang tua/mertua, anak/menantu meninggal
--     DUKA_SERUMAH      anggota keluarga dalam satu rumah meninggal
--     KEWAJIBAN_NEGARA  menjalankan kewajiban terhadap negara
--     IBADAH            menjalankan ibadah yang diperintahkan agama
-- - Ijin yang sudah APPROVED sebelum migrasi ini tidak dipotong mundur.
-- =====================================================================================

ALTER TABLE pengajuan_ijin_lembur_tbl
    ADD COLUMN IF NOT EXISTS kategori_ijin TEXT;

DO $$ BEGIN
    ALTER TABLE pengajuan_ijin_lembur_tbl ADD CONSTRAINT pengajuan_kategori_ijin_chk CHECK (
        kategori_ijin IS NULL OR kategori_ijin IN ('PRIBADI', 'SAKIT', 'NIKAH', 'NIKAHKAN_ANAK', 'KHITAN_BAPTIS',
            'ISTRI_MELAHIRKAN', 'DUKA_INTI', 'DUKA_SERUMAH', 'KEWAJIBAN_NEGARA', 'IBADAH'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Submit: terima kategori ijin ----------
DROP FUNCTION IF EXISTS public.submit_pengajuan_ijin_lembur(text, text, date, text, numeric, text, text);
CREATE OR REPLACE FUNCTION public.submit_pengajuan_ijin_lembur(
    p_pemohon_qrcode text, p_tipe text, p_tanggal date, p_alasan text,
    p_durasi_jam numeric DEFAULT 0, p_lokasi text DEFAULT ''::text, p_jenis_hari text DEFAULT 'HARI_KERJA'::text,
    p_kategori_ijin text DEFAULT 'PRIBADI'::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_nama TEXT;
    v_kualifikasi TEXT;
    v_l1_id BIGINT; v_l2_id BIGINT; v_l3_id BIGINT;
    v_rec RECORD;
    v_total_levels INT := 1;
    v_l1_label TEXT := 'Direktur (Auto-Approve)'; v_l1_auto BOOLEAN := TRUE; v_l1_approver BIGINT := NULL;
    v_l2_label TEXT := NULL; v_l2_auto BOOLEAN := FALSE; v_l2_approver BIGINT := NULL;
    v_l3_label TEXT := NULL; v_l3_auto BOOLEAN := FALSE; v_l3_approver BIGINT := NULL;
    v_new_id BIGINT;
    v_kategori_ijin TEXT := CASE WHEN UPPER(TRIM(p_tipe)) = 'IJIN'
                                 THEN COALESCE(NULLIF(UPPER(TRIM(p_kategori_ijin)), ''), 'PRIBADI') END;
BEGIN
    SELECT "NamaPersonnel", "Kualifikasi", "AuthorizedById"
    INTO v_nama, v_kualifikasi, v_l1_id
    FROM "karyawanTbl"
    WHERE UPPER(TRIM("QrCodeId")) = UPPER(TRIM(p_pemohon_qrcode))
    LIMIT 1;

    IF v_nama IS NULL THEN
        RETURN jsonb_build_object('status', 'ERROR', 'message', 'Data karyawan tidak ditemukan.');
    END IF;

    -- Rantai approval sekarang dibangun langsung dari kolom AuthorizedById (FK ke ID
    -- karyawan lain), bukan cocokin teks Kualifikasi/Author lagi. Kalau ketemu approver
    -- yang Kualifikasi-nya "Direktur..." (Direktur Utama/Direktur Operasional), level itu
    -- otomatis di-approve sistem tanpa perlu klik manual, sama seperti perilaku lama.
    -- Kalau AuthorizedById kosong dari awal (requester gak ada atasan yang diset), berarti
    -- pengajuan otomatis lolos semua (level 1 = auto, gak ada approval manusia sama sekali).
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
                v_total_levels := 3; -- capped di 3 level, sama seperti desain lama
            END IF;
        END IF;
    END IF;

    -- Setiap pengajuan (apapun rantai approval-nya) wajib dicek dulu oleh HR Admin
    -- (Kualifikasi/Author = "HR Operations / HR Admin") sebelum lanjut ke Level 1.
    -- current_level = 0 menandakan "menunggu cek HR Admin".
    INSERT INTO pengajuan_ijin_lembur_tbl (
        qrcodeid, nama_pemohon, kualifikasi, tipe, tanggal, alasan, durasi_jam, lokasi, jenis_hari, kategori_ijin,
        status, total_levels, current_level,
        hrcheck_target_role,
        level1_target_role, level1_approver_id, level1_is_auto,
        level2_target_role, level2_approver_id, level2_is_auto,
        level3_target_role, level3_approver_id, level3_is_auto
    ) VALUES (
        UPPER(TRIM(p_pemohon_qrcode)), v_nama, v_kualifikasi, UPPER(TRIM(p_tipe)), p_tanggal, p_alasan, p_durasi_jam, p_lokasi, p_jenis_hari, v_kategori_ijin,
        'PENDING_HR_CHECK', v_total_levels, 0,
        'HR Operations / HR Admin',
        v_l1_label, v_l1_approver, v_l1_auto,
        v_l2_label, v_l2_approver, v_l2_auto,
        v_l3_label, v_l3_approver, v_l3_auto
    ) RETURNING id INTO v_new_id;

    RETURN jsonb_build_object(
        'status', 'SUCCESS',
        'message', 'Pengajuan ' || p_tipe || ' berhasil dibuat. Menunggu cek HR Admin sebelum lanjut ke approval Level 1.'
                   || CASE WHEN v_kategori_ijin = 'PRIBADI' THEN ' Ijin pribadi memotong 1 hari hak cuti setelah disetujui.' ELSE '' END,
        'id', v_new_id,
        'total_levels', v_total_levels,
        'level1_target', v_l1_label,
        'level2_target', v_l2_label,
        'level3_target', v_l3_label
    );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.submit_pengajuan_ijin_lembur(text, text, date, text, numeric, text, text, text) TO anon, authenticated, service_role;

-- ---------- Approval final: ijin pribadi potong 1 hari cuti ----------
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
    END IF;

    -- LEMBUR sengaja tidak menyentuh absensiTbl -- karyawan tetap masuk kerja normal,
    -- jadi status attendance hari itu tidak boleh ketimpa jadi "LEMBUR".
END;
$function$;

-- ---------- Antrean approval: ikut kirim kategori_ijin (biar HR/atasan bisa verifikasi) ----------
DROP FUNCTION IF EXISTS public.get_pending_ijin_lembur_approvals_by_qrcode(text);
CREATE OR REPLACE FUNCTION public.get_pending_ijin_lembur_approvals_by_qrcode(p_qrcode text)
 RETURNS TABLE(id bigint, qrcodeid text, nama_pemohon text, kualifikasi text, tipe text, tanggal date, alasan text, durasi_jam numeric, lokasi text, status text, total_levels integer, current_level integer, required_action text, created_at timestamp with time zone, kategori_ijin text)
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
        p.id,
        p.qrcodeid,
        p.nama_pemohon,
        p.kualifikasi,
        p.tipe,
        p.tanggal,
        p.alasan,
        p.durasi_jam,
        p.lokasi,
        p.status,
        p.total_levels,
        p.current_level,
        CASE
            WHEN p.current_level = 0 THEN 'HR_CHECK'
            WHEN p.current_level = p.total_levels THEN 'APPROVE'
            WHEN p.current_level = 1 THEN 'PROPOSE'
            WHEN p.current_level = 2 THEN 'REVIEW'
            ELSE 'APPROVE'
        END AS required_action,
        p.created_at,
        p.kategori_ijin
    FROM pengajuan_ijin_lembur_tbl p
    WHERE p.status NOT IN ('APPROVED', 'REJECTED')
      AND (
        -- Cek HR Admin (level 0) tetap dicocokkan berdasarkan Kualifikasi/Author/Nama
        -- (role "HR Operations / HR Admin" -- ini gerbang berbasis JABATAN, bukan
        -- rantai personal AuthorizedBy, jadi tetap seperti semula).
        (p.current_level = 0 AND (
            UPPER(p.hrcheck_target_role) = UPPER(COALESCE(v_author, '')) OR
            UPPER(p.hrcheck_target_role) = UPPER(COALESCE(v_kualifikasi, '')) OR
            UPPER(p.hrcheck_target_role) = UPPER(COALESCE(v_nama, ''))
        ))
        OR
        -- Level 1/2/3 sekarang dicocokkan langsung ke ID karyawan (levelN_approver_id),
        -- bukan lagi cocokin teks jabatan -- ini yang bikin rantai approval anti-typo.
        (p.current_level = 1 AND v_my_id IS NOT NULL AND p.level1_approver_id = v_my_id)
        OR
        (p.current_level = 2 AND v_my_id IS NOT NULL AND p.level2_approver_id = v_my_id)
        OR
        (p.current_level = 3 AND v_my_id IS NOT NULL AND p.level3_approver_id = v_my_id)
      )
    ORDER BY p.id DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_pending_ijin_lembur_approvals_by_qrcode(text) TO anon, authenticated, service_role;
