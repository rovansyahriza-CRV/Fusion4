-- =====================================================================
-- S2 keamanan: Request barang & approval lewat RPC + kunci tabelnya
-- =====================================================================
-- Masalah:
-- - request & request_approval ditulis langsung dari browser (SMMS app.js,
--   Badge, Delivery, EUR, reportPdf.js) -> siapa pun bisa bikin/approve/ubah
--   status request lewat API.
-- - process_approval cek wewenang pakai format tag lama ("Review Request 014"),
--   padahal hampir semua orang pakai RR-014 / AR-014. RPC selalu menolak, lalu
--   browser jatuh ke fallback tulis langsung -> aturan wewenang gak pernah
--   benar-benar berlaku. process_approval(p_karyawan_id) & _by_qrcode juga
--   percaya Id/QrCodeId kiriman browser (bisa approve atas nama orang lain).
--
-- Perbaikan:
-- 1. request_buat(token SMMS, header, items): RefNo, status awal & RequestBy
--    ditentukan server.
-- 2. request_proses(token SMMS/Badge, refno, keputusan, alasan): wewenang
--    dicek di server dengan aturan PERSIS seperti tombol approval di SMMS &
--    Badge (Author+PIC: ALL/*, RR/AR, RR-<proyek>[area], "Review Request
--    <proyek>", dst). Label status tetap seperti sekarang.
-- 3. request_sinkron_status(refnos): status lanjutan (Dalam Proses RFQ,
--    PO Diterbitkan, Barang Diterima di Site, Selesai) DIHITUNG dari data
--    (rfqDetail -> PO approved -> delivery -> siteReceiving -> EUR), cuma
--    bisa naik. Aman dipanggil siapa saja.
-- 4. request_set_report(refno, fileId): link PDF dibangun server dari fileId
--    Drive (format divalidasi) -- bukan URL bebas dari browser.
-- 5. request & request_approval: RLS + baca saja; process_approval* dicabut.
-- =====================================================================

-- ---------- Helper ----------
-- Siapa yang memanggil: sesi SMMS/admin (fusion) atau sesi Badge.
CREATE OR REPLACE FUNCTION operational.sesi_staf(p_token text)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT COALESCE(operational.fusion_sesi(p_token), operational.badge_sesi(p_token));
$$;

-- Aturan sama dengan tombol approval di SMMS (app.js loadApprovalList) & Badge.
CREATE OR REPLACE FUNCTION operational.request_boleh_proses(p_actor bigint, p_level text, p_project text, p_area text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_tokens text[];
    v_proj   text := btrim(COALESCE(p_project, ''));
    v_clean  text := ltrim(btrim(COALESCE(p_project, '')), '0');
    v_area   text := upper(btrim(COALESCE(p_area, '')));
    v_tg     text[];
    v_kode   text;
    v_nama   text;
BEGIN
    SELECT array_agg(upper(btrim(t))) FILTER (WHERE btrim(t) <> '')
    INTO v_tokens
    FROM public."paswordTbl" p
    CROSS JOIN LATERAL regexp_split_to_table(
        COALESCE(p."Author", '') || ',' || COALESCE(NULLIF(btrim(p."PIC"), ''), p.pic, ''), ',') t
    WHERE p."Id" = p_actor AND COALESCE(p."IsActive", true);

    IF v_tokens IS NULL THEN RETURN false; END IF;
    IF v_tokens && ARRAY['ALL', '*'] THEN RETURN true; END IF;

    IF lower(p_level) = 'review' THEN v_kode := 'RR'; v_nama := 'REVIEW REQUEST';
    ELSIF lower(p_level) = 'approval' THEN v_kode := 'AR'; v_nama := 'APPROVAL REQUEST';
    ELSE RETURN false;
    END IF;

    -- Target proyek: dengan area (SMMS) maupun tanpa area (Badge) -- dua-duanya
    -- dipakai tombol yang sekarang, jadi dua-duanya tetap diterima.
    v_tg := array_remove(ARRAY[
        v_proj, NULLIF(v_clean, ''),
        CASE WHEN v_area <> '' THEN v_proj || v_area END,
        CASE WHEN v_area <> '' AND v_clean <> '' THEN v_clean || v_area END
    ], NULL);
    v_tg := array_remove(v_tg, '');

    RETURN EXISTS (
        SELECT 1 FROM unnest(v_tokens) t
        WHERE t = v_kode OR t = v_nama
           OR EXISTS (SELECT 1 FROM unnest(v_tg) g
                      WHERE t = v_kode || '-' || g
                         OR t = v_nama || ' ' || g
                         OR (t LIKE v_kode || '-%' AND right(t, length(g)) = g)
                         OR (t LIKE v_nama || '%' AND position(g IN t) > 0))
    );
END;
$$;

CREATE OR REPLACE FUNCTION operational.request_rank(p_status text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $$
    SELECT CASE btrim(COALESCE(p_status, ''))
        WHEN 'Menunggu Review' THEN 1
        WHEN 'Pending' THEN 1
        WHEN 'Menunggu Approval Direktur' THEN 2
        WHEN 'Menunggu Approval Akhir' THEN 2
        WHEN 'Disetujui' THEN 3
        WHEN 'Approved' THEN 3
        WHEN 'Dalam Proses RFQ' THEN 4
        WHEN 'PO Diterbitkan' THEN 5
        WHEN 'Barang Diterima di Site' THEN 6
        WHEN 'Selesai (Diterima End User)' THEN 7
        ELSE 0
    END;
$$;

-- ---------- 1. Buat request (SMMS) ----------
CREATE OR REPLACE FUNCTION public.request_buat(p_token text, p_header jsonb, p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_actor  bigint := operational.fusion_sesi(p_token);
    v_nama   text;
    v_refno  text;
    v_proj   text := btrim(COALESCE(p_header->>'projectId', ''));
    v_area   text := NULLIF(upper(btrim(COALESCE(p_header->>'area', ''))), '');
    v_foto   jsonb := p_header->'photoUrls';
    v_n      integer;
BEGIN
    IF v_actor IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;
    IF v_proj = '' THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Project wajib diisi.');
    END IF;
    IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 200 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Item request kosong / terlalu banyak.');
    END IF;
    IF v_foto IS NOT NULL AND (jsonb_typeof(v_foto) <> 'array' OR length(v_foto::text) > 3000000) THEN
        v_foto := NULL;
    END IF;
    IF jsonb_typeof(v_foto) = 'array' AND jsonb_array_length(v_foto) = 0 THEN v_foto := NULL; END IF;

    SELECT k."NamaPersonnel" INTO v_nama FROM public."karyawanTbl" k WHERE k."Id" = v_actor;
    v_refno := public.generate_refno();

    INSERT INTO public.request_approval ("RefNo", "ProjectID", "Area", "CurrentLevel")
    VALUES (v_refno, v_proj, v_area, 'Review');

    INSERT INTO public.request (
        "DATE_REQUEST", "PROJECTID", "Area", "PhotoUrls", "WO_NO", "ItemGroup", "ItemID",
        "ItemDescription", "QTY", "UNIT", "Duration", "DurUnit", "Purpose", "ExpectedDate",
        "WoID", "CostType", "CostFunction", "Status", "RequestBy", "RefNo")
    SELECT
        (now() AT TIME ZONE 'Asia/Makassar')::date,
        NULLIF(regexp_replace(v_proj, '[^0-9]', '', 'g'), '')::bigint,
        v_area,
        v_foto,
        NULLIF(left(p_header->>'woNo', 200), ''),
        COALESCE(NULLIF(left(it->>'ItemGroup', 60), ''), 'Material'),
        CASE WHEN (it->>'ItemID') ~ '^[0-9]+$' THEN (it->>'ItemID')::bigint END,
        left(COALESCE(it->>'ItemDescription', ''), 2000),
        CASE WHEN (it->>'QTY') ~ '^[0-9]+(\.[0-9]+)?$' THEN round((it->>'QTY')::numeric)::bigint ELSE 0 END,
        left(COALESCE(it->>'UNIT', ''), 40),
        CASE WHEN (it->>'Duration') ~ '^[0-9]+(\.[0-9]+)?$' THEN (it->>'Duration')::numeric END,
        left(COALESCE(it->>'DurUnit', ''), 40),
        left(COALESCE(p_header->>'purpose', ''), 2000),
        CASE WHEN (p_header->>'expectedDate') ~ '^\d{4}-\d{2}-\d{2}$' THEN (p_header->>'expectedDate')::date END,
        CASE WHEN (p_header->>'woId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (p_header->>'woId')::uuid END,
        NULLIF(left(p_header->>'costType', 40), ''),
        NULLIF(left(p_header->>'costFunction', 80), ''),
        'Menunggu Review',
        v_nama,
        v_refno
    FROM jsonb_array_elements(p_items) it;
    GET DIAGNOSTICS v_n = ROW_COUNT;

    RETURN jsonb_build_object('status', 'OK', 'refNo', v_refno, 'items', v_n, 'requestBy', v_nama);
END;
$$;

-- ---------- 2. Review / approve / tolak (SMMS & Badge) ----------
CREATE OR REPLACE FUNCTION public.request_proses(p_token text, p_refno text, p_decision text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_actor  bigint := operational.sesi_staf(p_token);
    v_appr   record;
    v_status text;
    v_level  text;
    v_reject boolean := lower(btrim(COALESCE(p_decision, ''))) = 'reject';
BEGIN
    IF v_actor IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;
    IF NOT v_reject AND lower(btrim(COALESCE(p_decision, ''))) <> 'approve' THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Keputusan harus Approve atau Reject.');
    END IF;

    SELECT * INTO v_appr FROM public.request_approval WHERE "RefNo" = p_refno FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'Data approval request tidak ditemukan.');
    END IF;
    IF v_appr."CurrentLevel" NOT IN ('Review', 'Approval') THEN
        RETURN jsonb_build_object('status', 'DONE', 'message', 'Request ini sudah selesai diproses (' || v_appr."CurrentLevel" || ').');
    END IF;
    IF NOT operational.request_boleh_proses(v_actor, v_appr."CurrentLevel", v_appr."ProjectID", v_appr."Area") THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS',
            'message', 'Anda tidak punya wewenang ' || v_appr."CurrentLevel" || ' request proyek ' || COALESCE(v_appr."ProjectID", '-') || '.');
    END IF;

    IF v_reject THEN
        UPDATE public.request_approval
        SET "CurrentLevel" = 'Rejected', "RejectedBy" = v_actor::text, "RejectedAt" = now(), "RejectReason" = left(p_reason, 1000)
        WHERE "RefNo" = p_refno;
        v_level := 'Rejected'; v_status := 'Ditolak';
    ELSIF v_appr."CurrentLevel" = 'Review' THEN
        UPDATE public.request_approval
        SET "CurrentLevel" = 'Approval', "ReviewedBy" = v_actor::text, "ReviewedAt" = now()
        WHERE "RefNo" = p_refno;
        v_level := 'Approval'; v_status := 'Menunggu Approval Direktur';
    ELSE
        UPDATE public.request_approval
        SET "CurrentLevel" = 'Approved', "ApprovedBy" = v_actor::text, "ApprovedAt" = now()
        WHERE "RefNo" = p_refno;
        v_level := 'Approved'; v_status := 'Disetujui';
    END IF;

    UPDATE public.request SET "Status" = v_status WHERE "RefNo" = p_refno;

    RETURN jsonb_build_object('status', 'OK', 'currentLevel', v_level, 'statusRequest', v_status,
        'wasReview', v_appr."CurrentLevel" = 'Review');
END;
$$;

-- ---------- 3. Status lanjutan dihitung dari data ----------
CREATE OR REPLACE FUNCTION public.request_sinkron_status(p_refnos text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_n integer;
BEGIN
    WITH turunan AS (
        SELECT r."ID",
            CASE
                WHEN EXISTS (SELECT 1 FROM public."rfqDetail" rd
                    JOIN public."purchaseOrderDetail" pod ON pod."RFQDetailID" = rd."RFQDetailID"
                    JOIN public.delivery dl ON dl."PODetailID" = pod."PODetailID"
                    JOIN public."siteReceiving" sr ON sr."DeliveryID" = dl."DeliveryID"
                    JOIN public."endUserReceiving" e ON e."ReceivingID" = sr."ReceivingID"
                    WHERE rd."RequestID" = r."ID") THEN 'Selesai (Diterima End User)'
                WHEN EXISTS (SELECT 1 FROM public."rfqDetail" rd
                    JOIN public."purchaseOrderDetail" pod ON pod."RFQDetailID" = rd."RFQDetailID"
                    JOIN public.delivery dl ON dl."PODetailID" = pod."PODetailID"
                    JOIN public."siteReceiving" sr ON sr."DeliveryID" = dl."DeliveryID"
                    WHERE rd."RequestID" = r."ID") THEN 'Barang Diterima di Site'
                WHEN EXISTS (SELECT 1 FROM public."rfqDetail" rd
                    JOIN public."purchaseOrder" po ON po."RFQID" = rd."RFQID" AND po."ManagementApproval" = 'Approved'
                    WHERE rd."RequestID" = r."ID") THEN 'PO Diterbitkan'
                WHEN EXISTS (SELECT 1 FROM public."rfqDetail" rd WHERE rd."RequestID" = r."ID") THEN 'Dalam Proses RFQ'
            END AS baru
        FROM public.request r
        WHERE (p_refnos IS NULL OR r."RefNo" = ANY (p_refnos))
          AND COALESCE(r."Status", '') NOT IN ('Ditolak', 'Rejected')
    )
    UPDATE public.request r
    SET "Status" = t.baru
    FROM turunan t
    WHERE r."ID" = t."ID" AND t.baru IS NOT NULL
      AND operational.request_rank(t.baru) > operational.request_rank(r."Status");
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN jsonb_build_object('status', 'OK', 'updated', v_n);
END;
$$;

-- ---------- 4. Link PDF laporan ----------
CREATE OR REPLACE FUNCTION public.request_set_report(p_refno text, p_file_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_n integer;
BEGIN
    IF p_file_id IS NULL OR p_file_id !~ '^[A-Za-z0-9_-]{10,200}$' THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'File ID Drive tidak valid.');
    END IF;
    UPDATE public.request
    SET "ReportURL" = 'https://drive.google.com/file/d/' || p_file_id || '/view',
        "ReportFileID" = p_file_id
    WHERE "RefNo" = p_refno;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN
        RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'RefNo tidak ditemukan.');
    END IF;
    RETURN jsonb_build_object('status', 'OK', 'updated', v_n);
END;
$$;

-- ---------- 5. Hak eksekusi & kunci tabel ----------
REVOKE ALL ON FUNCTION operational.sesi_staf(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION operational.request_boleh_proses(bigint, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_buat(text, jsonb, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_proses(text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_sinkron_status(text[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_set_report(text, text) TO anon, authenticated;
