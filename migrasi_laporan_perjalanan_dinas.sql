-- =====================================================================
-- Laporan PDF Perjalanan Dinas + QR tanda tangan approval
-- =====================================================================
-- 1. laporan_perjalanan_dinas(p_token, p_id): data laporan PD yang sudah APPROVED.
--    Boleh dibaca: pemohon, approver yang ditunjuk pada pengajuan itu, atau PIC OIL / ALL.
--    Penandatangan = pemohon (P), approver level 1-3 (1/2/3), verifikasi HR (H).
-- 2. verifikasi_perjalanan_dinas(p_kode, p_ttd): tambah parameter opsional p_ttd
--    (kode penandatangan dari QR) -> mengembalikan 'penandatangan' (nama, jabatan, waktu).
-- =====================================================================

DROP FUNCTION IF EXISTS public.verifikasi_perjalanan_dinas(text);

CREATE OR REPLACE FUNCTION public.pd_penandatangan(p_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT COALESCE(jsonb_agg(x ORDER BY ord), '[]'::jsonb) FROM (
        SELECT 0 AS ord, jsonb_build_object('kode', 'P', 'peran', 'Diajukan oleh', 'nama', p.nama_pemohon,
               'jabatan', p.kualifikasi, 'waktu', p.created_at, 'otomatis', false) AS x
          FROM public.pengajuan_ijin_lembur_tbl p WHERE p.id = p_id
        UNION ALL
        SELECT 1, jsonb_build_object('kode', '1', 'peran', 'Disetujui Level 1', 'nama', p.level1_by,
               'jabatan', p.level1_target_role, 'waktu', p.level1_at, 'otomatis', COALESCE(p.level1_is_auto, false))
          FROM public.pengajuan_ijin_lembur_tbl p WHERE p.id = p_id AND p.level1_by IS NOT NULL AND p.level1_action IS DISTINCT FROM 'REJECTED'
        UNION ALL
        SELECT 2, jsonb_build_object('kode', '2', 'peran', 'Disetujui Level 2', 'nama', p.level2_by,
               'jabatan', p.level2_target_role, 'waktu', p.level2_at, 'otomatis', COALESCE(p.level2_is_auto, false))
          FROM public.pengajuan_ijin_lembur_tbl p WHERE p.id = p_id AND p.level2_by IS NOT NULL AND p.level2_action IS DISTINCT FROM 'REJECTED'
        UNION ALL
        SELECT 3, jsonb_build_object('kode', '3', 'peran', 'Disetujui Level 3', 'nama', p.level3_by,
               'jabatan', p.level3_target_role, 'waktu', p.level3_at, 'otomatis', COALESCE(p.level3_is_auto, false))
          FROM public.pengajuan_ijin_lembur_tbl p WHERE p.id = p_id AND p.level3_by IS NOT NULL AND p.level3_action IS DISTINCT FROM 'REJECTED'
        UNION ALL
        SELECT 4, jsonb_build_object('kode', 'H', 'peran', 'Verifikasi HR', 'nama', p.hrcheck_by,
               'jabatan', p.hrcheck_target_role, 'waktu', p.hrcheck_at, 'otomatis', false)
          FROM public.pengajuan_ijin_lembur_tbl p WHERE p.id = p_id AND p.hrcheck_by IS NOT NULL
    ) s;
$$;
REVOKE ALL ON FUNCTION public.pd_penandatangan(bigint) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.laporan_perjalanan_dinas(p_token text, p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_emp bigint := operational.badge_sesi(p_token);
    v_qr  text;
    r     record;
    v_ok  boolean := false;
BEGIN
    IF v_emp IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED');
    END IF;
    SELECT UPPER(btrim("QrCodeId")) INTO v_qr FROM public."karyawanTbl" WHERE "Id" = v_emp;

    SELECT p.*, d.tujuan, d.transportasi, d.jarak_km, d.grade, d.uang_harian, d.uang_penginapan,
           d.estimasi_biaya, d.kode_verifikasi
      INTO r
      FROM public.pengajuan_ijin_lembur_tbl p
      JOIN public.perjalanan_dinas_detail d ON d.pengajuan_id = p.id
     WHERE p.id = p_id AND p.tipe = 'PERJALANAN_DINAS';
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'Perjalanan dinas tidak ditemukan.');
    END IF;

    v_ok := UPPER(btrim(r.qrcodeid)) = v_qr
         OR r.level1_approver_id = v_emp OR r.level2_approver_id = v_emp OR r.level3_approver_id = v_emp
         OR COALESCE(public.can_buat_gangguan(v_qr), false);
    IF NOT v_ok THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Anda tidak berhak melihat laporan ini.');
    END IF;
    IF r.status <> 'APPROVED' OR r.kode_verifikasi IS NULL THEN
        RETURN jsonb_build_object('status', 'NOT_APPROVED', 'message', 'Laporan hanya tersedia setelah perjalanan dinas disetujui.');
    END IF;

    RETURN jsonb_build_object('status', 'OK', 'data', jsonb_build_object(
        'id', r.id, 'kode', r.kode_verifikasi,
        'nama', r.nama_pemohon, 'qrCodeId', r.qrcodeid, 'kualifikasi', r.kualifikasi, 'grade', r.grade,
        'tujuan', r.tujuan, 'keperluan', r.alasan, 'transportasi', r.transportasi, 'jarakKm', r.jarak_km,
        'tanggalMulai', r.tanggal_mulai, 'tanggalSelesai', r.tanggal_selesai, 'jumlahHari', r.jumlah_hari,
        'uangHarian', r.uang_harian, 'uangPenginapan', r.uang_penginapan, 'estimasiBiaya', r.estimasi_biaya,
        'diajukanPada', r.created_at,
        'penandatangan', public.pd_penandatangan(r.id)
    ));
END;
$$;
REVOKE ALL ON FUNCTION public.laporan_perjalanan_dinas(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.laporan_perjalanan_dinas(text, bigint) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- verifikasi_perjalanan_dinas: tambah p_ttd (kode penandatangan dari QR laporan)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verifikasi_perjalanan_dinas(p_kode text, p_ttd text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v record;
    v_hari date := public.pd_hari_ini();
    v_ttd jsonb;
BEGIN
    SELECT p.*, d.tujuan, d.transportasi, d.kode_verifikasi,
           COALESCE(NULLIF(k."FotoURL", ''), k."FotoUrl") AS foto_url,
           COALESCE(NULLIF(k."FotoFileID", ''), k."FotoFileId") AS foto_file_id
    INTO v
    FROM public.perjalanan_dinas_detail d
    JOIN public.pengajuan_ijin_lembur_tbl p ON p.id = d.pengajuan_id
    LEFT JOIN public."karyawanTbl" k ON UPPER(btrim(k."QrCodeId")) = UPPER(btrim(p.qrcodeid))
    WHERE d.kode_verifikasi IS NOT NULL AND d.kode_verifikasi = UPPER(btrim(COALESCE(p_kode, '')))
    LIMIT 1;

    IF NOT FOUND OR v.status <> 'APPROVED' THEN
        RETURN jsonb_build_object('valid', false, 'statusBerlaku', 'TIDAK_DITEMUKAN',
            'message', 'Kode perjalanan dinas tidak ditemukan atau tidak berlaku.');
    END IF;

    IF NULLIF(btrim(COALESCE(p_ttd, '')), '') IS NOT NULL THEN
        SELECT x INTO v_ttd FROM jsonb_array_elements(public.pd_penandatangan(v.id)) x
         WHERE x->>'kode' = UPPER(btrim(p_ttd)) LIMIT 1;
    END IF;

    RETURN jsonb_build_object(
        'valid', true,
        'statusBerlaku', CASE WHEN v_hari < v.tanggal_mulai THEN 'BELUM_BERLAKU'
                              WHEN v_hari > v.tanggal_selesai THEN 'KEDALUWARSA'
                              ELSE 'BERLAKU' END,
        'kode', v.kode_verifikasi,
        'nama', v.nama_pemohon,
        'qrCodeId', v.qrcodeid,
        'kualifikasi', v.kualifikasi,
        'fotoUrl', v.foto_url,
        'fotoFileId', v.foto_file_id,
        'tujuan', v.tujuan,
        'keperluan', v.alasan,
        'transportasi', v.transportasi,
        'tanggalMulai', v.tanggal_mulai,
        'tanggalSelesai', v.tanggal_selesai,
        'jumlahHari', v.jumlah_hari,
        'disetujui', COALESCE((SELECT jsonb_agg(x) FROM unnest(ARRAY[v.level1_by, v.level2_by, v.level3_by]) AS x WHERE x IS NOT NULL), '[]'::jsonb),
        'verifikasiHr', v.hrcheck_by,
        'disetujuiPada', v.hrcheck_at,
        'hariIni', v_hari,
        'penandatangan', v_ttd,
        'konfirmasiTujuan', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('nama', l.nama, 'waktu', l.waktu) ORDER BY l.waktu DESC)
            FROM (SELECT * FROM public.perjalanan_dinas_log WHERE pengajuan_id = v.id AND sumber = 'KONFIRMASI_TUJUAN' ORDER BY waktu DESC LIMIT 5) l
        ), '[]'::jsonb)
    );
END;
$$;
REVOKE ALL ON FUNCTION public.verifikasi_perjalanan_dinas(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verifikasi_perjalanan_dinas(text, text) TO anon, authenticated, service_role;
