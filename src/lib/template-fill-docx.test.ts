/**
 * Il "binario A": riempire il .docx VERO invece di ricostruirlo.
 *
 * Progettato l'11 giugno 2026, mai costruito fino al 3 settembre. La differenza
 * non è tecnica, è di risultato: `B_html` reimpagina il documento a modo nostro,
 * `A_docx` apre il file dell'Ingegnere e tocca SOLO i segnaposto. Tutto il resto
 * — font, margini, intestazione, logo, tabelle — resta bit per bit quello che
 * era, perché non viene mai riscritto.
 *
 * I test costruiscono un .docx VERO (uno zip OOXML minimo ma valido) invece di
 * mockare la libreria: mockare docxtemplater qui vorrebbe dire verificare il
 * mock, non il riempimento. [[feedback_test_sicurezza_payload_finto]]
 */
import { describe, it, expect } from 'vitest'
import PizZip from 'pizzip'
import { riempiDocx, estraiSegnaposto } from './template-fill-docx'

/** Un .docx minimo ma vero: zip con la struttura OOXML che Word si aspetta. */
function docxCon(paragrafi: string[]): Buffer {
  const corpo = paragrafi
    .map((t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`)
    .join('')
  const zip = new PizZip()
  zip.file('[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `</Types>`)
  zip.folder('_rels')!.file('.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`)
  zip.folder('word')!.file('document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${corpo}</w:body></w:document>`)
  return zip.generate({ type: 'nodebuffer' }) as Buffer
}

/** Il testo leggibile dentro un .docx prodotto. */
function testoDi(docx: Buffer): string {
  const xml = new PizZip(docx).file('word/document.xml')!.asText()
  return xml.replace(/<[^>]+>/g, '')
}

describe('estraiSegnaposto — il modello dichiara da sé cosa gli serve', () => {
  it('trova i campi, senza che nessuno li trascriva a mano', () => {
    const doc = docxCon(['Spett.le {committente}', 'Oggetto: {oggetto}', 'Data {data}'])

    const res = estraiSegnaposto(doc)

    expect(res.ok).toBe(true)
    expect(res.campi).toEqual(['committente', 'oggetto', 'data'])
  })

  it('non elenca due volte lo stesso campo ripetuto nel documento', () => {
    const doc = docxCon(['{committente}', 'Egregio {committente},'])

    expect(estraiSegnaposto(doc).campi).toEqual(['committente'])
  })

  it('un file che non e un .docx non fa esplodere niente', () => {
    const res = estraiSegnaposto(Buffer.from('questo e un pdf, non uno zip'))

    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })
})

describe('riempiDocx — sostituisce i segnaposto e NON tocca il resto', () => {
  it('mette i valori al posto dei segnaposto', () => {
    const doc = docxCon(['Spett.le {committente}', 'Oggetto: {oggetto}'])

    const res = riempiDocx(doc, { committente: 'DLC (NW) LIMITED', oggetto: 'Lettera di incarico' })

    expect(res.ok).toBe(true)
    const testo = testoDi(res.buffer!)
    expect(testo).toContain('DLC (NW) LIMITED')
    expect(testo).toContain('Lettera di incarico')
  })

  it('NON lascia mai un segnaposto a vista nel documento consegnato', () => {
    // Un `{committente}` stampato in una lettera che va a un committente e'
    // peggio di un buco: sembra un errore di chi la manda.
    const doc = docxCon(['Spett.le {committente}', 'Rif. {protocollo}'])

    const res = riempiDocx(doc, { committente: 'Blasi Giuseppe' })

    expect(res.ok).toBe(true)
    expect(testoDi(res.buffer!)).not.toContain('{')
    // Ma il buco va DICHIARATO, non nascosto.
    expect(res.mancanti).toEqual(['protocollo'])
  })

  it('il testo NON segnaposto resta identico, parola per parola', () => {
    // È il motivo per cui esiste questo binario: la fedeltà non è "somigliante",
    // è "lo stesso file".
    const fisso = 'RESTRUKTURA S.r.l. — Via Roma 1, Potenza — P.IVA 01234567890'
    const doc = docxCon([fisso, 'Spett.le {committente}'])

    const res = riempiDocx(doc, { committente: 'Tizio' })

    expect(testoDi(res.buffer!)).toContain(fisso)
  })

  it('un valore che non e una stringa non diventa "[object Object]"', () => {
    // I valori arrivano dal MODELLO, che a volte passa un oggetto dove il
    // segnaposto vuole una riga di testo — tipicamente quando ha strutturato il
    // dato ("committente" come {nome, piva} invece che come stringa).
    //
    // I NUMERI docxtemplater li scrive bene da solo: mettere solo quelli nel
    // test lasciava passare una mutazione che toglieva la conversione. Il caso
    // che produce davvero "[object Object]" e' l'OGGETTO, ed e' quello che
    // finirebbe stampato in una lettera al committente.
    // (mutation testing 3 set 2026: D5 sopravvissuta perche' il test provava il
    // rischio sbagliato — [[feedback_controllo_positivo]])
    const doc = docxCon(['Importo {importo}', 'Anno {anno}', 'Spett.le {committente}'])

    const res = riempiDocx(doc, {
      importo: 1500.5,
      anno: 2026,
      committente: { nome: 'DLC (NW) LIMITED', piva: '168049487' },
    })

    const testo = testoDi(res.buffer!)
    expect(testo).toContain('1500.5')
    expect(testo).toContain('2026')
    expect(testo).not.toContain('[object Object]')
  })

  it('riempie un blocco ripetuto: le righe di una tabella', () => {
    const doc = docxCon(['{#voci}{descrizione} — {importo}{/voci}'])

    const res = riempiDocx(doc, {
      voci: [
        { descrizione: 'Ponteggio', importo: '3.200,00' },
        { descrizione: 'Smontaggio', importo: '800,00' },
      ],
    })

    expect(res.ok).toBe(true)
    const testo = testoDi(res.buffer!)
    expect(testo).toContain('Ponteggio')
    expect(testo).toContain('Smontaggio')
  })

  it('un modello rotto dice QUALE segnaposto lo rompe, non "Multi error"', () => {
    // docxtemplater impacchetta i dettagli in properties.errors: il message
    // generico non dice niente a chi deve sistemare il modello.
    const doc = docxCon(['{#apro} mai chiuso'])

    const res = riempiDocx(doc, { apro: [] })

    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
    expect(res.error).not.toBe('Multi error')
  })

  it('un file che non e un .docx non fa esplodere niente', () => {
    const res = riempiDocx(Buffer.from('non sono uno zip'), { a: 'b' })

    expect(res.ok).toBe(false)
    expect(res.buffer).toBeUndefined()
  })
})
