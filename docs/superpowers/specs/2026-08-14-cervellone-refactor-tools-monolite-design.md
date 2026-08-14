# Refactor monolite `tools.ts` (solo i giganti) — Design

**Data:** 2026-08-14
**Stato:** approvato (brainstorming)
**Contesto:** `src/lib/tools.ts` è cresciuto a 2563 righe / 120KB. È il registro centrale dei tool del bot: definizioni (`*_TOOLS`), executor per dominio, e l'assemblaggio `ALL_TOOLS`/`EXECUTORS`/`getToolDefinitions`/`executeTool`. La dimensione: (a) impedisce l'auto-fix del bot sui propri tool (file oltre il suo budget di riemissione — report anomalie #11), (b) aumenta il rischio di build-breaker, (c) peggiora la manutenibilità. Anomalia #11 del report.

## Obiettivo

Ridurre `tools.ts` estraendo i **pezzi più grandi e critici** in moduli dedicati sotto `src/lib/tools/` (pattern già esistente: `format.ts`, `prezziario.ts`, `preventivo.ts`, `scarica-prezziario.ts`), portandolo da ~2560 a ~800-1000 righe. **Puro spostamento: zero cambi di comportamento**, provati da test di caratterizzazione.

Non-obiettivo (YAGNI): NON modularizzare i gruppi piccoli (image, pdf, memoria, project, draft), NON cambiare logica, firme pubbliche, o comportamento dei tool.

## Principio di sicurezza: caratterizzazione-first

Per ogni gigante, PRIMA di spostare il codice:
1. Scrivere un **test di caratterizzazione** (snapshot) che fissa l'output delle funzioni per input noti, con le dipendenze non deterministiche congelate: Supabase mockato con dati fissi, `Math.random` e `Date`/`new Date()` stubdati (vitest `vi.spyOn`/`vi.setSystemTime`).
2. Spostare il codice nel nuovo modulo.
3. Il test deve produrre **output identico** → prova di zero regressioni.

Il refactor è un *move*, non una riscrittura: la logica interna resta byte-per-byte equivalente.

## Moduli da estrarre

Ogni modulo segue il contratto executor già usato da `sal-tools.ts`/`fic-write-tools.ts`:
`export const XXX_TOOLS: ToolDefinition[]` + `export async function executeXxx(name, input, conversationId?): Promise<string | null>` (ritorna `null` se il nome non è suo).

| Modulo | Contenuto (da tools.ts) | Righe ~ |
|--------|-------------------------|---------|
| `tools/mail.ts` | `GMAIL_TOOLS` (:1872), mail V19 (`MAIL_SEND_TOOLS` :1771, `executeMailWrapper` :1839, `executeGmailWrapper` :2049) e relative definizioni | ~400 |
| `tools/self.ts` | `SELF_TOOLS` (:1357) + `executeSelfTools` (:1432) — config, promozione modelli, github, deploy, check_aggiornamenti | ~600 |
| `tools/studio-tecnico.ts` (+ `tools/studio-tecnico-render.ts` per i template HTML del preventivo) | `STUDIO_TECNICO_TOOLS` (:92) + `executeStudioTecnico` (:421, ~1000 righe: cerca_prezziario, cerca_prezziario_batch, conta_prezziario, genera_preventivo_completo, importa_prezziario_da_url) | ~1000 |

Se un modulo resta troppo grande dopo l'estrazione (es. `studio-tecnico.ts` per via dell'HTML di `genera_preventivo_completo`), separare i **template/render HTML** in un sotto-modulo `studio-tecnico-render.ts`, riusando `tools/format.ts` (formatEuro) dove già disponibile.

## `tools.ts` dopo il refactor

Diventa un **registro sottile** (~800-1000 righe): mantiene i gruppi piccoli inline (`IMAGE_TOOLS`, `PDF_TOOLS`, `MEMORIA_TOOLS`, `WORKING_MEMORY_TOOLS`, `PROJECT_TOOLS`, `DRAFT_TOOLS` e i relativi executor), importa i tre moduli estratti, e assembla:
- `ALL_TOOLS` = spread di tutti i `*_TOOLS`
- `EXECUTORS` = array degli executor (ordine invariato)
- `getToolDefinitions()` e `executeTool()` invariati.

L'interfaccia pubblica (`getToolDefinitions`, `executeTool`, e ogni firma importata altrove) **non cambia**.

## Verifica (per ogni tappa)

1. Test di caratterizzazione del modulo: verde, output identico a prima dello spostamento.
2. `npx tsc --noEmit`: nessun errore nuovo (ignorare i pre-esistenti in `pdf-generator.test.ts`).
3. Suite unit esistente rilevante: verde (i test pre-esistenti falliti — memoria/v19/draft — restano invariati, non introdotti da noi).
4. Deploy della tappa e, alla fine, smoke manuale dell'Ingegnere sul bot (generare un preventivo reale).

## Ordine (rischio crescente; ogni tappa è un commit + deploy verificato a sé)

1. **`mail.ts`** — più isolato, dipendenze mail già in moduli esterni. Rischio basso.
2. **`self.ts`** — config/modelli/github/deploy. Rischio medio.
3. **`studio-tecnico.ts`** (+ render) — il più critico (preventivi/computi). Per ultimo, con caratterizzazione robusta e smoke.

Fermarsi e non proseguire alla tappa successiva se una verifica fallisce.

## Esecuzione con subagenti

- Subagente per scrivere gli **snapshot di caratterizzazione** (uno per gigante), con i mock deterministici.
- Subagente/Codex per l'**estrazione meccanica** di ogni modulo (move + import), verificata dal test snapshot.
- Subagente di **audit finale** (nessun tool perso, `ALL_TOOLS`/`EXECUTORS` completi, `getToolDefinitions` espone lo stesso set di prima).
- Claude Code orchestra, fa la review tra le tappe e i merge/deploy. `tools.ts` (monolite) lo edita Claude Code, non i github-tools del bot.

## Rischi e mitigazioni

- **Perdere un tool** nel move → audit finale che confronta il set di `getToolDefinitions()` prima/dopo (stessa lista di `name`).
- **Import ciclici** (moduli che importano da `tools.ts` che importa loro) → i moduli NON importano `tools.ts`; le utility condivise stanno in `tools/format.ts` o moduli dedicati. Se emergono cicli, estrarre i tipi/costanti condivisi (es. `ToolDefinition`, `REGIONI_ALIAS`) in un modulo neutro `tools/types.ts`.
- **Output non deterministico** (random/date) nel preventivo → congelato nei test di caratterizzazione.
