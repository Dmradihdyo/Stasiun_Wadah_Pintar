// Endpoint untuk ESP32. Alat TIDAK memegang service_role key: ia hanya memegang kunci alat
// (header x-device-key) yang di sini dicocokkan dengan hash di tabel `devices`.
// Deploy: supabase functions deploy device-api --no-verify-jwt
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const key = req.headers.get("x-device-key");
  if (!key) return json({ error: "unauthorized" }, 401);

  const { data: device, error: devErr } = await sb
    .from("devices")
    .select("id, station_id")
    .eq("key_hash", await sha256Hex(key))
    .maybeSingle();
  if (devErr) return json({ error: "server_error" }, 500);
  if (!device) return json({ error: "unauthorized" }, 401);

  await sb.from("devices").update({ last_seen: new Date().toISOString() }).eq("id", device.id);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* body kosong diperbolehkan untuk poll */ }

  switch (body.action) {
    // Alat menanyakan apakah ada perintah (buka pintu untuk pinjam/kembali) dari sesi pengguna yang sah.
    case "poll": {
      const { data, error } = await sb.rpc("device_poll", { p_station: device.station_id });
      if (error) return json({ error: "server_error" }, 500);
      return json(data);
    }

    // Alat melaporkan hasil sensor. Backend yang menetapkan berhasil atau tidaknya.
    case "report": {
      const requestId = String(body.request_id ?? "");
      if (!UUID.test(requestId)) return json({ error: "bad_request_id" }, 400);
      const weight = body.weight === null || body.weight === undefined ? null : Number(body.weight);
      if (weight !== null && !Number.isFinite(weight)) return json({ error: "bad_weight" }, 400);
      const { data, error } = await sb.rpc("device_report", {
        p_station: device.station_id,
        p_request_id: requestId,
        p_rfid: body.rfid == null ? null : String(body.rfid).slice(0, 64),
        p_weight: weight,
        p_sensor_ok: body.sensor_ok !== false,
      });
      if (error) return json({ error: "server_error" }, 500);
      return json(data);
    }

    // Log kejadian/diagnostik (pintu terbuka, kalibrasi, error sensor, dll).
    case "event": {
      const event = String(body.event ?? "").slice(0, 64);
      if (!event) return json({ error: "bad_event" }, 400);
      const payload = typeof body.payload === "object" && body.payload !== null ? body.payload : {};
      const { error } = await sb.from("device_events").insert({ station_id: device.station_id, event, payload });
      if (error) return json({ error: "server_error" }, 500);
      return json({ ok: true });
    }

    default:
      return json({ error: "unknown_action" }, 400);
  }
});
