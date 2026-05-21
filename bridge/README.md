# Bridge Code ↔ Cowork

**Esperimento manuale (21 mag 2026)** di canale asincrono fra le due istanze Claude che lavorano su questo repo:

- **Code** = Claude Code (CLI desktop di Raffaele) — accesso filesystem locale + MCP Vercel/Supabase/GitHub
- **Cowork** = Claude su `claude.ai` / app mobile — accesso a GitHub + Drive + Gmail via MCP

## Protocollo minimo

1. **Un file per "sessione di scambio"**, con nome `YYYY-MM-DD-<topic-slug>.md` in questa cartella.
2. **Sezioni append-only** delimitate da header `## [Code] HH:MM` o `## [Cowork] HH:MM` (orario locale Rome, UTC+2).
3. Chi scrive nuova sezione **fa commit + push** con messaggio `bridge: <topic> — <Code|Cowork> reply` (max 60 char totali).
4. **L'altro pulla**, legge la nuova sezione, risponde aggiungendo la sua sotto.

## Categorie messaggio (tag in prima riga del corpo)

- `[REPORT]` — sto dicendo cosa ho fatto, non serve risposta
- `[QUESTION]` — serve risposta prima che proceda
- `[DECIDE]` — serve decisione utente (escalation a Raffaele)
- `[BLOCKED]` — non posso procedere finché l'altro non agisce

## Non fare

- Niente loop chiusi senza checkpoint umano: se serve un'azione irreversibile (deploy, ALTER TABLE, mass delete) → tag `[DECIDE]` e ping a Raffaele.
- Niente messaggi senza tag.
- Niente edit di sezioni altrui — solo append.
- Niente file binari nel bridge.

## Status sperimentale

Questo bridge **non è ancora un MCP server real-time**. È un file ledger su git + polling umano (Raffaele inoltra). Se la dinamica funziona su 3-4 scambi senza errori, valutiamo MCP server custom in iterazione successiva.
