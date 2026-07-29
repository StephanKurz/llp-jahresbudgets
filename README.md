# Jahresbudgets (Easyverein)

Ein schlankes, per `<iframe>` einbettbares Widget zur Budgetplanung: pro Buchungskonto mit
Buchungen im laufenden Jahr wird das Jahresbudget editierbar angezeigt, zusammen mit der
Ist-Summe, einer Auslastungsanzeige und einer Budgetwarnung-Ampel.

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

- **Automatische Kontoauswahl**: gezeigt werden nur Buchungskonten, auf denen im laufenden Jahr
  mindestens eine Buchung stattgefunden hat (der volle SKR49-Kontenrahmen hat mehrere tausend
  Konten, die meisten davon ungenutzt).
- **Jahresbudget editierbar**: pro Konto direkt in der Tabelle setzbar, wird sofort gespeichert
  (Änderung per Tab/Klick außerhalb des Feldes bestätigen).
- **Ist-Summe**: Summe aller Buchungsbeträge des laufenden Jahres auf diesem Konto, als
  Absolutbetrag (Vorzeichen von Einnahme/Ausgabe wird ignoriert).
- **Auslastungsbalken**: Ist ÷ Budget in Prozent, Füllbreite optisch auf 100 % gedeckelt, die
  tatsächliche Prozentzahl wird daneben trotzdem angezeigt.
- **Budgetwarnung-Ampel**: vergleicht die Ist-Summe mit dem zeitanteiligen Soll
  (`Budget × Tag im Jahr ÷ Tage im Jahr`) – **grün** wenn darunter, **gelb** bis einschließlich
  10 % darüber, **rot** bei mehr als 10 % darüber. Gilt einheitlich für alle Konten (keine
  Unterscheidung Einnahme/Ausgabe, da Easyverein kein entsprechendes Flag liefert). Ohne
  hinterlegtes Budget erscheint ein neutraler grauer Punkt.

## Architektur

Statisches HTML (`index.html`, kein Build-Schritt, keine Abhängigkeiten) plus zwei Supabase Edge
Functions im Projekt `llp-schuldaten`, die den Easyverein-API-Key serverseitig halten (er darf nie
im Browser landen):

| Edge Function | Zweck |
|---|---|
| `budget-uebersicht` | Liest den Kontenplan und alle Buchungen des Jahres von Easyverein, aggregiert je Konto, verknüpft das gespeicherte Budget und liefert eine fertige JSON-Übersicht (inkl. Prozent und Ampel) |
| `budget-speichern` | Nimmt eine Budgetänderung entgegen und schreibt sie über die RPC `upsert_konto_budget` in die Tabelle `konto_budgets` |

Die Tabelle `konto_budgets` (Primärschlüssel `konto_nr, jahr`) hat bewusst **kein öffentliches
SELECT** – sie wird ausschließlich von `budget-uebersicht` per Service-Role gelesen und über die
`SECURITY DEFINER`-RPC `upsert_konto_budget` beschrieben, nie direkt vom Client aus.

**Benötigter Function-Secret:** `EV_API_KEY_BOOKING` (Easyverein-API-Key mit
Finanzen/Buchungen-Berechtigung) muss im Supabase-Projekt unter Edge Functions → Secrets gesetzt
sein.

## Repo

https://github.com/StephanKurz/llp-jahresbudgets (öffentlich, GitHub Pages aus `main`/`/`)
