-- =====================================================================
-- S3c keamanan: pendaftaran & approval vendor lewat RPC, kunci tabel RFQ,
-- tutup kolom PIN vendor
-- =====================================================================
-- 1. vendor_daftar(data): formulir publik (vendor-register.html) & input admin
--    SMMS. Validasi + cek duplikat NPWP/Email di server, status selalu "Review".
-- 2. vendor_proses(token, vendor, keputusan): sesi SMMS/Badge + wewenang tag
--    (vendor_author_can: RV = review, AV = approval, ALL). Pengganti
--    process_vendor_approval(_by_qrcode) yang percaya Id/QrCodeId kiriman browser.
-- 3. get_pending_rfq_approvals: kolom pin dikosongkan (PIN untuk email kini
--    dari rfq_proses_seleksi, hanya ke approver berwenang).
-- 4. rfq, rfqVendor, rfqQuote, rfqVendorTerm, rfqDetail, vendor: policy tulis
--    "Anyone can ..." dihapus, hak tulis anon dicabut (baca tetap). Kolom
--    rfqVendor.PIN tidak bisa dibaca dari luar.
-- 5. RPC lama dicabut dari anon: create_rfq_and_invite, process_rfq_approval*,
--    process_vendor_approval*.
-- =====================================================================

-- ---------- 1. Pendaftaran vendor ----------
CREATE OR REPLACE FUNCTION public.vendor_daftar(p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_nama  text := left(btrim(COALESCE(p_data->>'VendorName', '')), 200);
    v_email text := left(lower(btrim(COALESCE(p_data->>'Email', ''))), 200);
    v_npwp  text := left(btrim(COALESCE(p_data->>'NPWP', '')), 40);
    v_dup   record;
    v_id    bigint;
BEGIN
    IF v_nama = '' THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Nama vendor wajib diisi.');
    END IF;
    IF v_email <> '' AND v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Format email tidak valid.');
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('vendor-daftar', 0));
    SELECT v."VendorName", v."Status" INTO v_dup
    FROM public.vendor v
    WHERE (v_npwp <> '' AND v."NPWP" = v_npwp) OR (v_email <> '' AND lower(v."Email") = v_email)
    LIMIT 1;
    IF FOUND THEN
        RETURN jsonb_build_object('status', 'DUPLIKAT', 'vendorname', v_dup."VendorName", 'vendorstatus', v_dup."Status",
            'message', 'Vendor "' || v_dup."VendorName" || '" dengan NPWP/Email ini sudah terdaftar (status: ' || COALESCE(v_dup."Status", '-') || ').');
    END IF;

    INSERT INTO public.vendor ("VendorName", "AuthorizeName", "AuthorizeID", "Specialist", "Catagory", "Address",
                               "ContactNo", "Email", "NPWP", "RekeningNo", "Bank", "Status", "VendorListDate")
    VALUES (v_nama,
            NULLIF(left(btrim(COALESCE(p_data->>'AuthorizeName', '')), 200), ''),
            NULLIF(left(btrim(COALESCE(p_data->>'AuthorizeID', '')), 100), ''),
            NULLIF(left(btrim(COALESCE(p_data->>'Specialist', '')), 300), ''),
            NULLIF(left(btrim(COALESCE(p_data->>'Catagory', '')), 100), ''),
            NULLIF(left(btrim(COALESCE(p_data->>'Address', '')), 500), ''),
            NULLIF(left(btrim(COALESCE(p_data->>'ContactNo', '')), 60), ''),
            NULLIF(btrim(COALESCE(p_data->>'Email', '')), ''),
            NULLIF(v_npwp, ''),
            NULLIF(left(btrim(COALESCE(p_data->>'RekeningNo', '')), 60), ''),
            NULLIF(left(btrim(COALESCE(p_data->>'Bank', '')), 100), ''),
            'Review', now())
    RETURNING "VendorID" INTO v_id;

    RETURN jsonb_build_object('status', 'OK', 'vendorId', v_id);
END;
$$;

-- ---------- 2. Review / approval vendor ----------
CREATE OR REPLACE FUNCTION public.vendor_proses(p_token text, p_vendor_id bigint, p_decision text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_actor  bigint := operational.sesi_staf(p_token);
    v_status text;
    v_reject boolean := lower(btrim(COALESCE(p_decision, ''))) = 'reject';
    v_baru   text;
BEGIN
    IF v_actor IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;
    IF NOT v_reject AND lower(btrim(COALESCE(p_decision, ''))) <> 'approve' THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Keputusan harus Approve atau Reject.');
    END IF;
    SELECT "Status" INTO v_status FROM public.vendor WHERE "VendorID" = p_vendor_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'Vendor tidak ditemukan.');
    END IF;
    IF v_status NOT IN ('Review', 'Approval') THEN
        RETURN jsonb_build_object('status', 'DONE', 'message', 'Vendor ini sudah selesai diproses (status: ' || COALESCE(v_status, '-') || ').');
    END IF;
    IF NOT public.vendor_author_can(v_actor, v_status) THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Anda tidak punya wewenang ' || v_status || ' vendor (tag ' ||
            CASE WHEN v_status = 'Review' THEN 'RV' ELSE 'AV' END || ').');
    END IF;

    IF v_reject THEN
        UPDATE public.vendor SET "Status" = 'Rejected', "RejectedBy" = v_actor::text, "RejectedAt" = now(),
               "RejectReason" = NULLIF(left(btrim(COALESCE(p_reason, '')), 1000), '')
        WHERE "VendorID" = p_vendor_id;
        v_baru := 'Rejected';
    ELSIF v_status = 'Review' THEN
        UPDATE public.vendor SET "Status" = 'Approval', "ReviewedBy" = v_actor::text, "ReviewedAt" = now() WHERE "VendorID" = p_vendor_id;
        v_baru := 'Approval';
    ELSE
        UPDATE public.vendor SET "Status" = 'Approved', "ApprovedBy" = v_actor::text, "ApprovedAt" = now() WHERE "VendorID" = p_vendor_id;
        v_baru := 'Approved';
    END IF;
    RETURN jsonb_build_object('status', 'OK', 'statusVendor', v_baru);
END;
$$;

GRANT EXECUTE ON FUNCTION public.vendor_daftar(jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vendor_proses(text, bigint, text, text) TO anon, authenticated;

-- ---------- 3. Daftar approval RFQ tanpa PIN ----------
DO $$
DECLARE
    v_def text := pg_get_functiondef('public.get_pending_rfq_approvals(bigint)'::regprocedure);
    v_new text;
BEGIN
    IF v_def NOT LIKE '%rv."PIN"%' THEN RETURN; END IF;  -- sudah dipatch
    v_new := replace(v_def, 'rv."PIN"', 'NULL::bigint');
    EXECUTE v_new;
END $$;

-- ---------- 4. Kunci tabel RFQ & vendor ----------
DROP POLICY IF EXISTS "App can update rfq" ON public.rfq;
DROP POLICY IF EXISTS "Anyone can insert rfqQuote" ON public."rfqQuote";
DROP POLICY IF EXISTS "Anyone can update rfqQuote" ON public."rfqQuote";
DROP POLICY IF EXISTS "Anyone can update rfqVendor confirmation" ON public."rfqVendor";
DROP POLICY IF EXISTS "Anyone can insert rfqVendorTerm" ON public."rfqVendorTerm";
DROP POLICY IF EXISTS "Public can insert vendor registration" ON public.vendor;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['rfq', 'rfqVendor', 'rfqQuote', 'rfqVendorTerm', 'rfqDetail', 'vendor'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM anon, authenticated', t);
    END LOOP;
END $$;

-- Kolom PIN vendor tidak bisa dibaca dari luar (kolom lain tetap).
REVOKE SELECT ON public."rfqVendor" FROM anon, authenticated;
GRANT SELECT ("RFQVendorID", "RFQID", "VendorID", "SentDate", "Status", "SyncID", "ParentSyncID", "ConfirmationStatus",
              "ConfirmationDate", "Notes", "ManagementApproval", "ManagementApprovalBy", "ManagementApprovalDate")
    ON public."rfqVendor" TO anon, authenticated;

-- ---------- 5. Cabut RPC lama ----------
REVOKE EXECUTE ON FUNCTION public.create_rfq_and_invite(bigint[], bigint[], text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.process_rfq_approval(bigint, bigint, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.process_rfq_approval_by_qrcode(text, bigint, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.process_vendor_approval(bigint, bigint, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.process_vendor_approval_by_qrcode(text, bigint, text, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- ROLLBACK (kalau ada fitur RFQ/vendor yang rusak):
-- GRANT SELECT ON public."rfqVendor" TO anon, authenticated;
-- GRANT INSERT, UPDATE, DELETE ON public.rfq, public."rfqVendor", public."rfqQuote", public."rfqVendorTerm",
--   public."rfqDetail", public.vendor TO anon, authenticated;
-- CREATE POLICY "App can update rfq" ON public.rfq FOR UPDATE TO anon USING (true) WITH CHECK (true);
-- CREATE POLICY "Anyone can insert rfqQuote" ON public."rfqQuote" FOR INSERT TO anon WITH CHECK (true);
-- CREATE POLICY "Anyone can update rfqQuote" ON public."rfqQuote" FOR UPDATE TO anon USING (true) WITH CHECK (true);
-- CREATE POLICY "Anyone can update rfqVendor confirmation" ON public."rfqVendor" FOR UPDATE TO anon USING (true) WITH CHECK (true);
-- CREATE POLICY "Anyone can insert rfqVendorTerm" ON public."rfqVendorTerm" FOR INSERT TO anon WITH CHECK (true);
-- CREATE POLICY "Public can insert vendor registration" ON public.vendor FOR INSERT TO anon WITH CHECK (true);
-- GRANT EXECUTE ON FUNCTION public.create_rfq_and_invite(bigint[], bigint[], text, text, text),
--   public.process_rfq_approval(bigint, bigint, text, text), public.process_rfq_approval_by_qrcode(text, bigint, text, text),
--   public.process_vendor_approval(bigint, bigint, text, text), public.process_vendor_approval_by_qrcode(text, bigint, text, text)
--   TO anon, authenticated;
