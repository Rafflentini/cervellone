/**
 * lib/memoria-sovrascrittura.ts — Due regole che proteggono la memoria dal
 * proprio meccanismo di aggiornamento.
 *
 * Nascono da un audit del 3 settembre 2026, dopo la ricostruzione a mano dei
 * tre mesi di memoria persa. Entrambe riguardano lo stesso punto cieco: il
 * codice che SCRIVE la memoria non sapeva niente di quello che c'era gia'.
 */

/** La stringa che il sistema scrive per una giornata davvero senza attivita'. */
const SEGNAPOSTO_VUOTO = 'Nessuna attività rilevante'

export interface RigaSummary {
  summary_text: string | null
  message_count: number | null
}

/**
 * Dice se una rielaborazione che NON ha trovato messaggi puo' sovrascrivere il
 * riassunto gia' presente.
 *
 * Il caso che questa regola ferma e' reale e senza rete: 4 giornate di giugno
 * hanno un riassunto ricostruito a mano ma **zero messaggi** ancora in tabella
 * (cancellati). Se qualcuno chiede "rielabora il 3 giugno", `runMemoriaExtract`
 * trova 0 messaggi, imbocca il ramo "giornata vuota" e scrive
 * `summary_text: 'Nessuna attività rilevante', message_count: 0` — cioe'
 * riporta la giornata **esattamente alla bugia** che la ricostruzione serviva a
 * togliere. E siccome message_count diventa 0, la riga esce anche dal raggio
 * dell'audit (`message_count > 0`): la perdita diventa invisibile pure a lui.
 *
 * Non ci sono backup: `cervellone_summary_giornaliero` non ha versioni.
 *
 * Regola: se la riga esistente dichiara messaggi e contiene un riassunto vero,
 * una rielaborazione a mani vuote puo' solo peggiorarla. Si rifiuta.
 */
export function puoSovrascrivereGiornataVuota(esistente: RigaSummary | null): boolean {
  if (!esistente) return true

  const conteggio = esistente.message_count ?? 0
  if (conteggio <= 0) return true

  const testo = (esistente.summary_text ?? '').trim()
  if (!testo) return true

  // Il segnaposto e il marcatore di estrazione fallita non sono conoscenza:
  // sovrascriverli non perde niente.
  const soloSegnaposto = testo
    .split('|')
    .every((p) => p.trim() === '' || p.trim() === SEGNAPOSTO_VUOTO)
  if (soloSegnaposto) return true
  if (testo.startsWith('⚠️ Estrazione non riuscita')) return true

  return false
}

export interface RigaEntita {
  mention_count: number | null
  contexts_json: unknown
  last_seen_at: string | null
}

export interface FusioneEntita {
  mention_count: number
  contexts_json: string[]
  last_seen_at: string
}

/** Quanti contesti si conservano per entita': i piu' recenti. */
const MAX_CONTESTI = 8

/**
 * Fonde una menzione nuova con la riga gia' in tabella.
 *
 * Prima l'upsert scriveva sempre `mention_count: 1` e `contexts_json: [nuovo]`,
 * con un TODO che diceva "atomic increment per concurrency futura". L'effetto
 * non era un contatore impreciso: era che **ogni nuova menzione cancellava
 * tutto lo storico** di quell'entita'. Dopo la ricostruzione a mano, la prima
 * estrazione notturna che avesse nominato "Blasi Giuseppe" avrebbe buttato via
 * i contesti ricostruiti, una entita' alla volta e in silenzio.
 *
 * Idempotente per giornata: rielaborare due volte lo stesso giorno non fa
 * salire il contatore due volte (`last_seen_at` gia' uguale a `target`).
 */
export function fondiEntita(esistente: RigaEntita | null, contesto: string, target: string): FusioneEntita {
  const precedenti = Array.isArray(esistente?.contexts_json)
    ? (esistente!.contexts_json as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim() !== '')
    : []

  const contesti = precedenti.includes(contesto) ? precedenti : [...precedenti, contesto]

  const giaContataOggi = esistente?.last_seen_at === target
  const base = esistente?.mention_count ?? 0
  const conteggio = giaContataOggi ? Math.max(base, 1) : base + 1

  return {
    mention_count: conteggio,
    // Si tengono gli ultimi: un contesto vecchio vale meno di uno recente, e la
    // colonna non deve crescere senza fine.
    contexts_json: contesti.slice(-MAX_CONTESTI),
    last_seen_at: target,
  }
}
