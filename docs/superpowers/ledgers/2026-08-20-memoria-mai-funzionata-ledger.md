# La memoria persistente non ha mai funzionato — registro delle decisioni

**20 agosto 2026.** Live: `6a59b51` e `a950141`. Suite 890 → **950** test verdi.

## Come è saltata fuori

Non da un test. Da Raffaele, che dall'app chiedeva a Cervellone del caso **Blasi Giuseppe** e si sentiva rispondere che non ne aveva memoria — mentre i documenti erano tutti su Drive.

## La causa, provata sui dati di produzione

| Misura | Valore |
|---|---|
| Riassunti giornalieri salvati | 89 |
| Di cui con contenuto reale | **0** |
| Entità mai memorizzate | **0** |
| Run notturni dichiarati `ok` | 89 |
| Dal | 19 maggio |

L'estrattore chiedeva al modello un riassunto in JSON con `max_tokens: 1024`. Sulle giornate dense la risposta veniva troncata, `JSON.parse` falliva, il `catch` scartava la conversazione con un `console.warn`, e la giornata finiva archiviata come *"Nessuna attività rilevante"* con il run marcato `ok`.

Prova dal consumo token (`api_usage`, `entry_point='cron:memoria'`):

| Giorno estratto | input | output |
|---|---|---|
| 2026-08-17 | 45.398 | **1024** (= tetto, troncato) |
| 2026-08-05 | 28.825 | **1024** (= tetto, troncato) |
| 2026-07-03 | 1.696 | 189 (completo) |

**Più la giornata era piena di lavoro, più era certo che venisse persa.** L'esatto contrario di ciò che serve.

## Ipotesi smentite dai dati — da non riesumare

- Il cron **non** aveva buchi: ha girato ogni notte di agosto.
- `/nuova` **non** è stato usato: storico Telegram intatto dal 14 giugno.
- Il tetto delle 1000 righe di PostgREST **non** è stato raggiunto.

## Cosa è stato riparato

1. **Estrattore**: transcript spezzato in parti, tetto di risposta a 4096, run marcato `partial` quando scarta qualcosa invece di dichiararsi riuscito.
2. **Filtro anti-segreti**: non scambia più i protocolli tecnici per carte di credito. Criterio: prefisso emittente + lunghezza + Luhn + confini numerici. Un documento reale era archiviato come `Ass.Blasi_50%_ASID [REDACTED]-3K881C.pdf`.
3. **Doppia scrittura web**: un turno scriveva due righe in `messages`. Ora una sola, sanitizzata e indicizzata dalla route.
4. **Ricerca in memoria**: `richiama_memoria` cercava la frase intera come sequenza letterale. Ora spezza in parole. Era il motivo per cui il bot rispondeva "non ho memoria" in buona fede.
5. **`auto-debrief`**: scritto e testato, mai chiamato da nessuno. Ora cablato a fine turno, **resta flag-gated** (`auto_debrief_enabled`, fail-closed).
6. **Cron `?date=`**: era ignorato, quindi un giorno saltato era perso per sempre. Ora rielabora, saltando idempotenza e senza spostare il segnaposto.
7. **Audit**: vede i run `partial` con severity alta.
8. **Perdita alla chiusura pagina**: il testo già ricevuto viene inviato con `sendBeacon`; la route rifiuta il duplicato **solo** per i salvataggi d'emergenza.

## I tre difetti nati dentro le riparazioni

Nessuno è stato trovato dai test verdi. Tutti da revisioni istruite a cercare in che modo la riparazione potesse mentire.

- **Lo stato `partial` era rifiutato dal database.** Il vincolo CHECK ammetteva solo `started/ok/error`, l'errore della UPDATE non veniva letto: la riga restava `started`, l'audit cieco, e i punti 1 e 7 erano **inerti**. I test non potevano vederlo perché il database è mockato. Chiuso con la migration `2026-08-20-memoria-run-status-partial.sql` (applicata in prod e verificata rileggendo il vincolo) **più** il controllo dell'errore.
- **La difesa anti-duplicato scartava dati legittimi.** Confrontando il contenuto di ogni messaggio, un "ok" o un "procedi" scritti due volte in cinque minuti sparivano in silenzio. Ora vale solo per i salvataggi d'emergenza.
- **`keepalive: true` imponeva il tetto di 64KB a OGNI salvataggio**, non solo in chiusura pagina: ogni risposta lunga avrebbe smesso di salvarsi in silenzio anche a scheda aperta. Peggio del difetto che doveva prevenire. Ora è condizionale, e le soglie stanno in `chat-save-limits.ts` con test — misurate in **byte**, perché su testo tecnico italiano accenti, `€` e `m²` sballano il conto in caratteri.

## Verifica sul campo

Anteprima del ramo, messaggio da **196.199 caratteri** (tre volte la soglia critica): salvato **intero**. Il testo era per giunta storpiato da un errore di codifica dello strumento di prova — il che ha dimostrato che l'applicazione salva esattamente ciò che riceve, senza alterare nulla.

## Rimasto aperto

- **La ricostruzione dei tre mesi non è stata fatta.** I messaggi grezzi ci sono tutti: 25 giorni, costo trascurabile. Giornata di prova naturale: **2026-08-05**, di cui sappiamo cosa deve uscire.
- Chiudendo la **scheda** a metà risposta il testo si salva, ma la difesa anti-duplicato **non è atomica** (SELECT poi INSERT, senza vincolo): probabilità ridotta, non azzerata. Un vincolo unico romperebbe gli "ok" ripetuti legittimi.
- Il testo troncato dal salvataggio d'emergenza è marcato solo da una frase in coda, non da un campo strutturato.
- `projectId` non propagato agli embedding del path web.
- Il codice del browser **non ha test**: è lì che sono nati tutti e tre i difetti sopra.

## La lezione

Tre volte, oggi, una misura sembrava un dato e non lo era: zero righe che erano l'RLS e non il database vuoto; test verdi che giravano su un database finto e non vedevano un vincolo reale; una lunghezza giusta con dentro un testo corrotto.

**Guardare il numero non è guardare il dato.**
