/**
 * Quando far partire un promemoria di scadenza, e quante volte.
 *
 * ── Il problema (5 settembre 2026) ───────────────────────────────────────────
 * Il cron mandava UN SOLO promemoria per scadenza — il primo giorno utile
 * dentro la finestra `reminder_days` — e poi taceva per sempre. Per il token
 * GitHub appena rinnovato voleva dire: una mail sola, fra un anno, in una
 * casella che riceve 250 messaggi al mese. Se quel giorno l'Ingegnere e' in
 * cantiere, la scadenza muore in silenzio. Ed e' esattamente cio' che era gia'
 * successo col PAT scaduto il 5 giugno, di cui nessuno si e' accorto per tre
 * mesi.
 *
 * Ora i promemoria sono TRE: alla soglia dichiarata, a una settimana, e il
 * giorno stesso. Logica pura, senza posta ne' banca dati: si puo' provare tutta
 * senza mandare una mail.
 */

/** Il richiamo ravvicinato: una settimana prima. */
export const SOGLIA_IMMINENTE = 7

/**
 * Le soglie a cui far scattare un promemoria, dalla piu' lontana alla piu'
 * vicina. Sempre incluso 0, il giorno della scadenza: e' l'ultimo momento utile
 * e non deve dipendere da come e' configurata la riga.
 *
 * reminder_days 30 → [30, 7, 0]   ·   5 → [5, 0]   ·   7 → [7, 0]
 */
export function soglieDa(reminderDays: number): number[] {
  const finestra = Math.max(0, Math.trunc(reminderDays))
  const soglie = new Set<number>([finestra, SOGLIA_IMMINENTE, 0])
  return [...soglie].filter((s) => s <= finestra).sort((a, b) => b - a)
}

/** Il segno lasciato in `reminders_sent`: soglia e giorno in cui e' partito. */
export function marcatore(soglia: number, giorno: string): string {
  return `${soglia}:${giorno}`
}

/**
 * Quali soglie hanno gia' avuto il loro promemoria.
 *
 * Le righe vecchie contengono una data secca (`2026-06-04`), scritta quando il
 * promemoria era uno solo: valgono come "la soglia piu' larga e' gia' partita".
 * Si potevano ignorare, ma allora la prima notte col codice nuovo avrebbero
 * rimandato un avviso gia' dato; e si potevano contare come "tutte fatte", ma
 * allora i richiami ravvicinati non sarebbero mai partiti. Si sceglie di
 * chiudere solo quella larga: nessun doppione, e i richiami restano vivi.
 */
export function soglieGiaMandate(remindersSent: string[], reminderDays: number): number[] {
  const fatte = new Set<number>()
  for (const voce of remindersSent) {
    const conSoglia = /^(\d+):/.exec(voce)
    if (conSoglia) {
      fatte.add(Number(conSoglia[1]))
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(voce.trim())) {
      fatte.add(Math.max(0, Math.trunc(reminderDays)))
    }
  }
  return [...fatte]
}

export type PromemoriaDaMandare = {
  /** La soglia che fa scattare questo promemoria. */
  soglia: number
  /**
   * Le soglie piu' larghe scattate insieme a questa: vanno segnate come fatte
   * senza mandare nulla, altrimenti domani partirebbe un "mancano 30 giorni"
   * quando ne mancano quattro.
   */
  assorbite: number[]
}

/**
 * Il promemoria da mandare oggi, oppure null.
 *
 * Fra le soglie scattate si sceglie la PIU' STRETTA: se una scadenza viene
 * registrata quando mancano gia' pochi giorni, ha senso dire "fra 5 giorni" e
 * non "fra 30". Le altre si assorbono.
 *
 * Le scadenze gia' passate restano fuori (`days < 0`): non e' una svista, e'
 * la scelta presa il 3 settembre — le segnala il controllo settimanale, perche'
 * sono cose da sistemare una volta, non da ricordare ogni mattina.
 */
export function promemoriaDiOggi(
  giorniMancanti: number,
  soglie: number[],
  giaMandate: number[],
): PromemoriaDaMandare | null {
  if (giorniMancanti < 0) return null
  const scattate = soglie.filter((s) => giorniMancanti <= s && !giaMandate.includes(s))
  if (scattate.length === 0) return null
  const soglia = Math.min(...scattate)
  return { soglia, assorbite: scattate.filter((s) => s !== soglia) }
}

/** Come si dice, in italiano, quanto manca. */
export function quantoManca(giorni: number): string {
  if (giorni === 0) return 'oggi'
  if (giorni === 1) return 'domani'
  return `fra ${giorni} giorni`
}
