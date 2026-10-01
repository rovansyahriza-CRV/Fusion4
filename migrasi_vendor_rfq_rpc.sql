-- =====================================================================
-- S3a keamanan: halaman vendor (rfq-quote, rfq-confirm) lewat RPC
-- =====================================================================
-- Masalah:
-- - PIN vendor dikirim ke browser lalu dicocokkan di sana (siapa pun bisa
--   lihat PIN-nya), tanpa batas percobaan.
-- - Penawaran, syarat komersial & konfirmasi ditulis langsung ke tabel;
--   Qty & PPN dihitung di browser; ID penawaran "ambil max lalu +1".
-- - Konfirmasi vendor membuat draft PO dengan TotalAmount & harga per item
--   dari browser -> vendor bisa ubah harga PO-nya sendiri.
--
-- Perbaikan:
-- 1. vendor_rfq_info: info minimal sebelum PIN (nama, email disamarkan, tahap).
-- 2. vendor_rfq_masuk: PIN dicek server, salah 5x per undangan dikunci 15 menit,
--    sesi vendor 24 jam khusus 1 undangan (RFQVendorID).
-- 3. vendor_rfq_data / vendor_rfq_kirim_penawaran / vendor_rfq_konfirmasi:
--    Qty dari rfqDetail, PPN 11% dihitung server, ID penawaran dibuat server.
-- 4. operational.po_draft_dari_rfqvendor: draft PO dari harga yang tersimpan
--    (rumus sama dengan versi browser: item terpilih + mobilisasi + biaya lain
--    + PPN). Dipakai bersama nanti oleh SMMS & Badge (S3b/S4).
-- Tabel belum dikunci di sini (penulis internal SMMS/Badge pindah di S3b);
-- penguncian + tutup kolom PIN di S3c.
-- =====================================================================

CREATE TABLE IF NOT EXISTS operational.vendor_sessions (
    token_hash     bytea PRIMARY KEY,
    rfqvendor_id   bigint NOT NULL,
    expires_at     timestamptz NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON operational.vendor_sessions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION operational.vendor_sesi(p_token text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT s.rfqvendor_id
    FROM operational.vendor_sessions s
    WHERE s.token_hash = sha256(convert_to(COALESCE(p_token, ''), 'UTF8'))
      AND s.expires_at > now();
$$;

-- Semua yang dibutuhkan halaman vendor -- TANPA PIN.
CREATE OR REPLACE FUNCTION operational.vendor_rfq_payload(p_rv bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT jsonb_build_object(
        'rfq', (SELECT jsonb_build_object('RFQID', r."RFQID", 'NoRFQ', r."NoRFQ", 'DeliveryPoint', r."DeliveryPoint",
                                          'Notes', r."Notes", 'Status', r."Status")
                FROM public.rfq r WHERE r."RFQID" = rv."RFQID"),
        'vendor', (SELECT jsonb_build_object('VendorID', v."VendorID", 'VendorName', v."VendorName", 'Email', v."Email")
                   FROM public.vendor v WHERE v."VendorID" = rv."VendorID"),
        'rfqVendor', jsonb_build_object('RFQVendorID', rv."RFQVendorID", 'RFQID', rv."RFQID", 'VendorID', rv."VendorID",
                                        'Status', rv."Status", 'ConfirmationStatus', rv."ConfirmationStatus",
                                        'ManagementApproval', rv."ManagementApproval", 'Notes', rv."Notes"),
        'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('RFQDetailID', d."RFQDetailID", 'ItemDescription', d."ItemDescription",
                                                              'Qty', d."Qty", 'Unit', d."Unit", 'ItemID', d."ItemID",
                                                              'ItemGroup', (SELECT q."ItemGroup" FROM public.request q WHERE q."ID" = d."RequestID"))
                                             ORDER BY d."RFQDetailID")
                           FROM public."rfqDetail" d WHERE d."RFQID" = rv."RFQID"), '[]'::jsonb),
        'quotes', COALESCE((SELECT jsonb_agg(jsonb_build_object('RFQQuoteID', q."RFQQuoteID", 'RFQDetailID', q."RFQDetailID",
                                                               'UnitPrice', q."UnitPrice", 'Qty', q."Qty",
                                                               'VendorDeliveryDate', q."VendorDeliveryDate", 'IsSelected', q."IsSelected"))
                            FROM public."rfqQuote" q
                            JOIN public."rfqDetail" d ON d."RFQDetailID" = q."RFQDetailID"
                            WHERE d."RFQID" = rv."RFQID" AND q."VendorID" = rv."VendorID"), '[]'::jsonb),
        'term', (SELECT to_jsonb(t) - 'RFQVendorTermID'
                 FROM public."rfqVendorTerm" t WHERE t."RFQVendorID" = rv."RFQVendorID"
                 ORDER BY t."RFQVendorTermID" DESC LIMIT 1)
    )
    FROM public."rfqVendor" rv
    WHERE rv."RFQVendorID" = p_rv;
$$;

-- ---------- Draft PO dari harga yang tersimpan ----------
CREATE OR REPLACE FUNCTION operational.po_draft_dari_rfqvendor(p_rv bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_rv     record;
    v_term   record;
    v_po     bigint;
    v_sub    numeric;
    v_isso   boolean;
    v_type   text;
    v_next   bigint;
BEGIN
    SELECT * INTO v_rv FROM public."rfqVendor" WHERE "RFQVendorID" = p_rv;
    IF NOT FOUND THEN RETURN NULL; END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('po-draft:' || v_rv."RFQID" || ':' || v_rv."VendorID", 0));
    SELECT "POID" INTO v_po FROM public."purchaseOrder"
    WHERE "RFQID" = v_rv."RFQID" AND "VendorID" = v_rv."VendorID" ORDER BY "POID" LIMIT 1;
    IF v_po IS NOT NULL THEN RETURN v_po; END IF;

    CREATE TEMP TABLE IF NOT EXISTS _menang (rfqdetail_id bigint, qty numeric, harga numeric, kirim date,
        deskripsi text, unit text, item_id bigint, item_group text) ON COMMIT DROP;
    TRUNCATE _menang;
    INSERT INTO _menang
    SELECT d."RFQDetailID", COALESCE(q."Qty", 0), COALESCE(q."UnitPrice", 0), q."VendorDeliveryDate",
           COALESCE(d."ItemDescription", '-'), COALESCE(d."Unit", ''), d."ItemID",
           (SELECT r."ItemGroup" FROM public.request r WHERE r."ID" = d."RequestID")
    FROM public."rfqQuote" q
    JOIN public."rfqDetail" d ON d."RFQDetailID" = q."RFQDetailID"
    WHERE d."RFQID" = v_rv."RFQID" AND q."VendorID" = v_rv."VendorID" AND q."IsSelected" = 'Yes';

    IF NOT EXISTS (SELECT 1 FROM _menang) THEN RETURN NULL; END IF;

    SELECT * INTO v_term FROM public."rfqVendorTerm"
    WHERE "RFQVendorID" = p_rv ORDER BY "RFQVendorTermID" DESC LIMIT 1;

    SELECT sum(qty * harga),
           bool_or(lower(COALESCE(item_group, '')) LIKE '%service%' OR lower(deskripsi) LIKE '%jasa%')
    INTO v_sub, v_isso FROM _menang;
    v_type := CASE WHEN v_isso THEN 'SO' ELSE 'PO' END;
    SELECT COALESCE(max("POID"), 0) + 1 INTO v_next FROM public."purchaseOrder";

    INSERT INTO public."purchaseOrder" ("RFQID", "RFQVendorID", "VendorID", "DocType", "DocNumber", "TotalAmount",
                                        "Status", "CreatedDate", "DeliveryPoint")
    VALUES (v_rv."RFQID", p_rv, v_rv."VendorID", v_type,
            v_type || '-' || to_char(now() AT TIME ZONE 'Asia/Makassar', 'YYYYMMDD') || '-' || lpad(v_next::text, 4, '0'),
            COALESCE(v_sub, 0) + COALESCE(v_term."MobilisasiCost", 0) + COALESCE(v_term."OtherServiceCost", 0) + COALESCE(v_term."PPNAmount", 0),
            'Draft', now(), (SELECT "DeliveryPoint" FROM public.rfq WHERE "RFQID" = v_rv."RFQID"))
    RETURNING "POID" INTO v_po;

    INSERT INTO public."purchaseOrderDetail" ("POID", "RFQDetailID", "ItemDescription", "Unit", "Qty", "UnitPrice",
                                              "Subtotal", "VendorDeliveryDate", "ItemGroup", "ItemID")
    SELECT v_po, rfqdetail_id, deskripsi, unit, qty, harga, qty * harga, kirim::text, item_group, item_id FROM _menang;

    RETURN v_po;
END;
$$;

-- ---------- 1. Info sebelum PIN ----------
CREATE OR REPLACE FUNCTION public.vendor_rfq_info(p_rfqid bigint, p_vendorid bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT COALESCE((
        SELECT jsonb_build_object(
            'status', 'OK',
            'noRFQ', r."NoRFQ",
            'vendorName', v."VendorName",
            'emailMasked', CASE WHEN v."Email" LIKE '%@%'
                                THEN left(split_part(v."Email", '@', 1), 2) || '***@' || split_part(v."Email", '@', 2)
                                ELSE NULL END,
            'tahap', CASE
                WHEN rv."ConfirmationStatus" = 'Confirmed' THEN 'SUDAH_KONFIRMASI'
                WHEN rv."ConfirmationStatus" = 'Rejected' THEN 'SUDAH_TOLAK'
                WHEN rv."ManagementApproval" = 'Approved' AND rv."Status" = 'Approved' THEN 'PEMENANG'
                WHEN rv."Status" IN ('Tidak Terpilih', 'Ditolak Management') OR rv."ManagementApproval" = 'Rejected' THEN 'DITUTUP'
                WHEN rv."Status" = 'Diusulkan' THEN 'DIEVALUASI'
                ELSE 'PENAWARAN' END)
        FROM public."rfqVendor" rv
        JOIN public.rfq r ON r."RFQID" = rv."RFQID"
        LEFT JOIN public.vendor v ON v."VendorID" = rv."VendorID"
        WHERE rv."RFQID" = p_rfqid AND rv."VendorID" = p_vendorid
        LIMIT 1), jsonb_build_object('status', 'NOT_FOUND', 'message', 'Undangan RFQ tidak ditemukan.'));
$$;

-- ---------- 2. Masuk pakai PIN ----------
CREATE OR REPLACE FUNCTION public.vendor_rfq_masuk(p_rfqid bigint, p_vendorid bigint, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_rv       record;
    v_key      text;
    v_attempts integer;
    v_token    text;
BEGIN
    SELECT * INTO v_rv FROM public."rfqVendor" WHERE "RFQID" = p_rfqid AND "VendorID" = p_vendorid LIMIT 1;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'Undangan RFQ tidak ditemukan.');
    END IF;

    v_key := 'vendor:' || v_rv."RFQVendorID";
    PERFORM pg_advisory_xact_lock(hashtextextended(v_key, 0));
    DELETE FROM operational.setlokasi_pin_attempts WHERE window_start < now() - interval '15 minutes';
    SELECT attempts INTO v_attempts FROM operational.setlokasi_pin_attempts WHERE device_id = v_key;
    IF COALESCE(v_attempts, 0) >= 5 THEN
        RETURN jsonb_build_object('status', 'LOCKED', 'message', 'Salah PIN 5x. Coba lagi 15 menit lagi.');
    END IF;

    IF v_rv."PIN" IS NULL OR btrim(COALESCE(p_pin, '')) !~ '^[0-9]{1,9}$' OR btrim(p_pin)::bigint <> v_rv."PIN" THEN
        INSERT INTO operational.setlokasi_pin_attempts VALUES (v_key, 1, now())
        ON CONFLICT (device_id) DO UPDATE SET attempts = operational.setlokasi_pin_attempts.attempts + 1
        RETURNING attempts INTO v_attempts;
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'PIN tidak sesuai. Periksa kembali email undangan Anda.',
                                  'sisa', GREATEST(5 - v_attempts, 0));
    END IF;
    DELETE FROM operational.setlokasi_pin_attempts WHERE device_id = v_key;

    v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    DELETE FROM operational.vendor_sessions WHERE expires_at < now();
    INSERT INTO operational.vendor_sessions (token_hash, rfqvendor_id, expires_at)
    VALUES (sha256(convert_to(v_token, 'UTF8')), v_rv."RFQVendorID", now() + interval '24 hours');

    RETURN jsonb_build_object('status', 'OK', 'token', v_token, 'data', operational.vendor_rfq_payload(v_rv."RFQVendorID"));
END;
$$;

CREATE OR REPLACE FUNCTION public.vendor_rfq_data(p_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_rv bigint := operational.vendor_sesi(p_token);
BEGIN
    IF v_rv IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis. Masukkan PIN lagi.');
    END IF;
    RETURN jsonb_build_object('status', 'OK', 'data', operational.vendor_rfq_payload(v_rv));
END;
$$;

-- ---------- 3. Kirim / perbarui penawaran ----------
CREATE OR REPLACE FUNCTION public.vendor_rfq_kirim_penawaran(p_token text, p_items jsonb, p_term jsonb, p_notes text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_rvid    bigint := operational.vendor_sesi(p_token);
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
    IF v_rvid IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis. Masukkan PIN lagi.');
    END IF;
    SELECT * INTO v_rv FROM public."rfqVendor" WHERE "RFQVendorID" = v_rvid FOR UPDATE;
    IF v_rv."Status" IN ('Diusulkan', 'Approved', 'Tidak Terpilih', 'Ditolak Management')
       OR COALESCE(v_rv."ManagementApproval", '') IN ('Approved', 'Rejected') THEN
        RETURN jsonb_build_object('status', 'LOCKED', 'message', 'Pemasukan penawaran untuk RFQ ini sudah ditutup.');
    END IF;
    IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Data harga tidak valid.');
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

    DELETE FROM public."rfqVendorTerm" WHERE "RFQVendorID" = v_rvid;
    INSERT INTO public."rfqVendorTerm" ("RFQVendorID", "MobilisasiCost", "OtherServiceCost", "OtherServiceDescription",
                                        "PPNAmount", "PaymentTermType", "DPPercentage", "SubmitDate")
    VALUES (v_rvid, v_mob, v_other, NULLIF(left(btrim(COALESCE(p_term->>'otherDesc', '')), 500), ''), v_ppn, v_pay, v_dp, now());

    UPDATE public."rfqVendor"
    SET "ConfirmationStatus" = 'Submitted',
        "ConfirmationDate" = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        "Notes" = NULLIF(left(btrim(COALESCE(p_notes, '')), 2000), '')
    WHERE "RFQVendorID" = v_rvid;

    RETURN jsonb_build_object('status', 'OK', 'grandTotal', v_sub + v_mob + v_other + v_ppn,
                              'ppn', v_ppn, 'data', operational.vendor_rfq_payload(v_rvid));
EXCEPTION WHEN SQLSTATE 'P0001' THEN
    RETURN jsonb_build_object('status', 'INVALID', 'message', SQLERRM);
END;
$$;

-- ---------- 4. Konfirmasi kesediaan pemenang ----------
CREATE OR REPLACE FUNCTION public.vendor_rfq_konfirmasi(p_token text, p_decision text, p_notes text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_rvid bigint := operational.vendor_sesi(p_token);
    v_rv   record;
    v_dec  text := CASE lower(btrim(COALESCE(p_decision, ''))) WHEN 'confirmed' THEN 'Confirmed' WHEN 'rejected' THEN 'Rejected' END;
    v_po   bigint;
BEGIN
    IF v_rvid IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis. Masukkan PIN lagi.');
    END IF;
    IF v_dec IS NULL THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Keputusan tidak valid.');
    END IF;
    SELECT * INTO v_rv FROM public."rfqVendor" WHERE "RFQVendorID" = v_rvid FOR UPDATE;
    IF v_rv."ManagementApproval" IS DISTINCT FROM 'Approved' OR v_rv."Status" IS DISTINCT FROM 'Approved' THEN
        RETURN jsonb_build_object('status', 'NOT_WINNER', 'message', 'RFQ ini belum di-approve Management, atau Anda bukan vendor terpilih.');
    END IF;
    IF v_rv."ConfirmationStatus" IN ('Confirmed', 'Rejected') THEN
        RETURN jsonb_build_object('status', 'DONE', 'message', 'Anda sudah memberi keputusan untuk RFQ ini.', 'keputusan', v_rv."ConfirmationStatus");
    END IF;

    UPDATE public."rfqVendor"
    SET "ConfirmationStatus" = v_dec,
        "ConfirmationDate" = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        "Notes" = NULLIF(left(btrim(COALESCE(p_notes, '')), 2000), '')
    WHERE "RFQVendorID" = v_rvid;

    UPDATE public.rfq
    SET "Status" = CASE WHEN v_dec = 'Confirmed' THEN 'Vendor Terkonfirmasi' ELSE 'Vendor Menolak' END
    WHERE "RFQID" = v_rv."RFQID";

    IF v_dec = 'Confirmed' THEN
        v_po := operational.po_draft_dari_rfqvendor(v_rvid);
    END IF;

    RETURN jsonb_build_object('status', 'OK', 'keputusan', v_dec, 'poid', v_po);
END;
$$;

REVOKE ALL ON FUNCTION operational.vendor_sesi(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION operational.vendor_rfq_payload(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION operational.po_draft_dari_rfqvendor(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vendor_rfq_info(bigint, bigint) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vendor_rfq_masuk(bigint, bigint, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vendor_rfq_data(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vendor_rfq_kirim_penawaran(text, jsonb, jsonb, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vendor_rfq_konfirmasi(text, text, text) TO anon, authenticated;
