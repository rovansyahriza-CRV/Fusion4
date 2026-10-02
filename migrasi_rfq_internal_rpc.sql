-- =====================================================================
-- S3b keamanan: alur RFQ internal (SMMS & Badge) lewat RPC
-- =====================================================================
-- Masalah: buat RFQ, input penawaran oleh admin, usulan pemenang, approve /
-- tolak seleksi vendor, link PDF RFQ, status "PO Diterbitkan" ditulis langsung
-- dari browser. RPC lama (create_rfq_and_invite, process_rfq_approval*) bisa
-- dipanggil siapa saja / percaya Id-QrCodeId kiriman browser, dan cek
-- wewenangnya pakai format tag lama sehingga browser selalu jatuh ke fallback.
-- PIN vendor untuk email dibaca langsung dari tabel.
--
-- Perbaikan (wewenang = PERSIS tombol/daftar yang sekarang, digabung SMMS+Badge):
--   rfq  (Buat RFQ & Input Penawaran Admin): PIC RFQ / CREATE RFQ, Author RFQ*
--   svr  (Seleksi Vendor): PIC SVR / SRFQ / CREATE RFQ
--   asv  (Approval Seleksi Vendor): tag ASV / ASV-* / Approval Seleksi Vendor
--   ALL / * = boleh semua. MURNI dari tag (keputusan user 2026-10-02) -- jabatan
--   tidak dipakai; tag dibaca dari paswordTbl (Author + PIC) & karyawanTbl.Author.
-- 1. rfq_buat: bungkus create_rfq_and_invite + sesi + wewenang; PIN undangan
--    cuma dikembalikan ke pembuat RFQ (buat email).
-- 2. rfq_admin_penawaran: input penawaran atas nama vendor (inti sama dengan
--    halaman vendor: Qty dari RFQ, PPN & ID dihitung server).
-- 3. rfq_usulkan_pemenang: pilihan pemenang per item + vendor diusulkan.
-- 4. rfq_proses_seleksi (SMMS/Badge): approve/tolak, vendor lain jadi Tidak
--    Terpilih, draft PO dibuat server (po_draft_dari_rfqvendor); data email
--    (termasuk PIN) dikembalikan ke approver yang berwenang.
-- 5. rfq_set_report: link PDF RFQ / Seleksi dari fileId Drive.
-- 6. rfq_sinkron_status: "PO Diterbitkan" dihitung dari PO yang approved.
-- Penguncian tabel + tutup kolom PIN + cabut RPC lama: S3c.
-- =====================================================================

-- ---------- Wewenang staf ----------
CREATE OR REPLACE FUNCTION operational.staf_boleh(p_actor bigint, p_jenis text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
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
    END IF;
    RETURN false;
END;
$$;

-- ---------- Inti simpan penawaran (dipakai vendor & admin) ----------
CREATE OR REPLACE FUNCTION operational.rfq_simpan_penawaran(p_rv bigint, p_items jsonb, p_term jsonb, p_notes text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_rv      record;
    v_det     record;
    v_harga   numeric;
    v_kirim   date;
    v_it      jsonb;
    v_qid     text;
    v_next    bigint;
    v_sub     numeric := 0;
    v_ada     boolean := false;
    v_mob     numeric;
    v_other   numeric;
    v_ppn     numeric;
    v_pay     text;
    v_dp      numeric;
BEGIN
    SELECT * INTO v_rv FROM public."rfqVendor" WHERE "RFQVendorID" = p_rv;
    IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Data harga tidak valid.' USING ERRCODE = 'P0001';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('rfqquote-id', 0));

    FOR v_det IN SELECT * FROM public."rfqDetail" WHERE "RFQID" = v_rv."RFQID" ORDER BY "RFQDetailID" LOOP
        SELECT e INTO v_it FROM jsonb_array_elements(p_items) e WHERE (e->>'RFQDetailID') = v_det."RFQDetailID"::text LIMIT 1;
        v_harga := CASE WHEN (v_it->>'UnitPrice') ~ '^[0-9]+(\.[0-9]+)?$' THEN (v_it->>'UnitPrice')::numeric ELSE 0 END;
        v_kirim := CASE WHEN (v_it->>'VendorDeliveryDate') ~ '^\d{4}-\d{2}-\d{2}$' THEN (v_it->>'VendorDeliveryDate')::date END;
        IF v_harga > 0 THEN v_ada := true; END IF;
        v_sub := v_sub + v_harga * COALESCE(v_det."Qty", 0);

        SELECT "RFQQuoteID" INTO v_qid FROM public."rfqQuote"
        WHERE "RFQDetailID" = v_det."RFQDetailID" AND "VendorID" = v_rv."VendorID" LIMIT 1;
        IF v_qid IS NOT NULL THEN
            UPDATE public."rfqQuote"
            SET "UnitPrice" = v_harga, "Qty" = v_det."Qty", "VendorDeliveryDate" = v_kirim
            WHERE "RFQQuoteID" = v_qid;
        ELSE
            SELECT COALESCE(max("RFQQuoteID"::numeric), 0) + 1 INTO v_next
            FROM public."rfqQuote" WHERE "RFQQuoteID" ~ '^[0-9]+$';
            INSERT INTO public."rfqQuote" ("RFQQuoteID", "RFQDetailID", "VendorID", "UnitPrice", "Qty", "VendorDeliveryDate", "IsSelected")
            VALUES (v_next::text, v_det."RFQDetailID", v_rv."VendorID", v_harga, v_det."Qty", v_kirim, 'No');
        END IF;
        v_qid := NULL; v_it := NULL;
    END LOOP;

    IF NOT v_ada THEN
        RAISE EXCEPTION 'Harap isi harga satuan minimal 1 item.' USING ERRCODE = 'P0001';
    END IF;

    v_mob   := CASE WHEN (p_term->>'mobilisasi') ~ '^[0-9]+(\.[0-9]+)?$' THEN (p_term->>'mobilisasi')::numeric ELSE 0 END;
    v_other := CASE WHEN (p_term->>'otherCost') ~ '^[0-9]+(\.[0-9]+)?$' THEN (p_term->>'otherCost')::numeric ELSE 0 END;
    v_ppn := CASE p_term->>'ppnType'
        WHEN '11' THEN round((v_sub + v_mob + v_other) * 0.11)
        WHEN 'custom' THEN CASE WHEN (p_term->>'ppnAmount') ~ '^[0-9]+(\.[0-9]+)?$' THEN (p_term->>'ppnAmount')::numeric ELSE 0 END
        ELSE 0 END;
    v_pay := left(COALESCE(NULLIF(btrim(p_term->>'paymentTerm'), ''), 'Net 30'), 60);
    v_dp := CASE WHEN v_pay = 'DP + Pelunasan' AND (p_term->>'dpPercent') ~ '^[0-9]+(\.[0-9]+)?$'
                 THEN LEAST(GREATEST((p_term->>'dpPercent')::numeric, 0), 100) END;

    DELETE FROM public."rfqVendorTerm" WHERE "RFQVendorID" = p_rv;
    INSERT INTO public."rfqVendorTerm" ("RFQVendorID", "MobilisasiCost", "OtherServiceCost", "OtherServiceDescription",
                                        "PPNAmount", "PaymentTermType", "DPPercentage", "SubmitDate")
    VALUES (p_rv, v_mob, v_other, NULLIF(left(btrim(COALESCE(p_term->>'otherDesc', '')), 500), ''), v_ppn, v_pay, v_dp, now());

    UPDATE public."rfqVendor"
    SET "ConfirmationStatus" = 'Submitted',
        "ConfirmationDate" = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        "Notes" = NULLIF(left(btrim(COALESCE(p_notes, '')), 2000), '')
    WHERE "RFQVendorID" = p_rv;

    RETURN jsonb_build_object('grandTotal', v_sub + v_mob + v_other + v_ppn, 'ppn', v_ppn);
END;
$$;

-- Halaman vendor (S3a) sekarang pakai inti yang sama.
CREATE OR REPLACE FUNCTION public.vendor_rfq_kirim_penawaran(p_token text, p_items jsonb, p_term jsonb, p_notes text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_rvid bigint := operational.vendor_sesi(p_token);
    v_rv   record;
    v_hasil jsonb;
BEGIN
    IF v_rvid IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis. Masukkan PIN lagi.');
    END IF;
    SELECT * INTO v_rv FROM public."rfqVendor" WHERE "RFQVendorID" = v_rvid FOR UPDATE;
    IF v_rv."Status" IN ('Diusulkan', 'Approved', 'Tidak Terpilih', 'Ditolak Management')
       OR COALESCE(v_rv."ManagementApproval", '') IN ('Approved', 'Rejected') THEN
        RETURN jsonb_build_object('status', 'LOCKED', 'message', 'Pemasukan penawaran untuk RFQ ini sudah ditutup.');
    END IF;
    v_hasil := operational.rfq_simpan_penawaran(v_rvid, p_items, p_term, p_notes);
    RETURN jsonb_build_object('status', 'OK', 'data', operational.vendor_rfq_payload(v_rvid)) || v_hasil;
EXCEPTION WHEN SQLSTATE 'P0001' THEN
    RETURN jsonb_build_object('status', 'INVALID', 'message', SQLERRM);
END;
$$;

-- ---------- 1. Buat RFQ ----------
CREATE OR REPLACE FUNCTION public.rfq_buat(p_token text, p_request_ids bigint[], p_vendor_ids bigint[], p_notes text, p_delivery_point text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
-- 'public' (bukan ''): create_rfq_and_invite di live gak punya search_path sendiri dan
-- memakai nama tabel tanpa schema, jadi mewarisi search_path pemanggil.
SET search_path TO public, pg_temp
AS $$
DECLARE
    v_actor bigint := operational.fusion_sesi(p_token);
    v_nama  text;
    v_rows  jsonb;
BEGIN
    IF v_actor IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;
    IF NOT operational.staf_boleh(v_actor, 'rfq') THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Anda tidak punya hak membuat RFQ (PIC RFQ).');
    END IF;
    IF COALESCE(array_length(p_request_ids, 1), 0) = 0 OR COALESCE(array_length(p_vendor_ids, 1), 0) = 0 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Pilih minimal 1 item request dan 1 vendor.');
    END IF;
    SELECT k."NamaPersonnel" INTO v_nama FROM public."karyawanTbl" k WHERE k."Id" = v_actor;

    SELECT jsonb_agg(jsonb_build_object('rfqid', c.rfqid, 'norfq', c.norfq, 'vendorid', c.vendorid,
                                        'vendorname', c.vendorname, 'email', c.email, 'pin', c.pin))
    INTO v_rows
    FROM public.create_rfq_and_invite(p_request_ids, p_vendor_ids, v_nama,
                                      NULLIF(left(btrim(COALESCE(p_notes, '')), 2000), ''),
                                      NULLIF(left(btrim(COALESCE(p_delivery_point, '')), 300), '')) c;

    PERFORM public.request_sinkron_status(NULL);
    RETURN jsonb_build_object('status', 'OK', 'undangan', COALESCE(v_rows, '[]'::jsonb));
END;
$$;

-- ---------- 2. Input penawaran oleh admin ----------
CREATE OR REPLACE FUNCTION public.rfq_admin_penawaran(p_token text, p_rfqvendor_id bigint, p_items jsonb, p_term jsonb, p_notes text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_actor bigint := operational.fusion_sesi(p_token);
    v_rv    record;
    v_hasil jsonb;
BEGIN
    IF v_actor IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;
    IF NOT operational.staf_boleh(v_actor, 'rfq') THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Anda tidak punya hak input penawaran (PIC RFQ).');
    END IF;
    SELECT * INTO v_rv FROM public."rfqVendor" WHERE "RFQVendorID" = p_rfqvendor_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'Undangan vendor tidak ditemukan.');
    END IF;
    IF EXISTS (SELECT 1 FROM public."purchaseOrder" po
               WHERE po."RFQID" = v_rv."RFQID" AND po."Status" IN ('Approved', 'Barang Tiba di Site')) THEN
        RETURN jsonb_build_object('status', 'LOCKED', 'message', 'Penawaran ini sudah dikunci -- RFQ sudah ada pemenang & PO/SO sudah terbit.');
    END IF;
    v_hasil := operational.rfq_simpan_penawaran(p_rfqvendor_id, p_items, p_term, p_notes);
    RETURN jsonb_build_object('status', 'OK') || v_hasil;
EXCEPTION WHEN SQLSTATE 'P0001' THEN
    RETURN jsonb_build_object('status', 'INVALID', 'message', SQLERRM);
END;
$$;

-- ---------- 3. Usulkan pemenang ----------
-- p_pilihan: [{"RFQDetailID": .., "VendorID": ..}] (vendor pemenang per item);
-- p_vendor_terpilih: vendor yang dicentang "pilih".
CREATE OR REPLACE FUNCTION public.rfq_usulkan_pemenang(p_token text, p_rfqid bigint, p_pilihan jsonb, p_vendor_terpilih bigint[], p_notes text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_actor bigint := operational.fusion_sesi(p_token);
    v_det   record;
    v_menang bigint;
    v_n     integer;
BEGIN
    IF v_actor IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;
    IF NOT operational.staf_boleh(v_actor, 'svr') THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Anda tidak punya hak seleksi vendor (PIC SVR).');
    END IF;
    PERFORM 1 FROM public.rfq WHERE "RFQID" = p_rfqid FOR UPDATE;

    -- Vendor yang ikut seleksi = sama dengan layar: sudah kirim penawaran & belum diproses manajemen.
    CREATE TEMP TABLE IF NOT EXISTS _ikut (rfqvendor_id bigint, vendor_id bigint) ON COMMIT DROP;
    TRUNCATE _ikut;
    INSERT INTO _ikut SELECT "RFQVendorID", "VendorID" FROM public."rfqVendor"
    WHERE "RFQID" = p_rfqid AND "ConfirmationStatus" = 'Submitted' AND "ManagementApproval" IS NULL;

    IF NOT EXISTS (SELECT 1 FROM _ikut) THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Tidak ada vendor yang bisa diseleksi untuk RFQ ini.');
    END IF;
    IF COALESCE(array_length(p_vendor_terpilih, 1), 0) = 0
       OR EXISTS (SELECT 1 FROM unnest(p_vendor_terpilih) v WHERE v NOT IN (SELECT vendor_id FROM _ikut)) THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Vendor yang dipilih tidak valid untuk RFQ ini.');
    END IF;

    FOR v_det IN SELECT "RFQDetailID" FROM public."rfqDetail" WHERE "RFQID" = p_rfqid LOOP
        SELECT (e->>'VendorID')::bigint INTO v_menang
        FROM jsonb_array_elements(COALESCE(p_pilihan, '[]'::jsonb)) e
        WHERE (e->>'RFQDetailID') = v_det."RFQDetailID"::text AND (e->>'VendorID') ~ '^[0-9]+$'
        LIMIT 1;
        IF v_menang IS NOT NULL AND NOT (v_menang = ANY (p_vendor_terpilih)) THEN v_menang := NULL; END IF;

        UPDATE public."rfqQuote"
        SET "IsSelected" = CASE WHEN "VendorID" = v_menang THEN 'Yes' ELSE 'No' END
        WHERE "RFQDetailID" = v_det."RFQDetailID" AND "VendorID" IN (SELECT vendor_id FROM _ikut);
        v_menang := NULL;
    END LOOP;

    UPDATE public."rfqVendor" rv
    SET "Status" = CASE WHEN rv."VendorID" = ANY (p_vendor_terpilih) THEN 'Diusulkan' ELSE 'Tidak Terpilih' END,
        "Notes" = CASE WHEN rv."VendorID" = ANY (p_vendor_terpilih) THEN NULLIF(left(btrim(COALESCE(p_notes, '')), 2000), '') ELSE NULL END
    FROM _ikut i WHERE rv."RFQVendorID" = i.rfqvendor_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    RETURN jsonb_build_object('status', 'OK', 'vendorDiproses', v_n);
END;
$$;

-- ---------- 4. Approve / tolak seleksi (SMMS & Badge) ----------
CREATE OR REPLACE FUNCTION public.rfq_proses_seleksi(p_token text, p_rfqvendor_id bigint, p_decision text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_actor  bigint := operational.sesi_staf(p_token);
    v_nama   text;
    v_rv     record;
    v_reject boolean := lower(btrim(COALESCE(p_decision, ''))) = 'reject';
    v_po     bigint;
BEGIN
    IF v_actor IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;
    IF NOT v_reject AND lower(btrim(COALESCE(p_decision, ''))) <> 'approve' THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Keputusan harus Approve atau Reject.');
    END IF;
    IF NOT operational.staf_boleh(v_actor, 'asv') THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Anda tidak punya wewenang approval seleksi vendor (ASV).');
    END IF;
    SELECT * INTO v_rv FROM public."rfqVendor" WHERE "RFQVendorID" = p_rfqvendor_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'Data seleksi vendor tidak ditemukan.');
    END IF;
    IF v_rv."Status" IS DISTINCT FROM 'Diusulkan' OR v_rv."ManagementApproval" IS NOT NULL THEN
        RETURN jsonb_build_object('status', 'DONE', 'message', 'Seleksi vendor ini sudah diproses sebelumnya.');
    END IF;
    SELECT k."NamaPersonnel" INTO v_nama FROM public."karyawanTbl" k WHERE k."Id" = v_actor;

    IF v_reject THEN
        UPDATE public."rfqVendor"
        SET "Status" = 'Ditolak Management', "ManagementApproval" = 'Rejected', "ManagementApprovalBy" = v_nama,
            "ManagementApprovalDate" = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            "Notes" = NULLIF(left(btrim(COALESCE(p_reason, '')), 2000), '')
        WHERE "RFQVendorID" = p_rfqvendor_id;
        RETURN jsonb_build_object('status', 'OK', 'keputusan', 'Rejected');
    END IF;

    UPDATE public."rfqVendor"
    SET "Status" = 'Approved', "ManagementApproval" = 'Approved', "ManagementApprovalBy" = v_nama,
        "ManagementApprovalDate" = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    WHERE "RFQVendorID" = p_rfqvendor_id;
    UPDATE public."rfqVendor" SET "Status" = 'Tidak Terpilih'
    WHERE "RFQID" = v_rv."RFQID" AND "RFQVendorID" <> p_rfqvendor_id;
    UPDATE public.rfq SET "Status" = 'Seleksi Vendor Disetujui' WHERE "RFQID" = v_rv."RFQID";

    v_po := operational.po_draft_dari_rfqvendor(p_rfqvendor_id);

    RETURN jsonb_build_object('status', 'OK', 'keputusan', 'Approved', 'poid', v_po, 'approver', v_nama,
        'email', (SELECT jsonb_build_object('rfqid', v_rv."RFQID", 'vendorid', v_rv."VendorID", 'pin', v_rv."PIN",
                                            'norfq', r."NoRFQ", 'vendorname', v."VendorName", 'vendoremail', v."Email")
                  FROM public.rfq r LEFT JOIN public.vendor v ON v."VendorID" = v_rv."VendorID"
                  WHERE r."RFQID" = v_rv."RFQID"));
END;
$$;

-- ---------- 5. Link PDF RFQ / Seleksi ----------
CREATE OR REPLACE FUNCTION public.rfq_set_report(p_token text, p_rfqid bigint, p_jenis text, p_file_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_url text;
    v_n   integer;
BEGIN
    IF operational.sesi_staf(p_token) IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;
    IF p_file_id IS NULL OR p_file_id !~ '^[A-Za-z0-9_-]{10,200}$' THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'File ID Drive tidak valid.');
    END IF;
    v_url := 'https://drive.google.com/file/d/' || p_file_id || '/view';
    IF p_jenis = 'seleksi' THEN
        UPDATE public.rfq SET "SelectionReportURL" = v_url, "SelectionReportFileID" = p_file_id WHERE "RFQID" = p_rfqid;
    ELSIF p_jenis = 'rfq' THEN
        UPDATE public.rfq SET "ReportURL" = v_url, "ReportFileID" = p_file_id,
            "Status" = CASE WHEN "Status" = 'Menunggu Konfirmasi Vendor' THEN 'Menunggu Penawaran Vendor' ELSE "Status" END
        WHERE "RFQID" = p_rfqid;
    ELSE
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Jenis laporan tidak dikenal.');
    END IF;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'RFQ tidak ditemukan.'); END IF;
    RETURN jsonb_build_object('status', 'OK');
END;
$$;

-- ---------- 6. Status RFQ "PO Diterbitkan" dari data ----------
CREATE OR REPLACE FUNCTION public.rfq_sinkron_status(p_rfqid bigint DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE v_n integer;
BEGIN
    UPDATE public.rfq r SET "Status" = 'PO Diterbitkan'
    WHERE (p_rfqid IS NULL OR r."RFQID" = p_rfqid)
      AND r."Status" IS DISTINCT FROM 'PO Diterbitkan'
      AND EXISTS (SELECT 1 FROM public."purchaseOrder" po WHERE po."RFQID" = r."RFQID" AND po."ManagementApproval" = 'Approved');
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN jsonb_build_object('status', 'OK', 'updated', v_n);
END;
$$;

REVOKE ALL ON FUNCTION operational.staf_boleh(bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION operational.rfq_simpan_penawaran(bigint, jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rfq_buat(text, bigint[], bigint[], text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rfq_admin_penawaran(text, bigint, jsonb, jsonb, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rfq_usulkan_pemenang(text, bigint, jsonb, bigint[], text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rfq_proses_seleksi(text, bigint, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rfq_set_report(text, bigint, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rfq_sinkron_status(bigint) TO anon, authenticated;
