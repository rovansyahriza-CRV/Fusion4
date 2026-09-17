BEGIN;
DO $$
DECLARE r record;
BEGIN
 FOR r IN SELECT p.oid,p.proname,oidvectortypes(p.proargtypes) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('admin_reset_password_absensi','update_karyawan_core','create_karyawan_full','update_karyawan_badge_info') LOOP
 IF NOT EXISTS(SELECT 1 FROM pg_proc s JOIN pg_namespace n ON n.oid=s.pronamespace WHERE n.nspname='public' AND s.proname=r.proname||'_secure') THEN RAISE EXCEPTION 'Secure counterpart missing'; END IF;
 EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%I(%s) FROM PUBLIC,anon,authenticated',r.proname,r.args);
 END LOOP;
 IF has_column_privilege('anon','public."paswordTbl"','PasswordHas','SELECT') THEN RAISE EXCEPTION 'Credential protection missing'; END IF;
END $$;
UPDATE operational.auth_gate SET login_enabled=true WHERE id=true;
COMMIT;
