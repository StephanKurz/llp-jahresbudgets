// Durchsucht den GESAMTEN Easyverein-Kontenplan (mehrere tausend SKR-Konten, die meisten davon
// ungenutzte Vorlagen) und speichert alle Konten mit linkedBookings > 0 (also jemals tatsächlich
// bebuchte Konten) in konten_cache. Dauert bewusst lange (~15-20s, ~80 Seiten) - deshalb NICHT
// bei jedem Seitenaufruf, sondern nur manuell per Button im Tool ("Konten aktualisieren"), wenn
// ein neues Konto zum ersten Mal bebucht wurde und in der Übersicht auftauchen soll, auch wenn es
// im laufenden Jahr noch keine Buchung hat.
//
// budget-uebersicht liest konten_cache statt bei jedem Aufruf den vollen Kontenplan zu crawlen -
// das hält die normale Ladezeit bei ~2-3s.

const EV_BASE_URL = "https://easyverein.com/api/v2.0";
const PAGE_LIMIT = 100;

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

async function evGet(url: string, apiKey: string): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get("Retry-After") ?? "2");
      await new Promise((r) => setTimeout(r, (retryAfter || 2) * 1000));
      continue;
    }
    return resp;
  }
  throw new Error("Easyverein: zu viele 429-Antworten, abgebrochen.");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const evApiKey = Deno.env.get("EV_API_KEY_BOOKING");
  if (!evApiKey) {
    return jsonResponse({ error: "EV_API_KEY_BOOKING ist als Function-Secret nicht konfiguriert." }, 500);
  }
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  try {
    const used: { id: number; number: number; name: string; linkedBookings: number }[] = [];
    let url: string | null = `${EV_BASE_URL}/billing-account/?limit=${PAGE_LIMIT}`;
    let pages = 0;
    while (url) {
      const resp = await evGet(url, evApiKey);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Easyverein-Fehler (${resp.status}) bei ${url}: ${text}`);
      }
      const data = await resp.json();
      for (const acc of data.results ?? []) {
        if ((acc.linkedBookings ?? 0) > 0) {
          used.push({
            id: acc.id,
            number: acc.number,
            name: acc.name,
            linkedBookings: acc.linkedBookings,
          });
        }
      }
      url = data.next ?? null;
      pages++;
    }

    // Alten Cache-Stand vollständig ersetzen (Konten können in Easyverein umbenannt oder
    // stillgelegt werden - ein einfaches Upsert würde verwaiste Zeilen nicht entfernen).
    const deleteResp = await fetch(`${SUPABASE_URL}/rest/v1/konten_cache?id=gte.0`, {
      method: "DELETE",
      headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    });
    if (!deleteResp.ok) {
      const text = await deleteResp.text();
      throw new Error(`Supabase-Fehler beim Leeren des Caches (${deleteResp.status}): ${text}`);
    }

    if (used.length > 0) {
      const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/konten_cache`, {
        method: "POST",
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(
          used.map((u) => ({
            id: u.id,
            number: u.number,
            name: u.name,
            linked_bookings: u.linkedBookings,
          })),
        ),
      });
      if (!insertResp.ok) {
        const text = await insertResp.text();
        throw new Error(`Supabase-Fehler beim Schreiben des Caches (${insertResp.status}): ${text}`);
      }
    }

    return jsonResponse({ ok: true, kontenGefunden: used.length, seitenDurchsucht: pages }, 200);
  } catch (e) {
    return jsonResponse({ error: String(e instanceof Error ? e.message : e) }, 502);
  }
});
