-- =====================================================================
-- S4 keamanan: Purchase Order / Service Order lewat RPC + kunci tabel
-- =====================================================================
-- Wewenang MURNI TAG (keputusan user), ALL / * = super admin:
--   'spo' ajukan PO  : PIC PO / PO-xxx / APO / CREATE RFQ   (= menu "Submit PO" SMMS)
--   'apo' approve PO : APO / APO-xxx / APPROVAL PO/SO        (= menu "Approval PO" SMMS & Badge)
-- 1. po_ajukan(token, poids)            Draft -> Menunggu Approval
-- 2. po_proses(token, poid, keputusan)  Menunggu Approval -> Approved / Ditolak Management
-- 3. po_set_report(token, poid, fileId) link PDF disusun dari file ID Drive
-- 4. po_tandai_terkirim(token, poid)    SentDate (hanya PO Approved)
-- 5. po_sinkron_status(poids)           Approved -> Barang Tiba di Site, dihitung dari
--                                       siteReceiving (maju saja), tanpa sesi seperti request_sinkron_status
-- 6. purchaseOrder & purchaseOrderDetail: policy tulis "Anyone can ..." dihapus, hak tulis anon dicabut.
-- 7. RPC lama yang percaya Id/QrCodeId kiriman browser dicabut: process_po_approval(_by_qrcode),
--    get_pending_po_approvals(_by_qrcode), create_purchase_order_from_confirmation.
-- =====================================================================

-- ---------- Wewenang: tambah 'spo' & 'apo' ----------
CREATE OR REPLACE FUNCTION operational.staf_boleh(p_actor bigint, p_jenis text)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_pic    text[];
    v_auth   text[];
    v_kar    text[];
BEGIN
    SELECT
        COALESCE((SELECT array_agg(upper(btrim(t))) FILTER (WHERE btrim(t) <> '')
                  FROM regexp_split_to_table(COALESCE(NULLIF(btrim(p."PIC"), ''), p.pic, ''), ',') t), '{}'),
        COALESCE((SELECT array_agg(upper(btrim(t))) FILTER (WHERE btrim(t) <> '')
                  FROM regexp_split_to_table(COALESCE(p."Author", ''), ',') t), '{}'),
        COALESCE((SELECT array_agg(upper(btrim(t))) FILTER (WHERE btrim(t) <> '')
                  FROM regexp_split_to_table(COALESCE(k."Author", ''), ',') t), '{}')
    INTO v_pic, v_auth, v_kar
    FROM public."paswordTbl" p
    JOIN public."karyawanTbl" k ON k."Id" = p."Id"
    WHERE p."Id" = p_actor AND COALESCE(p."IsActive", true) AND COALESCE(k."IsActive", true);

    IF NOT FOUND THEN RETURN false; END IF;
    IF (v_pic || v_auth || v_kar) && ARRAY['ALL', '*'] THEN RETURN true; END IF;

    IF p_jenis = 'rfq' THEN
        RETURN v_pic && ARRAY['RFQ', 'CREATE RFQ']
            OR EXISTS (SELECT 1 FROM unnest(v_auth) a WHERE a = 'RFQ' OR a LIKE 'RFQ-%' OR a LIKE 'RFQ %');
    ELSIF p_jenis = 'svr' THEN
        RETURN v_pic && ARRAY['SVR', 'SRFQ', 'CREATE RFQ'];
    ELSIF p_jenis = 'asv' THEN
        RETURN EXISTS (SELECT 1 FROM unnest(v_auth || v_pic || v_kar) a
                       WHERE a = 'ASV' OR a LIKE 'ASV-%' OR a LIKE 'ASV %' OR a = 'APPROVAL SELEKSI VENDOR'
                          OR a LIKE 'APPROVAL SELEKSI VENDOR %' OR a LIKE 'APPROVAL SELEKSI VENDOR-%');
    ELSIF p_jenis = 'spo' THEN
        RETURN v_pic && ARRAY['PO', 'APO', 'CREATE RFQ']
            OR EXISTS (SELECT 1 FROM unnest(v_pic) a WHERE a LIKE 'PO-%');
    ELSIF p_jenis = 'apo' THEN
        RETURN EXISTS (SELECT 1 FROM unnest(v_auth || v_pic || v_kar) a
                       WHERE a = 'APO' OR a LIKE 'APO-%' OR a LIKE 'APO %' OR a LIKE 'APPROVAL PO/SO%');
    END IF;
    RETURN false;
END;
$function$;

-- ---------- 1. Ajukan ----------
CREATE OR REPLACE FUNCTION public.po_ajukan(p_token text, p_poids bigint[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_actor bigint := operational.sesi_staf(p_token);
    v_nama  text;
    v_n     integer;
BEGIN
    IF v_actor IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;
    IF NOT operational.staf_boleh(v_actor, 'spo') THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Anda tidak punya wewenang mengajukan PO/SO (tag PO / APO / CREATE RFQ).');
    END IF;
    IF p_poids IS NULL OR cardinality(p_poids) = 0 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Pilih minimal 1 PO/SO.');
    END IF;
    SELECT k."NamaPersonnel" INTO v_nama FROM public."karyawanTbl" k WHERE k."Id" = v_actor;
    UPDATE public."purchaseOrder"
    SET "Status" = 'Menunggu Approval', "SubmittedBy" = COALESCE(v_nama, v_actor::text), "SubmittedDate" = now()
    WHERE "POID" = ANY (p_poids) AND "Status" = 'Draft';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'Tidak ada PO/SO berstatus Draft yang dipilih.');
    END IF;
    RETURN jsonb_build_object('status', 'OK', 'diajukan', v_n);
END;
$$;

-- ---------- 2. Approve / Reject ----------
CREATE OR REPLACE FUNCTION public.po_proses(p_token text, p_poid bigint, p_decision text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_actor  bigint := operational.sesi_staf(p_token);
    v_reject boolean := lower(btrim(COALESCE(p_decision, ''))) = 'reject';
    v_nama   text;
    v_po     record;
BEGIN
    IF v_actor IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;
    IF NOT v_reject AND lower(btrim(COALESCE(p_decision, ''))) <> 'approve' THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Keputusan harus Approve atau Reject.');
    END IF;
    IF NOT operational.staf_boleh(v_actor, 'apo') THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Anda tidak punya wewenang approval PO/SO (tag APO).');
    END IF;
    SELECT "POID", "Status", "ManagementApproval", "RFQID" INTO v_po FROM public."purchaseOrder" WHERE "POID" = p_poid FOR UPDATE;
    IF v_po."POID" IS NULL THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'PO/SO tidak ditemukan.');
    END IF;
    IF v_po."Status" IS DISTINCT FROM 'Menunggu Approval' OR v_po."ManagementApproval" IS NOT NULL THEN
        RETURN jsonb_build_object('status', 'DONE', 'message', 'PO/SO ini sudah diproses sebelumnya (status: ' || COALESCE(v_po."Status", '-') || ').');
    END IF;
    SELECT k."NamaPersonnel" INTO v_nama FROM public."karyawanTbl" k WHERE k."Id" = v_actor;
    UPDATE public."purchaseOrder"
    SET "Status" = CASE WHEN v_reject THEN 'Ditolak Management' ELSE 'Approved' END,
        "ManagementApproval" = CASE WHEN v_reject THEN 'Rejected' ELSE 'Approved' END,
        "ManagementApprovalBy" = COALESCE(v_nama, v_actor::text),
        "ManagementApprovalDate" = now(),
        "Notes" = CASE WHEN v_reject THEN NULLIF(left(btrim(COALESCE(p_reason, '')), 1000), '') ELSE "Notes" END
    WHERE "POID" = p_poid;
    RETURN jsonb_build_object('status', 'OK', 'statusPo', CASE WHEN v_reject THEN 'Ditolak Management' ELSE 'Approved' END,
                              'rfqId', v_po."RFQID");
END;
$$;

-- ---------- 3. Link PDF ----------
CREATE OR REPLACE FUNCTION public.po_set_report(p_token text, p_poid bigint, p_file_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_n integer;
BEGIN
    IF operational.sesi_staf(p_token) IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;
    IF p_file_id IS NULL OR p_file_id !~ '^[A-Za-z0-9_-]{10,200}$' THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'File ID Drive tidak valid.');
    END IF;
    UPDATE public."purchaseOrder"
    SET "ReportURL" = 'https://drive.google.com/file/d/' || p_file_id || '/view', "ReportFileID" = p_file_id
    WHERE "POID" = p_poid;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'PO/SO tidak ditemukan.'); END IF;
    RETURN jsonb_build_object('status', 'OK');
END;
$$;

-- ---------- 4. Tandai terkirim ke vendor ----------
CREATE OR REPLACE FUNCTION public.po_tandai_terkirim(p_token text, p_poid bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_n integer;
BEGIN
    IF operational.sesi_staf(p_token) IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;
    UPDATE public."purchaseOrder" SET "SentDate" = now()
    WHERE "POID" = p_poid AND "ManagementApproval" = 'Approved';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'PO/SO approved tidak ditemukan.'); END IF;
    RETURN jsonb_build_object('status', 'OK');
END;
$$;

-- ---------- 5. Status dari data penerimaan (maju saja) ----------
CREATE OR REPLACE FUNCTION public.po_sinkron_status(p_poids bigint[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_n integer;
BEGIN
    UPDATE public."purchaseOrder" po
    SET "Status" = 'Barang Tiba di Site'
    WHERE (p_poids IS NULL OR po."POID" = ANY (p_poids))
      AND po."Status" = 'Approved'
      AND EXISTS (SELECT 1 FROM public.delivery d JOIN public."siteReceiving" s ON s."DeliveryID" = d."DeliveryID"
                  WHERE d."POID" = po."POID");
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN jsonb_build_object('status', 'OK', 'diperbarui', v_n);
END;
$$;

REVOKE ALL ON FUNCTION public.po_ajukan(text, bigint[]), public.po_proses(text, bigint, text, text),
    public.po_set_report(text, bigint, text), public.po_tandai_terkirim(text, bigint), public.po_sinkron_status(bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.po_ajukan(text, bigint[]), public.po_proses(text, bigint, text, text),
    public.po_set_report(text, bigint, text), public.po_tandai_terkirim(text, bigint), public.po_sinkron_status(bigint[])
    TO anon, authenticated;

-- ---------- 6. Kunci tabel ----------
DROP POLICY IF EXISTS "Anyone can insert purchaseOrder" ON public."purchaseOrder";
DROP POLICY IF EXISTS "Anyone can update purchaseOrder" ON public."purchaseOrder";
DROP POLICY IF EXISTS "Anyone can insert purchaseOrderDetail" ON public."purchaseOrderDetail";
DROP POLICY IF EXISTS "Anyone can update purchaseOrderDetail" ON public."purchaseOrderDetail";
ALTER TABLE public."purchaseOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."purchaseOrderDetail" ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public."purchaseOrder", public."purchaseOrderDetail" FROM anon, authenticated;

-- ---------- 7. Cabut RPC lama ----------
REVOKE EXECUTE ON FUNCTION public.process_po_approval(bigint, bigint, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.process_po_approval_by_qrcode(text, bigint, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_pending_po_approvals(bigint) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_pending_po_approvals_by_qrcode(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.create_purchase_order_from_confirmation(bigint) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------
-- ROLLBACK:
-- GRANT INSERT, UPDATE, DELETE ON public."purchaseOrder", public."purchaseOrderDetail" TO anon, authenticated;
-- CREATE POLICY "Anyone can insert purchaseOrder" ON public."purchaseOrder" FOR INSERT TO anon WITH CHECK (true);
-- CREATE POLICY "Anyone can update purchaseOrder" ON public."purchaseOrder" FOR UPDATE TO anon USING (true) WITH CHECK (true);
-- CREATE POLICY "Anyone can insert purchaseOrderDetail" ON public."purchaseOrderDetail" FOR INSERT TO anon WITH CHECK (true);
-- CREATE POLICY "Anyone can update purchaseOrderDetail" ON public."purchaseOrderDetail" FOR UPDATE TO anon USING (true) WITH CHECK (true);
-- GRANT EXECUTE ON FUNCTION public.process_po_approval(bigint,bigint,text,text), public.process_po_approval_by_qrcode(text,bigint,text,text),
--   public.get_pending_po_approvals(bigint), public.get_pending_po_approvals_by_qrcode(text),
--   public.create_purchase_order_from_confirmation(bigint) TO anon, authenticated;
-- ---------------------------------------------------------------------
