# Auto-debrief — Apprendimento implicito (Fase 2 memoria)

**Data:** 2026-06-10
**Binario:** A (auto-debrief). Indipendente dal binario B (durable Fase 2).
**Flag:** `auto_debrief_enabled` (default OFF fino a collaudo).
**Decisioni brainstorming (Raffaele, 10 giu):** trigger su segnali concreti · pass dedicato
automatico · auto-salvataggio + avviso visibile non bloccante.

## Problema

Cervellone ha già tutta l'infrastruttura di apprendimento (tool `crea_procedura`,
`registra_apprendimento`, `imposta_progetto_attivo`, `aggiorna_progetto`, `chiudi_progetto`,
tabelle `procedures` e `project_state`) ma è **acceso e inerte**: il modello quasi mai chiama
quei tool di sua iniziativa (`project_state` = 0 righe in prod). Approccio opt-in dal prompt =
fallito.

Requisito **vincolante** di Raffaele: *"non devo spiegargli io come si fa"*. Lavorando insieme a
un documento, Cervellone deve apprendere **da solo** e ricordare per la prossima volta:
1. la **strategia** seguita,
2. **dove** ha preso documenti e info da allegare (fonti: file Drive, mail, tabelle),
3. **cosa è piaciuto** a Raffaele (struttura, stile, formato approvato),
e le **lezioni** dalle correzioni ricevute.

## Soluzione: auto-debrief post-task

Quando un lavoro documentale si conclude, un **pass di distillazione dedicato** (una chiamata
Sonnet separata, lanciata dal codice — non opt-in dal modello) estrae strategia/fonti/preferenze/
lezioni dalla conversazione e le **scrive in automatico** in procedure + project_state, mandando
una riga di riepilogo all'utente.

### 1. Trigger — segnali concreti (deterministici, in codice)

Aggancio: alla **fine di `runAgentJob()`** in `src/lib/agent-job.ts` (cucitura stabile: la
chiamano sia il path veloce sia quello durable). Nuova funzione `maybeRunDebrief(ctx)`.

Segnali (uno qualsiasi → candidato debrief):
- `pdf_saved` — `salva_bozza_pdf` è andato a buon fine nel turno (flag raccolto durante
  l'esecuzione tool del turno).
- `project_closed` — `chiudi_progetto` eseguito nel turno.
- `approval` — l'ultimo messaggio utente matcha una regex di approvazione
  (`perfetto`, `ok così`, `va bene così`, `ottimo`, `perfetto grazie`, `così va bene`…),
  case-insensitive, ancorata a frase breve (no match dentro frasi lunghe interrogative).

**Gate anti-spreco / anti-falso-positivo.** Il debrief parte SOLO se c'è vero contesto di lavoro:
- `pdf_saved` o `project_closed` → sempre OK (evento certo);
- `approval` → OK solo se esiste un **progetto attivo** per la conversazione OPPURE un
  `task_type` riconosciuto con lavoro reale nel turno. "Perfetto" in chat casuale senza progetto
  → niente debrief → **costo zero**.

**Dedup.** In `project_state` si salva `last_debrief_at` (+ hash dello stato distillato). Lo stesso
lavoro non viene distillato due volte anche se scattano più segnali in sequenza (salva PDF →
"perfetto" → chiude progetto). Cooldown minimo: nessun secondo debrief se `last_debrief_at`
< N minuti fa per la stessa conversazione/progetto.

### 2. Pass di distillazione (una chiamata Sonnet, output JSON strutturato)

`runDebrief(transcript, currentProcedure, projectState)` → chiama Sonnet con `tool_choice` forzato
su uno strumento `StructuredOutput` (schema rigido), così il modello DEVE restituire JSON valido.

**Input:** transcript recente troncato (cap ~30-40K char), procedura corrente del task_type (se
esiste), stato progetto attivo.

**Output JSON:**
```jsonc
{
  "task_type": "pos",                 // slug esistente o nuovo
  "is_new_type": false,
  "strategy_steps": ["..."],          // → checklist (la STRATEGIA)
  "sources": { "DVR": "drive://...", "computo": "sheet://..." }, // → key_files (DOVE)
  "save_location": "cantiere/05_Sicurezza/POS",
  "output_preferences": ["tabella bordata", "firme in fondo", "tono formale"], // COSA piace
  "lessons": ["le firme RSPP/medico si leggono dal DVR, non si chiedono"],     // correzioni
  "confidence": { "strategy_steps": 0.9, "sources": 0.8, "output_preferences": 0.7, "lessons": 0.95 }
}
```

**Modello/costo:** Sonnet 4.6, `max_tokens` cappato (~2-3K), effort standard. Parte solo su segnale
concreto + contesto reale (raro: a lavoro finito). Stima **~$0.02–0.05 a lavoro concluso**.

### 3. Scrittura (riuso dei tool esistenti) + soglia confidence

Solo le voci con `confidence ≥ 0.6` entrano. Mapping:
- `is_new_type=true` → `createProcedure({ taskType, title, keywords, checklist: strategy_steps,
  outputSpec, saveLocation })`.
- `is_new_type=false` → `addLesson(task_type, lesson)` per ogni lezione; merge `strategy_steps`
  nella checklist esistente (dedup, no duplicati); set `output_preferences`.
- `sources` / `save_location` → `setActiveProject(conversationId, { key_files: sources })`.

**Nuovo campo schema (decisione 10 giu):** aggiungere `output_preferences text[]` a `procedures`,
iniettato nel contesto da `buildProcedureContext` come *"Formato preferito da Raffaele per questo
tipo: …"*. Migration additiva, default `'{}'`.

### 4. Avviso visibile + correggibilità

Dopo le scritture, **una riga** Telegram (non bloccante, zero tap):
> 📝 Ho imparato per i POS: firme dal DVR, output con tabella bordata. Se sbaglio, dimmelo.

Correzione a voce nel turno dopo (il modello usa i tool esistenti per rimuovere/aggiornare). Il
riepilogo elenca esattamente cosa è entrato, così l'errore è visibile subito.

### 5. Anti-poisoning (provenienza)

Tutte le scritture del debrief sono taggate `updated_by='cervellone:auto-debrief'`. Coerente col
guardrail del 6 giu: **possono** entrare in procedure/lessons (è il canale di apprendimento), ma
**mai** in `prompt_extra` (le istruzioni umane restano solo umane). Nessun loop di
auto-suggestione.

## File toccati (binario A — NON tocca `claude.ts`)

- `src/lib/auto-debrief.ts` — **nuovo**: `maybeRunDebrief`, `runDebrief`, rilevamento segnali,
  gate, dedup, applicazione scritture.
- `src/lib/agent-job.ts` — hook `maybeRunDebrief(ctx)` a fine `runAgentJob` (best-effort, mai
  lancia, non blocca la risposta).
- `src/lib/working-memory.ts` — supporto `output_preferences` (read in `buildProcedureContext`,
  write in `createProcedure`/nuovo helper); `last_debrief_at` su `project_state`.
- `src/lib/tools.ts` — solo cattura del flag `pdf_saved`/`project_closed` durante l'esecuzione
  tool (sezione working-memory; **nessun** tocco ai tool-write del binario B).
- `supabase/migrations/2026-06-10-procedures-output-preferences.sql` — `output_preferences text[]`
  + `project_state.last_debrief_at timestamptz`.
- Flag `auto_debrief_enabled` in `cervellone_config`.

## Testing (TDD)

Unit (chiamata Sonnet mockata):
- rilevamento segnali + gate (approval senza progetto → skip; pdf_saved → fire);
- dedup / cooldown (secondo segnale entro N min → no doppio debrief);
- parsing JSON + soglia confidence (voce <0.6 scartata);
- tag provenienza `updated_by='cervellone:auto-debrief'`;
- merge checklist senza duplicati; set `output_preferences`.

Smoke sul campo (post-deploy, flag ON): lavoro documentale reale → `project_state` si popola +
riga di riepilogo arriva + procedura aggiornata.

## Rollout

Flag-gated, default OFF. Mergiabile in qualsiasi ordine rispetto al binario B. Rollback = flag OFF.
