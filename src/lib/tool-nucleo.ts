/**
 * I tool che restano SEMPRE caricati nel contesto. Tutti gli altri vengono
 * differiti: il modello li trova cercandoli.
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
export const NUCLEO_TOOL: ReadonlySet<string> = new Set([
  'cerca_documenti',          // cosa e' gia' stato prodotto
  'ricorda',                  // fissare un fatto
  'richiama_memoria',         // cosa si e' gia' detto
  'lista_entita',             // chi sono clienti, cantieri, fornitori
  'lista_scadenze',           // cosa incombe (modalita' segretaria)
  'cervellone_info',          // cosa so fare io
  'imposta_societa_attiva',   // dentro quale delle due societa' siamo
  'imposta_progetto_attivo',  // su quale lavoro siamo
])
