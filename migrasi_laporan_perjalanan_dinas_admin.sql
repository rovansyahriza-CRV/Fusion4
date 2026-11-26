-- =====================================================================
-- Laporan PDF Perjalanan Dinas dari Admin Portal (PIC OIL / ALL)
-- =====================================================================
-- pd_laporan_data(p_id): isi laporan (dipakai versi Badge & versi admin).
-- laporan_perjalanan_dinas_secure(p_id, p_session_token): untuk Admin Portal,
--   wewenang PIC OIL / ALL lewat sesi login Fusion4 (fusionAdminRpc).
-- =====================================================================

CREATE OR REPLACE FUNCTION public.pd_laporan_data(p_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT jsonb_build_object(
        'id', p.id, 'kode', d.kode_verifikasi,
        'nama', p.nama_pemohon, 'qrCodeId', p.qrcodeid, 'kualifikasi', p.kualifikasi, 'grade', d.grade,
        'tujuan', d.tujuan, 'keperluan', p.alasan, 'transportasi', d.transportasi, 'jarakKm', d.jarak_km,
        'tanggalMulai', p.tanggal_mulai, 'tanggalSelesai', p.tanggal_selesai, 'jumlahHari', p.jumlah_hari,
        'uangHarian', d.uang_harian, 'uangPenginapan', d.uang_penginapan, 'estimasiBiaya', d.estimasi_biaya,
        'diajukanPada', p.created_at,
        'penandatangan', public.pd_penandatangan(p.id))
    FROM public.pengajuan_ijin_lembur_tbl p
    JOIN public.perjalanan_dinas_detail d ON d.pengajuan_id = p.id
    WHERE p.id = p_id AND p.tipe = 'PERJALANAN_DINAS' AND p.status = 'APPROVED' AND d.kode_verifikasi IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.pd_laporan_data(bigint) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.laporan_perjalanan_dinas_secure(p_id bigint, p_session_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE v jsonb;
BEGIN
    PERFORM operational.check_fusion_session(p_session_token, 'oil');
    v := public.pd_laporan_data(p_id);
    IF v IS NULL THEN
        RETURN jsonb_build_object('status', 'NOT_APPROVED', 'message', 'Laporan hanya tersedia untuk perjalanan dinas yang sudah disetujui.');
    END IF;
    RETURN jsonb_build_object('status', 'OK', 'data', v);
END;
$$;
REVOKE ALL ON FUNCTION public.laporan_perjalanan_dinas_secure(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.laporan_perjalanan_dinas_secure(bigint, text) TO anon, authenticated, service_role;
