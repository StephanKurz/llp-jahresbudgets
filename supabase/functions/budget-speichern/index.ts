// Speichert/aktualisiert das Jahresbudget für ein Buchungskonto per RPC upsert_konto_budget.
// Läuft server-seitig (statt direktem Tabellenzugriff aus dem Browser), da konto_budgets
// bewusst keine RLS-Policy für anon/authenticated hat - Schreiben ist nur über die
// SECURITY DEFINER RPC (mit anon-Key) erlaubt.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  let body: { konto_nr?: unknown; jahr?: unknown; budget?: unknown; ist_einnahmekonto?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Ungültiger Request-Body (JSON erwartet)." }, 400);
  }

  const konto_nr = Number(body.konto_nr);
  const jahr = Number(body.jahr);
  const budget = Number(body.budget);
  const ist_einnahmekonto = Boolean(body.ist_einnahmekonto);

  if (!Number.isInteger(konto_nr) || konto_nr <= 0) {
    return jsonResponse({ error: "konto_nr fehlt oder ist ungültig." }, 400);
  }
  if (!Number.isInteger(jahr) || jahr < 2000 || jahr > 2100) {
    return jsonResponse({ error: "jahr fehlt oder ist ungültig." }, 400);
  }
  if (!Number.isFinite(budget) || budget < 0) {
    return jsonResponse({ error: "budget fehlt oder ist negativ." }, 400);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

  try {
    const rpcResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_konto_budget`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_konto_nr: konto_nr,
        p_jahr: jahr,
        p_budget: budget,
        p_ist_einnahmekonto: ist_einnahmekonto,
      }),
    });

    if (!rpcResp.ok) {
      const errText = await rpcResp.text();
      return jsonResponse({ error: `Speichern fehlgeschlagen: ${errText}` }, 502);
    }
  } catch (e) {
    return jsonResponse({ error: `Verbindungsfehler zu Supabase: ${String(e)}` }, 502);
  }

  return jsonResponse({ ok: true, konto_nr, jahr, budget, ist_einnahmekonto }, 200);
});
