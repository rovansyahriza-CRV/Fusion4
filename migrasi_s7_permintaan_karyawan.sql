-- =====================================================================
-- S7 keamanan: Permintaan Karyawan & Rekrutmen Kandidat lewat sesi
-- =====================================================================
-- Sebelumnya 17 dari 18 RPC modul ini bisa dipanggil siapa saja tanpa login, mis.:
--   delete_employee_request(id)            -> hapus permintaan apa pun
--   list_kandidat_rekrutmen(id)            -> semua kolom kandidat TERMASUK Pin & InterviewPin
--   kirim_undangan_interview_kandidat(id)  -> bikin & balikin PIN undangan baru
--   submit_hasil_interview(...)            -> tandai kandidat lulus/gagal
--   process_employee_request_step_by_qrcode-> approve atas nama QrCodeId (bahkan Id) kiriman browser
--
-- Admin Fusion4 sudah punya pola fusionAdminRpc(name) -> <name>_secure(..., p_session_token)
-- (dipakai process_employee_request_step_secure). Semua aksi admin dibuat versi _secure:
-- sesi fusion_login + tag (sama dengan menu admin), nama aktor dari server.
-- Badge: process_employee_request_step_badge(token Badge) -- aturan tahap tetap emp_req_step_denied.
-- Halaman kandidat (konfirmasi-kandidat / konfirmasi-interview) tetap publik + PIN.
--
-- Hak (tag, ALL / * / ADMIN = super admin):
--   buat : Author AER / AER-xxx / APER / HR / LEAD / BOD, PIC PER / ER / ER-xxx / HR (= menu admin)
--   hr   : PIC PER / HR, Author HR                                             (= canUserProcessHrd)
--   hapus: hr, atau pemohon sendiri selama masih menunggu persetujuan AER
-- =====================================================================

-- Fungsi lama tanpa search_path -> kunci ke public supaya aman dipanggil dari fungsi lain.
DO $$
DECLARE f text;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'public.list_employee_requests(text)',
        'public.submit_employee_request(integer,text,text,text,text,text,text,integer,date,text,text,text,text,text,text)',
        'public.list_kandidat_rekrutmen(bigint)',
        'public.submit_kandidat_rekrutmen(bigint,text,date,text,text,text,text,text,text)',
        'public.submit_hasil_interview(bigint,text,date,text,numeric,text,jsonb,text,text,text,text)',
        'public.kirim_undangan_interview_kandidat(bigint)',
        'public.catat_pengiriman_konfirmasi_kandidat(bigint)',
        'public.get_lembar_interview_data(bigint)',
        'public.process_employee_request_step(bigint,text,text,text)',
        'public.emp_req_step_denied(text,text,text,text,text)',
        'public.emp_req_tokens(text)'] LOOP
        EXECUTE format('ALTER FUNCTION %s SET search_path TO public, pg_temp', f);
    END LOOP;
END $$;

-- ---------- Helper ----------
CREATE OR REPLACE FUNCTION operational.emp_req_hak(p_actor bigint, p_jenis text)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
    v_a text[];
    v_p text[];
BEGIN
    SELECT public.emp_req_tokens(COALESCE(k."Author", '') || ',' || COALESCE(p."Author", '')),
           public.emp_req_tokens(COALESCE(NULLIF(btrim(p."PIC"), ''), p.pic, ''))
    INTO v_a, v_p
    FROM public."paswordTbl" p LEFT JOIN public."karyawanTbl" k ON k."Id" = p."Id"
    WHERE p."Id" = p_actor;
    IF NOT FOUND THEN RETURN false; END IF;
    IF (v_a || v_p) && ARRAY['ALL', '*', 'ADMIN'] THEN RETURN true; END IF;
    IF p_jenis = 'buat' THEN
        RETURN EXISTS (SELECT 1 FROM unnest(v_a) t WHERE t IN ('AER', 'APER', 'HR', 'LEAD', 'BOD') OR t LIKE 'AER-%')
            OR EXISTS (SELECT 1 FROM unnest(v_p) t WHERE t IN ('PER', 'ER', 'HR') OR t LIKE 'ER-%');
    ELSIF p_jenis = 'hr' THEN
        RETURN v_p && ARRAY['PER', 'HR'] OR v_a && ARRAY['HR'];
    END IF;
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION operational.emp_req_aktor(p_token text, p_jenis text)
RETURNS bigint
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
    v_id bigint := operational.fusion_sesi(p_token);
BEGIN
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'Sesi login habis. Silakan logout dan login kembali.' USING ERRCODE = '28000';
    END IF;
    IF p_jenis IS NOT NULL AND NOT operational.emp_req_hak(v_id, p_jenis) THEN
        RAISE EXCEPTION '%', CASE p_jenis WHEN 'hr' THEN 'Akun ini tidak punya otorisasi HRD (PER / HR).'
                                          ELSE 'Akun ini tidak punya akses Permintaan Karyawan.' END
            USING ERRCODE = '42501';
    END IF;
    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION operational.emp_req_hak(bigint, text), operational.emp_req_aktor(text, text) FROM PUBLIC, anon, authenticated;

-- ---------- Permintaan karyawan ----------
DROP FUNCTION IF EXISTS public.list_employee_requests_secure(text, text);
CREATE FUNCTION public.list_employee_requests_secure(p_status text DEFAULT NULL, p_session_token text DEFAULT NULL)
RETURNS TABLE(id integer, requestno text, tanggalrequest date, pemohonid integer, pemohonnama text, divisi text, departemen text,
              projectcode text, lokasisite text, posisijabatan text, jumlahorang integer, tanggaldibutuhkan date, durasikerja text,
              jeniskelamin text, pendidikanminimal text, pengalamanminimal text, kualifikasikhusus text, alasanpermintaan text,
              status text, aer_approved_by text, aer_approved_at timestamptz, aer_notes text, hrd_processed_by text,
              hrd_processed_at timestamptz, hrd_notes text, aper_approved_by text, aper_approved_at timestamptz, aper_notes text,
              createdat timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public, pg_temp
AS $$
BEGIN
    PERFORM operational.emp_req_aktor(p_session_token, NULL);
    RETURN QUERY SELECT * FROM public.list_employee_requests(p_status);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_employee_request_secure(
    p_divisi text, p_departemen text, p_project_code text, p_lokasi_site text, p_posisi_jabatan text,
    p_jumlah_orang integer, p_tanggal_dibutuhkan date, p_durasi_kerja text, p_jenis_kelamin text,
    p_pendidikan text, p_pengalaman text, p_kualifikasi text, p_alasan text, p_session_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp
AS $$
DECLARE
    v_id   bigint := operational.emp_req_aktor(p_session_token, 'buat');
    v_nama text;
BEGIN
    SELECT k."NamaPersonnel" INTO v_nama FROM public."karyawanTbl" k WHERE k."Id" = v_id;
    RETURN public.submit_employee_request(v_id::integer, COALESCE(v_nama, v_id::text), p_divisi, p_departemen, p_project_code,
        p_lokasi_site, p_posisi_jabatan, p_jumlah_orang, p_tanggal_dibutuhkan, p_durasi_kerja, p_jenis_kelamin,
        p_pendidikan, p_pengalaman, p_kualifikasi, p_alasan);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_employee_request_secure(p_id integer, p_session_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp
AS $$
DECLARE
    v_actor bigint := operational.emp_req_aktor(p_session_token, 'buat');
    v_req   record;
BEGIN
    SELECT "Id", "PemohonId", "Status" INTO v_req FROM public."employeeRequestTbl" WHERE "Id" = p_id FOR UPDATE;
    IF v_req."Id" IS NULL THEN
        RAISE EXCEPTION 'Permintaan karyawan tidak ditemukan.';
    END IF;
    IF NOT operational.emp_req_hak(v_actor, 'hr')
       AND NOT (v_req."PemohonId" = v_actor AND upper(COALESCE(v_req."Status", '')) IN ('PENDING_AER', 'PENDING')) THEN
        RAISE EXCEPTION 'Hanya pemohon (selama menunggu persetujuan AER) atau HRD yang bisa menghapus permintaan ini.' USING ERRCODE = '42501';
    END IF;
    DELETE FROM public."employeeRequestTbl" WHERE "Id" = p_id;
    RETURN jsonb_build_object('success', true, 'message', 'Permintaan karyawan berhasil dihapus');
END;
$$;

-- ---------- Rekrutmen kandidat (HRD) ----------
CREATE OR REPLACE FUNCTION public.list_kandidat_rekrutmen_secure(p_request_id bigint, p_session_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public, pg_temp
AS $$
DECLARE
    v_actor bigint := operational.emp_req_aktor(p_session_token, NULL);
    v       jsonb := public.list_kandidat_rekrutmen(p_request_id);
BEGIN
    -- PIN kandidat cuma untuk HRD (dipakai di email undangan / konfirmasi).
    IF NOT operational.emp_req_hak(v_actor, 'hr') THEN
        v := jsonb_set(v, '{kandidat}', COALESCE((SELECT jsonb_agg(e - 'Pin' - 'InterviewPin')
                                                  FROM jsonb_array_elements(v->'kandidat') e), '[]'::jsonb));
    END IF;
    RETURN v;
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_kandidat_rekrutmen_secure(
    p_request_id bigint, p_nama_kandidat text, p_tgl_interview date, p_status text, p_notes text DEFAULT NULL,
    p_cv_url text DEFAULT NULL, p_cv_fileid text DEFAULT NULL, p_cv_filename text DEFAULT NULL, p_session_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp
AS $$
DECLARE
    v_id   bigint := operational.emp_req_aktor(p_session_token, 'hr');
    v_nama text;
BEGIN
    SELECT k."NamaPersonnel" INTO v_nama FROM public."karyawanTbl" k WHERE k."Id" = v_id;
    RETURN public.submit_kandidat_rekrutmen(p_request_id, p_nama_kandidat, p_tgl_interview, p_status, p_notes,
        COALESCE(v_nama, v_id::text), p_cv_url, p_cv_fileid, p_cv_filename);
END;
$$;

CREATE OR REPLACE FUNCTION public.submit_hasil_interview_secure(
    p_kandidat_id bigint, p_interviewer_nama text, p_tanggal_pelaksanaan date, p_catatan text, p_skor numeric, p_hasil text,
    p_kriteria_json jsonb DEFAULT NULL, p_dokumen_url text DEFAULT NULL, p_dokumen_fileid text DEFAULT NULL,
    p_dokumen_filename text DEFAULT NULL, p_session_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp
AS $$
DECLARE
    v_id   bigint := operational.emp_req_aktor(p_session_token, 'hr');
    v_nama text;
BEGIN
    SELECT k."NamaPersonnel" INTO v_nama FROM public."karyawanTbl" k WHERE k."Id" = v_id;
    RETURN public.submit_hasil_interview(p_kandidat_id, p_interviewer_nama, p_tanggal_pelaksanaan, p_catatan, p_skor, p_hasil,
        p_kriteria_json, p_dokumen_url, p_dokumen_fileid, p_dokumen_filename, COALESCE(v_nama, v_id::text));
END;
$$;

CREATE OR REPLACE FUNCTION public.kirim_undangan_interview_kandidat_secure(p_kandidat_id bigint, p_session_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp
AS $$
BEGIN
    PERFORM operational.emp_req_aktor(p_session_token, 'hr');
    RETURN public.kirim_undangan_interview_kandidat(p_kandidat_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.catat_pengiriman_konfirmasi_kandidat_secure(p_kandidat_id bigint, p_session_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp
AS $$
BEGIN
    PERFORM operational.emp_req_aktor(p_session_token, 'hr');
    RETURN public.catat_pengiriman_konfirmasi_kandidat(p_kandidat_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_lembar_interview_data_secure(p_kandidat_id bigint, p_session_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public, pg_temp
AS $$
BEGIN
    PERFORM operational.emp_req_aktor(p_session_token, 'hr');
    RETURN public.get_lembar_interview_data(p_kandidat_id);
END;
$$;

-- ---------- Approval dari Badge (sesi Badge) ----------
CREATE OR REPLACE FUNCTION public.process_employee_request_step_badge(p_token text, p_id bigint, p_step_action text, p_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp
AS $$
DECLARE
    v_actor  bigint := operational.badge_sesi(p_token);
    v_nama   text;
    v_author text;
    v_pic    text;
    v_req    record;
    v_denied text;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Sesi Badge habis. Tutup lalu buka Badge dan masukkan PIN lagi.' USING ERRCODE = '28000';
    END IF;
    SELECT COALESCE(k."NamaPersonnel", p."Nama", 'Approver'), COALESCE(k."Author", '') || ',' || COALESCE(p."Author", ''),
           COALESCE(NULLIF(btrim(p."PIC"), ''), p.pic, '')
    INTO v_nama, v_author, v_pic
    FROM public."karyawanTbl" k LEFT JOIN public."paswordTbl" p ON p."Id" = k."Id"
    WHERE k."Id" = v_actor;
    SELECT "Status", "ProjectCode" INTO v_req FROM public."employeeRequestTbl" WHERE "Id" = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Permintaan karyawan tidak ditemukan.'; END IF;
    v_denied := public.emp_req_step_denied(v_author, v_pic, p_step_action, v_req."Status", v_req."ProjectCode");
    IF v_denied IS NOT NULL THEN RAISE EXCEPTION '%', v_denied USING ERRCODE = '42501'; END IF;
    RETURN public.process_employee_request_step(p_id, v_nama || ' (' || v_actor || ')', p_step_action, p_notes);
END;
$$;

REVOKE ALL ON FUNCTION public.list_employee_requests_secure(text, text),
    public.submit_employee_request_secure(text, text, text, text, text, integer, date, text, text, text, text, text, text, text),
    public.delete_employee_request_secure(integer, text), public.list_kandidat_rekrutmen_secure(bigint, text),
    public.submit_kandidat_rekrutmen_secure(bigint, text, date, text, text, text, text, text, text),
    public.submit_hasil_interview_secure(bigint, text, date, text, numeric, text, jsonb, text, text, text, text),
    public.kirim_undangan_interview_kandidat_secure(bigint, text), public.catat_pengiriman_konfirmasi_kandidat_secure(bigint, text),
    public.get_lembar_interview_data_secure(bigint, text), public.process_employee_request_step_badge(text, bigint, text, text)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_employee_requests_secure(text, text),
    public.submit_employee_request_secure(text, text, text, text, text, integer, date, text, text, text, text, text, text, text),
    public.delete_employee_request_secure(integer, text), public.list_kandidat_rekrutmen_secure(bigint, text),
    public.submit_kandidat_rekrutmen_secure(bigint, text, date, text, text, text, text, text, text),
    public.submit_hasil_interview_secure(bigint, text, date, text, numeric, text, jsonb, text, text, text, text),
    public.kirim_undangan_interview_kandidat_secure(bigint, text), public.catat_pengiriman_konfirmasi_kandidat_secure(bigint, text),
    public.get_lembar_interview_data_secure(bigint, text), public.process_employee_request_step_badge(text, bigint, text, text)
    TO anon, authenticated;

-- ---------- Tahap 2 (SETELAH halaman baru tayang): cabut RPC lama dari anon ----------
-- REVOKE EXECUTE ON FUNCTION
--     public.list_employee_requests(text),
--     public.submit_employee_request(integer,text,text,text,text,text,text,integer,date,text,text,text,text,text,text),
--     public.delete_employee_request(integer),
--     public.list_kandidat_rekrutmen(bigint),
--     public.submit_kandidat_rekrutmen(bigint,text,date,text,text,text,text,text,text),
--     public.submit_hasil_interview(bigint,text,date,text,numeric,text,jsonb,text,text,text,text),
--     public.kirim_undangan_interview_kandidat(bigint),
--     public.catat_pengiriman_konfirmasi_kandidat(bigint),
--     public.get_lembar_interview_data(bigint),
--     public.process_employee_request_step_by_qrcode(text,integer,text,text),
--     public.process_employee_request_approval(integer,text,text,text)
--   FROM PUBLIC, anon, authenticated;
