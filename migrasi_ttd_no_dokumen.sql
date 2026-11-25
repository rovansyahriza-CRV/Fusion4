-- Nomor dokumen sesuai Sistem Penomoran Dokumen BIMA: [Project]-[Originator]-[Tipe]-[Urut], contoh 001-09-D.1-001.
-- Versi dokumen tetap kolom terpisah (V1.0).
ALTER TABLE public.ttd_dokumen_master ADD COLUMN IF NOT EXISTS no_dokumen text;
ALTER TABLE public.ttd_dokumen_master DROP CONSTRAINT IF EXISTS ttd_no_dokumen_fmt;
ALTER TABLE public.ttd_dokumen_master ADD CONSTRAINT ttd_no_dokumen_fmt CHECK (no_dokumen IS NULL OR no_dokumen ~ '^[0-9]{3}-(0[1-9]|10)-D\.[1-8]-[0-9]{3}$');
CREATE UNIQUE INDEX IF NOT EXISTS ttd_no_dokumen_uq ON public.ttd_dokumen_master (no_dokumen) WHERE no_dokumen IS NOT NULL;

DROP FUNCTION IF EXISTS public.daftarkan_ttd_dokumen(text,text,text,text,date,text,text,boolean,jsonb);
DROP FUNCTION IF EXISTS public.daftarkan_ttd_dokumen(text,text,text,text,text,date,text,text,boolean,jsonb);
CREATE OR REPLACE FUNCTION public.daftarkan_ttd_dokumen(
  p_pembuat_qrcode text, p_dibuat_oleh text, p_no_dokumen text, p_judul text, p_versi text, p_tgl date,
  p_file_nama text, p_sha256 text, p_berurutan boolean, p_penandatangan jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint; v_i int := 0; s jsonb; k record; v_no text := nullif(upper(btrim(coalesce(p_no_dokumen,''))),'');
BEGIN
  IF NOT public.can_buat_gangguan(p_pembuat_qrcode) THEN RAISE EXCEPTION 'Hanya PIC OIL atau ALL yang boleh mendaftarkan dokumen tanda tangan.' USING ERRCODE='42501'; END IF;
  IF btrim(coalesce(p_judul,''))='' OR btrim(coalesce(p_versi,''))='' THEN RAISE EXCEPTION 'Judul dan versi wajib diisi.'; END IF;
  IF v_no IS NOT NULL AND v_no !~ '^[0-9]{3}-(0[1-9]|10)-D\.[1-8]-[0-9]{3}$' THEN RAISE EXCEPTION 'Format nomor dokumen tidak valid. Contoh: 001-09-D.1-001'; END IF;
  IF p_sha256 IS NOT NULL AND p_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Format sidik dokumen tidak valid.'; END IF;
  IF jsonb_typeof(p_penandatangan) <> 'array' OR jsonb_array_length(p_penandatangan) = 0 THEN RAISE EXCEPTION 'Pilih minimal satu penanda tangan.'; END IF;
  IF v_no IS NOT NULL AND EXISTS (SELECT 1 FROM public.ttd_dokumen_master WHERE no_dokumen = v_no AND versi = btrim(p_versi)) THEN RAISE EXCEPTION 'Nomor dokumen % versi % sudah terdaftar.', v_no, btrim(p_versi); END IF;
  INSERT INTO public.ttd_dokumen_master (no_dokumen, judul, versi, tgl_terbit, file_nama, file_sha256, berurutan, dibuat_oleh)
  VALUES (v_no, btrim(p_judul), btrim(p_versi), p_tgl, nullif(btrim(coalesce(p_file_nama,'')),''), p_sha256, coalesce(p_berurutan,true), p_dibuat_oleh)
  RETURNING id INTO v_id;
  FOR s IN SELECT * FROM jsonb_array_elements(p_penandatangan) LOOP
    v_i := v_i + 1;
    SELECT "Id", coalesce("NamaPersonnel",'-') AS nama, coalesce(nullif(btrim(s->>'jabatan'),''), nullif("Kualifikasi",''), '-') AS jabatan
      INTO k FROM public."karyawanTbl" WHERE "Id" = (s->>'karyawan_id')::bigint;
    IF NOT FOUND THEN RAISE EXCEPTION 'Karyawan penanda tangan tidak ditemukan.'; END IF;
    INSERT INTO public.ttd_dokumen_penandatangan (dokumen_id, urut, peran, karyawan_id, nama, jabatan)
    VALUES (v_id, v_i, coalesce(nullif(btrim(s->>'peran'),''),'Penanda tangan'), k."Id", k.nama, k.jabatan);
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'Dokumen dengan judul/versi atau nomor yang sama sudah terdaftar.';
END $$;

CREATE OR REPLACE FUNCTION public.list_ttd_dokumen(p_qrcode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.can_buat_gangguan(p_qrcode) THEN RAISE EXCEPTION 'Tidak berhak.' USING ERRCODE='42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', m.id, 'noDokumen', m.no_dokumen, 'judul', m.judul, 'versi', m.versi, 'tglTerbit', m.tgl_terbit, 'fileNama', m.file_nama,
      'ada_sha', m.file_sha256 IS NOT NULL, 'berurutan', m.berurutan, 'status', m.status, 'dibuatOleh', m.dibuat_oleh,
      'dibuatPada', m.dibuat_pada,
      'penandatangan', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'urut', p.urut, 'peran', p.peran, 'nama', p.nama,
          'jabatan', p.jabatan, 'status', p.status, 'kode', p.kode, 'waktu', p.ditandatangani_pada) ORDER BY p.urut), '[]'::jsonb)
          FROM public.ttd_dokumen_penandatangan p WHERE p.dokumen_id = m.id)) ORDER BY m.id DESC)
    FROM public.ttd_dokumen_master m), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.get_pending_ttd(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor bigint := operational.badge_sesi(p_token);
BEGIN
  IF v_actor IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'noDokumen', m.no_dokumen, 'judul', m.judul, 'versi', m.versi, 'tglTerbit', m.tgl_terbit,
      'peran', p.peran, 'urut', p.urut, 'berurutan', m.berurutan, 'fileNama', m.file_nama, 'adaSha', m.file_sha256 IS NOT NULL,
      'total', (SELECT count(*) FROM public.ttd_dokumen_penandatangan x WHERE x.dokumen_id = m.id)) ORDER BY p.id)
    FROM public.ttd_dokumen_penandatangan p JOIN public.ttd_dokumen_master m ON m.id = p.dokumen_id
    WHERE p.karyawan_id = v_actor AND p.status = 'MENUNGGU' AND m.status = 'AKTIF'
      AND (NOT m.berurutan OR NOT EXISTS (SELECT 1 FROM public.ttd_dokumen_penandatangan x
            WHERE x.dokumen_id = m.id AND x.urut < p.urut AND x.status <> 'DITANDATANGANI'))), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.ttd_saya(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor bigint := operational.badge_sesi(p_token);
BEGIN
  IF v_actor IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('noDokumen', m.no_dokumen, 'judul', m.judul, 'versi', m.versi, 'peran', p.peran, 'kode', p.kode,
      'waktu', p.ditandatangani_pada, 'nama', p.nama, 'jabatan', p.jabatan,
      'status', CASE WHEN p.status='DITANDATANGANI' AND m.status='AKTIF' THEN 'AKTIF' ELSE 'DICABUT' END) ORDER BY p.ditandatangani_pada DESC)
    FROM public.ttd_dokumen_penandatangan p JOIN public.ttd_dokumen_master m ON m.id = p.dokumen_id
    WHERE p.karyawan_id = v_actor AND p.kode IS NOT NULL), '[]'::jsonb);
END $$;

CREATE OR REPLACE FUNCTION public.verifikasi_ttd_dokumen(p_kode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k text := upper(trim(coalesce(p_kode,''))); n record; l public.ttd_dokumen_tbl;
BEGIN
  SELECT p.*, m.no_dokumen, m.judul, m.versi, m.tgl_terbit, m.file_sha256, m.file_nama, m.status AS m_status, m.id AS mid INTO n
    FROM public.ttd_dokumen_penandatangan p JOIN public.ttd_dokumen_master m ON m.id = p.dokumen_id WHERE p.kode = k;
  IF FOUND THEN
    RETURN jsonb_build_object('ditemukan', true,
      'status', CASE WHEN n.status='DITANDATANGANI' AND n.m_status='AKTIF' THEN 'AKTIF' ELSE 'DICABUT' END,
      'noDokumen', n.no_dokumen, 'dokumen', n.judul, 'versi', n.versi, 'tglTerbit', n.tgl_terbit, 'peran', n.peran, 'nama', n.nama, 'jabatan', n.jabatan,
      'ditandatanganiPada', n.ditandatangani_pada, 'fileSha256', n.file_sha256, 'fileNama', n.file_nama,
      'penandatangan', (SELECT jsonb_agg(jsonb_build_object('peran', x.peran, 'nama', x.nama, 'status', x.status, 'waktu', x.ditandatangani_pada) ORDER BY x.urut)
                         FROM public.ttd_dokumen_penandatangan x WHERE x.dokumen_id = n.mid));
  END IF;
  SELECT * INTO l FROM public.ttd_dokumen_tbl WHERE kode = k;
  IF NOT FOUND THEN RETURN jsonb_build_object('ditemukan', false); END IF;
  RETURN jsonb_build_object('ditemukan', true, 'status', l.status, 'dokumen', l.dokumen, 'versi', l.versi, 'tglTerbit', l.tgl_terbit,
    'peran', l.peran, 'nama', l.nama, 'jabatan', l.jabatan, 'legacy', true);
END $$;

GRANT EXECUTE ON FUNCTION public.daftarkan_ttd_dokumen(text,text,text,text,text,date,text,text,boolean,jsonb) TO anon, authenticated;

UPDATE public.ttd_dokumen_master SET no_dokumen = '001-09-D.1-001' WHERE id = 2 AND no_dokumen IS NULL;
