/**
 * src/lib/politica-caselle.ts — la POLITICA con cui i tool guardano piu' caselle.
 *
 * Non e' in `src/lib/tools/mail.ts` apposta: il suo test importerebbe
 * `mail.ts`, che tira dentro `googleapis` e mezzo mondo — in questo repo un
 * import pesante dentro un test e' costato 1703 ms e un test caduto per
 * timeout (14 settembre 2026). Questo file resta leggero: lo importa solo
 * `./caselle`.
 */
import { caselleDiTrasporto, type ChiaveCasella } from './caselle'

export interface EsitoLettura<T> {
  risultati: Array<T & { casella: ChiaveCasella }>
  caselleFallite: Array<{ casella: ChiaveCasella; errore: string }>
}

/**
 * Legge su piu' caselle Google e tiene traccia di DUE cose: cosa ha trovato, e
 * dove NON e' riuscito a guardare.
 *
 * ⚠️ La seconda meta' non e' un lusso. Restituire solo i risultati trovati
 * significa che una casella con il token morto sparisce in silenzio, e chi
 * legge crede di aver visto tutto. In questa casa quel difetto e' gia' costato
 * quattro mesi di fatture estere a zero, sei rapporti di autodiagnosi mai
 * consegnati. Un elenco parziale che sembra completo e' il difetto di
 * famiglia — qui non si ripete.
 *
 * `opts.nonTrovato`, se dato, riconosce il caso «la casella ha risposto, ma
 * quell'oggetto non c'e'» (una lettura per ID: un id sta in UNA casella sola,
 * l'altra dira' sempre «non trovato»). Quel caso NON e' un fallimento — non
 * finisce in `caselleFallite`, semplicemente non produce risultati.
 *
 * 🚨 Chi passa `nonTrovato` deve riconoscere SOLO il «non c'e'», mai
 * indovinarlo su una stringa a caso nel messaggio d'errore: un token morto, un
 * 401, un 403 devono continuare a finire in `caselleFallite`. Un predicato
 * troppo largo spegne la guardia che questa funzione esiste per accendere —
 * il difetto peggiore, al contrario: la perdita silenziosa.
 */
export async function leggiSuTutteLeGoogle<T>(
  caselle: ChiaveCasella[] | undefined,
  leggi: (c: ChiaveCasella) => Promise<T[]>,
  opts?: { nonTrovato?: (e: unknown) => boolean },
): Promise<EsitoLettura<T>> {
  const scelte = caselle && caselle.length > 0
    ? caselle
    : caselleDiTrasporto('google').map((c) => c.chiave)

  const risultati: EsitoLettura<T>['risultati'] = []
  const caselleFallite: EsitoLettura<T>['caselleFallite'] = []

  for (const casella of scelte) {
    try {
      for (const r of await leggi(casella)) risultati.push({ ...r, casella })
    } catch (e) {
      if (opts?.nonTrovato?.(e)) continue
      caselleFallite.push({ casella, errore: e instanceof Error ? e.message : String(e) })
    }
  }

  return { risultati, caselleFallite }
}

/**
 * I tool Gmail che TOCCANO la posta (bozza, invio, label, archivia, cestina,
 * segna letta): per loro la casella e' obbligatoria, sempre. Un tool
 * dimenticato qui e' una porta aperta che nessuno nota finche' una mail non
 * parte dall'indirizzo sbagliato.
 */
export const TOOL_GMAIL_CHE_SCRIVONO: readonly string[] = [
  'gmail_create_draft', 'gmail_send_draft', 'gmail_delete_draft',
  'gmail_apply_label', 'gmail_remove_label',
  'gmail_archive', 'gmail_trash', 'gmail_mark_read',
]

/**
 * La casella su cui scrivere. NESSUN predefinito, nemmeno «quella dove ho
 * letto».
 *
 * ⚠️ Rispondere da La Real Estate a una mail trovata su La Real Estate sembra
 * ovvio — ma il giorno in cui il bot ha letto in piu' caselle, la scelta
 * l'avrebbe fatta lui e non l'avrebbe vista nessuno, finche' una mail non
 * fosse partita firmata dalla societa' sbagliata: non si richiama indietro.
 * Qui si chiede, sempre — questa e' la difesa che sta nel CODICE, non nel
 * prompt: tiene anche il giorno in cui il modello legge male la sua regola.
 */
export function casellaPerScrittura(
  input: Record<string, unknown>,
): { ok: true; casella: ChiaveCasella } | { ok: false; messaggio: string } {
  const grezzo = input.casella
  const google = caselleDiTrasporto('google')
  const valide = google.map((c) => c.chiave) as string[]

  if (typeof grezzo === 'string' && valide.includes(grezzo)) {
    return { ok: true, casella: grezzo as ChiaveCasella }
  }

  const elenco = google.map((c) => `${c.chiave} (${c.indirizzo})`).join(' oppure ')
  return {
    ok: false,
    messaggio:
      "Non scrivo senza sapere da quale casella: non la deduco e non ne ho una predefinita. "
      + `CHIEDI all'Ingegnere quale usare fra: ${elenco}.`,
  }
}
