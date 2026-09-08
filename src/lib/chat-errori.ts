/**
 * Il messaggio da mostrare quando un turno della chat web non arriva in fondo.
 *
 * Il difetto che questa funzione chiude (8 set 2026): in `chat/page.tsx` il
 * ramo `err instanceof Error && err.message` veniva PRIMA di quello sulla
 * connessione caduta. Ma `TypeError` e' una sottoclasse di `Error`: il primo
 * prendeva tutto e il secondo era codice morto. Risultato, misurato in
 * produzione due volte in venti minuti: `⚠️ Failed to fetch` su Chrome e
 * `⚠️ network error` su Safari — il gergo del browser al posto della
 * spiegazione scritta apposta.
 */

/**
 * Come i browser chiamano una richiesta che non ha ricevuto risposta. Chrome
 * dice 'Failed to fetch', Safari 'Load failed' o 'network error': cercare la
 * sola parola 'fetch' ne prendeva uno su tre.
 */
const SEGNI_DI_RETE = ['fetch', 'network', 'load failed', 'connection', 'connessione']

function eUnaCadutaDiRete(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false
  const testo = (err.message ?? '').toLowerCase()
  return SEGNI_DI_RETE.some((s) => testo.includes(s))
}

export function messaggioErroreChat(err: unknown, numeroFile: number): string {
  // PRIMA della `Error` generica, altrimenti non si esegue mai.
  if (eUnaCadutaDiRete(err)) {
    // Non si promette che la risposta sia salvata: questo errore si prende
    // anche quando la richiesta non e' MAI arrivata al server (offline, DNS,
    // TLS), e li' non esiste nessun turno da recuperare. Si dice dove
    // guardare, non cosa si trovera'.
    return '⚠️ Connessione persa.\n\n💡 Cosa fare:\n• Controlla la connessione internet\n• Riapri la conversazione: se il turno era partito, la risposta e\' salvata sul server\n• Se stavi caricando file pesanti, prova uno alla volta'
  }
  // Gli errori con un messaggio scritto per l'Ingegnere (il 413 sui file
  // pesanti, per esempio) devono arrivargli interi.
  if (err instanceof Error && err.message) return `⚠️ ${err.message}`
  return numeroFile > 0
    ? '⚠️ Errore durante l\'analisi dei file.\n\n💡 Cosa fare:\n• Carica i file uno alla volta — ogni analisi viene salvata in memoria'
    : '⚠️ Errore di connessione. Riprova.'
}
