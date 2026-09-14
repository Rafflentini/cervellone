# `fic_pdf_documento` — rivedere una fattura emessa senza aprire il gestionale

**14 settembre 2026** · worktree `worktree-agent-aac8b37d87a782412` · commit `061cf10`, `c6f2010`

---

## Che cosa serviva

L'Ingegnere fa compilare fatture e autofatture a Cervellone, e poi vuole **rivederle
prima di trasmetterle allo SdI**. Per farlo doveva aprire Fatture in Cloud a mano.
Parole sue:

> «se gli richiedo da Cervellone il PDF della fattura o autofattura che ha compilato per
> controllarla, sa scaricare PDF e ridarmelo lì per controllare»

## Che cosa c'è adesso

Tre pezzi.

**1. `pdfDocumentoEmesso(id, societa)` — `src/lib/fic-allegato.ts`**
Legge il documento emesso con `fieldset=detailed`, prende il campo `url`, scarica, e
restituisce i byte con i dati del documento (numero, data, totale, tipo, cliente, nome
file). Legge e basta: non modifica, non trasmette, non cancella.

**2. `GET /api/fic-pdf/[societa]/[id]` — rotta nuova**
Stesso schema di accesso di `/api/doc/[id]`: cookie di sessione **oppure** collegamento
firmato (`?t=…&exp=…`), verificato da `isDocAccessAllowed`. Scarica da FIC al momento e
passa i byte con `Content-Type: application/pdf` e un `Content-Disposition` col nome
leggibile. Niente PDF binari nella tabella `documents`.

**3. `fic_pdf_documento` — `src/lib/tools/fic-pdf-tools.ts`**
Prende l'id, restituisce il **link** con numero, data, totale, tipo e cliente. Registrato
in `ALL_TOOLS`, in `EXECUTORS` e nello scaffale *Contabilità e fatture* di
`mappa-officina.ts` (da cui deriva il perimetro della contabile).

## L'incognita, dichiarata

🚨 **La documentazione ufficiale di Fatture in Cloud non dice se il campo `url` di un
documento emesso sia scaricabile direttamente, se voglia il token, né se scada.** Non
era verificabile: le variabili FIC stanno solo su Vercel e scaricarle tirerebbe giù
tutti i segreti del progetto.

Quindi il codice **prova e dice com'è andata**:

1. tentativo **senza** token;
2. **solo** su 401/403, ritentativo con `Authorization: Bearer`;
3. se falliscono entrambi, il messaggio porta **lo stato HTTP vero** e il corpo della
   risposta (primi 200 caratteri) — mai un «documento non disponibile» generico.

Il campo `autenticazione` (`'nessuna' | 'bearer'`) arriva fino alla risposta del tool:
**al primo uso vero si leggerà quale strada ha funzionato**, invece di dedurla.

⬜ **Da verificare al primo uso vero** — è scritto anche nel commento in testa al blocco:
quale delle due strade risponde, e se il link di FIC scade (in quel caso una chiamata
tardiva darà 403/404 e lo si leggerà scritto).

## Le difese, e cosa succede se le spegni

| Difesa | Dove | Mutazione | Esito |
|---|---|---|---|
| I **byte**, non il nome: `rilevaFormato` cerca `%PDF` | `fic-allegato.ts` | `formato !== 'pdf'` → `false` | 🔴 1 rosso |
| Il Bearer **non** parte verso un host che non sia `fattureincloud` | `fic-allegato.ts` | `!eDiFattureInCloud(url)` → `false` | 🔴 1 rosso |
| Si ritenta **solo** su 401/403 | `fic-allegato.ts` | condizione → `false` | 🔴 1 rosso |
| Il nome file passa da un setaccio `[A-Za-z0-9._-]` (finisce in un header) | `fic-allegato.ts` | `pulisci` → identità | 🔴 2 rossi |
| La chiave firmata porta dentro la **società** | `fic-allegato.ts` | chiave senza società | 🔴 4 rossi |
| `nessun_url` ≠ `scaricamento` | `fic-allegato.ts` | motivi confusi | 🔴 1 rosso |
| Nessun accesso senza token valido | rotta | guardia spenta | 🔴 6 rossi |
| Un guasto non risponde 200 | rotta | `? 404 : 502` → `? 200 : 200` | 🔴 3 rossi |
| Il link **scade** | tool | 30 min → un anno | 🔴 1 rosso |
| L'ordine in `EXECUTORS` | `tools.ts` | i due wrapper scambiati | 🔴 1 rosso |
| Il tool sta su **uno** scaffale | `mappa-officina.ts` | tolto dal dominio | 🔴 1 rosso |

**11 mutazioni, 11 uccise.** `grep -c` prima e dopo ogni mutazione, con i file misurati:
`fic-allegato.ts` 593/593 righe CRLF, la rotta 91/91, il tool 139/139 — tutti CRLF al
100%, quindi nessun falso verde da terminatore. Ogni file ripristinato da `.bak` con
`md5sum` confrontato prima e dopo.

Ogni difesa ha il suo **controllo positivo** accanto: un link senza token dà 401 **e** un
link con token valido dà 200 (con byte `%PDF` veri e `Content-Disposition` giusto); un
nome `fic_` inesistente viene ancora rifiutato dalla catena, altrimenti un wrapper che
torna sempre `null` passerebbe il test dell'ordine.

## Il guasto di famiglia che stava per ripetersi

`executeFicTool` rivendica **ogni** nome che comincia per `fic_` e a quelli che non
conosce risponde `tool FIC sconosciuto` — che è una *risposta*, non un `null`:
`executeTool` si ferma lì. Messo dopo `executeFicWrapper`, `fic_pdf_documento` sarebbe
stato un tool **registrato in cinque posti e irraggiungibile**, esattamente come
`gmail_leggi_allegato` il 14 settembre. Il wrapper sta prima, e un test chiama
`executeTool` come lo chiama il modello.

## Verifica

- `npx tsc --noEmit` → pulito
- `npx vitest run` → **3.077 verdi**, 4 saltati, 0 rossi (38 test nuovi)
- `npx eslint` sui file nuovi → nessun errore
- `npm run build` → compila e supera il TypeScript, poi muore su `supabaseUrl is
  required` in `/api/conversations/[id]/messages`: è il guasto noto dei worktree senza
  `.env.local`, non di questo lavoro. La parte che conta — la validazione dei tipi della
  rotta App Router — è passata.

## I dubbi

1. **Il tool scarica il PDF due volte.** Una volta per verificare i byte prima di firmare
   il link, una volta quando il link si apre. È una scelta mia: consegnare un link
   «probabilmente valido» sposterebbe il guasto nel browser dell'Ingegnere, dove nessuno
   lo sa spiegare. Ma se un PDF FIC fosse grosso, un giro di tool costerebbe due
   download. **Da rivedere se i tempi si allungano.**
2. **Trenta minuti di scadenza li ho decisi io.** Nessuno l'ha chiesto. Serve per un
   controllo immediato, non per archiviare; se all'Ingegnere serve più tempo (apre il
   link dal telefono più tardi), va alzata — è una costante sola,
   `DURATA_LINK_MINUTI`.
3. **La difesa che NON sono riuscito a costruire: la prova che l'`url` funziona.** Nessun
   test qui dimostra che Fatture in Cloud risponda davvero. Tutte e tredici le prove
   girano su `fetch` finto. Se FIC non espone affatto un PDF pronto su quel campo — per
   esempio se l'`url` fosse una pagina web del gestionale invece del file — il tool
   risponderà `non_pdf` con l'anteprima dei byte, il che è onesto ma non è la funzione
   che l'Ingegnere ha chiesto. **Il primo uso vero è la prova, e non c'è modo di
   anticiparla da qui.**
4. **La lista degli host fidati (`fattureincloud.it`/`.com`) è un'ipotesi.** Se FIC
   servisse i PDF da un CDN suo con un altro dominio e quel CDN rispondesse 401, il
   ritentativo non partirebbe. Il messaggio lo direbbe in chiaro (nomina l'host), quindi
   il guasto non è muto, ma la cura sarebbe allargare la lista — dopo aver visto
   l'host vero, non prima.
5. **Il ramo `!token` in `scaricaPdfDaFic` oggi è irraggiungibile**: se il token mancasse,
   `ficGet` avrebbe già fallito prima. L'ho lasciato perché dichiara invece di tacere, ma
   è codice non esercitato da nessun test.
6. **`fic_dettaglio_documento` non rimanda a questo tool.** La sua descrizione parla di
   `fic_leggi_allegato_fattura` per le ricevute; non ho toccato `fatture-in-cloud.ts`
   oltre a un import, perché un altro agente ci sta lavorando in parallelo. Se vale la
   pena incrociare le descrizioni, è un ritocco da fare **dopo** il merge dei due rami —
   e paga il pedaggio dell'impronta.
7. **Il test `fatture-in-cloud.pagamento-fornitore.test.ts` è andato in timeout a 5000 ms**
   in uno dei giri della suite intera, e verde negli altri due più in isolamento. È il
   fenomeno già documentato in `vitest.config.ts` (fame di CPU fra worker), non una
   regressione di questo lavoro — ma quel test consuma 4,03 s su 5 anche da solo, quindi
   è appeso a un filo.
