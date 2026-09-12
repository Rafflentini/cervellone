/**
 * src/lib/guardia-societa.ts — un documento non esce con i dati di un'altra societa'.
 *
 * Il 12 set 2026 Raffaele ha chiesto: «mi assicuri che non compili un documento
 * sbagliando la partita IVA senza accorgersene?». La risposta onesta e' che il
 * testo lo scrive il modello e nessuna promessa sul modello e' una garanzia.
 * Questa e' la garanzia che si puo' dare invece: un confronto fra stringhe, che
 * non dipende dall'attenzione di nessuno.
 *
 * Cerca SOLO le partite IVA NOSTRE — un insieme CHIUSO, due valori, letti dal
 * registro. Non «ogni partita IVA deve essere quella attiva»: quella regola
 * bloccherebbe ogni preventivo, perche' un preventivo nomina il committente.
 * Una guardia che blocca il caso normale e' peggio del buco che chiude.
 */
import { listaSocieta, type CodiceSocieta } from './societa'

// `sede` e' opzionale qui: la guardia (verificaDatiSocietari/messaggioBlocco)
// confronta e nomina solo denominazione+piva, e diversi test la costruiscono
// a mano senza sede. `societaPerDocumento` la valorizza sempre: e' il posto
// dove chi genera un documento (es. studio-tecnico.ts) la trova, senza una
// seconda chiamata a getSocieta.
export type DatiSocietari = { denominazione: string; piva: string; sede?: string }

export type EsitoGuardia =
  | { ok: true }
  | { ok: false; trovate: Array<{ piva: string; denominazione: string }>; attesa: DatiSocietari }

/** Le nostre partite IVA, DAL REGISTRO: mai riscritte a mano qui. */
export function pivaNostre(): Map<string, { codice: CodiceSocieta; denominazione: string }> {
  const m = new Map<string, { codice: CodiceSocieta; denominazione: string }>()
  for (const s of listaSocieta()) m.set(s.piva, { codice: s.codice, denominazione: s.denominazione })
  return m
}

/**
 * Normalizza il contenuto alle sole cifre. Serve perche' la stessa partita IVA
 * si scrive `02087420762`, `IT 02087420762`, `02.087.420.762`, e dentro il
 * markup puo' essere spezzata da un tag. Cercare la stringa cosi' com'e'
 * troverebbe il caso facile e mancherebbe gli altri: una guardia che si
 * aggira con un punto non e' una guardia.
 *
 * Costo accettato: undici cifre consecutive che per caso coincidono con una
 * nostra partita IVA producono un blocco dichiarato. Meglio di un documento
 * sbagliato consegnato in silenzio.
 */
function soleCifre(testo: string): string {
  return (testo || '').replace(/\D+/g, '')
}

export function verificaDatiSocietari(contenuto: string, attesa: DatiSocietari): EsitoGuardia {
  const cifre = soleCifre(contenuto)
  const trovate: Array<{ piva: string; denominazione: string }> = []
  for (const [piva, info] of pivaNostre()) {
    if (piva === attesa.piva) continue
    if (cifre.includes(piva)) trovate.push({ piva, denominazione: info.denominazione })
  }
  if (trovate.length === 0) return { ok: true }
  return { ok: false, trovate, attesa }
}

/**
 * Il testo che legge l'Ingegnere. NOMINA le partite IVA: un rifiuto che non
 * dice cosa non torna lo costringe a indovinare, ed e' il difetto che abbiamo
 * chiuso sei volte questa settimana sotto altre forme.
 */
export function messaggioBlocco(esito: Extract<EsitoGuardia, { ok: false }>): string {
  const altre = esito.trovate
    .map((t) => `${t.denominazione} (P.IVA ${t.piva})`)
    .join(', ')
  return [
    `⚠️ DOCUMENTO NON CONSEGNATO — dati societari incoerenti.`,
    ``,
    `La societa' attiva e' ${esito.attesa.denominazione} (P.IVA ${esito.attesa.piva}),`,
    `ma nel documento compare ${altre}.`,
    ``,
    `Non l'ho consegnato: un documento con la partita IVA sbagliata, una volta`,
    `mandato, non si richiama piu'.`,
    ``,
    `Se e' voluto (per esempio l'altra societa' e' il committente), dimmelo e`,
    `lo genero comunque.`,
    `Se non e' voluto, dimmi su quale societa' stiamo lavorando e la sistemo.`,
  ].join('\n')
}
