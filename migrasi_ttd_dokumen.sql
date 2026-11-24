-- Tanda tangan digital dokumen (QR di kolom TTD). QR berisi link verifikasi-ttd.html?k=KODE,
-- halaman publik memanggil verifikasi_ttd_dokumen(kode). Tabel dikunci RLS; hanya RPC yang membaca.
CREATE TABLE IF NOT EXISTS public.ttd_dokumen_tbl (
  kode        text PRIMARY KEY,
  dokumen     text NOT NULL,
  versi       text NOT NULL,
  tgl_terbit  date NOT NULL,
  peran       text NOT NULL,
  nama        text NOT NULL,
  jabatan     text NOT NULL,
  status      text NOT NULL DEFAULT 'AKTIF' CHECK (status IN ('AKTIF','DICABUT')),
  dibuat_pada timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ttd_dokumen_tbl ENABLE ROW LEVEL SECURITY;

DROP FUNCTION IF EXISTS public.verifikasi_ttd_dokumen(text);
CREATE OR REPLACE FUNCTION public.verifikasi_ttd_dokumen(p_kode text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.ttd_dokumen_tbl;
BEGIN
  SELECT * INTO r FROM public.ttd_dokumen_tbl WHERE kode = upper(trim(coalesce(p_kode,'')));
  IF NOT FOUND THEN RETURN jsonb_build_object('ditemukan', false); END IF;
  RETURN jsonb_build_object('ditemukan', true, 'status', r.status, 'dokumen', r.dokumen, 'versi', r.versi,
    'tglTerbit', r.tgl_terbit, 'peran', r.peran, 'nama', r.nama, 'jabatan', r.jabatan, 'dibuatPada', r.dibuat_pada);
END $$;
GRANT EXECUTE ON FUNCTION public.verifikasi_ttd_dokumen(text) TO anon, authenticated;
