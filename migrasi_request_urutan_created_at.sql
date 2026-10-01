-- =====================================================================
-- Perbaikan urutan daftar request + tanggal RefNo
-- =====================================================================
-- 1. request.created_at kosong di semua baris (kolom tanpa default, tidak
--    pernah diisi) -> daftar request di SMMS yang diurutkan pakai created_at
--    jadi acak. Isi dari request_approval.CreatedAt (jam pembuatan asli) dan
--    beri default now() untuk request baru.
-- 2. generate_refno pakai tanggal UTC, padahal DATE_REQUEST pakai WITA ->
--    request jam 00.00-08.00 WITA dapat RefNo bertanggal kemarin. Sekarang
--    tanggal RefNo = tanggal WITA. Penomoran urut tetap lanjut (counter per tahun).
-- =====================================================================

ALTER TABLE public.request ALTER COLUMN created_at SET DEFAULT now();

UPDATE public.request r
SET created_at = ra."CreatedAt" AT TIME ZONE 'UTC'
FROM public.request_approval ra
WHERE ra."RefNo" = r."RefNo" AND r.created_at IS NULL AND ra."CreatedAt" IS NOT NULL;

CREATE OR REPLACE FUNCTION public.generate_refno()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  waktu_lokal timestamp := now() at time zone 'Asia/Makassar';
  year_key text := to_char(waktu_lokal, 'YYYY');
  today_str text := to_char(waktu_lokal, 'YYYYMMDD');
  next_num int;
begin
  insert into refno_counter (date_key, last_number)
  values (year_key, 1)
  on conflict (date_key)
  do update set last_number = refno_counter.last_number + 1
  returning last_number into next_num;

  return 'BIMA/REQ/' || today_str || '-' || lpad(next_num::text, 4, '0');
end;
$function$;
