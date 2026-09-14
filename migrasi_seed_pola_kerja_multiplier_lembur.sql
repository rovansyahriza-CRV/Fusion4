-- =====================================================================================
-- SEED: Isi PembagiJamKerja / MultiplierHariKerja / MultiplierHariOff di polaKerjaTbl
-- Sebelumnya 3 kolom ini NULL semua walau form admin "Pola Kerja & Tarif Lembur per Jam"
-- udah nampilin input box-nya. Diisi sesuai nilai yang di-set admin (CRV) di form:
--   - PembagiJamKerja = 173 utk semua pola (divisor standar konversi Gaji Pokok bulanan
--     jadi tarif per jam).
--   - MultiplierHariKerja = 1.5 utk semua pola (lembur di hari kerja/otomatis).
--   - MultiplierHariOff = 2 utk pola yang beneran punya hari OFF di jadwalnya (8 Jam/Hari
--     Reguler & Reguler Staff/PMT, keduanya Sabtu-Minggu/Libur Nasional jadi off beneran),
--     1.5 utk pola yang gak kenal hari OFF / jalan terus-menerus (10 Jam/Hari, 12 Jam/Hari
--     lapangan, & Rotasi 3 Bulan On/2 Minggu Off).
-- Dipakai get_timesheet_bulanan() buat estimasi Rupiah lembur di halaman 1 slip gaji
-- (lihat migrasi_timesheet_bulanan_slip_gaji.sql).
-- =====================================================================================

UPDATE "polaKerjaTbl" SET "PembagiJamKerja" = 173, "MultiplierHariKerja" = 1.5, "MultiplierHariOff" = 2
WHERE "NamaPola" IN ('8 Jam/Hari (Reguler)', 'Reguler (Senin-Jumat, Sabtu-Minggu Libur)');

UPDATE "polaKerjaTbl" SET "PembagiJamKerja" = 173, "MultiplierHariKerja" = 1.5, "MultiplierHariOff" = 1.5
WHERE "NamaPola" IN ('10 Jam/Hari', '12 Jam/Hari', 'Rotasi 3 Bulan On / 2 Minggu Off');
