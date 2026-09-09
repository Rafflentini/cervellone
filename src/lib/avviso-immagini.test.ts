import { describe, test, expect } from 'vitest'
import { avvisoImmagini } from './avviso-immagini'

describe('avvisoImmagini', () => {
  // L'8 set 2026 il Preventivo Extra B e' stato consegnato con la foto rotta e
  // dichiarato a posto tre volte di fila. Il documento non puo' uscire con un
  // "fatto" liscio se le immagini non sono entrate.
  test('quando una foto non entra, lo dice a chiare lettere', () => {
    const avviso = avvisoImmagini(['1Zg97_TDKOoUWeAAYsTQ-TrlH5m601rXU'])
    expect(avviso).toContain('⚠️')
    expect(avviso).toContain('1 immagine')
    expect(avviso).toContain('1Zg97_TDKOoUWeAAYsTQ-TrlH5m601rXU')
  })

  test('al plurale conta bene', () => {
    expect(avvisoImmagini(['a1', 'b2', 'c3'])).toContain('3 immagini')
  })

  // CONTROLLO POSITIVO: senza, una funzione che avvisa SEMPRE passerebbe i test
  // qui sopra e infilerebbe un allarme in fondo a ogni documento riuscito.
  test('quando sono entrate tutte non aggiunge niente', () => {
    expect(avvisoImmagini([])).toBe('')
  })
})

describe('l etichetta non deve mentire', () => {
  // Da quando le voci possono essere "nome (id)", l'etichetta fissa "Id Drive:"
  // produceva un formato misto e una bugia:
  //   Id Drive: facciata_nord.heic (1a2b3c), 9z8y7x
  test('non chiama "id Drive" quello che e un nome di file', () => {
    const avviso = avvisoImmagini(['facciata_nord.heic (1a2b3c4d5e6f7g)'])
    expect(avviso).not.toContain('Id Drive:')
    expect(avviso).toContain('facciata_nord.heic')
  })

  test('elenca ogni voce su una riga sua, che sia nome o id', () => {
    const avviso = avvisoImmagini(['facciata.heic (1a2b3c)', '9z8y7x'])
    const righe = avviso.split('\n').filter((r) => r.trim().startsWith('•'))
    expect(righe).toHaveLength(2)
  })
})

describe('i formati consigliati dipendono dal documento', () => {
  /**
   * L'elenco era uno solo, quello del WORD, mostrato anche quando il documento
   * e' un PDF. Cosi' l'Ingegnere si sentiva dire di riconvertire un WebP che
   * nel PDF sarebbe entrato benissimo: Chromium lo mostra, e' il Word che non
   * lo sa contenere.
   */
  test('per un PDF nomina anche WebP, AVIF e SVG', () => {
    const testo = avvisoImmagini(['facciata.webp'], 'pdf')
    expect(testo).toContain('WebP')
    expect(testo).toContain('SVG')
  })

  test('per un Word NON li nomina: li' + ' dentro non entrano', () => {
    const testo = avvisoImmagini(['facciata.webp'], 'word')
    expect(testo).not.toContain('WebP')
    expect(testo).toContain('JPEG')
  })

  test('per un Excel come per il Word', () => {
    const testo = avvisoImmagini(['foto.avif'], 'excel')
    expect(testo).not.toContain('AVIF')
    expect(testo).toContain('JPEG')
  })

  // Chi non dichiara il tipo riceve l'elenco prudente: mai consigliare un
  // formato che in quel documento non entrerebbe.
  test('senza tipo si resta sui quattro che vanno ovunque', () => {
    const testo = avvisoImmagini(['x.heic'])
    expect(testo).toContain('JPEG')
    expect(testo).not.toContain('WebP')
  })

  // CONTROLLO POSITIVO
  test('senza mancanti non si dice niente, qualunque sia il tipo', () => {
    expect(avvisoImmagini([], 'pdf')).toBe('')
  })
})
