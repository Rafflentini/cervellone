/**
 * Chi comanda la fine di una dettatura sulla chat web.
 *
 * Il difetto che questo modulo chiude (8 set 2026): il riconoscimento del
 * browser (`SpeechRecognition`) chiude da solo dopo qualche secondo di
 * silenzio — e' il suo comportamento normale, anche con `continuous = true`.
 * In `chat/page.tsx` quel `onend` chiamava `stopAudioAnalysis()`, che ferma
 * anche il MediaRecorder: cioe' la registrazione VERA, quella che poi va al
 * server per essere trascritta. Bastava una pausa per pensare e la dettatura
 * finiva a meta'.
 *
 * Il riconoscimento del browser serve solo a mostrare le parole mentre si
 * parla. Non deve decidere quando si smette di registrare. Lo decidono
 * l'Ingegnere, il tetto dei 5 minuti e i due freni qui sotto.
 */

/** Tetto alla dettatura: senza, un microfono dimenticato aperto registra all'infinito. */
export const MAX_REGISTRAZIONE_MS = 5 * 60 * 1000

/**
 * Quanti riavvii a vuoto di fila si tollerano prima di arrendersi.
 *
 * Con la rete giu' (o un proxy che blocca il servizio di riconoscimento) Chrome
 * emette 'network' SUBITO dopo ogni start, non dopo secondi come 'no-speech':
 * senza questo freno il ciclo girerebbe a piena velocita' per tutti e cinque i
 * minuti del tetto, bruciando CPU e batteria.
 */
export const MAX_RIAVVII_RAPIDI = 5

/**
 * Errori dopo i quali riavviare il riconoscimento non serve a niente: il
 * microfono non c'e' o non e' stato concesso.
 */
const ERRORI_FATALI = new Set(['not-allowed', 'audio-capture', 'service-not-allowed'])

export type EsitoRiconoscimento =
  | { tipo: 'fine' }
  | { tipo: 'errore'; codice: string }

export type StatoDettatura = {
  /** false appena l'Ingegnere preme stop: da quel momento non si riavvia piu'. */
  utenteVuoleRegistrare: boolean
  msTrascorsi: number
  /**
   * false quando questo evento arriva da una sessione gia' sostituita da
   * un'altra (doppio tap sul microfono: lo `onend` della vecchia arriva quando
   * la nuova e' gia' partita).
   */
  eLaSessioneCorrente: boolean
  /** Riavvii di fila chiusi subito, senza che sia stata riconosciuta una parola. */
  riavviiRapidiConsecutivi: number
}

export type AzioneDettatura = 'riavvia' | 'ferma' | 'ignora'

export function decidiDopoRiconoscimento(
  esito: EsitoRiconoscimento,
  stato: StatoDettatura,
  maxMs: number,
): AzioneDettatura {
  // Per primo, prima di ogni altra cosa: un evento in ritardo di una sessione
  // superata non deve ne' riavviare se stesso (resterebbe vivo e irraggiungibile
  // dallo stop e dal tetto) ne' fermare la dettatura NUOVA, che l'Ingegnere ha
  // appena fatto partire.
  if (!stato.eLaSessioneCorrente) return 'ignora'
  if (!stato.utenteVuoleRegistrare) return 'ferma'
  if (stato.msTrascorsi >= maxMs) return 'ferma'
  if (esito.tipo === 'errore' && ERRORI_FATALI.has(esito.codice)) return 'ferma'
  if (stato.riavviiRapidiConsecutivi >= MAX_RIAVVII_RAPIDI) return 'ferma'
  // Fine naturale sul silenzio, 'no-speech', 'aborted', 'network': e' una pausa,
  // non la fine della dettatura.
  return 'riavvia'
}

/**
 * Il testo da mostrare nella casella mentre si parla.
 *
 * Al riavvio del riconoscimento `event.results` riparte da zero: quello che era
 * gia' stato detto va tenuto da parte (`giaFissato`), altrimenti a ogni pausa la
 * casella si svuoterebbe sotto gli occhi dell'Ingegnere.
 *
 * NB: questo e' solo cio' che si vede mentre si parla. La trascrizione buona
 * arriva dal server a fine dettatura e sostituisce tutto.
 */
export function componiTestoDettatura(
  giaFissato: string,
  finalCorrente: string,
  interimCorrente: string,
): string {
  return [giaFissato, finalCorrente, interimCorrente]
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Cosa fare della trascrizione del server quando torna. */
export type EsitoTrascrizione =
  | { applica: true; testo: string }
  | { applica: false; motivo: 'dettatura-superata' | 'niente-da-applicare' }

/**
 * La trascrizione del server e' asincrona: torna DOPO la fine della dettatura,
 * e puo' tornare dopo che l'Ingegnere ha gia' premuto invia. Prima, il testo
 * veniva scritto nella casella in ogni caso — quindi ricompariva in una casella
 * appena svuotata, e andava cancellato a mano.
 *
 * Il difetto visibile era il meno grave. Quello vero: il messaggio partiva col
 * testo del BROWSER, il meno accurato, e la trascrizione buona del server
 * finiva nella casella per essere cestinata. Il sistema aveva la risposta
 * migliore e consegnava la peggiore.
 *
 * ⭐ La guardia esisteva gia': `generazioneDettatura` cresce a ogni avvio e a
 * ogni stop, e il suo commento dice che serve «a riconoscere uno stream aperto
 * da una dettatura ormai abbandonata». Era pero' cablata sul microfono e non
 * sulla trascrizione — una difesa costruita per un percorso e non portata su
 * quello accanto, che e' la forma di difetto piu' frequente in questo repo.
 *
 * Qui la regola sta scritta una volta sola, ed e' pura: chi la usa passa la
 * generazione che aveva quando ha chiesto la trascrizione e quella corrente.
 */
export function esitoTrascrizioneTardiva(opzioni: {
  testo: string | null | undefined
  generazioneAllAvvio: number
  generazioneCorrente: number
}): EsitoTrascrizione {
  if (opzioni.generazioneAllAvvio !== opzioni.generazioneCorrente) {
    return { applica: false, motivo: 'dettatura-superata' }
  }
  // Se il server non ha capito niente si tiene quello che aveva scritto il
  // browser: non si peggiora mai.
  const testo = (opzioni.testo ?? '').trim()
  if (!testo) return { applica: false, motivo: 'niente-da-applicare' }

  return { applica: true, testo }
}
