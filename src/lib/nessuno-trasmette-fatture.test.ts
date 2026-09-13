/**
 * src/lib/nessuno-trasmette-fatture.test.ts — l'invariante dichiarata da Raffaele.
 *
 * Le sue parole, 13 set 2026:
 *   «Né il coordinatore né la segretaria spedisce MAI una fattura.
 *    Quello lo faccio solo io.»
 *
 * **Oggi è vero, ma per OMISSIONE: nessuno ha ancora scritto quel codice.**
 * «Nessuno ci ha pensato» non è una garanzia — è una coincidenza che dura
 * finché qualcuno non ci pensa. Questo test la trasforma in un'invariante:
 * se un giorno qualcuno aggiunge la trasmissione allo SdI, **la suite diventa
 * rossa** e la scelta torna in mano a Raffaele invece di scivolare dentro una
 * pull request fra altre venti righe.
 *
 * Cosa il bot PUÒ fare, e resta permesso:
 *  - creare una fattura su Fatture in Cloud (`POST /c/{id}/issued_documents`)
 *  - segnare pagata una fattura ricevuta (`PUT /c/{id}/received_documents/{id}`)
 *  - leggere tutto, comprese le fatture elettroniche già ricevute
 *
 * Cosa NON può fare, ed è ciò che questo test sorveglia:
 *  - `POST /c/{id}/issued_documents/{id}/e_invoice/send` — la trasmissione al
 *    Sistema di Interscambio. Da lì non si torna indietro: una fattura
 *    elettronica trasmessa non si annulla, si storna.
 *
 * ⚠️ Il test NON vieta la stringa `e_invoice`: comparirebbe un falso positivo a
 * ogni lettura legittima (`e_invoice: false` nelle scritture, `e_invoice/xml`
 * citato nei commenti). Vieta **l'endpoint di invio**. Una guardia che blocca
 * il caso normale è peggio del buco che chiude.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Tutti i sorgenti di produzione: niente test, niente fixture. */
function sorgenti(dir: string, out: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome)
    if (statSync(p).isDirectory()) {
      if (nome === 'node_modules' || nome === '__tests__') continue
      sorgenti(p, out)
    } else if (/\.tsx?$/.test(nome) && !/\.test\.|\.spec\./.test(nome)) {
      out.push(p)
    }
  }
  return out
}

/**
 * Le forme in cui la trasmissione potrebbe entrare nel codice.
 *
 * Non è un elenco di parole sospette: è l'endpoint vero dell'API di Fatture in
 * Cloud, più i due nomi che chiunque userebbe scrivendo quella funzione.
 */
const TRASMISSIONE = [
  /e_invoice\s*\/\s*send/i,
  /\/e_invoice\/send/i,
  /\bsendEInvoice\b/i,
  /\btrasmettiFattura\b/i,
  /\binviaFatturaElettronica\b/i,
  /\binvia_fattura_elettronica\b/i,
]

describe("nessuno trasmette una fattura: l'invariante, non la fortuna", () => {
  it('nessun sorgente di produzione contiene una via verso il Sistema di Interscambio', () => {
    const colpevoli: string[] = []
    for (const file of sorgenti('src')) {
      const testo = readFileSync(file, 'utf8')
      for (const forma of TRASMISSIONE) {
        const m = testo.match(forma)
        if (!m) continue
        // Una CITAZIONE in un commento non è una via: il commento spiega
        // perché la trasmissione non c'è, e vietarlo renderebbe impossibile
        // documentare la scelta.
        const riga = testo.split('\n').find((r) => forma.test(r)) ?? ''
        const eCommento = /^\s*(\/\/|\*|\/\*)/.test(riga)
        if (eCommento) continue
        colpevoli.push(`${file}: ${riga.trim().slice(0, 120)}`)
      }
    }
    expect(
      colpevoli,
      colpevoli.length
        ? `\n\n🚨 QUALCUNO HA AGGIUNTO LA TRASMISSIONE DELLE FATTURE ALLO SDI.\n\n` +
          `Raffaele ha dichiarato il 13 set 2026: «né il coordinatore né la segretaria\n` +
          `spedisce MAI una fattura, quello lo faccio solo io».\n\n` +
          `Se la decisione è cambiata, la cambia LUI e questo test si aggiorna insieme.\n` +
          `Se non è cambiata, questa riga va tolta:\n\n` +
          colpevoli.map((c) => `  ${c}`).join('\n') +
          `\n`
        : '',
    ).toEqual([])
  })

  it("CONTROLLO NEGATIVO — cio' che il bot PUO' fare non fa scattare la guardia", () => {
    // Se questo test fallisse, la guardia starebbe bloccando il caso normale:
    // creare una fattura e segnarne una pagata sono operazioni permesse, e
    // vivono davvero nel codice.
    const fic = readFileSync('src/lib/fatture-in-cloud.ts', 'utf8')
    expect(fic).toMatch(/issued_documents/)
    for (const forma of TRASMISSIONE) expect(fic).not.toMatch(forma)
  })

  it('la guardia riconoscerebbe davvero la trasmissione, se ci fosse', () => {
    // Controllo positivo: senza questo, un test che non trova mai niente
    // potrebbe non trovare niente perché è rotto.
    const finto = `await ficPost(\`/c/\${cid}/issued_documents/\${id}/e_invoice/send\`, {}, societa)`
    expect(TRASMISSIONE.some((f) => f.test(finto))).toBe(true)
  })
})
