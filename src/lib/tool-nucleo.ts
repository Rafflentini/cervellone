/**
 * I tool che restano SEMPRE caricati nel contesto. Tutti gli altri vengono
 * differiti: il modello li trova cercandoli.
 */

/**
 * Gli otto che stanno nel nucleo PER DISEGNO.
 *
 * CRITERIO DICHIARATO: e' di nucleo un tool che serve a ORIENTARSI nel contesto
 * o a CONSERVARLO — chi e' il cliente, che lavoro e', dentro quale societa'
 * siamo, cosa ci si e' gia' detti — non a produrre un risultato per l'Ingegnere.
 * `ricorda` e' una scrittura, ma conserva contesto: senza, il bot dovrebbe
 * cercare uno strumento prima di poter fissare un fatto da se', e
 * l'apprendimento implicito smetterebbe di essere implicito.
 * UNICA ECCEZIONE DICHIARATA: `lista_scadenze` produce un risultato, e sta nel
 * nucleo lo stesso perche' la modalita' segretaria e' PROATTIVA — deve poter
 * accorgersi di una scadenza senza che nessuno gliela chieda.
 *
 * ⚠️ Questa e' un'IPOTESI, non una scelta su prove: l'11 settembre 2026 non
 * esisteva ancora nessun registro delle chiamate ai tool. Va rivista sui dati
 * di `cervellone_tool_calls` dopo una settimana di uso vero.
 */
export const NUCLEO_DISEGNO: ReadonlySet<string> = new Set([
  'cerca_documenti',          // cosa e' gia' stato prodotto
  'ricorda',                  // fissare un fatto
  'richiama_memoria',         // cosa si e' gia' detto
  'lista_entita',             // chi sono clienti, cantieri, fornitori
  'lista_scadenze',           // cosa incombe (modalita' segretaria)
  'cervellone_info',          // cosa so fare io
  'imposta_societa_attiva',   // dentro quale delle due societa' siamo
  'imposta_progetto_attivo',  // su quale lavoro siamo
])

/**
 * ⚠️ QUESTI SEI SONO UN DEBITO, NON UNA SCELTA.
 * Stanno nel nucleo solo perche' la ricerca NON LI RITROVA: misurato l'11 set 2026 con frasi
 * vere, col differimento acceso il modello chiamava altro (o niente). Costano ~1.200 token.
 * Ognuno esce da qui il giorno in cui la sua descrizione conterra' le parole con cui lo si
 * cerca — vedi il criterio in 2026-09-11-strada-c-differimento-tool-design.md §5.1.
 * Se questo insieme non si svuota mai, il debito e' diventato un costo fisso.
 */
export const NUCLEO_DEBITO_RICERCA: ReadonlySet<string> = new Set([
  'riconcilia_automatico',          // la ricerca LO TROVA, il modello sceglie lista_movimenti
  'modello_attivo',                 // chiamava richiama_memoria
  'checkin_prepara_foglio',         // chiamava richiama_memoria
  'cervellone_check_aggiornamenti', // chiamava cervellone_info
  'affitti_imposta_soggiorno',      // non chiamava NIENTE: rispondeva a parole
  'affitti_situazione',             // perso 2 volte su 3
])

export const NUCLEO_TOOL: ReadonlySet<string> = new Set([...NUCLEO_DISEGNO, ...NUCLEO_DEBITO_RICERCA])

/**
 * Con il differimento acceso il modello vede ~11 tool su 130. Se nessuno gli dice
 * che gli altri esistono, NON li cerca: risponde con quelli che vede, e sembra che
 * abbia perso delle capacita'. Misurato l'11 set 2026: senza questa riga cercava in
 * 3 casi su 9, con questa riga in 7 su 9.
 *
 * Non e' un router e non e' una regola procedurale: e' dirgli la verita' sulla sua
 * situazione. Per questo compare SOLO quando il differimento e' acceso — a
 * interruttore spento sarebbe una bugia.
 */
export const AVVISO_STRUMENTI_CERCABILI =
  '\n\nI TUOI STRUMENTI: ne vedi solo una parte. Gli altri esistono ma non ti sono stati ' +
  'caricati. Per trovarli usa tool_search_tool_bm25 con una query in italiano che descriva ' +
  'cosa ti serve. Se ti sembra di non avere lo strumento adatto, CERCALO prima di rispondere ' +
  'che non puoi.'
