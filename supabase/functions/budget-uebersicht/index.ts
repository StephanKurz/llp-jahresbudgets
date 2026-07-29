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
// Anzahl gleichzeitiger Konto-Detail-Abfragen. Die einzelnen Buchungsseiten (max. 3 für ein
// Jahr mit einigen hundert Buchungen) bleiben sequenziell, da jede die "next"-URL der
// vorherigen braucht. Bei echtem 429 greift trotzdem der Retry-After-Backoff unten.
const ACCOUNT_DETAIL_CONCURRENCY = 6;

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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
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
    const details = await mapWithConcurrency(accountIds, ACCOUNT_DETAIL_CONCURRENCY, async (id) => {
      const resp = await evGet(`${EV_BASE_URL}/billing-account/${id}/`, evApiKey);
      if (!resp.ok) return null;
      const acc = await resp.json();
      return { id, number: acc.number, name: acc.name };
    });
    for (const d of details) {
      if (d) accountInfo.set(d.id, { number: d.number, name: d.name });
    }

    const budgetResp = await fetch(
      `${SUPABASE_URL}/rest/v1/konto_budgets?jahr=eq.${jahr}&select=konto_nr,budget,ist_einnahmekonto`,
      { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } },
    );
    if (!budgetResp.ok) {
      const text = await budgetResp.text();
      throw new Error(`Supabase-Fehler beim Lesen der Budgets (${budgetResp.status}): ${text}`);
    }
    const budgetRows: { konto_nr: number; budget: string | number; ist_einnahmekonto: boolean }[] =
      await budgetResp.json();
    const budgetByKontoNr = new Map<number, { budget: number; istEinnahmekonto: boolean }>(
      budgetRows.map((r) => [r.konto_nr, { budget: Number(r.budget), istEinnahmekonto: r.ist_einnahmekonto }]),
    );

    const tag = dayOfYear(now);
    const tageGesamt = daysInYear(jahr);

    const konten = accountIds
      .filter((id) => accountInfo.has(id))
      .map((id) => {
        const info = accountInfo.get(id)!;
        const actual = sumByAccountId.get(id) ?? 0;
        const gespeichert = budgetByKontoNr.get(info.number);
        const budget = gespeichert?.budget ?? 0;
        const istEinnahmekonto = gespeichert?.istEinnahmekonto ?? false;
        const prozent = budget > 0 ? (actual / budget) * 100 : null;
        let ampel: "green" | "yellow" | "red" | null = null;
        if (!istEinnahmekonto && budget > 0) {
          const prorated = budget * (tag / tageGesamt);
          if (actual < prorated) ampel = "green";
          else if (actual <= prorated * 1.10) ampel = "yellow";
          else ampel = "red";
        }
        return {
          nr: info.number,
          name: info.name,
          budget,
          actual,
          prozent,
          ampel,
          istEinnahmekonto,
        };
      })
      .sort((a, b) => a.nr - b.nr);

    return jsonResponse({ jahr, heute: now.toISOString().slice(0, 10), konten }, 200);
  } catch (e) {
    return jsonResponse({ error: String(e instanceof Error ? e.message : e) }, 502);
  }
});
