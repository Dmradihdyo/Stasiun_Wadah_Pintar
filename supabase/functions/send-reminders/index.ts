// Pengingat email harian: sehari sebelum jatuh tempo dan saat terlambat.
// Dipanggil terjadwal (pg_cron + pg_net, lihat README) dengan header Authorization: Bearer <CRON_SECRET>.
// Deploy: supabase functions deploy send-reminders --no-verify-jwt
// Secrets: CRON_SECRET, RESEND_API_KEY, MAIL_FROM
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

async function sendMail(to: string, subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}` },
    body: JSON.stringify({ from: Deno.env.get("MAIL_FROM"), to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const now = Date.now();
  const { data: loans, error } = await sb
    .from("loans")
    .select("id, due_at, reminded_at, late_mailed_at, profiles(email, full_name)")
    .is("returned_at", null);
  if (error) return new Response(error.message, { status: 500 });

  let sent = 0;
  const failed: string[] = [];
  for (const l of loans ?? []) {
    const due = new Date(l.due_at).getTime();
    const soon = due > now && due - now <= 864e5 && !l.reminded_at;
    const late = due < now && !l.late_mailed_at;
    const p = Array.isArray(l.profiles) ? l.profiles[0] : l.profiles;
    if ((!soon && !late) || !p?.email) continue;
    try {
      await sendMail(
        p.email,
        late ? "Wadah belum dikembalikan" : "Pengingat: wadah jatuh tempo besok",
        `<p>Halo ${esc(p.full_name || "")},</p><p>${
          late
            ? "Wadah yang kamu pinjam sudah melewati jatuh tempo. Kuota peminjaman dikunci sampai wadah dikembalikan."
            : "Wadah yang kamu pinjam jatuh tempo besok."
        }</p><p>Buka aplikasi Stasiun Wadah Pintar untuk melihat detailnya.</p>`,
      );
      await sb.from("loans").update(late ? { late_mailed_at: new Date().toISOString() } : { reminded_at: new Date().toISOString() }).eq("id", l.id);
      sent++;
    } catch (e) {
      failed.push(`${l.id}: ${(e as Error).message}`);
    }
  }
  return new Response(JSON.stringify({ sent, failed }), { headers: { "content-type": "application/json" } });
});
