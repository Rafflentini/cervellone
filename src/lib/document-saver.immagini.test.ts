/**
 * `salva_documento_su_drive` e' il tool che il prompt raccomanda per POS,
 * preventivi e perizie. Converte l'HTML in testo piatto con una regex che
 * elimina i tag: un `<img>` non diventava un URL rotto, SPARIVA — e il
 * documento consegnato non diceva che mancava qualcosa.
 *
 * E' lo stesso difetto chiuso l'8 set per il PDF, sulla porta piu' larga.
 */
import { describe, test, expect } from 'vitest'
import { htmlInTestoPiatto } from './document-saver-testo'

const HTML =
  '<h1>Perizia</h1><p>Facciata Est</p>' +
  '<img src="https://drive.google.com/thumbnail?id=1Zg97_TDKOoUWeAAYsTQ-TrlH5m601rXU">' +
  '<p>Fine.</p>'

describe('htmlInTestoPiatto', () => {
  test('una foto non sparisce: lascia detto che c era, e quale', () => {
    const { testo, immagini } = htmlInTestoPiatto(HTML)

    expect(immagini).toEqual(['1Zg97_TDKOoUWeAAYsTQ-TrlH5m601rXU'])
    expect(testo).toContain('Facciata Est')
    // Nel Google Doc resta una riga che dice che li' c'era una foto: un buco
    // dichiarato e' un'altra cosa da un buco invisibile.
    expect(testo).toMatch(/\[Foto 1\b/)
    expect(testo).toContain('1Zg97_TDKOoUWeAAYsTQ-TrlH5m601rXU')
  })

  // CONTROLLO POSITIVO: senza, una funzione che infila un segnaposto sempre
  // passerebbe il test qui sopra e sporcherebbe ogni documento senza foto.
  test('un documento senza foto resta pulito', () => {
    const { testo, immagini } = htmlInTestoPiatto('<h1>Titolo</h1><p>Solo testo.</p>')

    expect(immagini).toEqual([])
    expect(testo).not.toContain('[Foto')
    expect(testo).toContain('Solo testo.')
  })

  test('toglie comunque script, style e tag come faceva prima', () => {
    const { testo } = htmlInTestoPiatto('<style>p{color:red}</style><p>Ciao</p><script>x()</script>')
    expect(testo).toBe('Ciao')
  })
})

describe('htmlInTestoPiatto — i casi trovati dall audit sui test', () => {
  // Il ternario distingueva Drive da non-Drive, ma nessun test lo esercitava:
  // mutare la condizione in `tag.length >= 0` sopravviveva. E un `<img>` che
  // non punta a Drive veniva (e viene) CANCELLATO in silenzio — meta' del
  // difetto originale, rimasta aperta.
  test('anche una foto NON di Drive lascia detto che c era', () => {
    const { testo, immagini } = htmlInTestoPiatto('<p>Prima</p><img src="https://esempio.it/foto.jpg"><p>Dopo</p>')

    // Conta anche le non-Drive: il numero dei buchi nel documento e quello
    // dichiarato all'Ingegnere devono coincidere.
    expect(immagini).toEqual(['https://esempio.it/foto.jpg'])
    expect(testo).toContain('Prima')
    expect(testo).toContain('Dopo')
    expect(testo).toMatch(/\[Foto 1\b/)   // ma il buco e' dichiarato lo stesso
  })

  // `immaginiDriveNellHtml` deduplica per id, il contatore dei segnaposto no:
  // con la stessa foto richiamata due volte usciva `[Foto 2 — ...: ]` con l'id
  // VUOTO, perche' l'array delle immagini ne aveva una sola.
  test('la stessa foto richiamata due volte non produce un segnaposto vuoto', () => {
    const doppia = '<img src="https://drive.google.com/thumbnail?id=AAAAAAAAAAAA">' +
                   '<img src="https://drive.google.com/thumbnail?id=AAAAAAAAAAAA">'
    const { testo } = htmlInTestoPiatto(doppia)

    expect(testo).not.toMatch(/:\s*\]/)   // nessun segnaposto con l'id mancante
    expect(testo.match(/AAAAAAAAAAAA/g) ?? []).toHaveLength(2)
  })
})

describe('htmlInTestoPiatto — i difetti trovati dagli audit', () => {
  // Un data URI e' gia' l'immagine: stamparlo nel segnaposto riversava
  // migliaia di caratteri di base64 dentro il Google Doc consegnato al
  // committente. Prima veniva rimosso e basta.
  test('un data URI non finisce dentro il documento', () => {
    const dataUri = 'data:image/png;base64,' + 'A'.repeat(3000)
    const { testo } = htmlInTestoPiatto(`<p>Prima</p><img src="${dataUri}"><p>Dopo</p>`)

    expect(testo.length).toBeLessThan(300)
    expect(testo).not.toContain('AAAAAAAAAA')
    expect(testo).toContain('Prima')
    expect(testo).toContain('Dopo')
  })

  // Un indirizzo lunghissimo non deve comunque riversarsi nel documento.
  test('un URL lunghissimo viene accorciato', () => {
    const lungo = 'https://esempio.it/' + 'x'.repeat(500) + '.jpg'
    const { testo } = htmlInTestoPiatto(`<img src="${lungo}">`)
    expect(testo.length).toBeLessThan(200)
  })

  // ⭐ Il conteggio dei buchi nel documento deve corrispondere a quello che il
  // bot dichiara. Prima i segnaposto erano su OGNI img e `immagini` contava
  // solo le Drive deduplicate: nel documento due buchi, nell'avviso uno.
  test('quante foto mancano nel testo, tante ne dichiara', () => {
    const { testo, immagini } = htmlInTestoPiatto(
      '<img src="https://drive.google.com/thumbnail?id=AAAAAAAAAAAA">' +
      '<img src="https://esempio.it/foto.jpg">',
    )
    const buchi = (testo.match(/\[Foto \d+/g) ?? []).length
    expect(buchi).toBe(immagini.length)
  })

  test('e con la stessa foto ripetuta, il conto regge lo stesso', () => {
    const { testo, immagini } = htmlInTestoPiatto(
      '<img src="https://drive.google.com/thumbnail?id=AAAAAAAAAAAA">' +
      '<img src="https://drive.google.com/thumbnail?id=AAAAAAAAAAAA">',
    )
    const buchi = (testo.match(/\[Foto \d+/g) ?? []).length
    expect(buchi).toBe(immagini.length)
  })
})
