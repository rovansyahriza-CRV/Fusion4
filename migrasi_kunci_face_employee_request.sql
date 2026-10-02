-- =====================================================================
-- Kunci faceDescriptorTbl & employeeRequestTbl
-- =====================================================================
-- faceDescriptorTbl : sisa enroll SMMS lama (sudah dialihkan ke enroll_fusion4 / faceData),
--                     tidak dipakai kode mana pun, RLS mati -> siapa pun bisa baca/ubah/hapus.
-- employeeRequestTbl: policy "emp_req_all_policy" (ALL, public, true) -> siapa pun bisa
--                     baca/ubah/hapus langsung. Semua halaman lewat RPC SECURITY DEFINER
--                     (submit/list/process_employee_request_*, list_kandidat_rekrutmen, dst),
--                     edge log 24 jam: tidak ada akses tabel langsung.
-- Keduanya: RLS nyala tanpa policy + hak anon/authenticated dicabut -> hanya lewat RPC.
-- =====================================================================

ALTER TABLE public."faceDescriptorTbl" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."faceDescriptorTbl" FROM anon, authenticated;

DROP POLICY IF EXISTS emp_req_all_policy ON public."employeeRequestTbl";
ALTER TABLE public."employeeRequestTbl" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."employeeRequestTbl" FROM anon, authenticated;

-- ROLLBACK:
-- GRANT ALL ON public."faceDescriptorTbl", public."employeeRequestTbl" TO anon, authenticated;
-- ALTER TABLE public."faceDescriptorTbl" DISABLE ROW LEVEL SECURITY;
-- CREATE POLICY emp_req_all_policy ON public."employeeRequestTbl" FOR ALL TO public USING (true) WITH CHECK (true);
