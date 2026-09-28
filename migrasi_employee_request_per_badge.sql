-- =====================================================================================
-- Fix: Permintaan Karyawan stage PER (HRD) tidak muncul di antrean Digital Badge.
-- - Tambah blok Level 2 (PER): status PROSES_HRD, untuk user dengan token PER / HR
-- - Token otorisasi dibaca dari Author (karyawanTbl + paswordTbl) DAN PIC (paswordTbl),
--   karena PER disimpan di kolom PIC.
-- - Pencocokan per-token (split koma) supaya 'APER' tidak ikut kebaca sebagai 'PER'/'AER'.
-- =====================================================================================

CREATE OR REPLACE FUNCTION public.get_pending_employee_requests_by_qrcode(p_qrcode text)
 RETURNS TABLE(id integer, requestno text, tanggalrequest date, pemohonid integer, pemohonnama text, divisi text, departemen text, projectcode text, lokasisite text, posisijabatan text, jumlahorang integer, tanggaldibutuhkan date, durasikerja text, jeniskelamin text, pendidikanminimal text, pengalamanminimal text, kualifikasikhusus text, alasanpermintaan text, status text, stage text, createdat timestamp with time zone, jumlah_kandidat integer, jumlah_diterima integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_user_author TEXT := '';
    v_user_nama TEXT := '';
    v_tokens TEXT[];
    v_super BOOLEAN;
BEGIN
    SELECT
        COALESCE(k."Author", '') || ',' || COALESCE(p."Author", '') || ',' || COALESCE(p."PIC", ''),
        COALESCE(k."NamaPersonnel", p."Nama", '')
    INTO v_user_author, v_user_nama
    FROM "karyawanTbl" k
    LEFT JOIN "paswordTbl" p ON k."Id" = p."Id"
    WHERE k."QrCodeId" = p_qrcode
       OR p."QrCodeId" = p_qrcode
       OR k."Id"::TEXT = p_qrcode
       OR p."Id"::TEXT = p_qrcode
    LIMIT 1;

    v_user_author := UPPER(COALESCE(v_user_author, ''));
    SELECT COALESCE(array_agg(TRIM(t)), '{}') INTO v_tokens
    FROM unnest(string_to_array(v_user_author, ',')) t
    WHERE TRIM(t) <> '';

    IF array_length(v_tokens, 1) IS NULL THEN
        RETURN;
    END IF;

    v_super := v_tokens && ARRAY['ALL', '*', 'ADMIN'];

    -- Level 1 (AER) - butuh aksi
    IF v_super OR 'AER' = ANY(v_tokens) OR EXISTS (SELECT 1 FROM unnest(v_tokens) t WHERE t LIKE 'AER-%') THEN
        RETURN QUERY
        SELECT
            r."Id", r."RequestNo", r."TanggalRequest", r."PemohonId", r."PemohonNama",
            r."Divisi", r."Departemen", r."ProjectCode", r."LokasiSite", r."PosisiJabatan",
            r."JumlahOrang", r."TanggalDibutuhkan", r."DurasiKerja", r."JenisKelamin",
            r."PendidikanMinimal", r."PengalamanMinimal", r."KualifikasiKhusus", r."AlasanPermintaan",
            r."Status", 'AER'::TEXT, r."CreatedAt",
            NULL::integer, NULL::integer
        FROM "employeeRequestTbl" r
        WHERE (r."Status" = 'PENDING_AER' OR r."Status" = 'PENDING')
          AND (
              v_super
              OR 'AER' = ANY(v_tokens)
              OR 'AER-ALL' = ANY(v_tokens)
              OR (r."ProjectCode" IS NOT NULL AND (
                    ('AER-' || UPPER(TRIM(r."ProjectCode"))) = ANY(v_tokens)
                 OR ('AER-' || LTRIM(UPPER(TRIM(r."ProjectCode")), '0')) = ANY(v_tokens)))
          )
        ORDER BY r."CreatedAt" ASC;

        -- Read-only: request yang PERNAH di-approve AER ini, masih berjalan (belum FULFILLED/REJECTED)
        RETURN QUERY
        SELECT
            r."Id", r."RequestNo", r."TanggalRequest", r."PemohonId", r."PemohonNama",
            r."Divisi", r."Departemen", r."ProjectCode", r."LokasiSite", r."PosisiJabatan",
            r."JumlahOrang", r."TanggalDibutuhkan", r."DurasiKerja", r."JenisKelamin",
            r."PendidikanMinimal", r."PengalamanMinimal", r."KualifikasiKhusus", r."AlasanPermintaan",
            r."Status", 'AER_READONLY'::TEXT, r."CreatedAt",
            (SELECT COUNT(*)::integer FROM "kandidatRekrutmenTbl" kr WHERE kr."RequestId" = r."Id"),
            (SELECT COUNT(*)::integer FROM "kandidatRekrutmenTbl" kr WHERE kr."RequestId" = r."Id" AND kr."Status" = 'DITERIMA')
        FROM "employeeRequestTbl" r
        WHERE r."Status" IN ('PROSES_HRD', 'PENDING_APER', 'REKRUTMEN_AKTIF')
          AND r."AerApprovedBy" IS NOT NULL
          AND v_user_nama <> ''
          AND r."AerApprovedBy" LIKE v_user_nama || '%'
          -- jangan dobel dengan kartu aksi PER di bawah
          AND NOT (r."Status" = 'PROSES_HRD' AND (v_super OR v_tokens && ARRAY['PER', 'HR']))
        ORDER BY r."CreatedAt" DESC;
    END IF;

    -- Level 2 (PER / HRD) - butuh aksi: ajukan ke Direksi
    IF v_super OR v_tokens && ARRAY['PER', 'HR'] THEN
        RETURN QUERY
        SELECT
            r."Id", r."RequestNo", r."TanggalRequest", r."PemohonId", r."PemohonNama",
            r."Divisi", r."Departemen", r."ProjectCode", r."LokasiSite", r."PosisiJabatan",
            r."JumlahOrang", r."TanggalDibutuhkan", r."DurasiKerja", r."JenisKelamin",
            r."PendidikanMinimal", r."PengalamanMinimal", r."KualifikasiKhusus", r."AlasanPermintaan",
            r."Status", 'PER'::TEXT, r."CreatedAt",
            NULL::integer, NULL::integer
        FROM "employeeRequestTbl" r
        WHERE r."Status" IN ('PROSES_HRD', 'IN PROGRESS')
        ORDER BY r."CreatedAt" ASC;
    END IF;

    -- Level 3 (APER) - butuh aksi
    IF v_super OR v_tokens && ARRAY['APER', 'BOD', 'DIR'] THEN
        RETURN QUERY
        SELECT
            r."Id", r."RequestNo", r."TanggalRequest", r."PemohonId", r."PemohonNama",
            r."Divisi", r."Departemen", r."ProjectCode", r."LokasiSite", r."PosisiJabatan",
            r."JumlahOrang", r."TanggalDibutuhkan", r."DurasiKerja", r."JenisKelamin",
            r."PendidikanMinimal", r."PengalamanMinimal", r."KualifikasiKhusus", r."AlasanPermintaan",
            r."Status", 'APER'::TEXT, r."CreatedAt",
            NULL::integer, NULL::integer
        FROM "employeeRequestTbl" r
        WHERE r."Status" = 'PENDING_APER'
        ORDER BY r."CreatedAt" ASC;
    END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION get_pending_employee_requests_by_qrcode(TEXT) TO anon, authenticated, service_role;
