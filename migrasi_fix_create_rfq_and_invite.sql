-- =====================================================================================
-- MIGRASI PERBAIKAN FUNCTION RPC: create_rfq_and_invite
-- Mengatasi error: operator does not exist: text = numeric
-- =====================================================================================

DROP FUNCTION IF EXISTS create_rfq_and_invite(BIGINT[], BIGINT[], TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS create_rfq_and_invite(BIGINT[], BIGINT[], TEXT, TEXT);
DROP FUNCTION IF EXISTS create_rfq_and_invite(INT[], INT[], TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS create_rfq_and_invite(INT[], INT[], TEXT, TEXT);

CREATE OR REPLACE FUNCTION create_rfq_and_invite(
    p_request_ids BIGINT[],
    p_vendor_ids BIGINT[],
    p_created_by TEXT,
    p_notes TEXT DEFAULT NULL,
    p_delivery_point TEXT DEFAULT NULL
)
RETURNS TABLE (
    rfqid BIGINT,
    norfq TEXT,
    vendorid BIGINT,
    vendorname TEXT,
    email TEXT,
    pin INT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_rfqid BIGINT;
    v_norfq TEXT;
    v_date_str TEXT := TO_CHAR(NOW() AT TIME ZONE 'Asia/Makassar', 'YYYYMMDD');
    v_seq INT;
    v_req RECORD;
    v_ven RECORD;
    v_pin INT;
BEGIN
    -- 1. Hitung nomor sequence RFQ hari ini
    SELECT COALESCE(COUNT(*), 0) + 1 INTO v_seq
    FROM "rfq"
    WHERE "NoRFQ" LIKE 'RFQ-' || v_date_str || '-%';

    v_norfq := 'RFQ-' || v_date_str || '-' || LPAD(v_seq::TEXT, 4, '0');

    -- 2. Insert Header RFQ
    INSERT INTO "rfq" (
        "NoRFQ",
        "RFQDate",
        "CreatedBy",
        "Status",
        "Notes",
        "DeliveryPoint"
    )
    VALUES (
        v_norfq,
        NOW(),
        COALESCE(p_created_by, 'System'),
        'Menunggu Konfirmasi Vendor',
        p_notes,
        p_delivery_point
    )
    RETURNING "RFQID" INTO v_rfqid;

    -- 3. Insert Items ke rfqDetail dari table request
    IF p_request_ids IS NOT NULL AND array_length(p_request_ids, 1) > 0 THEN
        FOR v_req IN
            SELECT
                r."ID"::BIGINT AS req_id,
                COALESCE(r."ItemID"::BIGINT, 0) AS item_id,
                COALESCE(r."ItemDescription", '') AS item_desc,
                COALESCE(r."UNIT", 'ea') AS unit,
                COALESCE(r."QTY"::NUMERIC, 1) AS qty
            FROM "request" r
            WHERE r."ID"::BIGINT = ANY(p_request_ids)
        LOOP
            INSERT INTO "rfqDetail" (
                "RFQID",
                "RequestID",
                "ItemID",
                "ItemDescription",
                "Unit",
                "Qty"
            )
            VALUES (
                v_rfqid,
                v_req.req_id,
                v_req.item_id,
                v_req.item_desc,
                v_req.unit,
                v_req.qty
            );
        END LOOP;

        -- Update Status di table request menjadi 'Dalam Proses RFQ'
        UPDATE "request"
        SET "Status" = 'Dalam Proses RFQ'
        WHERE "ID"::BIGINT = ANY(p_request_ids);
    END IF;

    -- 4. Insert Vendor ke rfqVendor dan siapkan return table
    IF p_vendor_ids IS NOT NULL AND array_length(p_vendor_ids, 1) > 0 THEN
        FOR v_ven IN
            SELECT
                v."VendorID"::BIGINT AS ven_id,
                COALESCE(v."VendorName", 'Vendor') AS ven_name,
                COALESCE(v."Email", '') AS ven_email
            FROM "vendor" v
            WHERE v."VendorID"::BIGINT = ANY(p_vendor_ids)
        LOOP
            -- Generate 5-digit PIN unik untuk vendor
            v_pin := FLOOR(10000 + RANDOM() * 90000)::INT;

            INSERT INTO "rfqVendor" (
                "RFQID",
                "VendorID",
                "SentDate",
                "Status",
                "PIN",
                "ConfirmationStatus"
            )
            VALUES (
                v_rfqid,
                v_ven.ven_id,
                NOW(),
                'Sent',
                v_pin,
                'Pending'
            );

            -- Return record undangan
            rfqid := v_rfqid;
            norfq := v_norfq;
            vendorid := v_ven.ven_id;
            vendorname := v_ven.ven_name;
            email := v_ven.ven_email;
            pin := v_pin;
            RETURN NEXT;
        END LOOP;
    END IF;

    RETURN;
END;
$$;
