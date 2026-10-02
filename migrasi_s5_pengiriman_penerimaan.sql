-- =====================================================================
-- S5 keamanan: pengiriman & penerimaan barang lewat RPC + kunci tabel
-- =====================================================================
-- Tabel delivery, siteReceiving, vendorReceiving, endUserReceiving, materialReturn
-- selama ini TANPA RLS (rollback 0a) -- siapa pun bisa tambah/ubah/hapus.
-- Keputusan user: petugas utama wajib sesi Badge (atau login SMMS); orang kedua
-- (end user penerima, petugas gudang retur) cukup scan wajah di HP -> dicatat id-nya.
--
-- Wewenang (kolom paswordTbl.Author, sama dengan halaman), ALL / * = super admin:
--   kirim  : "Pengirim barang <proyek>"
--   terima : "Penerima barang <proyek>"
--   serah  : "Penerima barang <proyek>" / "Serah Terima Barang <proyek>"
--   tv     : PIC TV / TRV / TERIMA VENDOR (menu Terima dari Vendor SMMS)
-- Proyek sebuah PO = PROJECTID request di RFQ-nya.
-- Jumlah dicek server: tidak bisa kirim/terima/serah/retur melebihi sisa.
-- =====================================================================

-- ---------- Wewenang: tambah 'tv' ----------
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
    ELSIF p_jenis = 'tv' THEN
        RETURN v_pic && ARRAY['TV', 'TRV', 'TERIMA VENDOR'];
    END IF;
    RETURN false;
END;
$function$;

-- ---------- Helper ----------
-- Proyek dari tag Author: jenis kirim / terima / serah.
CREATE OR REPLACE FUNCTION operational.s5_proyek_tag(p_actor bigint, p_jenis text)
RETURNS bigint[]
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT COALESCE(array_agg(DISTINCT (m[2])::bigint), '{}')
    FROM public."paswordTbl" p
    CROSS JOIN LATERAL regexp_split_to_table(COALESCE(p."Author", ''), ',') t
    CROSS JOIN LATERAL regexp_match(lower(btrim(t)), '^(pengirim barang|penerima barang|serah terima barang)\s+(\d+)$') m
    WHERE p."Id" = p_actor AND m IS NOT NULL
      AND CASE p_jenis WHEN 'kirim'  THEN m[1] = 'pengirim barang'
                       WHEN 'terima' THEN m[1] = 'penerima barang'
                       WHEN 'serah'  THEN m[1] IN ('penerima barang', 'serah terima barang')
                       ELSE false END;
$$;

CREATE OR REPLACE FUNCTION operational.po_proyek(p_poid bigint)
RETURNS bigint[]
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT COALESCE(array_agg(DISTINCT r."PROJECTID") FILTER (WHERE r."PROJECTID" IS NOT NULL), '{}')
    FROM public."purchaseOrder" po
    JOIN public."rfqDetail" rd ON rd."RFQID" = po."RFQID"
    JOIN public.request r ON r."ID" = rd."RequestID"
    WHERE po."POID" = p_poid;
$$;

-- Boleh untuk PO ini? ALL = super admin (staf_boleh dengan jenis apa pun -> true kalau ALL).
CREATE OR REPLACE FUNCTION operational.s5_boleh(p_actor bigint, p_jenis text, p_poid bigint)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT operational.staf_boleh(p_actor, '-super-')
        OR operational.s5_proyek_tag(p_actor, p_jenis) && operational.po_proyek(p_poid);
$$;

CREATE OR REPLACE FUNCTION operational.drive_url(p_file_id text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $$
    SELECT CASE WHEN p_file_id ~ '^[A-Za-z0-9_-]{10,200}$' THEN 'https://drive.google.com/file/d/' || p_file_id || '/view' END;
$$;

-- Ringkas daftar item jsonb [{"id":..,"qty":..}] -> per id, qty dijumlah.
CREATE OR REPLACE FUNCTION operational.s5_items(p_items jsonb, p_kunci text)
RETURNS TABLE(id bigint, qty numeric)
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $$
    SELECT (e->>p_kunci)::bigint, sum((e->>'qty')::numeric)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END) e
    GROUP BY 1;
$$;

REVOKE ALL ON FUNCTION operational.s5_proyek_tag(bigint, text), operational.po_proyek(bigint),
    operational.s5_boleh(bigint, text, bigint), operational.drive_url(text), operational.s5_items(jsonb, text)
    FROM PUBLIC, anon, authenticated;

-- ---------- 1. Kirim barang ke site (delivery) ----------
CREATE OR REPLACE FUNCTION public.kirim_barang(p_token text, p_poid bigint, p_tujuan text, p_notes text, p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_actor bigint := operational.sesi_staf(p_token);
    v_it    record;
    v_sisa  numeric;
    v_sj    text;
    v_n     integer;
BEGIN
    IF v_actor IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis. Buka Badge dan masukkan PIN lagi.');
    END IF;
    IF NOT operational.s5_boleh(v_actor, 'kirim', p_poid) THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Anda tidak terdaftar sebagai Pengirim barang untuk proyek PO ini.');
    END IF;
    IF btrim(COALESCE(p_tujuan, '')) = '' THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Pilih tujuan site dulu.');
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('s5-po:' || p_poid, 0));
    SELECT count(*) INTO v_n FROM operational.s5_items(p_items, 'podetailId');
    IF v_n = 0 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Isi minimal 1 qty yang dikirim.');
    END IF;
    FOR v_it IN SELECT * FROM operational.s5_items(p_items, 'podetailId') LOOP
        IF v_it.qty IS NULL OR v_it.qty <= 0 THEN
            RETURN jsonb_build_object('status', 'INVALID', 'message', 'Qty kirim harus lebih dari 0.');
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public."purchaseOrderDetail" WHERE "PODetailID" = v_it.id AND "POID" = p_poid) THEN
            RETURN jsonb_build_object('status', 'INVALID', 'message', 'Item bukan bagian dari PO ini.');
        END IF;
        v_sisa := COALESCE((SELECT sum("QtyReceived") FROM public."vendorReceiving" WHERE "PODetailID" = v_it.id), 0)
                - COALESCE((SELECT sum("QtyDelivered") FROM public.delivery WHERE "PODetailID" = v_it.id), 0);
        IF v_it.qty > v_sisa THEN
            RETURN jsonb_build_object('status', 'INVALID', 'message', 'Qty kirim melebihi sisa siap kirim (' || v_sisa || ').');
        END IF;
    END LOOP;

    v_sj := public.generate_surat_jalan_no();
    INSERT INTO public.delivery ("POID", "PODetailID", "QtyDelivered", "PengirimBy", "DeliveredBy", "DestinationSite", "SuratJalanNo", "Notes")
    SELECT p_poid, i.id, i.qty, v_actor, NULL, left(btrim(p_tujuan), 200), v_sj, NULLIF(left(btrim(COALESCE(p_notes, '')), 1000), '')
    FROM operational.s5_items(p_items, 'podetailId') i;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN jsonb_build_object('status', 'OK', 'suratJalanNo', v_sj, 'jumlah', v_n);
END;
$$;

-- ---------- 2. Terima di site (siteReceiving) ----------
CREATE OR REPLACE FUNCTION public.terima_di_site(p_token text, p_items jsonb, p_notes text, p_photo_file_id text,
                                                 p_lokasi text, p_lat double precision, p_lng double precision)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_actor bigint := operational.sesi_staf(p_token);
    v_it    record;
    v_del   record;
    v_sisa  numeric;
    v_trx   text;
    v_n     integer;
BEGIN
    IF v_actor IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis. Buka Badge dan masukkan PIN lagi.');
    END IF;
    IF p_photo_file_id IS NOT NULL AND operational.drive_url(p_photo_file_id) IS NULL THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'File ID foto tidak valid.');
    END IF;
    SELECT count(*) INTO v_n FROM operational.s5_items(p_items, 'deliveryId');
    IF v_n = 0 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Isi minimal 1 qty yang diterima.');
    END IF;
    FOR v_it IN SELECT * FROM operational.s5_items(p_items, 'deliveryId') ORDER BY 1 LOOP
        SELECT "DeliveryID", "POID", "QtyDelivered" INTO v_del FROM public.delivery WHERE "DeliveryID" = v_it.id FOR UPDATE;
        IF v_del."DeliveryID" IS NULL THEN
            RETURN jsonb_build_object('status', 'INVALID', 'message', 'Data kiriman tidak ditemukan.');
        END IF;
        IF NOT operational.s5_boleh(v_actor, 'terima', v_del."POID") THEN
            RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Anda tidak terdaftar sebagai Penerima barang untuk proyek kiriman ini.');
        END IF;
        IF v_it.qty IS NULL OR v_it.qty <= 0 THEN
            RETURN jsonb_build_object('status', 'INVALID', 'message', 'Qty diterima harus lebih dari 0.');
        END IF;
        v_sisa := v_del."QtyDelivered" - COALESCE((SELECT sum("QtyReceived") FROM public."siteReceiving" WHERE "DeliveryID" = v_it.id), 0);
        IF v_it.qty > v_sisa THEN
            RETURN jsonb_build_object('status', 'INVALID', 'message', 'Qty diterima melebihi sisa kiriman (' || v_sisa || ').');
        END IF;
    END LOOP;

    v_trx := public.generate_no_transaksi_sr();
    INSERT INTO public."siteReceiving" ("DeliveryID", "QtyReceived", "ReceivedBy", "Notes", "NoTransaksi", "PhotoURL", "PhotoFileID",
                                        "LokasiNama", "Latitude", "Longitude")
    SELECT i.id, i.qty, v_actor, NULLIF(left(btrim(COALESCE(p_notes, '')), 1000), ''), v_trx,
           operational.drive_url(p_photo_file_id), p_photo_file_id, NULLIF(left(btrim(COALESCE(p_lokasi, '')), 200), ''), p_lat, p_lng
    FROM operational.s5_items(p_items, 'deliveryId') i;

    -- Kiriman yang sudah diterima penuh -> tandai selesai.
    UPDATE public.delivery d SET "DeliveredBy" = v_actor, "ReceivedDate" = now()
    WHERE d."DeliveryID" IN (SELECT id FROM operational.s5_items(p_items, 'deliveryId'))
      AND d."QtyDelivered" <= (SELECT COALESCE(sum(s."QtyReceived"), 0) FROM public."siteReceiving" s WHERE s."DeliveryID" = d."DeliveryID");
    RETURN jsonb_build_object('status', 'OK', 'noTransaksi', v_trx);
END;
$$;

-- ---------- 3. Serah terima ke end user (endUserReceiving) ----------
CREATE OR REPLACE FUNCTION public.serah_terima_barang(p_token text, p_wo_id uuid, p_penerima_id bigint, p_items jsonb, p_notes text,
                                                      p_photo_file_id text, p_lokasi text, p_lat double precision, p_lng double precision)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_actor bigint := operational.sesi_staf(p_token);
    v_it    record;
    v_sr    record;
    v_sisa  numeric;
    v_trx   text;
    v_n     integer;
BEGIN
    IF v_actor IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis. Buka Badge dan masukkan PIN lagi.');
    END IF;
    IF p_wo_id IS NULL THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Pilih No. WO dulu.');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public."karyawanTbl" WHERE "Id" = p_penerima_id AND COALESCE("IsActive", true)) THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Penerima barang tidak dikenal / tidak aktif.');
    END IF;
    IF p_photo_file_id IS NOT NULL AND operational.drive_url(p_photo_file_id) IS NULL THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'File ID foto tidak valid.');
    END IF;
    SELECT count(*) INTO v_n FROM operational.s5_items(p_items, 'receivingId');
    IF v_n = 0 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Tidak ada item yang valid buat diserahkan.');
    END IF;
    FOR v_it IN SELECT * FROM operational.s5_items(p_items, 'receivingId') ORDER BY 1 LOOP
        SELECT s."ReceivingID", s."QtyReceived", d."POID" INTO v_sr
        FROM public."siteReceiving" s JOIN public.delivery d ON d."DeliveryID" = s."DeliveryID"
        WHERE s."ReceivingID" = v_it.id FOR UPDATE OF s;
        IF v_sr."ReceivingID" IS NULL THEN
            RETURN jsonb_build_object('status', 'INVALID', 'message', 'Stok penerimaan site tidak ditemukan.');
        END IF;
        IF NOT operational.s5_boleh(v_actor, 'serah', v_sr."POID") THEN
            RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Anda tidak terdaftar sebagai Storeman (Penerima / Serah Terima barang) untuk proyek ini.');
        END IF;
        IF v_it.qty IS NULL OR v_it.qty <= 0 THEN
            RETURN jsonb_build_object('status', 'INVALID', 'message', 'Qty diserahkan harus lebih dari 0.');
        END IF;
        v_sisa := v_sr."QtyReceived" - COALESCE((SELECT sum("QtyConfirmed") FROM public."endUserReceiving" WHERE "ReceivingID" = v_it.id), 0);
        IF v_it.qty > v_sisa THEN
            RETURN jsonb_build_object('status', 'INVALID', 'message', 'Sisa stok tidak cukup (' || v_sisa || '). Muat ulang halaman, kemungkinan sudah diambil orang lain.');
        END IF;
    END LOOP;

    v_trx := public.generate_no_transaksi_eur();
    INSERT INTO public."endUserReceiving" ("ReceivingID", "QtyConfirmed", "ConfirmedBy", "IssuedBy", "Notes", "woID", "NoTransaksi",
                                           "PhotoURL", "PhotoFileID", "LokasiNama", "Latitude", "Longitude")
    SELECT i.id, i.qty, p_penerima_id, v_actor, NULLIF(left(btrim(COALESCE(p_notes, '')), 1000), ''), p_wo_id, v_trx,
           operational.drive_url(p_photo_file_id), p_photo_file_id, NULLIF(left(btrim(COALESCE(p_lokasi, '')), 200), ''), p_lat, p_lng
    FROM operational.s5_items(p_items, 'receivingId') i;
    RETURN jsonb_build_object('status', 'OK', 'noTransaksi', v_trx);
END;
$$;

-- ---------- 4. Retur material ke gudang (materialReturn) ----------
CREATE OR REPLACE FUNCTION public.retur_material(p_token text, p_gudang_id bigint, p_items jsonb, p_notes text, p_photo_file_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_actor bigint := operational.sesi_staf(p_token);
    v_it    record;
    v_eur   record;
    v_sisa  numeric;
    v_n     integer;
BEGIN
    IF v_actor IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis. Buka Badge dan masukkan PIN lagi.');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public."karyawanTbl" WHERE "Id" = p_gudang_id AND COALESCE("IsActive", true)) THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Petugas gudang tidak dikenal / tidak aktif.');
    END IF;
    IF p_photo_file_id IS NOT NULL AND operational.drive_url(p_photo_file_id) IS NULL THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'File ID foto tidak valid.');
    END IF;
    SELECT count(*) INTO v_n FROM operational.s5_items(p_items, 'confirmationId');
    IF v_n = 0 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Isi minimal 1 qty yang mau dikembalikan.');
    END IF;
    FOR v_it IN SELECT * FROM operational.s5_items(p_items, 'confirmationId') ORDER BY 1 LOOP
        SELECT e."ConfirmationID", e."QtyConfirmed", d."POID" INTO v_eur
        FROM public."endUserReceiving" e
        JOIN public."siteReceiving" s ON s."ReceivingID" = e."ReceivingID"
        JOIN public.delivery d ON d."DeliveryID" = s."DeliveryID"
        WHERE e."ConfirmationID" = v_it.id FOR UPDATE OF e;
        IF v_eur."ConfirmationID" IS NULL THEN
            RETURN jsonb_build_object('status', 'INVALID', 'message', 'Data serah terima tidak ditemukan.');
        END IF;
        IF NOT operational.s5_boleh(v_actor, 'serah', v_eur."POID") THEN
            RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Anda tidak terdaftar sebagai Storeman untuk proyek ini.');
        END IF;
        IF v_it.qty IS NULL OR v_it.qty <= 0 THEN
            RETURN jsonb_build_object('status', 'INVALID', 'message', 'Qty dikembalikan harus lebih dari 0.');
        END IF;
        v_sisa := v_eur."QtyConfirmed" - COALESCE((SELECT sum("QtyReturned") FROM public."materialReturn" WHERE "ConfirmationID" = v_it.id), 0);
        IF v_it.qty > v_sisa THEN
            RETURN jsonb_build_object('status', 'INVALID', 'message', 'Qty kembali melebihi sisa (' || v_sisa || ').');
        END IF;
    END LOOP;

    INSERT INTO public."materialReturn" ("ConfirmationID", "QtyReturned", "ReturnedBy", "ReceivedBy", "Notes", "PhotoURL", "PhotoFileID")
    SELECT i.id, i.qty, v_actor, p_gudang_id, NULLIF(left(btrim(COALESCE(p_notes, '')), 1000), ''),
           operational.drive_url(p_photo_file_id), p_photo_file_id
    FROM operational.s5_items(p_items, 'confirmationId') i;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN jsonb_build_object('status', 'OK', 'jumlah', v_n);
END;
$$;

-- ---------- 5. Terima dari vendor (vendorReceiving, menu SMMS) ----------
CREATE OR REPLACE FUNCTION public.terima_dari_vendor(p_token text, p_poid bigint, p_vendor_doc text, p_notes text, p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_actor bigint := operational.sesi_staf(p_token);
    v_nama  text;
    v_it    record;
    v_qty   numeric;
    v_sisa  numeric;
    v_n     integer;
BEGIN
    IF v_actor IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;
    IF NOT operational.staf_boleh(v_actor, 'tv') THEN
        RETURN jsonb_build_object('status', 'NO_ACCESS', 'message', 'Anda tidak punya wewenang Terima dari Vendor (tag TV).');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public."purchaseOrder" WHERE "POID" = p_poid AND "ManagementApproval" = 'Approved') THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'PO/SO belum disetujui management.');
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('s5-po:' || p_poid, 0));
    SELECT count(*) INTO v_n FROM operational.s5_items(p_items, 'podetailId');
    IF v_n = 0 THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Isi minimal 1 qty yang diterima.');
    END IF;
    FOR v_it IN SELECT * FROM operational.s5_items(p_items, 'podetailId') LOOP
        SELECT "Qty" INTO v_qty FROM public."purchaseOrderDetail" WHERE "PODetailID" = v_it.id AND "POID" = p_poid;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('status', 'INVALID', 'message', 'Item bukan bagian dari PO ini.');
        END IF;
        IF v_it.qty IS NULL OR v_it.qty <= 0 THEN
            RETURN jsonb_build_object('status', 'INVALID', 'message', 'Qty diterima harus lebih dari 0.');
        END IF;
        v_sisa := COALESCE(v_qty, 0) - COALESCE((SELECT sum("QtyReceived") FROM public."vendorReceiving" WHERE "PODetailID" = v_it.id), 0);
        IF v_it.qty > v_sisa THEN
            RETURN jsonb_build_object('status', 'INVALID', 'message', 'Qty diterima melebihi sisa PO (' || v_sisa || ').');
        END IF;
    END LOOP;
    SELECT "NamaPersonnel" INTO v_nama FROM public."karyawanTbl" WHERE "Id" = v_actor;
    INSERT INTO public."vendorReceiving" ("POID", "PODetailID", "QtyReceived", "ReceivedBy", "VendorDocNumber", "Notes")
    SELECT p_poid, i.id, i.qty, COALESCE(v_nama, v_actor::text), NULLIF(left(btrim(COALESCE(p_vendor_doc, '')), 100), ''),
           NULLIF(left(btrim(COALESCE(p_notes, '')), 1000), '')
    FROM operational.s5_items(p_items, 'podetailId') i;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN jsonb_build_object('status', 'OK', 'jumlah', v_n);
END;
$$;

-- ---------- 6. Link PDF laporan (per No. Transaksi) ----------
CREATE OR REPLACE FUNCTION public.laporan_terima_set_report(p_token text, p_jenis text, p_notrx text, p_file_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_url text := operational.drive_url(p_file_id);
    v_n   integer;
BEGIN
    IF operational.sesi_staf(p_token) IS NULL THEN
        RETURN jsonb_build_object('status', 'SESSION_EXPIRED', 'message', 'Sesi habis, silakan login lagi.');
    END IF;
    IF v_url IS NULL THEN
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'File ID Drive tidak valid.');
    END IF;
    IF p_jenis = 'sr' THEN
        UPDATE public."siteReceiving" SET "ReportURL" = v_url, "ReportFileID" = p_file_id WHERE "NoTransaksi" = p_notrx;
    ELSIF p_jenis = 'eur' THEN
        UPDATE public."endUserReceiving" SET "ReportURL" = v_url, "ReportFileID" = p_file_id WHERE "NoTransaksi" = p_notrx;
    ELSE
        RETURN jsonb_build_object('status', 'INVALID', 'message', 'Jenis laporan tidak dikenal.');
    END IF;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN RETURN jsonb_build_object('status', 'NOT_FOUND', 'message', 'No. Transaksi tidak ditemukan.'); END IF;
    RETURN jsonb_build_object('status', 'OK');
END;
$$;

REVOKE ALL ON FUNCTION public.kirim_barang(text, bigint, text, text, jsonb),
    public.terima_di_site(text, jsonb, text, text, text, double precision, double precision),
    public.serah_terima_barang(text, uuid, bigint, jsonb, text, text, text, double precision, double precision),
    public.retur_material(text, bigint, jsonb, text, text),
    public.terima_dari_vendor(text, bigint, text, text, jsonb),
    public.laporan_terima_set_report(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kirim_barang(text, bigint, text, text, jsonb),
    public.terima_di_site(text, jsonb, text, text, text, double precision, double precision),
    public.serah_terima_barang(text, uuid, bigint, jsonb, text, text, text, double precision, double precision),
    public.retur_material(text, bigint, jsonb, text, text),
    public.terima_dari_vendor(text, bigint, text, text, jsonb),
    public.laporan_terima_set_report(text, text, text, text) TO anon, authenticated;

-- ---------- 7. Kunci tabel (dijalankan SETELAH halaman baru tayang) ----------
-- DO $$
-- DECLARE t text;
-- BEGIN
--     FOREACH t IN ARRAY ARRAY['delivery', 'siteReceiving', 'vendorReceiving', 'endUserReceiving', 'materialReturn'] LOOP
--         EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
--         EXECUTE format('DROP POLICY IF EXISTS baca_publik ON public.%I', t);
--         EXECUTE format('CREATE POLICY baca_publik ON public.%I FOR SELECT TO anon, authenticated USING (true)', t);
--         EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM anon, authenticated', t);
--         EXECUTE format('GRANT SELECT ON public.%I TO anon, authenticated', t);
--     END LOOP;
-- END $$;
-- ROLLBACK bagian 7: ALTER TABLE ... DISABLE ROW LEVEL SECURITY; GRANT INSERT, UPDATE, DELETE ON ... TO anon, authenticated;
