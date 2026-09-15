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
import { readFileSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'

const CARTELLA = join(process.cwd(), 'src/lib')
const sorgente = (f: string) => readFileSync(join(CARTELLA, f), 'utf8')

/**
 * Tutti i sorgenti di `src/lib`, test esclusi.
 *
 * ⚠️ Si elencano dal DISCO, non da una lista scritta a mano: una lista scritta
 * a mano dimentica esattamente il file nuovo, che e' quello da controllare.
 */
function tuttiISorgenti(): string[] {
  return readdirSync(CARTELLA, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.includes('.test.'))
    .map((e) => join(CARTELLA, e.name))
}

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
    //
    // ⚠️ 15 set 2026 (sera): il controllo guardava DUE file soli. Da oggi
    // esiste `fic-verifica-formale.ts`, che parla con lo stesso ramo
    // `e_invoice` dell API — e una guardia che copre due file su cinquanta
    // e una guardia che il prossimo file scavalca senza accorgersene.
    // Adesso si legge TUTTO `src/lib`.
    for (const f of tuttiISorgenti()) {
      const testo = readFileSync(f, 'utf8')
      expect(`${f}: ${testo}`).not.toContain('/e_invoice/send')
      // `dry_run` e l opzione che fa girare a vuoto l INVIO: se compare, vuol
      // dire che qualcuno ha preso quella strada invece della verifica.
      expect(`${f}: ${testo}`).not.toContain('dry_run')
    }
  })

  it('🚨 l unico endpoint e_invoice toccato e quello di VERIFICA, e sta in un file solo', () => {
    // Un secondo giro sullo stesso perimetro, dal verso opposto: non «cosa
    // non c e» ma «cosa c e, e dove».
    // Si cerca la COSTRUZIONE del percorso, non la parola: `fic-allegato.ts`
    // nomina `e_invoice/xml` in un commento per dire che quegli endpoint
    // stanno altrove, e un test che bocciasse anche i commenti costringerebbe
    // a togliere le spiegazioni per far passare le guardie.
    const COSTRUISCE_IL_PERCORSO = /issued_documents\/[^\n]*\/e_invoice\//
    const conEInvoice = tuttiISorgenti().filter((f) => COSTRUISCE_IL_PERCORSO.test(readFileSync(f, 'utf8')))

    expect(conEInvoice.map((f) => basename(f))).toEqual(['fic-verifica-formale.ts'])
    const testo = sorgente('fic-verifica-formale.ts')
    expect(testo).toContain("const PERCORSO_VERIFICA = 'xml_verify'")
    // ⛔ In quel file non si POSTa: la verifica e una lettura.
    expect(testo).not.toMatch(/method:\s*'POST'/)
  })

  it('🚨 creaDocumentoFIC non impone piu il valore: lo decide il chiamante', () => {
    expect(sorgente('fatture-in-cloud.ts')).toContain('e_invoice: payloadWithoutNumber.e_invoice === true')
  })
})
