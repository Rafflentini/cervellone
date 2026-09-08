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
