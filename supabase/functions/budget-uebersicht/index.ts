// Liefert die Budgetübersicht für ein Jahr (Standard: laufendes Jahr, ?jahr=YYYY überschreibt):
// pro Buchungskonto mit mindestens einer Buchung in diesem Jahr die Summe der Buchungsbeträge
// (Absolutwert), das hinterlegte Jahresbudget, den Prozentsatz sowie eine Budgetwarnung-Ampel
// (Ist vs. zeitanteiligem Soll, linear nach Kalendertag). Nur Konten mit Buchungen in diesem
// Jahr werden angezeigt - Kontonummern sind bei Easyverein nicht global eindeutig (mehrere
// accountingPlans können dieselbe Nummer verwenden), daher lässt sich ein reines
// Budget-ohne-Buchung nicht zuverlässig einem Konto zuordnen.
//
// Läuft server-seitig, weil EV_API_KEY_BOOKING (Finanz-Scope, als Function-Secret zu setzen)
// niemals im Browser landen darf. Liest konto_budgets direkt per Service-Role (Tabelle hat
// bewusst keine RLS-Policy für anon/authenticated), Schreiben erfolgt separat über
// budget-speichern.

const EV_BASE_URL = "https://easyverein.com/api/v2.0";
const PAGE_LIMIT = 100;
const MIN_REQUEST_INTERVAL_MS = 650;

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

let lastRequestAt = 0;
async function throttle(): Promise<void> {
  const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function evGet(url: string, apiKey: string): Promise<Response> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await throttle();
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

async function evGetPaginated(startUrl: string, apiKey: string): Promise<any[]> {
  const all: any[] = [];
  let url: string | null = startUrl;
  while (url) {
    const resp: Response = await evGet(url, apiKey);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Easyverein-Fehler (${resp.status}) bei ${url}: ${text}`);
    }
    const data: any = await resp.json();
    all.push(...(data.results ?? []));
    url = data.next ?? null;
  }
  return all;
}

function extractId(resourceUrl: string | null | undefined): string | null {
  if (!resourceUrl) return null;
  const m = resourceUrl.match(/\/(\d+)\/?$/);
  return m ? m[1] : null;
}

function dayOfYear(date: Date): number {
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.floor((date.getTime() - start.getTime()) / 86400000) + 1;
}

function daysInYear(year: number): number {
  return (new Date(Date.UTC(year, 1, 29)).getUTCMonth() === 1) ? 366 : 365;
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

  const url = new URL(req.url);
  const now = new Date();
  const jahr = Number(url.searchParams.get("jahr")) || now.getUTCFullYear();

  try {
    const dateGt = `${jahr - 1}-12-31`;
    const dateLt = `${jahr + 1}-01-01`;
    const bookingsUrl =
      `${EV_BASE_URL}/booking/?limit=${PAGE_LIMIT}&date__gt=${dateGt}&date__lt=${dateLt}`;
    const bookings = await evGetPaginated(bookingsUrl, evApiKey);

    const sumByAccountId = new Map<string, number>();
    for (const b of bookings) {
      const accId = extractId(b.billingAccount);
      if (!accId) continue;
      const amount = Math.abs(parseFloat(b.amount ?? "0"));
      sumByAccountId.set(accId, (sumByAccountId.get(accId) ?? 0) + amount);
    }

    const accountIds = [...sumByAccountId.keys()];
    const accountInfo = new Map<string, { number: number; name: string }>();
    for (const id of accountIds) {
      const resp = await evGet(`${EV_BASE_URL}/billing-account/${id}/`, evApiKey);
      if (!resp.ok) continue;
      const acc = await resp.json();
      accountInfo.set(id, { number: acc.number, name: acc.name });
    }

    const budgetResp = await fetch(
      `${SUPABASE_URL}/rest/v1/konto_budgets?jahr=eq.${jahr}&select=konto_nr,budget`,
      { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } },
    );
    if (!budgetResp.ok) {
      const text = await budgetResp.text();
      throw new Error(`Supabase-Fehler beim Lesen der Budgets (${budgetResp.status}): ${text}`);
    }
    const budgetRows: { konto_nr: number; budget: string | number }[] = await budgetResp.json();
    const budgetByKontoNr = new Map<number, number>(
      budgetRows.map((r) => [r.konto_nr, Number(r.budget)]),
    );

    const tag = dayOfYear(now);
    const tageGesamt = daysInYear(jahr);

    const konten = accountIds
      .filter((id) => accountInfo.has(id))
      .map((id) => {
        const info = accountInfo.get(id)!;
        const actual = sumByAccountId.get(id) ?? 0;
        const budget = budgetByKontoNr.get(info.number) ?? 0;
        const prozent = budget > 0 ? (actual / budget) * 100 : null;
        let ampel: "green" | "yellow" | "red" | null = null;
        if (budget > 0) {
          const prorated = budget * (tag / tageGesamt);
          if (actual < prorated) ampel = "green";
          else if (actual <= prorated * 1.10) ampel = "yellow";
          else ampel = "red";
        }
        return { nr: info.number, name: info.name, budget, actual, prozent, ampel };
      })
      .sort((a, b) => a.nr - b.nr);

    return jsonResponse({ jahr, heute: now.toISOString().slice(0, 10), konten }, 200);
  } catch (e) {
    return jsonResponse({ error: String(e instanceof Error ? e.message : e) }, 502);
  }
});
