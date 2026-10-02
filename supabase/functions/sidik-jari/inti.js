// Logika Edge Function "sidik-jari" (WebAuthn). Dipisah dari index.ts supaya bisa dites di Node.
// db(nama, args)  -> hasil jsonb fungsi operational.<nama>(...)
// wa              -> modul @simplewebauthn/server ({ generate..., verify... })
// helpers         -> @simplewebauthn/server/helpers ({ isoBase64URL })
// Aksi: daftar_opsi, daftar_verifikasi, absen_opsi, absen_verifikasi.

export const ORIGIN_SAH = ["https://rovansyahriza-crv.github.io"];

export function buatHandler({ db, wa, helpers, origins = ORIGIN_SAH, acak }) {
  const b64 = helpers.isoBase64URL;
  const tantanganBaru = () => {
    const bytes = acak ? acak(32) : crypto.getRandomValues(new Uint8Array(32));
    return { bytes, teks: b64.fromBuffer(bytes) };
  };

  return async function handle(body, origin) {
    if (!origins.includes(origin)) return { status: "INVALID", message: "Asal permintaan tidak dikenal." };
    const rpID = new URL(origin).hostname;
    const aksi = String(body && body.aksi || "");
    const token = String(body && body.token || "");
    const device = String(body && body.device || "").slice(0, 64);
    if (!token || !device) return { status: "INVALID", message: "Permintaan tidak lengkap." };

    const gagal = async (info, pesan) => {
      await db("sj_catat_gagal", [token, device, aksi + ": " + info]).catch(() => {});
      return { status: "GAGAL", message: pesan || "Sidik jari tidak dikenali / dibatalkan." };
    };

    if (aksi === "daftar_opsi" || aksi === "absen_opsi") {
      const jenis = aksi === "daftar_opsi" ? "daftar" : "absen";
      const t = tantanganBaru();
      const r = await db("sj_mulai", [token, device, jenis, t.teks]);
      if (!r || r.status !== "OK") return r;
      if (jenis === "daftar") {
        const options = await wa.generateRegistrationOptions({
          rpName: "Fusion4 SmartGate",
          rpID,
          userName: r.qrCodeId || ("F4-" + r.employeeId),
          userDisplayName: r.nama || r.qrCodeId || "",
          userID: new TextEncoder().encode("F4-" + r.employeeId),
          challenge: t.bytes,
          attestationType: "none",
          // Sensor bawaan HP saja; kunci tidak disimpan sebagai passkey yang bisa disinkron ke HP lain.
          authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "discouraged", userVerification: "required" },
          timeout: 120000
        });
        return { status: "OK", options };
      }
      const options = await wa.generateAuthenticationOptions({
        rpID,
        challenge: t.bytes,
        allowCredentials: [{ id: r.credentialId, transports: r.transports ? String(r.transports).split(",") : undefined }],
        userVerification: "required",
        timeout: 120000
      });
      return { status: "OK", options, nama: r.nama, qrCodeId: r.qrCodeId };
    }

    if (aksi === "daftar_verifikasi") {
      const t = await db("sj_tantangan_pakai", [token, "daftar"]);
      if (!t || t.status !== "OK") return t;
      if (t.device !== device) return gagal("device beda", "HP berbeda dengan saat mulai daftar.");
      let v;
      try {
        v = await wa.verifyRegistrationResponse({
          response: body.respon, expectedChallenge: t.challenge, expectedOrigin: origins, expectedRPID: rpID,
          requireUserVerification: true
        });
      } catch (e) { return gagal(String(e.message || e).slice(0, 200)); }
      if (!v || !v.verified || !v.registrationInfo) return gagal("tidak terverifikasi");
      const c = v.registrationInfo.credential;
      const transports = (c.transports || (body.respon.response && body.respon.response.transports) || []).join(",");
      return db("sj_daftar_simpan", [token, device, String(body.label || "").slice(0, 80), c.id,
        b64.fromBuffer(c.publicKey), c.counter || 0, transports]);
    }

    if (aksi === "absen_verifikasi") {
      const t = await db("sj_tantangan_pakai", [token, "absen"]);
      if (!t || t.status !== "OK") return t;
      if (t.device !== device) return gagal("device beda", "HP berbeda dengan saat mulai absen.");
      if (!t.credentialId || !body.respon || body.respon.id !== t.credentialId) return gagal("credential beda");
      let v;
      try {
        v = await wa.verifyAuthenticationResponse({
          response: body.respon, expectedChallenge: t.challenge, expectedOrigin: origins, expectedRPID: rpID,
          credential: { id: t.credentialId, publicKey: b64.toBuffer(t.publicKey), counter: Number(t.counter) || 0,
                        transports: t.transports ? String(t.transports).split(",") : undefined },
          requireUserVerification: true
        });
      } catch (e) { return gagal(String(e.message || e).slice(0, 200)); }
      if (!v || !v.verified) return gagal("tidak terverifikasi");
      return db("sj_verifikasi_ok", [token, t.credentialId, v.authenticationInfo.newCounter || 0, device]);
    }

    return { status: "INVALID", message: "Aksi tidak dikenal." };
  };
}
