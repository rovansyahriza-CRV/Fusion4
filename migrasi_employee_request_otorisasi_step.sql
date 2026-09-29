-- =====================================================================================
-- Fix: Permintaan Karyawan -- otorisasi tiap tahap dicek di server, APER khusus Direksi.
--
-- Masalah:
-- - Akun dengan PIC "..., PER, ..., ALL" dan Author kosong bisa approve sebagai Direksi
--   (APER), karena token ALL dianggap super admin di semua tahap.
-- - RPC process_employee_request_step(_by_qrcode) sama sekali tidak mengecek hak akses,
--   siapa pun yang memanggilnya bisa approve/tolak tahap mana pun, bahkan set status
--   bebas lewat cabang ELSE.
--
-- Aturan baru (dipakai web SmartGate & Digital Badge):
-- - AER  (status PENDING_AER/PENDING)     : ALL/*/ADMIN, AER, AER-ALL, AER-<Proyek>
-- - PER  (status PROSES_HRD/IN PROGRESS)  : ALL/*/ADMIN, PER, HR (Author atau PIC)
-- - APER (status PENDING_APER)            : HANYA Author APER / BOD / DIR.
--                                           ALL di PIC tetap buka semua menu, tapi TIDAK
--                                           bisa approve final Direksi.
-- - Aksi lain ditolak (cabang "set status bebas" dihapus).
--
-- File ini juga MENGGANTIKAN migrasi_employee_request_per_badge.sql (blok Level 2 PER
-- ikut ada di sini), jadi cukup jalankan file ini.
-- =====================================================================================

-- 1. Helper: token otorisasi (split koma/titik koma, upper, trim)
CREATE OR REPLACE FUNCTION public.emp_req_tokens(p_text text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT COALESCE(array_agg(UPPER(TRIM(t))) FILTER (WHERE TRIM(t) <> ''), ARRAY[]::text[])
    FROM regexp_split_to_table(COALESCE(p_text, ''), '[,;]+') t;
$$;

-- 2. Helper: boleh nggak aktor ini menjalankan aksi di request ini?
--    Return NULL kalau boleh, atau pesan error kalau nggak.
CREATE OR REPLACE FUNCTION public.emp_req_step_denied(
    p_author text,   -- gabungan Author (karyawanTbl + paswordTbl)
    p_pic text,      -- PIC (paswordTbl)
    p_action text,
    p_status text,
    p_project text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_auth text[] := emp_req_tokens(p_author);
    v_all text[] := emp_req_tokens(p_author) || emp_req_tokens(p_pic);
    v_super boolean := v_all && ARRAY['ALL', '*', 'ADMIN'];
    v_proj text := UPPER(REPLACE(COALESCE(p_project, ''), ' ', ''));
    v_status text := UPPER(COALESCE(p_status, ''));
BEGIN
    IF p_action IN ('AER_APPROVE', 'AER_REJECT') THEN
        IF v_status NOT IN ('PENDING_AER', 'PENDING') THEN
            RETURN 'Permintaan ini sudah tidak di tahap persetujuan Atasan/PM (AER).';
        END IF;
        IF v_super OR v_auth && ARRAY['AER', 'AER-ALL']
           OR (v_proj <> '' AND v_auth && ARRAY['AER-' || v_proj, 'AER-' || LTRIM(v_proj, '0')]) THEN
            RETURN NULL;
        END IF;
        RETURN 'Akun ini tidak punya otorisasi AER untuk proyek ' || COALESCE(NULLIF(v_proj, ''), '-') || '.';

    ELSIF p_action IN ('HRD_PROCEED_BOD', 'HRD_UPDATE') THEN
        IF v_status NOT IN ('PROSES_HRD', 'IN PROGRESS') THEN
            RETURN 'Permintaan ini sudah tidak di tahap proses HRD (PER).';
        END IF;
        IF v_super OR v_all && ARRAY['PER', 'HR'] THEN
            RETURN NULL;
        END IF;
        RETURN 'Akun ini tidak punya otorisasi HRD (PER).';

    ELSIF p_action IN ('APER_APPROVE', 'APER_REJECT') THEN
        IF v_status <> 'PENDING_APER' THEN
            RETURN 'Permintaan ini sudah tidak menunggu persetujuan Direksi (APER).';
        END IF;
        -- Sengaja TANPA v_super: ALL/ADMIN tidak otomatis jadi Direksi.
        IF v_auth && ARRAY['APER', 'BOD', 'DIR'] THEN
            RETURN NULL;
        END IF;
        RETURN 'Persetujuan final hanya untuk Author APER / BOD / DIR (Direksi).';
    END IF;

    RETURN 'Aksi tidak dikenal: ' || COALESCE(p_action, '-');
END;
$$;

-- 3. Inti proses (tanpa cek akses) -- sekarang cuma boleh dipanggil dari wrapper di bawah.
--    Cabang ELSE "set status bebas" dihapus.
CREATE OR REPLACE FUNCTION public.process_employee_request_step(p_id bigint, p_actor_name text, p_step_action text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_new_status TEXT;
    v_msg TEXT;
BEGIN
    IF p_step_action = 'AER_APPROVE' THEN
        v_new_status := 'PROSES_HRD';
        v_msg := 'Permintaan disetujui oleh Atasan/PM (AER) dan diteruskan ke Tim HRD (PER) untuk proses rekrutmen.';
        UPDATE "employeeRequestTbl"
        SET "Status" = v_new_status, "AerApprovedBy" = p_actor_name, "AerApprovedAt" = NOW(),
            "AerNotes" = p_notes, "UpdatedAt" = NOW()
        WHERE "Id" = p_id;

    ELSIF p_step_action = 'AER_REJECT' THEN
        v_new_status := 'REJECTED_AER';
        v_msg := 'Permintaan ditolak oleh Atasan/PM (AER).';
        UPDATE "employeeRequestTbl"
        SET "Status" = v_new_status, "AerApprovedBy" = p_actor_name, "AerApprovedAt" = NOW(),
            "AerNotes" = p_notes, "UpdatedAt" = NOW()
        WHERE "Id" = p_id;

    ELSIF p_step_action = 'HRD_PROCEED_BOD' THEN
        v_new_status := 'PENDING_APER';
        v_msg := 'Proses seleksi HRD selesai. Berkas diajukan ke Direksi / BOD (APER) untuk persetujuan final.';
        UPDATE "employeeRequestTbl"
        SET "Status" = v_new_status, "HrdProcessedBy" = p_actor_name, "HrdProcessedAt" = NOW(),
            "HrdNotes" = p_notes, "UpdatedAt" = NOW()
        WHERE "Id" = p_id;

    ELSIF p_step_action = 'HRD_UPDATE' THEN
        v_new_status := 'PROSES_HRD';
        v_msg := 'Catatan rekrutmen HRD berhasil diperbarui.';
        UPDATE "employeeRequestTbl"
        SET "HrdProcessedBy" = p_actor_name, "HrdProcessedAt" = NOW(),
            "HrdNotes" = p_notes, "UpdatedAt" = NOW()
        WHERE "Id" = p_id;

    ELSIF p_step_action = 'APER_APPROVE' THEN
        v_new_status := 'REKRUTMEN_AKTIF';
        v_msg := 'Permintaan resmi disetujui oleh Direksi / BOD (APER). Tim HRD dapat memulai proses sourcing & interview kandidat.';
        UPDATE "employeeRequestTbl"
        SET "Status" = v_new_status, "AperApprovedBy" = p_actor_name, "AperApprovedAt" = NOW(),
            "AperNotes" = p_notes, "UpdatedAt" = NOW()
        WHERE "Id" = p_id;

    ELSIF p_step_action = 'APER_REJECT' THEN
        v_new_status := 'REJECTED_APER';
        v_msg := 'Permintaan ditolak oleh Direksi / BOD (APER).';
        UPDATE "employeeRequestTbl"
        SET "Status" = v_new_status, "AperApprovedBy" = p_actor_name, "AperApprovedAt" = NOW(),
            "AperNotes" = p_notes, "UpdatedAt" = NOW()
        WHERE "Id" = p_id;
    ELSE
        RAISE EXCEPTION 'Aksi tidak dikenal: %', p_step_action;
    END IF;

    RETURN jsonb_build_object('success', true, 'id', p_id, 'status', v_new_status, 'message', v_msg);
END;
$function$;

-- 4. Web SmartGate: pakai session login Fusion4 (token dari fusion_login), identitas aktor
--    diambil dari session di server, bukan dari nama yang dikirim browser.
CREATE OR REPLACE FUNCTION public.process_employee_request_step_secure(
    p_id bigint,
    p_step_action text,
    p_notes text DEFAULT NULL::text,
    p_session_token text DEFAULT NULL::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_actor_id bigint;
    v_actor_nama text;
    v_author text;
    v_pic text;
    v_req RECORD;
    v_denied text;
BEGIN
    SELECT s.employee_id INTO v_actor_id
    FROM operational.fusion_sessions s
    JOIN "paswordTbl" p ON p."Id" = s.employee_id
    WHERE s.token_hash = sha256(convert_to(COALESCE(p_session_token, ''), 'UTF8'))
      AND s.expires_at > now()
      AND p."IsActive" = true
      AND s.credential_hash = sha256(convert_to(COALESCE(p."PasswordHas", ''), 'UTF8'));
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Login Fusion4 kembali untuk memproses Permintaan Karyawan.' USING ERRCODE = '28000';
    END IF;

    SELECT COALESCE(k."NamaPersonnel", p."Nama", 'Approver'),
           COALESCE(k."Author", '') || ',' || COALESCE(p."Author", ''),
           COALESCE(NULLIF(TRIM(p."PIC"), ''), p.pic, '')
    INTO v_actor_nama, v_author, v_pic
    FROM "paswordTbl" p
    LEFT JOIN "karyawanTbl" k ON k."Id" = p."Id"
    WHERE p."Id" = v_actor_id;

    SELECT "Status", "ProjectCode" INTO v_req FROM "employeeRequestTbl" WHERE "Id" = p_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Permintaan karyawan tidak ditemukan.';
    END IF;

    v_denied := emp_req_step_denied(v_author, v_pic, p_step_action, v_req."Status", v_req."ProjectCode");
    IF v_denied IS NOT NULL THEN
        RAISE EXCEPTION '%', v_denied USING ERRCODE = '42501';
    END IF;

    RETURN process_employee_request_step(p_id, v_actor_nama || ' (' || v_actor_id || ')', p_step_action, p_notes);
END;
$function$;

-- 5. Digital Badge: identitas dari QR/Id badge, sekarang dicek otorisasinya juga.
CREATE OR REPLACE FUNCTION public.process_employee_request_step_by_qrcode(p_qrcode text, p_id integer, p_step_action text, p_notes text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_actor_name TEXT;
    v_author TEXT;
    v_pic TEXT;
    v_req RECORD;
    v_denied TEXT;
BEGIN
    SELECT COALESCE(k."NamaPersonnel", p."Nama", 'Approver'),
           COALESCE(k."Author", '') || ',' || COALESCE(p."Author", ''),
           COALESCE(p."PIC", '')
    INTO v_actor_name, v_author, v_pic
    FROM "karyawanTbl" k
    LEFT JOIN "paswordTbl" p ON k."Id" = p."Id"
    WHERE k."QrCodeId" = p_qrcode
       OR p."QrCodeId" = p_qrcode
       OR k."Id"::TEXT = p_qrcode
       OR p."Id"::TEXT = p_qrcode
    LIMIT 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Badge tidak dikenali.' USING ERRCODE = '42501';
    END IF;

    SELECT "Status", "ProjectCode" INTO v_req FROM "employeeRequestTbl" WHERE "Id" = p_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Permintaan karyawan tidak ditemukan.';
    END IF;

    v_denied := emp_req_step_denied(v_author, v_pic, p_step_action, v_req."Status", v_req."ProjectCode");
    IF v_denied IS NOT NULL THEN
        RAISE EXCEPTION '%', v_denied USING ERRCODE = '42501';
    END IF;

    RETURN process_employee_request_step(p_id, v_actor_name, p_step_action, p_notes);
END;
$function$;

-- 6. Antrean Digital Badge: sama seperti migrasi_employee_request_per_badge.sql, kecuali
--    blok APER sekarang cuma baca token Author (APER/BOD/DIR), bukan ALL/PIC.
CREATE OR REPLACE FUNCTION public.get_pending_employee_requests_by_qrcode(p_qrcode text)
 RETURNS TABLE(id integer, requestno text, tanggalrequest date, pemohonid integer, pemohonnama text, divisi text, departemen text, projectcode text, lokasisite text, posisijabatan text, jumlahorang integer, tanggaldibutuhkan date, durasikerja text, jeniskelamin text, pendidikanminimal text, pengalamanminimal text, kualifikasikhusus text, alasanpermintaan text, status text, stage text, createdat timestamp with time zone, jumlah_kandidat integer, jumlah_diterima integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_author_raw TEXT := '';
    v_pic_raw TEXT := '';
    v_user_nama TEXT := '';
    v_tokens TEXT[];
    v_auth_tokens TEXT[];
    v_super BOOLEAN;
BEGIN
    SELECT
        COALESCE(k."Author", '') || ',' || COALESCE(p."Author", ''),
        COALESCE(p."PIC", ''),
        COALESCE(k."NamaPersonnel", p."Nama", '')
    INTO v_author_raw, v_pic_raw, v_user_nama
    FROM "karyawanTbl" k
    LEFT JOIN "paswordTbl" p ON k."Id" = p."Id"
    WHERE k."QrCodeId" = p_qrcode
       OR p."QrCodeId" = p_qrcode
       OR k."Id"::TEXT = p_qrcode
       OR p."Id"::TEXT = p_qrcode
    LIMIT 1;

    v_auth_tokens := emp_req_tokens(v_author_raw);
    v_tokens := v_auth_tokens || emp_req_tokens(v_pic_raw);

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

    -- Level 3 (APER) - butuh aksi. Khusus Author APER/BOD/DIR, ALL/ADMIN tidak ikut.
    IF v_auth_tokens && ARRAY['APER', 'BOD', 'DIR'] THEN
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

-- 7. Hak eksekusi: fungsi inti tanpa cek akses ditutup dari browser.
REVOKE EXECUTE ON FUNCTION public.process_employee_request_step(bigint, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_employee_request_step_secure(bigint, text, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.process_employee_request_step_by_qrcode(text, integer, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_pending_employee_requests_by_qrcode(text) TO anon, authenticated, service_role;
