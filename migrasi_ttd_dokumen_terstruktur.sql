-- Tanda tangan digital terstruktur: dokumen didaftarkan di portal (PIC OIL/ALL), penandatangan
-- menandatangani dari Digital Badge (sesi token + konfirmasi PIN), QR/kode terbit per penandatangan.
-- Sidik dokumen = SHA-256 file TANPA QR; hanya hash + nama file yang disimpan (file tidak diunggah).
CREATE TABLE IF NOT EXISTS public.ttd_dokumen_master (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  judul       text NOT NULL,
  versi       text NOT NULL,
  tgl_terbit  date NOT NULL,
  file_nama   text,
  file_sha256 text,
  berurutan   boolean NOT NULL DEFAULT true,
  status      text NOT NULL DEFAULT 'AKTIF' CHECK (status IN ('AKTIF','DICABUT')),
  dibuat_oleh text,
  dibuat_pada timestamptz NOT NULL DEFAULT now(),
  UNIQUE (judul, versi)
);
CREATE TABLE IF NOT EXISTS public.ttd_dokumen_penandatangan (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dokumen_id         bigint NOT NULL REFERENCES public.ttd_dokumen_master(id) ON DELETE CASCADE,
  urut               int NOT NULL,
  peran              text NOT NULL,
  karyawan_id        bigint NOT NULL,
  nama               text NOT NULL,
  jabatan            text NOT NULL,
  status             text NOT NULL DEFAULT 'MENUNGGU' CHECK (status IN ('MENUNGGU','DITANDATANGANI','DICABUT')),
  kode               text UNIQUE,
  ditandatangani_pada timestamptz,
  dicabut_pada       timestamptz,
  alasan_cabut       text,
  UNIQUE (dokumen_id, urut)
);
ALTER TABLE public.ttd_dokumen_master ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ttd_dokumen_penandatangan ENABLE ROW LEVEL SECURITY;

DROP FUNCTION IF EXISTS public.daftarkan_ttd_dokumen(text,text,text,text,date,text,text,boolean,jsonb);
CREATE OR REPLACE FUNCTION public.daftarkan_ttd_dokumen(
  p_pembuat_qrcode text, p_dibuat_oleh text, p_judul text, p_versi text, p_tgl date,
  p_file_nama text, p_sha256 text, p_berurutan boolean, p_penandatangan jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id bigint; v_i int := 0; s jsonb; k record;
BEGIN
  IF NOT public.can_buat_gangguan(p_pembuat_qrcode) THEN RAISE EXCEPTION 'Hanya PIC OIL atau ALL yang boleh mendaftarkan dokumen tanda tangan.' USING ERRCODE='42501'; END IF;
  IF btrim(coalesce(p_judul,''))='' OR btrim(coalesce(p_versi,''))='' THEN RAISE EXCEPTION 'Judul dan versi wajib diisi.'; END IF;
  IF p_sha256 IS NOT NULL AND p_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Format sidik dokumen tidak valid.'; END IF;
  IF jsonb_typeof(p_penandatangan) <> 'array' OR jsonb_array_length(p_penandatangan) = 0 THEN RAISE EXCEPTION 'Pilih minimal satu penanda tangan.'; END IF;
  INSERT INTO public.ttd_dokumen_master (judul, versi, tgl_terbit, file_nama, file_sha256, berurutan, dibuat_oleh)
  VALUES (btrim(p_judul), btrim(p_versi), p_tgl, nullif(btrim(coalesce(p_file_nama,'')),''), p_sha256, coalesce(p_berurutan,true), p_dibuat_oleh)
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
EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'Dokumen dengan judul dan versi yang sama sudah terdaftar.';
END $$;

DROP FUNCTION IF EXISTS public.list_ttd_dokumen(text);
CREATE OR REPLACE FUNCTION public.list_ttd_dokumen(p_qrcode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.can_buat_gangguan(p_qrcode) THEN RAISE EXCEPTION 'Tidak berhak.' USING ERRCODE='42501'; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id', m.id, 'judul', m.judul, 'versi', m.versi, 'tglTerbit', m.tgl_terbit, 'fileNama', m.file_nama,
      'ada_sha', m.file_sha256 IS NOT NULL, 'berurutan', m.berurutan, 'status', m.status, 'dibuatOleh', m.dibuat_oleh,
      'dibuatPada', m.dibuat_pada,
      'penandatangan', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'urut', p.urut, 'peran', p.peran, 'nama', p.nama,
          'jabatan', p.jabatan, 'status', p.status, 'kode', p.kode, 'waktu', p.ditandatangani_pada) ORDER BY p.urut), '[]'::jsonb)
          FROM public.ttd_dokumen_penandatangan p WHERE p.dokumen_id = m.id)) ORDER BY m.id DESC)
    FROM public.ttd_dokumen_master m), '[]'::jsonb);
END $$;

DROP FUNCTION IF EXISTS public.cabut_ttd_dokumen(text,bigint,bigint,text);
CREATE OR REPLACE FUNCTION public.cabut_ttd_dokumen(p_qrcode text, p_dokumen_id bigint, p_penandatangan_id bigint, p_alasan text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.can_buat_gangguan(p_qrcode) THEN RAISE EXCEPTION 'Tidak berhak.' USING ERRCODE='42501'; END IF;
  IF btrim(coalesce(p_alasan,''))='' THEN RAISE EXCEPTION 'Alasan pencabutan wajib diisi.'; END IF;
  IF p_penandatangan_id IS NULL THEN
    UPDATE public.ttd_dokumen_master SET status='DICABUT' WHERE id = p_dokumen_id;
  ELSE
    UPDATE public.ttd_dokumen_penandatangan SET status='DICABUT', dicabut_pada=now(), alasan_cabut=p_alasan
      WHERE id = p_penandatangan_id AND dokumen_id = p_dokumen_id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

DROP FUNCTION IF EXISTS public.get_pending_ttd(text);
CREATE OR REPLACE FUNCTION public.get_pending_ttd(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor bigint := operational.badge_sesi(p_token);
BEGIN
  IF v_actor IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'judul', m.judul, 'versi', m.versi, 'tglTerbit', m.tgl_terbit,
      'peran', p.peran, 'urut', p.urut, 'berurutan', m.berurutan, 'fileNama', m.file_nama, 'adaSha', m.file_sha256 IS NOT NULL,
      'total', (SELECT count(*) FROM public.ttd_dokumen_penandatangan x WHERE x.dokumen_id = m.id)) ORDER BY p.id)
    FROM public.ttd_dokumen_penandatangan p JOIN public.ttd_dokumen_master m ON m.id = p.dokumen_id
    WHERE p.karyawan_id = v_actor AND p.status = 'MENUNGGU' AND m.status = 'AKTIF'
      AND (NOT m.berurutan OR NOT EXISTS (SELECT 1 FROM public.ttd_dokumen_penandatangan x
            WHERE x.dokumen_id = m.id AND x.urut < p.urut AND x.status <> 'DITANDATANGANI'))), '[]'::jsonb);
END $$;

DROP FUNCTION IF EXISTS public.ttd_tanda_tangani(text,bigint,text);
CREATE OR REPLACE FUNCTION public.ttd_tanda_tangani(p_token text, p_id bigint, p_pin text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor bigint := operational.badge_sesi(p_token); r record; v_kode text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Sesi Badge habis. Tutup lalu buka Badge dan masukkan PIN lagi.' USING ERRCODE='28000'; END IF;
  IF operational.karyawan_id_by_pin(btrim(coalesce(p_pin,''))) IS DISTINCT FROM v_actor THEN RAISE EXCEPTION 'PIN salah.' USING ERRCODE='28000'; END IF;
  SELECT p.*, m.status AS m_status, m.berurutan INTO r FROM public.ttd_dokumen_penandatangan p
    JOIN public.ttd_dokumen_master m ON m.id = p.dokumen_id WHERE p.id = p_id FOR UPDATE OF p;
  IF NOT FOUND OR r.karyawan_id <> v_actor THEN RAISE EXCEPTION 'Tiket tanda tangan tidak ditemukan.'; END IF;
  IF r.m_status <> 'AKTIF' THEN RAISE EXCEPTION 'Dokumen ini sudah dicabut.'; END IF;
  IF r.status <> 'MENUNGGU' THEN RAISE EXCEPTION 'Tanda tangan ini sudah diproses.'; END IF;
  IF r.berurutan AND EXISTS (SELECT 1 FROM public.ttd_dokumen_penandatangan x WHERE x.dokumen_id = r.dokumen_id AND x.urut < r.urut AND x.status <> 'DITANDATANGANI') THEN
    RAISE EXCEPTION 'Belum giliran Anda. Penanda tangan sebelumnya belum selesai.'; END IF;
  v_kode := 'TTD-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10));
  UPDATE public.ttd_dokumen_penandatangan SET status='DITANDATANGANI', kode=v_kode, ditandatangani_pada=now() WHERE id = p_id;
  RETURN jsonb_build_object('ok', true, 'kode', v_kode);
END $$;

DROP FUNCTION IF EXISTS public.ttd_saya(text);
CREATE OR REPLACE FUNCTION public.ttd_saya(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor bigint := operational.badge_sesi(p_token);
BEGIN
  IF v_actor IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('judul', m.judul, 'versi', m.versi, 'peran', p.peran, 'kode', p.kode,
      'waktu', p.ditandatangani_pada, 'nama', p.nama, 'jabatan', p.jabatan,
      'status', CASE WHEN p.status='DITANDATANGANI' AND m.status='AKTIF' THEN 'AKTIF' ELSE 'DICABUT' END) ORDER BY p.ditandatangani_pada DESC)
    FROM public.ttd_dokumen_penandatangan p JOIN public.ttd_dokumen_master m ON m.id = p.dokumen_id
    WHERE p.karyawan_id = v_actor AND p.kode IS NOT NULL), '[]'::jsonb);
END $$;

DROP FUNCTION IF EXISTS public.verifikasi_ttd_dokumen(text);
CREATE OR REPLACE FUNCTION public.verifikasi_ttd_dokumen(p_kode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE k text := upper(trim(coalesce(p_kode,''))); n record; l public.ttd_dokumen_tbl;
BEGIN
  SELECT p.*, m.judul, m.versi, m.tgl_terbit, m.file_sha256, m.file_nama, m.status AS m_status, m.id AS mid INTO n
    FROM public.ttd_dokumen_penandatangan p JOIN public.ttd_dokumen_master m ON m.id = p.dokumen_id WHERE p.kode = k;
  IF FOUND THEN
    RETURN jsonb_build_object('ditemukan', true,
      'status', CASE WHEN n.status='DITANDATANGANI' AND n.m_status='AKTIF' THEN 'AKTIF' ELSE 'DICABUT' END,
      'dokumen', n.judul, 'versi', n.versi, 'tglTerbit', n.tgl_terbit, 'peran', n.peran, 'nama', n.nama, 'jabatan', n.jabatan,
      'ditandatanganiPada', n.ditandatangani_pada, 'fileSha256', n.file_sha256, 'fileNama', n.file_nama,
      'penandatangan', (SELECT jsonb_agg(jsonb_build_object('peran', x.peran, 'nama', x.nama, 'status', x.status, 'waktu', x.ditandatangani_pada) ORDER BY x.urut)
                         FROM public.ttd_dokumen_penandatangan x WHERE x.dokumen_id = n.mid));
  END IF;
  SELECT * INTO l FROM public.ttd_dokumen_tbl WHERE kode = k;
  IF NOT FOUND THEN RETURN jsonb_build_object('ditemukan', false); END IF;
  RETURN jsonb_build_object('ditemukan', true, 'status', l.status, 'dokumen', l.dokumen, 'versi', l.versi, 'tglTerbit', l.tgl_terbit,
    'peran', l.peran, 'nama', l.nama, 'jabatan', l.jabatan, 'legacy', true);
END $$;

GRANT EXECUTE ON FUNCTION public.verifikasi_ttd_dokumen(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.daftarkan_ttd_dokumen(text,text,text,text,date,text,text,boolean,jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_ttd_dokumen(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cabut_ttd_dokumen(text,bigint,bigint,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_ttd(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ttd_tanda_tangani(text,bigint,text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ttd_saya(text) TO anon, authenticated;
