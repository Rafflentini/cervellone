/**
 * I tool che restano SEMPRE caricati nel contesto. Tutti gli altri vengono
 * differiti: il modello li trova cercandoli.
 *
 * CRITERIO DICHIARATO: e' di nucleo un tool che serve a CAPIRE la richiesta,
 * non a FARE il lavoro. Orientarsi (chi e' il cliente, che progetto e', cosa
 * si e' detto prima) deve essere possibile senza cercare niente.
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
