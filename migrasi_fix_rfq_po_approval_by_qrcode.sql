-- ==============================================================================
-- Migrasi: Fix Otorisasi & RPC Approval Seleksi Vendor (RFQ) & PO/SO via Digital Badge
-- ==============================================================================

-- 1. Function: get_pending_rfq_approvals_by_qrcode
CREATE OR REPLACE FUNCTION get_pending_rfq_approvals_by_qrcode(p_qrcode TEXT)
RETURNS TABLE (
    rfqvendorid BIGINT,
    rfqid BIGINT,
    vendorid BIGINT,
    pin BIGINT,
    norfq TEXT,
    diusulkanoleh TEXT,
    vendorname TEXT,
    vendoremail TEXT,
    totalpenawaran NUMERIC
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_id BIGINT;
    v_kualifikasi TEXT;
    v_author TEXT;
    v_pas_author TEXT;
    v_full_author TEXT;
    v_is_direktur BOOLEAN := FALSE;
    v_can_approve BOOLEAN := FALSE;
BEGIN
    SELECT "Id", "Kualifikasi", "Author"
    INTO v_id, v_kualifikasi, v_author
    FROM "karyawanTbl"
    WHERE LOWER(TRIM("QrCodeId")) = LOWER(TRIM(p_qrcode))
    LIMIT 1;

    IF v_id IS NULL THEN
        RETURN;
    END IF;

    SELECT "Author" INTO v_pas_author
    FROM "paswordTbl"
    WHERE "Id" = v_id
    LIMIT 1;

    v_full_author := UPPER(COALESCE(v_author, '') || ',' || COALESCE(v_pas_author, ''));

    IF LOWER(COALESCE(v_kualifikasi, '')) LIKE '%direktur%' THEN
        v_is_direktur := TRUE;
    END IF;

    IF v_is_direktur 
       OR v_full_author LIKE '%ALL%' 
       OR v_full_author LIKE '%*%' 
       OR v_full_author LIKE '%ASV%' 
       OR v_full_author LIKE '%SELEKSI%' 
       OR v_full_author LIKE '%RFQ%' THEN
        v_can_approve := TRUE;
    END IF;

    IF NOT v_can_approve THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT 
        rv."RFQVendorID"::BIGINT AS rfqvendorid,
        rv."RFQID"::BIGINT AS rfqid,
        rv."VendorID"::BIGINT AS vendorid,
        rv."PIN"::BIGINT AS pin,
        COALESCE(r."NoRFQ", 'RFQID-' || rv."RFQID"::TEXT) AS norfq,
        COALESCE(r."CreatedBy", '-') AS diusulkanoleh,
        COALESCE(v."VendorName", 'Vendor #' || rv."VendorID"::TEXT) AS vendorname,
        COALESCE(v."Email", '') AS vendoremail,
        (
            COALESCE((
                SELECT SUM(COALESCE(q."UnitPrice", 0) * COALESCE(q."Qty", 0))
                FROM "rfqQuote" q
                JOIN "rfqDetail" d ON q."RFQDetailID" = d."RFQDetailID"
                WHERE q."VendorID" = rv."VendorID" 
                  AND d."RFQID" = rv."RFQID"
                  AND q."IsSelected" = 'Yes'
            ), 0) + 
            COALESCE((
                SELECT COALESCE(t."MobilisasiCost", 0) + COALESCE(t."OtherServiceCost", 0) + COALESCE(t."PPNAmount", 0)
                FROM "rfqVendorTerm" t
                WHERE t."RFQVendorID" = rv."RFQVendorID"
                ORDER BY t."RFQVendorTermID" DESC
                LIMIT 1
            ), 0)
        )::NUMERIC AS totalpenawaran
    FROM "rfqVendor" rv
    JOIN "rfq" r ON rv."RFQID" = r."RFQID"
    JOIN "vendor" v ON rv."VendorID" = v."VendorID"
    WHERE rv."Status" = 'Diusulkan'
      AND rv."ManagementApproval" IS NULL;
END;
$$;


-- 2. Function: process_rfq_approval_by_qrcode
CREATE OR REPLACE FUNCTION process_rfq_approval_by_qrcode(
    p_qrcode TEXT,
    p_rfqvendorid BIGINT,
    p_decision TEXT,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_nama TEXT;
BEGIN
    SELECT "NamaPersonnel" INTO v_nama
    FROM "karyawanTbl"
    WHERE LOWER(TRIM("QrCodeId")) = LOWER(TRIM(p_qrcode))
    LIMIT 1;

    IF v_nama IS NULL THEN
        v_nama := 'Direktur';
    END IF;

    UPDATE "rfqVendor"
    SET "Status" = CASE WHEN p_decision = 'Approve' THEN 'Approved' ELSE 'Ditolak Management' END,
        "ManagementApproval" = CASE WHEN p_decision = 'Approve' THEN 'Approved' ELSE 'Rejected' END,
        "ManagementApprovalBy" = v_nama,
        "ManagementApprovalDate" = NOW(),
        "Notes" = COALESCE(p_reason, "Notes")
    WHERE "RFQVendorID" = p_rfqvendorid;

    IF p_decision = 'Approve' THEN
        UPDATE "rfqVendor"
        SET "Status" = 'Tidak Terpilih'
        WHERE "RFQID" = (SELECT "RFQID" FROM "rfqVendor" WHERE "RFQVendorID" = p_rfqvendorid)
          AND "RFQVendorID" <> p_rfqvendorid;

        UPDATE "rfq"
        SET "Status" = 'Seleksi Vendor Disetujui'
        WHERE "RFQID" = (SELECT "RFQID" FROM "rfqVendor" WHERE "RFQVendorID" = p_rfqvendorid);
    END IF;

    RETURN json_build_object('status', 'success', 'message', 'Hasil seleksi RFQ berhasil diproses.');
END;
$$;


-- 3. Function: get_pending_po_approvals_by_qrcode
CREATE OR REPLACE FUNCTION get_pending_po_approvals_by_qrcode(p_qrcode TEXT)
RETURNS TABLE (
    poid BIGINT,
    docnumber TEXT,
    doctype TEXT,
    vendorname TEXT,
    totalamount NUMERIC,
    status TEXT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_id BIGINT;
    v_kualifikasi TEXT;
    v_author TEXT;
    v_pas_author TEXT;
    v_full_author TEXT;
    v_is_direktur BOOLEAN := FALSE;
    v_can_approve BOOLEAN := FALSE;
BEGIN
    SELECT "Id", "Kualifikasi", "Author"
    INTO v_id, v_kualifikasi, v_author
    FROM "karyawanTbl"
    WHERE LOWER(TRIM("QrCodeId")) = LOWER(TRIM(p_qrcode))
    LIMIT 1;

    IF v_id IS NULL THEN
        RETURN;
    END IF;

    SELECT "Author" INTO v_pas_author
    FROM "paswordTbl"
    WHERE "Id" = v_id
    LIMIT 1;

    v_full_author := UPPER(COALESCE(v_author, '') || ',' || COALESCE(v_pas_author, ''));

    IF LOWER(COALESCE(v_kualifikasi, '')) LIKE '%direktur%' THEN
        v_is_direktur := TRUE;
    END IF;

    IF v_is_direktur 
       OR v_full_author LIKE '%ALL%' 
       OR v_full_author LIKE '%*%' 
       OR v_full_author LIKE '%APO%' 
       OR v_full_author LIKE '%PO%' 
       OR v_full_author LIKE '%SO%' THEN
        v_can_approve := TRUE;
    END IF;

    IF NOT v_can_approve THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT 
        po."POID"::BIGINT AS poid,
        po."DocNumber"::TEXT AS docnumber,
        COALESCE(po."DocType", 'PO')::TEXT AS doctype,
        COALESCE(v."VendorName", 'Vendor #' || po."VendorID"::TEXT)::TEXT AS vendorname,
        COALESCE(po."TotalAmount", 0)::NUMERIC AS totalamount,
        po."Status"::TEXT AS status
    FROM "purchaseOrder" po
    LEFT JOIN "vendor" v ON po."VendorID" = v."VendorID"
    WHERE po."Status" = 'Menunggu Approval'
      AND po."ManagementApproval" IS NULL;
END;
$$;


-- 4. Function: process_po_approval_by_qrcode
CREATE OR REPLACE FUNCTION process_po_approval_by_qrcode(
    p_qrcode TEXT,
    p_poid BIGINT,
    p_decision TEXT,
    p_reason TEXT DEFAULT NULL
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_nama TEXT;
BEGIN
    SELECT "NamaPersonnel" INTO v_nama
    FROM "karyawanTbl"
    WHERE LOWER(TRIM("QrCodeId")) = LOWER(TRIM(p_qrcode))
    LIMIT 1;

    IF v_nama IS NULL THEN
        v_nama := 'Direktur';
    END IF;

    UPDATE "purchaseOrder"
    SET "Status" = CASE WHEN p_decision = 'Approve' THEN 'Approved' ELSE 'Ditolak Management' END,
        "ManagementApproval" = CASE WHEN p_decision = 'Approve' THEN 'Approved' ELSE 'Rejected' END,
        "ManagementApprovalBy" = v_nama,
        "ManagementApprovalDate" = NOW(),
        "Notes" = COALESCE(p_reason, "Notes")
    WHERE "POID" = p_poid;

    IF p_decision = 'Approve' THEN
        UPDATE "rfq"
        SET "Status" = 'PO Diterbitkan'
        WHERE "RFQID" = (SELECT "RFQID" FROM "purchaseOrder" WHERE "POID" = p_poid);

        UPDATE "request"
        SET "Status" = 'PO Diterbitkan'
        WHERE "ID" IN (
            SELECT d."RequestID"
            FROM "rfqDetail" d
            JOIN "purchaseOrder" po ON d."RFQID" = po."RFQID"
            WHERE po."POID" = p_poid AND d."RequestID" IS NOT NULL
        );
    END IF;

    RETURN json_build_object('status', 'success', 'message', 'PO/SO berhasil diproses.');
END;
$$;
