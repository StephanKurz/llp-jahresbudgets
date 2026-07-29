# Jahresbudgets (Easyverein)

Ein schlankes, per `<iframe>` einbettbares Widget zur Budgetplanung: pro Buchungskonto wird das
Jahresbudget editierbar angezeigt, zusammen mit der Ist-Summe, dem zeitanteiligen Soll, einer
Auslastungsanzeige und einer Budgetwarnung-Ampel.

**Live:** https://stephankurz.github.io/llp-jahresbudgets/

## Einbindung

```html
<iframe
  src="https://stephankurz.github.io/llp-jahresbudgets/"
  style="width:100%; height:600px; border:0;">
</iframe>
```

Es gibt keinen eigenen Login: Die einbettende Webseite ist die Sicherheitsgrenze (gleiches
Prinzip wie bei Termine-Suche und dem Schulkontakte-Editor).

## Funktionen

- **Automatische Kontoauswahl**: gezeigt werden alle jemals tatsächlich bebuchten Buchungskonten
  (der volle SKR49-Kontenrahmen hat mehrere tausend Konten, die meisten davon ungenutzte
  Vorlagen). Ein Konto bleibt also auch sichtbar, wenn es im laufenden Jahr (noch) keine Buchung
  hat. Über den Button **"Konten aktualisieren"** kann die zugrunde liegende Kontenliste neu
  eingelesen werden (voller Kontenplan-Scan, dauert ~15-20 s) – nötig, wenn ein Konto zum ersten
  Mal überhaupt bebucht wurde und noch nicht auftaucht.
- **Jahresbudget editierbar**: Klick auf das Stift-Symbol öffnet ein Eingabefeld; Speichern erfolgt
  automatisch beim Verlassen des Felds oder mit Enter. Ein leeres Feld bedeutet "kein Budget
  hinterlegt" – das ist bewusst etwas anderes als ein explizit eingetragenes Budget von 0 €.
- **Ist (Jahr)**: Saldo aller Buchungen des laufenden Jahres auf diesem Konto (Soll- und
  Haben-Buchungen vorzeichenbehaftet aufsummiert, danach Absolutbetrag – damit sich
  Gegenbuchungen auf Durchlauf-/Transitkonten korrekt ausgleichen statt sich zu addieren).
- **Soll (Heute)**: zeitanteiliges Soll (`Budget × Tag im Jahr ÷ Tage im Jahr`), derselbe Wert,
  der auch der Budgetwarnung zugrunde liegt.
- **Auslastungsbalken**: Ist ÷ Budget in Prozent, Füllbreite optisch auf 100 % gedeckelt, die
  tatsächliche Prozentzahl wird trotzdem angezeigt. Grün < 80 %, sonst neutral, rot > 100 %.
- **Einnahmekonto-Checkbox**: kehrt die Logik für dieses Konto um (z. B. für Mitgliedsbeiträge o.
  Ä., wo eine hohe Auslastung erwünscht ist): Balken rot ≤ 80 %, gelb < 100 %, grün ≥ 100 %;
  Budgetwarnung-Ampel grün wenn Ist ≥ Budget, sonst rot. Speichert die Änderung still im
  Hintergrund.
- **Budgetwarnung-Ampel** (Ausgabenkonten): vergleicht die Ist-Summe mit dem zeitanteiligen Soll –
  **grün** wenn darunter, **gelb** bis einschließlich 10 % darüber, **rot** bei mehr als 10 %
  darüber. Ohne hinterlegtes Budget erscheint ein neutraler grauer Punkt.

## Architektur

Statisches HTML (`index.html`, kein Build-Schritt, keine Abhängigkeiten) plus drei Supabase Edge
Functions im Projekt `llp-schuldaten`, die den Easyverein-API-Key serverseitig halten (er darf nie
im Browser landen):

| Edge Function | Zweck |
|---|---|
| `budget-uebersicht` | Liest die Konten aus dem Cache (`konten_cache`) und die Buchungen des laufenden Jahres von Easyverein, aggregiert je Konto, verknüpft das gespeicherte Budget und liefert eine fertige JSON-Übersicht |
| `budget-speichern` | Nimmt eine Budget-/Einnahmekonto-Änderung entgegen und schreibt sie über die RPC `upsert_konto_budget` in die Tabelle `konto_budgets` |
| `konten-aktualisieren` | Durchsucht einmalig den vollständigen Easyverein-Kontenplan (~80 Seiten, ~15-20 s) und speichert alle jemals bebuchten Konten in `konten_cache` – wird nur manuell per Button im Tool ausgelöst, damit die normale Ladezeit bei ~2-3 s bleibt |

Die Tabellen `konto_budgets` (Primärschlüssel `konto_nr, jahr`) und `konten_cache` haben bewusst
**kein öffentliches SELECT** – sie werden ausschließlich von den Edge Functions per Service-Role
gelesen bzw. (im Fall von `konto_budgets`) über die `SECURITY DEFINER`-RPC `upsert_konto_budget`
beschrieben, nie direkt vom Client aus.

**Benötigter Function-Secret:** `EV_API_KEY_BOOKING` (Easyverein-API-Key mit
Finanzen/Buchungen-Berechtigung) muss im Supabase-Projekt unter Edge Functions → Secrets gesetzt
sein.

## Repo

https://github.com/StephanKurz/llp-jahresbudgets (öffentlich, GitHub Pages aus `main`/`/`)
