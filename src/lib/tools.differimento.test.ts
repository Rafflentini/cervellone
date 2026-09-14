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
  // LA DECISIONE, 14 settembre 2026 (caselle di posta, Task 3). Il NUMERO NON
  // CAMBIA — restano 136 — ma l'impronta si', da `0e77f378c51bbd066553761b0161f8a2`
  // a `881bc21612852e7a859a23c9824f4cc5`. Gli 8 tool `gmail_*` di sola lettura
  // (list_inbox, search, read_message, read_thread, list_drafts, show_draft,
  // list_labels, summary_inbox) hanno un parametro in piu', `caselle`
  // (facoltativo): senza indicazione guardano TUTTE le caselle Google
  // (drive, larealestate) e ogni risultato dichiara da quale viene. Le
  // descrizioni dei tool sono cambiate di conseguenza — non piu'
  // "casella restruktura.drive@gmail.com" fissa.
  it('senza opzioni: 136 definizioni e la stessa impronta di main', () => {
    const defs = getToolDefinitions()
    expect(defs).toHaveLength(136)
    expect(createHash('md5').update(JSON.stringify(defs)).digest('hex'))
      .toBe('881bc21612852e7a859a23c9824f4cc5')
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
