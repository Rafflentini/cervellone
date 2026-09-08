/**
 * Il server della chat web disfaceva la cura del suo stesso client.
 *
 * Telegram comprime «a strati»: trova l'ULTIMO messaggio con un documento e lo
 * lascia intatto, comprimendo gli altri a 3000 caratteri ma tenendo il titolo.
 * Il client web fa la stessa cosa. Il SERVER web, invece, ricomprimeva TUTTI —
 * ultimo incluso — e con uno stub senza nemmeno il titolo:
 *   '[Documento gia generato — visibile nel pannello anteprima]'
 *
 * Effetto: sul web il modello non vedeva MAI il documento che aveva appena
 * prodotto. «Togli la voce ponteggi e rifai il totale» arrivava a un modello
 * che ha in contesto una frase-segnaposto, quindi o rigenera da zero perdendo
 * le correzioni — l'errore che il system prompt gli vieta — o va a cercare
 * `ritrova_bozza`. Su Telegram, lo stesso turno, il documento ce l'ha sotto gli
 * occhi.
 */
import { describe, it, expect } from 'vitest'
import { comprimiDocumentiNellaStoria } from './compressione-documenti'

const doc = (titolo: string, corpo: string) =>
  `~~~document\n<h1>${titolo}</h1>${corpo}\n~~~\n`

describe('comprimiDocumentiNellaStoria', () => {
  it("l ULTIMO documento resta intatto: e' quello su cui si sta lavorando", () => {
    const lungo = 'x'.repeat(5000)
    const storia = [
      { role: 'assistant', content: doc('Preventivo Blasi', lungo) },
      { role: 'user', content: 'ora il computo' },
      { role: 'assistant', content: doc('Computo Fermi', lungo) },
    ]

    comprimiDocumentiNellaStoria(storia)

    expect(storia[2].content).toContain(lungo)
    expect(storia[0].content).not.toContain(lungo)
  })

  it('i documenti vecchi tengono il TITOLO, non solo un segnaposto muto', () => {
    const storia = [
      { role: 'assistant', content: doc('Preventivo Blasi', 'y'.repeat(5000)) },
      { role: 'assistant', content: doc('Computo Fermi', 'z'.repeat(5000)) },
    ]

    comprimiDocumentiNellaStoria(storia)

    expect(storia[0].content).toContain('Preventivo Blasi')
    expect(storia[0].content).toContain('troncato')
  })

  it('un documento corto non si tocca', () => {
    const corto = doc('Nota', 'poche righe')
    const storia = [
      { role: 'assistant', content: corto },
      { role: 'assistant', content: doc('Altro', 'w'.repeat(5000)) },
    ]

    comprimiDocumentiNellaStoria(storia)

    expect(storia[0].content).toBe(corto)
  })

  // CONTROLLO POSITIVO: senza, una funzione che non comprime niente
  // passerebbe i test "resta intatto" a mani basse.
  it('un documento vecchio e lungo viene DAVVERO accorciato', () => {
    const storia = [
      { role: 'assistant', content: doc('Vecchio', 'q'.repeat(50_000)) },
      { role: 'assistant', content: doc('Ultimo', 'r'.repeat(50_000)) },
    ]
    const primaLunghezza = storia[0].content.length

    comprimiDocumentiNellaStoria(storia)

    expect(storia[0].content.length).toBeLessThan(primaLunghezza / 5)
  })

  it('i messaggi utente e quelli senza documenti non si toccano', () => {
    const storia = [
      { role: 'user', content: '~~~document\nnon dovrebbe contare\n~~~\n' },
      { role: 'assistant', content: 'solo testo' },
    ]

    comprimiDocumentiNellaStoria(storia)

    expect(storia[0].content).toContain('non dovrebbe contare')
    expect(storia[1].content).toBe('solo testo')
  })
})
