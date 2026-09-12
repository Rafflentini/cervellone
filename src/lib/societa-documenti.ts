/**
 * Chi firma un documento generato, in fondo alla pagina.
 *
 * Sta in un file suo perche' le societa' sono DUE e i punti che generano
 * documenti sono sei: prima questa stessa funzione era stata copiata in
 * `tools.ts` e in `document-template-tools.ts`, e due copie della stessa cosa
 * sono due cose destinate a divergere.
 *
 * NON e' piu' best-effort. Prima, un guasto nella lettura della societa'
 * attiva finiva nello stesso `catch { return undefined }` di "non l'ha mai
 * scelta", e il chiamante trattava entrambi allo stesso modo: Restruktura.
 * Per chi legge un blocco di contesto va bene (`getSocietaAttiva`, che resta
 * cosi' apposta). Per chi stampa una partita IVA su un documento fiscale no:
 * un guasto travestito da "Restruktura" e' un documento intestato alla
 * societa' sbagliata, spedito con sicurezza indebita. `societaPerDocumento`
 * si appoggia a `leggiSocietaAttiva` (Task 2), che distingue "non scelta" da
 * "non siamo riusciti a leggerla", e propaga il secondo caso come errore
 * dichiarato invece di indovinare.
 */
import { leggiSocietaAttiva } from './societa-attiva'
import { getSocieta } from './societa'
import type { DatiSocietari } from './guardia-societa'

export type EsitoSocietaDocumento =
  | { ok: true; societa: DatiSocietari; esplicita: boolean }
  | { ok: false; errore: string }

export async function societaPerDocumento(conversationId?: string): Promise<EsitoSocietaDocumento> {
  const e = await leggiSocietaAttiva(conversationId ?? '')
  if (!e.ok) return { ok: false, errore: e.errore }

  const s = getSocieta(e.codice)
  // Difesa contro un codice che leggiSocietaAttiva restituisse ma che il
  // registro non conosce: non deve esplodere con un TypeError su
  // `undefined.denominazione`, deve dichiarare l'errore come tutti gli altri.
  if (!s) return { ok: false, errore: `societa' sconosciuta nel registro: ${e.codice}` }

  return {
    ok: true,
    societa: { denominazione: s.denominazione, piva: s.piva },
    esplicita: e.esplicita,
  }
}
