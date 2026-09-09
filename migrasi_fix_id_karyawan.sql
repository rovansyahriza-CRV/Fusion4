-- =====================================================================================
-- FIX FINAL: AUTO-GENERATE ID karyawanTbl & paswordTbl + RPC create_karyawan_full
-- Mengatasi error: null value in column Id of relation karyawanTbl violates not-null constraint
-- Sinkronisasi kolom otorisasi (pic, PIC, Author, PasswordHas, Password)
-- =====================================================================================

-- 1. Pasang Sequence Auto-Increment pada kolom Id di tabel karyawanTbl & paswordTbl
CREATE SEQUENCE IF NOT EXISTS karyawanTbl_Id_seq;
SELECT setval('karyawanTbl_Id_seq', COALESCE((SELECT MAX(Id) FROM karyawanTbl), 0) + 1, false);
ALTER TABLE karyawanTbl ALTER COLUMN Id SET DEFAULT nextval('karyawanTbl_Id_seq');

CREATE SEQUENCE IF NOT EXISTS paswordTbl_Id_seq;
SELECT setval('paswordTbl_Id_seq', COALESCE((SELECT MAX(Id) FROM paswordTbl), 0) + 1, false);
ALTER TABLE paswordTbl ALTER COLUMN Id SET DEFAULT nextval('paswordTbl_Id_seq');

-- 2. Pastikan kolom-kolom pendukung tersedia di karyawanTbl
ALTER TABLE karyawanTbl ADD COLUMN IF NOT EXISTS Divisi TEXT;
ALTER TABLE karyawanTbl ADD COLUMN IF NOT EXISTS Departemen TEXT;
ALTER TABLE karyawanTbl ADD COLUMN IF NOT EXISTS Kualifikasi TEXT;
ALTER TABLE karyawanTbl ADD COLUMN IF NOT EXISTS Type TEXT;
ALTER TABLE karyawanTbl ADD COLUMN IF NOT EXISTS TglMasuk DATE;
ALTER TABLE karyawanTbl ADD COLUMN IF NOT EXISTS QrCodeId TEXT;
ALTER TABLE karyawanTbl ADD COLUMN IF NOT EXISTS DigitalPin TEXT;
ALTER TABLE karyawanTbl ADD COLUMN IF NOT EXISTS IsActive BOOLEAN DEFAULT true;
ALTER TABLE karyawanTbl ADD COLUMN IF NOT EXISTS FotoUrl TEXT;
ALTER TABLE karyawanTbl ADD COLUMN IF NOT EXISTS FotoFileId TEXT;

-- 3. Pastikan kolom-kolom pendukung tersedia di paswordTbl
ALTER TABLE paswordTbl ADD COLUMN IF NOT EXISTS Nama TEXT;
ALTER TABLE paswordTbl ADD COLUMN IF NOT EXISTS Password TEXT;
ALTER TABLE paswordTbl ADD COLUMN IF NOT EXISTS PasswordHas TEXT;
ALTER TABLE paswordTbl ADD COLUMN IF NOT EXISTS Author TEXT;
ALTER TABLE paswordTbl ADD COLUMN IF NOT EXISTS pic TEXT;
ALTER TABLE paswordTbl ADD COLUMN IF NOT EXISTS PIC TEXT;
ALTER TABLE paswordTbl ADD COLUMN IF NOT EXISTS QrCodeId TEXT;

-- Sinkronisasi data pic & PIC, Password & PasswordHas agar tidak terjadi inkonsistensi case-sensitivity
UPDATE paswordTbl 
SET pic = COALESCE(NULLIF(PIC, ''), pic),
    PIC = COALESCE(NULLIF(PIC, ''), pic),
    PasswordHas = COALESCE(NULLIF(Password, ''), PasswordHas),
    Password = COALESCE(NULLIF(PasswordHas, ''), Password);

-- Update khusus ID 21 (CRV) jika terdeteksi pic lama ALL padahal PIC baru PER
UPDATE paswordTbl 
SET pic = 'PER', PIC = 'PER', Author = 'AER' 
WHERE Id = 21 AND PIC = 'PER';

-- 4. Perbarui RPC create_karyawan_full (Penanganan Eksplisit & Robust)
DROP FUNCTION IF EXISTS create_karyawan_full(TEXT, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS create_karyawan_full(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION create_karyawan_full(
    p_nama TEXT,
    p_type TEXT DEFAULT NULL,
    p_kualifikasi TEXT DEFAULT NULL,
    p_departemen TEXT DEFAULT NULL,
    p_divisi TEXT DEFAULT NULL,
    p_tglmasuk TEXT DEFAULT NULL,
    p_password TEXT DEFAULT '12345',
    p_author TEXT DEFAULT NULL,
    p_pic TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS 
DECLARE
    v_new_id BIGINT;
    v_qrcodeid TEXT;
    v_digitalpin TEXT;
    v_clean_name TEXT;
    v_tgl_masuk DATE;
    v_clean_pass TEXT;
BEGIN
    v_clean_name := TRIM(p_nama);
    IF v_clean_name IS NULL OR v_clean_name = '' THEN
        RETURN jsonb_build_object(
            'status', 'ERROR',
            'message', 'Nama karyawan tidak boleh kosong.'
        );
    END IF;

    -- Konversi tanggal jika diberikan
    IF p_tglmasuk IS NOT NULL AND TRIM(p_tglmasuk) <> '' THEN
        BEGIN
            v_tgl_masuk := p_tglmasuk::DATE;
        EXCEPTION WHEN OTHERS THEN
            v_tgl_masuk := CURRENT_DATE;
        END;
    ELSE
        v_tgl_masuk := CURRENT_DATE;
    END IF;

    v_clean_pass := COALESCE(NULLIF(TRIM(p_password), ''), '12345');

    -- Dapatkan ID Baru secara eksplisit (Anti-Gagal)
    SELECT GREATEST(
        COALESCE((SELECT MAX(Id) FROM karyawanTbl), 0),
        COALESCE((SELECT MAX(Id) FROM paswordTbl), 0)
    ) + 1 INTO v_new_id;

    -- Update sequence agar tetap sinkron
    PERFORM setval('karyawanTbl_Id_seq', v_new_id, true);
    PERFORM setval('paswordTbl_Id_seq', v_new_id, true);

    -- Generate QrCodeId & Digital PIN unik
    v_qrcodeid := 'K-' || LPAD(v_new_id::TEXT, 4, '0');
    v_digitalpin := LPAD(FLOOR(RANDOM() * 900000 + 100000)::TEXT, 6, '0');

    -- INSERT ke karyawanTbl dengan Id eksplisit
    INSERT INTO karyawanTbl (
        Id,
        NamaPersonnel,
        Type,
        Kualifikasi,
        Departemen,
        Divisi,
        TglMasuk,
        QrCodeId,
        DigitalPin,
        IsActive
    ) VALUES (
        v_new_id,
        v_clean_name,
        p_type,
        p_kualifikasi,
        p_departemen,
        p_divisi,
        v_tgl_masuk,
        v_qrcodeid,
        v_digitalpin,
        true
    );

    -- INSERT / UPSERT ke paswordTbl (sinkronisasi pic dan PIC, Password dan PasswordHas)
    INSERT INTO paswordTbl (
        Id,
        Nama,
        Password,
        PasswordHas,
        Author,
        pic,
        PIC,
        QrCodeId
    ) VALUES (
        v_new_id,
        v_clean_name,
        v_clean_pass,
        v_clean_pass,
        p_author,
        p_pic,
        p_pic,
        v_qrcodeid
    )
    ON CONFLICT (Id) DO UPDATE
    SET Nama = EXCLUDED.Nama,
        Password = EXCLUDED.Password,
        PasswordHas = EXCLUDED.PasswordHas,
        Author = EXCLUDED.Author,
        pic = EXCLUDED.pic,
        PIC = EXCLUDED.PIC,
        QrCodeId = EXCLUDED.QrCodeId;

    RETURN jsonb_build_object(
        'status', 'SUCCESS',
        'message', 'Karyawan baru berhasil didaftarkan.',
        'id', v_new_id,
        'qrcodeid', v_qrcodeid,
        'digitalpin', v_digitalpin
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'status', 'ERROR',
        'message', SQLERRM
    );
END;
;

-- 5. Perbarui RPC update_karyawan_core
DROP FUNCTION IF EXISTS update_karyawan_core(BIGINT, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION update_karyawan_core(
    p_id BIGINT,
    p_departemen TEXT DEFAULT NULL,
    p_divisi TEXT DEFAULT NULL,
    p_author TEXT DEFAULT NULL,
    p_pic TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS 
BEGIN
    UPDATE karyawanTbl
    SET Departemen = p_departemen,
        Divisi = p_divisi
    WHERE Id = p_id;

    UPDATE paswordTbl
    SET Author = p_author,
        pic = p_pic,
        PIC = p_pic
    WHERE Id = p_id;

    RETURN jsonb_build_object(
        'status', 'SUCCESS',
        'message', 'Data karyawan berhasil diperbarui.'
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object(
        'status', 'ERROR',
        'message', SQLERRM
    );
END;
;

-- 6. RPC get_karyawan_pic (kompatibel dengan pic & PIC)
DROP FUNCTION IF EXISTS get_karyawan_pic(BIGINT);
DROP FUNCTION IF EXISTS get_karyawan_pic(INT);

CREATE OR REPLACE FUNCTION get_karyawan_pic(p_id BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS 
DECLARE
    v_pic TEXT;
BEGIN
    SELECT COALESCE(NULLIF(p.PIC, ''), p.pic, '') INTO v_pic
    FROM paswordTbl p
    WHERE p.Id = p_id;
    RETURN COALESCE(v_pic, '');
END;
;

-- 7. Perbarui RPC list_karyawan_all
DROP FUNCTION IF EXISTS list_karyawan_all();

CREATE OR REPLACE FUNCTION list_karyawan_all()
RETURNS TABLE (
    id BIGINT,
    namapersonnel TEXT,
    type TEXT,
    kualifikasi TEXT,
    departemen TEXT,
    divisi TEXT,
    tglmasuk DATE,
    qrcodeid TEXT,
    digitalpin TEXT,
    isactive BOOLEAN,
    author TEXT,
    pic TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS 
BEGIN
    RETURN QUERY
    SELECT 
        k.Id AS id,
        k.NamaPersonnel::TEXT AS namapersonnel,
        k.Type::TEXT AS type,
        k.Kualifikasi::TEXT AS kualifikasi,
        k.Departemen::TEXT AS departemen,
        k.Divisi::TEXT AS divisi,
        k.TglMasuk::DATE AS tglmasuk,
        k.QrCodeId::TEXT AS qrcodeid,
        k.DigitalPin::TEXT AS digitalpin,
        COALESCE(k.IsActive, true) AS isactive,
        p.Author::TEXT AS author,
        COALESCE(NULLIF(p.PIC, ''), p.pic)::TEXT AS pic
    FROM karyawanTbl k
    LEFT JOIN paswordTbl p ON k.Id = p.Id
    ORDER BY k.Id DESC;
END;
;

GRANT EXECUTE ON FUNCTION get_karyawan_pic(BIGINT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION create_karyawan_full TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION update_karyawan_core TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION list_karyawan_all TO anon, authenticated, service_role;