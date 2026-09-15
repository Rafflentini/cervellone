/**
 * src/lib/fic-write-tools.elettronica.test.ts — una fattura nasce ELETTRONICA.
 *
 * ⚠️ Il difetto, 15 settembre 2026, trovato perche' l'Ingegnere ha detto «sulla
 * fattura io non vedo il tasto invia».
 *
 * `creaDocumentoFIC` imponeva `e_invoice: false` a OGNI documento, senza una
 * riga di spiegazione, e i tool lo ripetevano. Su Fatture in Cloud un documento
 * che non nasce elettronico **non mostra nemmeno il tasto per trasmetterlo**:
 * quindi non si poteva mandare allo SdI ne' a mano ne' in altro modo.
 *
 * Valeva per le integrazioni TD17 — che si assolvono solo trasmettendole — e
 * valeva per OGNI fattura emessa ai clienti. Documenti che sembravano fatti e
 * non erano mai passati dallo SdI.
 *
 * Accanto al payload c'era pure scritto «si COMPILA, non si trasmette: l'invio
 * lo fa l'Ingegnere»: un'intenzione che il codice rendeva impossibile.
 *
 * ⚠️ Elettronico NON vuol dire trasmesso. Questi test pinnano ANCHE quello: il
 * documento nasce pronto, e l'invio resta un gesto umano.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sorgente = (f: string) => readFileSync(join(process.cwd(), 'src/lib', f), 'utf8')

describe('i documenti fiscali nascono elettronici', () => {
  it('🚨 la FATTURA emessa si', () => {
    const t = sorgente('fic-write-tools.ts')
    // 15 set 2026: la condizione ha un nome, cosi la legge anche il ramo che
    // aggiunge ei_data — FIC pretende il metodo di pagamento sugli elettronici.
    expect(t).toContain("const elettronica = tipo === 'fattura_emessa'")
    expect(t).toContain('e_invoice: elettronica,')
  })

  it('🚨 l AUTOFATTURA si: un integrazione TD17 si assolve trasmettendola', () => {
    const testo = sorgente('fic-write-tools.ts')
    expect(testo).toContain('e_invoice: true')
    // CONTROLLO POSITIVO al contrario: non deve essere rimasto nessun
    // documento fiscale che nasce non elettronico.
    expect(testo).not.toContain('e_invoice: false')
  })

  it('🚨 CONTROLLO POSITIVO — il rapporto d intervento NON e una fattura e NON va allo SdI', () => {
    // Senza questo, accendere l elettronica per tutti passerebbe i test qui
    // sopra e manderebbe allo SdI un documento che fiscale non e'.
    const testo = sorgente('fic-write-tools.ts')
    expect(testo).toContain("tipo === 'fattura_emessa'")
    expect(testo).not.toContain('e_invoice: true,\n    // rapporto')
  })

  it('🚨 elettronico NON vuol dire trasmesso: NESSUNA chiamata di invio allo SdI esiste nel repo', () => {
    // La difesa vera di questa storia. Il documento nasce pronto, ma chi
    // decide di mandarlo resta l Ingegnere: se un giorno qualcuno aggiungesse
    // l invio automatico, questo test lo dice.
    for (const f of ['fic-write-tools.ts', 'fatture-in-cloud.ts']) {
      const testo = sorgente(f)
      expect(testo).not.toContain('/e_invoice/send')
      expect(testo).not.toMatch(/e_invoice\/xml/)
    }
  })

  it('🚨 creaDocumentoFIC non impone piu il valore: lo decide il chiamante', () => {
    expect(sorgente('fatture-in-cloud.ts')).toContain('e_invoice: payloadWithoutNumber.e_invoice === true')
  })
})
