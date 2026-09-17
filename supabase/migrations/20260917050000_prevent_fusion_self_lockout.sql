BEGIN;
-- Preserve authenticated administration and prevent self-lockout in Fusion4.
DO $$
DECLARE target regprocedure; definition text;
BEGIN
 SELECT p.oid::regprocedure INTO STRICT target FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='update_karyawan_core_secure';
 definition:=pg_get_functiondef(target);
 IF position('Akses edit akun sendiri' in definition)=0 THEN
  IF position('PERFORM operational.check_fusion_session(p_session_token,''dk'');' in definition)=0 THEN
   RAISE EXCEPTION 'Unexpected admin wrapper definition; no changes applied';
  END IF;
  definition:=replace(definition,'PERFORM operational.check_fusion_session(p_session_token,''dk'');',
   'IF operational.check_fusion_session(p_session_token,''dk'') = p_id AND NOT (operational.tokens(p_pic) && ARRAY[''all'',''dk'']) THEN RAISE EXCEPTION ''Akses edit akun sendiri harus tetap memiliki PIC ALL atau DK. Perubahan belum disimpan.'' USING ERRCODE=''42501''; END IF;');
  EXECUTE definition;
 END IF;
END $$;
COMMIT;
