import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'crypto'

vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'upsert', 'delete', 'order', 'limit', 'in', 'ilike']) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

import { getToolDefinitions } from './tools'

type Def = { name: string; defer_loading?: boolean; type?: string }

describe('differimento delle definizioni dei tool', () => {
  it('SENZA opzioni l output e identico a prima: nessun defer_loading, nessuna ricerca', () => {
    const defs = getToolDefinitions() as Def[]
    expect(defs.some((d) => d.defer_loading !== undefined)).toBe(false)
    expect(defs.some((d) => d.type?.startsWith('tool_search'))).toBe(false)
    // L'ordine e' parte della garanzia: `tools` e' il primo blocco del prefisso
    // della cache, un riordino la invaliderebbe a ogni turno senza dirlo.
    expect(defs.slice(0, 2).map((d) => d.name)).toEqual(['web_search', 'code_execution'])
  })

  // LA GARANZIA DEL RAMO, PRESIDIATA.
  //
  // "Senza opzioni l'output e' identico a main" e' la frase piu' citata di
  // questo lavoro, ma era una misura fatta A MANO una volta sola: nessun test
  // la difendeva. Mutazione sopravvissuta alla suite INTERA (2.231 verdi):
  //   ALL_TOOLS.filter(t => t.name !== 'gmail_summary_inbox'
  //                      && t.name !== 'estrai_movimenti'
  //                      && t.name !== 'affitti_incassi')
  // cioe' tre tool spariti dalle definizioni spedite all'API senza che nulla
  // se ne accorgesse.
  //
  // ⚠️ L'md5 e' quello di `main`: md5(JSON.stringify(getToolDefinitions())),
  // 130 definizioni = 2 tool server + 128 custom, ordine compreso. Se questa
  // asserzione cade, NON si aggiorna il numero: o la parita' con `main` si e'
  // rotta per sbaglio, o si e' DECISO di cambiarla — e allora va scritta la
  // decisione, non il nuovo md5.
  //
  // LA DECISIONE, 12 settembre 2026 (prima). Era 129 (2 + 127) con impronta
  // `5fe48792af88c5f89beaf66c53366b1c`. E' stato aggiunto UN tool custom:
  // `segna_fatture_ricevute_pagate` — segnare pagata una fattura RICEVUTA su
  // Fatture in Cloud, che prima non si poteva fare, per registrare i pagamenti
  // in contanti che non lasciano nessun movimento bancario. Un tool in piu' e'
  // esattamente quello che questa asserzione deve costringere a dichiarare: il
  // numero sale da 129 a 130 di proposito, non per sbaglio.
  //
  // LA DECISIONE, 12 settembre 2026 (Task 14). Era 130 con impronta
  // `16ce3fca1c09ee99f6f379e648300bee`. E' stato aggiunto UN tool custom:
  // `fic_leggi_allegato_fattura` — legge l'ALLEGATO (XML SDI o PDF) di una
  // fattura RICEVUTA per sapere la modalita' di pagamento SCRITTA DAL
  // FORNITORE, che nessun campo di `ReceivedDocument` espone. Nasce dal fatto
  // di produzione dello stesso giorno: tre ore passate a riportare "nessuna
  // modalita' di pagamento" leggendo `payment_account` (il CONTO con cui NOI
  // registriamo il pagamento) invece della `ModalitaPagamento` dell'XML SDI.
  // Il numero sale da 130 a 131 di proposito.
  //
  // LA DECISIONE, 13 settembre 2026 (Task 15). Era 131 con impronta
  // `d232705817ad40a8d35902df2c968b82`. E' stato aggiunto UN tool custom:
  // `fic_modalita_pagamento_fornitore` — screma un GRUPPO di fatture RICEVUTE
  // per la modalita' di pagamento SCRITTA DAL FORNITORE (contanti/bonifico/
  // assegno/carta/RIBA), leggendo l'allegato di ognuna e dividendo l'insieme
  // in tre esiti mai confusi: dichiarata, non_dichiarata (un DATO) e
  // non_leggibile (un GUASTO). Nasce dalle parole di Raffaele il 12 set 2026:
  // «se io ti dico di controllare, se c'e', tu devi saperlo fare e dirmelo, in
  // modo da scremare le fatture». Il numero sale da 131 a 132 di proposito.
  //
  // LA DECISIONE, 13 settembre 2026 (Decollo, passo 4). Era 132 con impronta
  // `fd64fdae3ab2fc6c39e7d6fe1a54fc22`. E' stato aggiunto UN tool custom:
  // `chiedi_alla_contabile` — la porta con cui il coordinatore gira un lavoro
  // di contabilita' alla contabile, uno specialista che ha in mano SOLO
  // Fatture in Cloud, prima nota, movimenti e riconciliazioni.
  //
  // ⚠️ Il tool sta nel registro anche a DECOLLO SPENTO, ed e' voluto: da spento
  // l'esecutore rifiuta e spiega perche', ma la definizione resta. Un tool che
  // compare e scompare a seconda di una variabile d'ambiente sfuggirebbe alle
  // guardie anti-buco della mappa dell'officina — si spegnerebbe la difesa
  // insieme alla funzione, che e' il modo in cui un interruttore diventa un
  // buco. Il numero sale da 132 a 133 di proposito.
  //
  // LA DECISIONE, 13 settembre 2026 (audit del Decollo). Il NUMERO NON CAMBIA
  // — restano 133 — ma l'impronta sì, da `21a1fc15f6632aa8756c066c4e041138`.
  // E' cambiata la DESCRIZIONE di `chiedi_alla_contabile`, per un bloccante:
  // aveva un parametro `societa` che non commutava niente. Gli attrezzi della
  // contabile passano dal wrapper `contabile()`, che ricava la societa' dalla
  // CONVERSAZIONE e non guarda mai l'input: il coordinatore avrebbe potuto
  // scrivere «La Real Estate», la contabile leggere Restruktura e riferirle
  // come La Real Estate, senza che se ne accorgesse nessuno. Il parametro e'
  // stato TOLTO dallo schema e la descrizione ora dice di cambiare societa'
  // attiva prima di chiamare.
  //
  // ⚠️ Un'impronta che cambia SENZA che cambi il numero e' esattamente il caso
  // per cui questa asserzione porta l'md5 e non solo il conteggio: un tool
  // ritoccato non si vede contando.
  //
  // LA DECISIONE, 13 settembre 2026 (Decollo, passo 5). Era 133 con impronta
  // `7f67d1145e7198ec7aac24abe0532c57`. E' stato aggiunto UN tool custom:
  // `chiedi_al_geometra` — la seconda porta del Decollo.
  //
  // ⚠️ E cambia anche la descrizione della PRIMA (`chiedi_alla_contabile`),
  // perche' le due porte ora sono GENERATE dal registro degli specialisti
  // invece di essere scritte a mano: le parti comuni — identificativi esatti,
  // «prepara ma non esegue», societa' attiva — stanno in un posto solo. Era
  // questo il punto del passo 5: non «un secondo specialista scritto a mano»,
  // ma la prova che il secondo costa **una riga** in `specialisti.ts`.
  //
  // Il geometra e' scelto apposta come secondo perche' e' l'unico che NON puo'
  // fare danni: `haPotereIrreversibile(geometra)` e' false, calcolato. Un
  // preventivo si rifa'; una mail spedita no.
  //
  // LA DECISIONE, 13 settembre 2026 (sera). Era 134 con impronta
  // `33ab554e57979b33aceb46cfbab47f43`. E' stato aggiunto UN tool custom:
  // `fic_crea_cliente` — crea l'anagrafica cliente su Fatture in Cloud, su
  // entrambe le societa'.
  //
  // Nasce da un buco trovato rispondendo a una domanda di Raffaele: il bot NON
  // sapeva creare un'anagrafica. In tutto il codice c'era una sola chiamata a
  // `entities/clients`, ed era una LETTURA. Per La Real Estate e' il caso
  // NORMALE — affitti brevi, quasi ogni ospite e' nuovo — quindi senza questo
  // tool la fatturazione di lunedi' si sarebbe fermata al primo cliente.
  //
  // Cambia anche la descrizione di `compila_fattura_emessa`, che ora accetta
  // `cliente_id`: col solo nome, se in anagrafica ci sono due persone simili,
  // veniva preso il PRIMO in silenzio.
  //
  // LA DECISIONE, 13 settembre 2026 (sera, seconda). Il NUMERO NON CAMBIA —
  // restano 135 — ma l'impronta si', da `c015553b88cc656168e7cbdf3e0efe3b`.
  // Sono cambiate DUE descrizioni, per chiudere l'ultimo anello del giro che
  // Raffaele ha descritto:
  //
  // - `fic_cerca_anagrafica` ora cerca anche per CODICE FISCALE e PARTITA IVA,
  //   non piu' solo per nome. Il nome e' la chiave meno affidabile: «Rossi
  //   Mario» e «Mario Rossi» sono la stessa persona e `name contains` non li
  //   unisce. Su un ospite ricorrente voleva dire concludere «non c'e'» e
  //   creargli la seconda scheda — cioe' il doppione, esattamente il difetto
  //   che `fic_crea_cliente` era appena nato per evitare.
  //
  // - `compila_fattura_emessa` ora porta scritta la PROCEDURA nei suoi tre
  //   passi (cerca → se manca crea → passa il cliente_id). Il tool sapeva
  //   farlo; nessuno gli diceva in che ordine.
  //
  // LA DECISIONE, 14 settembre 2026 (notte). Era 135 con impronta
  // `99f55eff78f0e4b014d76ed7d9ef51e4`. E' stato aggiunto UN tool custom:
  // `segna_fatture_emesse_pagate` — segnare INCASSATA una fattura EMESSA,
  // alla data del bonifico. Nasce alle 00:20 dello stesso giorno: il bot aveva
  // in mano la fattura 19-ED (€501,05 del 15/06) e il bonifico da €501,05 del
  // 15/06, li ha abbinati, e poi ha dovuto dire all'Ingegnere che «non esiste
  // un tool che scriva pagata su una fattura EMESSA». Esisteva solo per le
  // ricevute (i contanti Limongi). Il numero sale da 135 a 136 di proposito.
  //
  // LA DECISIONE, 14 settembre 2026 (notte, seconda). Il NUMERO NON CAMBIA —
  // restano 136 — ma l'impronta si', da `0e77f378c51bbd066553761b0161f8a2`.
  // `segna_fatture_emesse_pagate` ha un parametro in piu', `importo_bonifico`:
  // l'audit dell'accensione ha fatto notare che il prompt diceva «combacia al
  // centesimo» e il tool non aveva modo di saperlo — un bonifico parziale
  // avrebbe segnato pagata l'intera voce. Ora, se l'importo non combacia, la
  // fattura viene ESCLUSA e lo dice.
  //
  // LA DECISIONE, 14 settembre 2026. Da 136 a 137, impronta da
  // `bec89cf4b8eca133e2e64a6ee3f21d54`. E' entrato `verifica_deriva_schema`:
  // dice quali migrazioni del repository NON sono applicate al database di
  // produzione. Nasce perche' quel giorno si e' scoperto che cinque migrazioni
  // su 43 non erano mai state applicate, e due di quelle reggevano codice vivo
  // da mesi senza che nessuno se ne accorgesse. Il numero sale di proposito.
  // LA DECISIONE, 14 settembre 2026 (caselle di posta, Task 3). Il NUMERO NON
  // CAMBIA — restano 136 — ma l'impronta si', da `0e77f378c51bbd066553761b0161f8a2`
  // a `881bc21612852e7a859a23c9824f4cc5`. Gli 8 tool `gmail_*` di sola lettura
  // (list_inbox, search, read_message, read_thread, list_drafts, show_draft,
  // list_labels, summary_inbox) hanno un parametro in piu', `caselle`
  // (facoltativo): senza indicazione guardano TUTTE le caselle Google
  // (drive, larealestate) e ogni risultato dichiara da quale viene. Le
  // descrizioni dei tool sono cambiate di conseguenza — non piu'
  // "casella restruktura.drive@gmail.com" fissa.
  //
  // LA DECISIONE, 14 settembre 2026 (caselle di posta, Task 4). Il NUMERO NON
  // CAMBIA — restano 136 — ma l'impronta si', da `881bc21612852e7a859a23c9824f4cc5`
  // a `a236f73fc2a117216b97b4db1b70544e`. Gli 8 tool `gmail_*` di SCRITTURA
  // (create_draft, send_draft, delete_draft, apply_label, remove_label,
  // mark_read, archive, trash) hanno un parametro in piu', `casella`
  // (OBBLIGATORIO, niente default): a differenza della lettura (Task 3), in
  // scrittura la casella non si deduce mai — non e' nello schema come
  // facoltativo ma come `required`, e il rifiuto vero e proprio (se manca o
  // e' inventata) avviene nel CODICE — `casellaPerScrittura` in
  // `politica-caselle.ts`, chiamata da `executeGmailWrapper` prima di
  // toccare `gmail-tools` — non in una regola di prompt.
  // LA DECISIONE, 14 settembre 2026 (caselle di posta, Task 6). Il NUMERO
  // CAMBIA — da 136 a 137 — e l'impronta con esso, da
  // `a236f73fc2a117216b97b4db1b70544e` a `0848ebc6c335bda6580cea6459eee647`.
  // Nuovo tool `verifica_accessi_google`: prova una per una le credenziali
  // Google e dice quali sono VIVE, col motivo se non lo sono. Prima di oggi
  // la domanda "la casella di La Real Estate funziona?" non aveva risposta:
  // la credenziale era salvata ma mai esercitata.
  // LA DECISIONE, 14 settembre 2026 (sera, merge dei due rami). 136 -> 139.
  // Tre tool nati nella stessa giornata su rami diversi: `verifica_deriva_schema`
  // (quali migrazioni del repo non sono applicate al database),
  // `verifica_accessi_google` (quali credenziali Google sono vive) e
  // `gmail_leggi_allegato` — quest'ultimo perche' la funzione che scarica un
  // allegato Gmail esisteva da mesi e NESSUN tool la esponeva.
  //
  // LA DECISIONE, 14 settembre 2026 (autofatture). E' entrato
  // `compila_autofattura`: le INTEGRAZIONI in reverse charge per le fatture
  // estere — il caso vero sono le commissioni mensili di Booking.com B.V. a
  // LA REAL ESTATE, identiche per le fee di Airbnb Ireland UC.
  //
  // E' l'unico tool che crea N documenti fiscali con UNA conferma sola («non
  // e che mi metto a confermare quindici fatture vocalmente»), e per questo
  // la sua descrizione e' lunga: porta scritte le cose che NON decide —
  // l'aliquota IVA (senza `vat_id` si ferma ed elenca quelle vere di Fatture
  // in Cloud), la serie di numerazione dedicata, e i «dati fattura collegata»
  // che vanno controllati a mano su FIC.
  //
  // LA DECISIONE, 14 settembre 2026 (TD17 in `ei_raw`). La documentazione
  // ufficiale di Fatture in Cloud dice che il codice TD17 NON sta nel campo
  // `type` ma in `ei_raw.FatturaElettronicaBody.DatiGenerali.
  // DatiGeneraliDocumento.TipoDocumento`. Il tool ora lo imposta.
  // Un tool che dice di NON fare una cosa che invece fa e' sbagliato quanto
  // il contrario: per questo il cambio di descrizione paga il pedaggio
  // dell'impronta anche senza un tool in piu'.
  //
  // LA DECISIONE, 14 settembre 2026 (il PDF da rivedere). Era 140 con impronta
  // `1f2040fdd43a653c897ee0119d750d14`. E' stato aggiunto UN tool custom:
  // `fic_pdf_documento` — il LINK al PDF di un documento EMESSO su Fatture in
  // Cloud (fattura, autofattura/integrazione, nota di credito) dato il suo id.
  //
  // Nasce dalle parole dell'Ingegnere: «se gli richiedo da Cervellone il PDF
  // della fattura o autofattura che ha compilato per controllarla, sa scaricare
  // PDF e ridarmelo li' per controllare». Prima, per rivedere una bozza appena
  // compilata, bisognava aprire il gestionale a mano.
  //
  // ⚠️ Restituisce un LINK e non il file, ed e' una scelta obbligata dalla
  // regola dei DUE CANALI EQUIPOLLENTI: su Telegram Cervellone sa mandare solo
  // testo (`telegram-helpers.ts` non ha `sendDocument`) e i tool ricevono
  // `conversationId`, non l'id della chat. Un link si apre identico sui due
  // canali. Il numero sale da 140 a 141 di proposito.
  //
  // IL MERGE, 14 settembre 2026 (notte). I due rami dichiaravano ENTRAMBI
  // 139 con impronte diverse, perche' contavano insiemi diversi: quello di
  // `main` non aveva `compila_autofattura`, quello delle autofatture non
  // aveva `verifica_deriva_schema`. Numero e impronta qui sotto sono presi
  // DAL FALLIMENTO del test, non calcolati a parte.
  // LA DECISIONE, 14 settembre 2026 (la spesa del fornitore). Era 140 con
  // impronta `1f2040fdd43a653c897ee0119d750d14`. E' stato aggiunto UN tool
  // custom: `registra_spesa_fornitore` — registra su Fatture in Cloud la
  // fattura d'ACQUISTO di un fornitore come documento RICEVUTO, prendendo il
  // PDF da una mail di Gmail e allegandoglielo.
  //
  // Nasce da un buco aperto dal tool del giorno prima: `compila_autofattura`
  // sa creare l'integrazione TD17 delle fatture estere, cioe' l'IVA a DEBITO,
  // e nessuno sapeva registrare la fattura passiva a monte. Mezzo adempimento.
  // Le parole dell'Ingegnere sul perimetro: «deve solo mettere PDF e importo».
  //
  // ⚠️ Numero e impronta qui sotto sono presi DAL FALLIMENTO del test, non
  // calcolati a parte. Il numero sale da 140 a 141 di proposito.
  //
  // IL SECONDO MERGE, 14 settembre 2026 (notte). Di nuovo due rami che
  // dichiaravano ENTRAMBI 141 con impronte diverse: uno contava
  // `fic_pdf_documento` (riavere il PDF di un documento emesso per
  // ricontrollarlo prima di trasmetterlo), l'altro `registra_spesa_fornitore`.
  // Sommati fanno 142. E anche qui numero e impronta vengono DAL FALLIMENTO
  // del test: calcolarli a parte vorrebbe dire scrivere l'impronta di quello
  // che si crede, non di quello che c'e'.
  //
  // LA DECISIONE, 14 settembre 2026 (il fornitore nel suo elenco). Il NUMERO
  // NON CAMBIA — restano 142 — ma l'impronta si', da
  // `873a2973612199d616af1368ddb8ee65`. `fic_crea_cliente` aveva
  // `entities/clients` CABLATO e sapeva creare solo clienti: Booking.com B.V.
  // e' un FORNITORE, e su Fatture in Cloud i due elenchi sono separati.
  // Adesso accetta `elenco: 'fornitore'`, e siccome una capacita' che non e'
  // nello schema per il modello NON ESISTE, la descrizione cambia con lui e
  // paga il pedaggio dell'impronta.
  //
  // LA DECISIONE, 15 settembre 2026 (l'integrazione a norma). Il numero NON
  // cambia — restano 142 — ma l'impronta si'. La descrizione di
  // `compila_autofattura` diceva due cose che non sono piu' vere: che NON
  // compila i «dati fattura collegata» (ora li compila, in `ei_raw`, ed e'
  // visibile sull'anteprima elettronica come «Fatt.Coll.») e non diceva nulla
  // del codice destinatario SdI, che ora e' il NOSTRO e non quello del
  // fornitore estero.
  //
  // ⚠️ Una descrizione che mente al modello e' un difetto, non un dettaglio:
  // e' su quella che decide se e quando usare il tool, e cosa dire
  // all'Ingegnere dopo. Per questo il cambio di parole paga il pedaggio
  // dell'impronta anche senza un tool in piu'.
  //
  // LA DECISIONE, 15 settembre 2026 (il metodo di pagamento sulle fatture ai
  // clienti). Numero invariato — 142 — impronta cambiata: `compila_fattura_emessa`
  // accetta ora `metodo_pagamento`, perche' Fatture in Cloud lo PRETENDE su un
  // documento elettronico. Senza, la prima fattura di soggiorno sarebbe morta
  // con lo stesso 422 dell'autofattura.
  //
  // LA DECISIONE, 15 settembre 2026 (modificare invece di cancellare e
  // rifare). Da 142 a 143: nasce `modifica_documento_fic`, che cambia i campi
  // di un documento EMESSO gia' creato e non ancora trasmesso. Prima l'unica
  // strada per correggere un'autofattura sbagliata era cancellarla e rifarla,
  // e su una serie di numerazione fiscale questo lascia un BUCO: il numero
  // bruciato non torna.
  //
  // ⚠️ Numero e impronta vengono DAL FALLIMENTO del test, non calcolati a
  // parte. ⚠️ In questo checkout `node_modules` e' incompleto (la cartella
  // `pino` e' VUOTA, mancano puppeteer-core, @sparticuz/chromium, pdf-parse,
  // rimraf) e QUESTO FILE non si importa affatto — insieme ad altri 33. La
  // misura e' stata presa facendo fallire lo stesso `expect` in un file
  // temporaneo che stuzzava solo quei pacchetti, che le definizioni dei tool
  // non toccano; il conteggio letto li' era 143, cioe' esattamente 142 + 1.
  it('senza opzioni: 143 definizioni e la stessa impronta di main', () => {
    const defs = getToolDefinitions()
    expect(defs).toHaveLength(143)
    expect(createHash('md5').update(JSON.stringify(defs)).digest('hex'))
      .toBe('873a2973612199d616af1368ddb8ee65')
  })

  it('col nucleo, i tool fuori dal nucleo sono differiti e quelli dentro no', () => {
    const nucleo = new Set(['cervellone_info', 'cerca_documenti'])
    const defs = getToolDefinitions({ nucleo }) as Def[]
    const dentro = defs.find((d) => d.name === 'cervellone_info')
    const fuori = defs.find((d) => d.name === 'read_email')
    expect(dentro?.defer_loading).toBeUndefined()
    expect(fuori?.defer_loading).toBe(true)
  })

  it('i due tool server non vengono MAI differiti', () => {
    const defs = getToolDefinitions({ nucleo: new Set<string>() }) as Def[]
    for (const n of ['web_search', 'code_execution']) {
      expect(defs.find((d) => d.name === n)?.defer_loading).toBeUndefined()
    }
  })

  it('con ricerca:true dichiara il tool di ricerca in testa', () => {
    const defs = getToolDefinitions({ nucleo: new Set(['cervellone_info']), ricerca: true }) as Def[]
    expect(defs[0].type).toBe('tool_search_tool_bm25_20251119')
    expect(defs[0].name).toBe('tool_search_tool_bm25')
  })

  // L'API rifiuta con 400 una richiesta in cui TUTTO e differito. Il nucleo
  // vuoto piu ricerca deve restare legale grazie ai due tool server.
  it('non differisce mai tutto: resta sempre almeno un tool caricato', () => {
    const defs = getToolDefinitions({ nucleo: new Set<string>(), ricerca: true }) as Def[]
    expect(defs.filter((d) => !d.defer_loading).map((d) => d.name))
      .toEqual(['tool_search_tool_bm25', 'web_search', 'code_execution'])
  })
})
