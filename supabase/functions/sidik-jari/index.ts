// Edge Function "sidik-jari": cek tanda tangan WebAuthn (sidik jari bawaan HP) untuk daftar & absen.
// Data disimpan lewat fungsi operational.sj_* (koneksi langsung SUPABASE_DB_URL, tidak lewat API publik).
// Deploy dengan verify_jwt = false: keamanan dari token sesi Badge yang dicek di database.
import * as wa from "npm:@simplewebauthn/server@13.3.3";
import * as helpers from "npm:@simplewebauthn/server@13.3.3/helpers";
import postgres from "npm:postgres@3.4.5";
import { buatHandler, ORIGIN_SAH } from "./inti.js";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 2, prepare: false });

const FUNGSI_BOLEH: Record<string, number> = {
  sj_mulai: 4, sj_tantangan_pakai: 2, sj_daftar_simpan: 7, sj_verifikasi_ok: 4, sj_catat_gagal: 3,
};

async function db(nama: string, args: unknown[]) {
  const n = FUNGSI_BOLEH[nama];
  if (n === undefined || n !== args.length) throw new Error("fungsi tidak diizinkan: " + nama);
  const ph = args.map((_, i) => "$" + (i + 1)).join(", ");
  const rows = await sql.unsafe(`select operational.${nama}(${ph}) as r`, args as never[]);
  return rows[0] && rows[0].r;
}

const handle = buatHandler({ db, wa, helpers });

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": ORIGIN_SAH.includes(origin) ? origin : ORIGIN_SAH[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  let hasil;
  try {
    if (req.method !== "POST") throw new Error("Metode tidak didukung.");
    hasil = await handle(await req.json(), origin);
  } catch (e) {
    console.error("sidik-jari:", e);
    hasil = { status: "ERROR", message: "Server sidik jari bermasalah. Coba lagi atau pakai Scan Wajah." };
  }
  return new Response(JSON.stringify(hasil), { headers: { ...cors(origin), "Content-Type": "application/json" } });
});
