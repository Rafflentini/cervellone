# I blocchi e il nucleo — quanto è davvero separato il Cervellone

**11 settembre 2026.** Nasce da una domanda di Raffaele, dopo una notte di lavoro sulla
ricalibrazione: *«stiamo lavorando a scompartimenti? Se si rompe il blocco della real estate, devo
poter intervenire lì senza che mi tocchi il resto. Perché ci sono volute dodici ore?»*

**La risposta breve: sì, i blocchi ci sono già, e tengono meglio di quanto pensassimo.** Le dodici
ore non sono state spese in un blocco — sono state spese nel **nucleo condiviso**, che è un altro
posto e ha un altro problema.

---

## 1. Le dimensioni

| | righe |
|---|---:|
| **blocco** check-in / affitti (La Real Estate) | 9.757 |
| **blocco** cantieri (SAL, prezzario, foto) | 4.954 |
| **blocco** posta | 2.382 |
| **blocco** fatturazione (Fatture in Cloud) | 986 |
| **nucleo condiviso** (`claude.ts`, `prompts.ts`, `tools.ts`, `memory.ts`, `circuit-breaker.ts`) | **3.437** |

I blocchi sono **la parte grossa**. Il nucleo è piccolo — ma ci passa tutto.

## 2. La separazione, misurata

**Nessun blocco importa il nucleo.** Zero, tutti e quattro. L'unica cosa "vicina al nucleo" che un
blocco tocca è `type ToolDefinition` da `src/lib/tools/types.ts` — **17 righe di sole interfacce**
(`checkin/tools.ts:13`).

**Il nucleo non importa nessun blocco.** `claude.ts` ha 26 import, tutti di infrastruttura
trasversale; i riferimenti a moduli di dominio che ci sono (righe 415, 971) sono **commenti**, non
import. Stessa cosa per `prompts.ts` (4 import), `memory.ts` (6), `circuit-breaker.ts` (3).

⭐ **E ogni attrezzo che fallisce è già isolato.** `executeToolBlocks` (`claude.ts:1120-1153`)
avvolge **ogni singola** chiamata in un try/catch suo (righe 1126-1150): l'errore diventa un
`tool_result` che torna al modello, e **il ciclo prosegue sugli altri**. Sopra c'è un secondo
try/catch (righe 650-907) che trasforma un errore sfuggito in un fallimento di turno pulito, non in
un crash.

### Il raggio dell'esplosione, su due guasti concreti

| guasto | cosa cade | cosa NON cade |
|---|---|---|
| **Fatture in Cloud risponde 500 a tutto** | le singole chiamate `fic_*`, riconciliazione, prima nota, movimenti — una alla volta | il turno · gli altri tre blocchi · nessun'altra tabella (`cervellone_fic_pending` non la legge nessun altro) |
| **il foglio Google del check-in viene cancellato** | le singole chiamate `checkin_*` / `affitti_*` | il turno · gli altri tre blocchi (0 import, 0 tabelle in comune) |

**È esattamente quello che Raffaele chiedeva, e funziona già.**

## 3. Le due crepe vere

1. **Una catena di tre righe.** `checkin → posta` (`checkin/avvisi.ts:27`, manda mail) e
   `posta → fatturazione` (`v19/tools/email/telegram-confirm.ts:25` → `conferma-fic.ts` →
   `fic-write-tools.ts`). Sono tre `import`, non un intreccio. **Cantieri è completamente isolato:
   zero collegamenti con gli altri tre.**
2. **La tabella `documents`.** Scritta da cantieri (`studio-tecnico.ts:429,545,986`) e, per via
   traversa, da posta (`sent-mail.ts:48,82`). È **accoppiamento invisibile**: non si vede negli
   import, ma un guasto ci passa lo stesso. `checkin` e `fic` non condividono nessuna tabella con
   nessuno — checkin non tocca Supabase affatto (stato su Google Sheet e Drive).

## 4. ⚠️ Il punto cieco

Il check-in ha **una seconda porta**: 13 route REST sotto `src/app/api/checkin/*` (il sito per gli
ospiti) più il cron `checkin-documenti`, che chiamano `foglio-google.ts` **direttamente, fuori dal
ciclo del turno** — quindi **fuori dal try/catch che protegge tutto il resto**. Se la gestione
errori lì dentro sia adeguata **non è stato verificato da nessuno**.

## 5. 🚨 Il macchinario in `src/v19/agent/` va cancellato, non collegato

Sembrava l'idea dei blocchi già scritta. **Non lo è**, per tre ragioni misurate:

- **È tagliato per capacità tecnica, non per dominio.** I sei "specialisti" sono `parsing-files`,
  `numerical-engine`, `document-render`, `domain-italiano`, `web-research`, `mail-router`. Un SAL di
  cantiere ne attraversa **tre**, e **nessuno dei tre possiede il cantiere**. È il contrario esatto
  dell'isolamento per dominio.
- **È marcito.** `document-render` — quello che dovrebbe produrre DOCX, XLSX e PDF — ha **4 nomi di
  attrezzo su 5 che non esistono più** (mancano i suffissi `_v19` che nessuno usa). `web_fetch`, in
  tre specialisti su sei, **non è mai esistito in produzione**.
- **Non avrebbe nessuna delle protezioni accumulate.** Al motore v19 mancano: rilevatore di promesse
  a vuoto, anti-bugia sull'archiviazione, circuit breaker, memoria RAG, scelta del modello,
  differimento dei tool, messaggi d'errore tradotti. Ogni riga è una guardia nata da un incidente
  vero.

E la delega annidata costa: il figlio **non eredita il prompt**, vede **un solo messaggio** e zero
storico, la latenza **si somma** (esecuzione sequenziale), e il suo consumo **non rientra nel budget
del padre** (`orchestrator.ts:113-116, 157`) — cioè il guard del padre resterebbe cieco.

### ⭐ Ma l'idea buona si salva, e non serve un sotto-agente

L'unica cosa da tenere è **l'elenco di attrezzi per specialista**. E per averla **non serve una
seconda chiamata al modello**: `getToolDefinitions({ nucleo })`, in produzione dall'11 settembre,
accetta già **un insieme qualsiasi**. Un blocco *è* quello: un insieme di attrezzi più le sue regole.
Aprire il blocco fatturazione = passare quell'insieme alla funzione che gira già. Nessuna latenza in
più, nessun contesto mutilato, nessun budget cieco.

**Si butta:** `orchestrator.ts`, `loop.ts`, `subagent-registry.ts`, `persist.ts`, e il prompt orfano
`v19/prompts/system.ts` (istruisce a usare `spawn_subagent` e non è importato da nessuno).
**Si tiene:** `hallucination-validator.ts` e `types.ts` — usati davvero da `lib/link-allucinati.ts`.

## 6. Allora perché dodici ore

Perché **stanotte non si è mai lavorato dentro un blocco.** Si è lavorato nelle 3.437 righe che
stanno sotto a tutti — ed è lì che il costo si concentra, giustamente, perché è l'unico posto dove un
errore li riguarda tutti. I **tre difetti critici** trovati dall'audit erano **tutti e tre nel
nucleo**, e nessuno c'entrava con la modifica: erano lì da prima.

La modifica in sé è stata **circa un'ora**: un flag per attrezzo e un parametro facoltativo. Le altre
undici sono servite a **dimostrare che fosse vero** — e **tre degli strumenti di misura erano rotti a
loro volta**. Quel costo si paga una volta per area: adesso il censimento è scritto, committato, e si
rifà con un comando.

## 7. Cosa manca davvero

Non una riarchitettura. Tre cose piccole:

1. **Chiudere le due crepe** (la catena a tre righe, la tabella `documents`) — o decidere che vanno
   bene così, ma scrivendolo.
2. **Verificare il punto cieco**: le 13 route del check-in fuori dal ciclo del turno.
3. ⭐ **Mettere la rete di sicurezza nel nucleo, non nei blocchi.** I blocchi si proteggono da soli —
   misurato. È il pezzo condiviso a non avere abbastanza controlli, ed è lì che sono finiti tutti e
   tre i difetti critici di stanotte.

> **Non si isola la conoscenza, si isolano i guasti.** Il Cervellone *deve* sapere tutto insieme: è
> tutto il suo valore. Quello che non deve propagarsi non è quello che sa — è quello che si rompe.
