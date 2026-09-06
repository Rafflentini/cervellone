import { describe, it, expect } from 'vitest'
import { applicaLettura } from './proposta-documento'

const ETICHETTE = {
  cognome: 'cognome', nome: 'nome', sesso: 'sesso', dataNascita: 'data di nascita',
  cittadinanza: 'cittadinanza', tipoDocumento: 'tipo di documento',
  numeroDocumento: 'numero del documento',
}
const PREDEFINITI = { sesso: 'M', cittadinanza: 'ITALIA', tipoDocumento: 'IDENT' }

const applica = (attuale: Record<string, string>, letti: Record<string, string>) =>
  applicaLettura(attuale, letti, PREDEFINITI, ETICHETTE)

describe('applicaLettura', () => {
  it('CONTROLLO POSITIVO: i campi vuoti si riempiono', () => {
    const e = applica({ cognome: '' }, { cognome: 'ROSSI', nome: 'MARIA' })
    expect(e.cambi).toEqual({ cognome: 'ROSSI', nome: 'MARIA' })
    expect(e.riempiti).toEqual(['cognome', 'nome'])
    expect(e.conflitti).toEqual([])
  })

  it('⭐ quello che una persona ha scritto NON si sovrascrive mai', () => {
    const e = applica({ cognome: 'ROSSINI' }, { cognome: 'ROSSI' })
    expect(e.cambi).toEqual({})
    expect(e.conflitti).toHaveLength(1)
    expect(e.conflitti[0]).toContain('ROSSI')
    expect(e.conflitti[0]).toContain('ROSSINI')
  })

  it('⭐ un PREDEFINITO che nessuno ha toccato si comporta come un campo vuoto', () => {
    /*
      Il caso trovato provando in produzione: su un documento di MARIA ROSSI il
      modulo partiva da sesso «M», la lettura diceva «F» e non correggeva
      niente. Ogni donna sarebbe andata alla Questura come maschio.
    */
    const e = applica({ sesso: 'M' }, { sesso: 'F' })
    expect(e.cambi).toEqual({ sesso: 'F' })
    expect(e.riempiti).toEqual(['sesso'])
    expect(e.conflitti).toEqual([])
  })

  it('ma un predefinito CAMBIATO a mano torna a essere una dichiarazione', () => {
    // Chi ha scelto FRANCIA lo ha fatto apposta: la foto non lo scavalca.
    const e = applica({ cittadinanza: 'FRANCIA' }, { cittadinanza: 'ITALIA' })
    expect(e.cambi).toEqual({})
    expect(e.conflitti).toHaveLength(1)
    expect(e.conflitti[0]).toContain('FRANCIA')
  })

  it('un predefinito che coincide con la foto non produce rumore', () => {
    // Annunciare "compilato sesso" quando era gia' giusto fa perdere di vista
    // le righe che contano.
    const e = applica({ sesso: 'M', tipoDocumento: 'IDENT' }, { sesso: 'M', tipoDocumento: 'IDENT' })
    expect(e.cambi).toEqual({})
    expect(e.riempiti).toEqual([])
    expect(e.conflitti).toEqual([])
  })

  it('un campo letto vuoto non cancella quello che c era', () => {
    const e = applica({ cognome: 'ROSSI' }, { cognome: '', nome: '   ' })
    expect(e.cambi).toEqual({})
    expect(e.conflitti).toEqual([])
  })

  it('il confronto ignora maiuscole e spazi: non e un disaccordo vero', () => {
    const e = applica({ cognome: '  rossi ' }, { cognome: 'ROSSI' })
    expect(e.conflitti).toEqual([])
    expect(e.cambi).toEqual({})
  })

  it('i campi che il modulo non conosce restano fuori', () => {
    // Il server potrebbe un giorno restituire qualcosa in piu': non deve
    // finire nel modulo per il solo fatto di essere arrivato.
    const e = applica({}, { cognome: 'ROSSI', inventato: 'x' } as Record<string, string>)
    expect(e.cambi).toEqual({ cognome: 'ROSSI' })
  })

  it('un caso intero, come capita davvero', () => {
    const e = applica(
      { cognome: 'ROSSI', sesso: 'M', cittadinanza: 'ITALIA', tipoDocumento: 'IDENT', nome: '', dataNascita: '', numeroDocumento: '' },
      { cognome: 'ROSSI', nome: 'MARIA', sesso: 'F', dataNascita: '1985-04-12', cittadinanza: 'ITALIA', tipoDocumento: 'IDENT', numeroDocumento: 'CA12345AB' },
    )
    expect(e.cambi).toEqual({ nome: 'MARIA', sesso: 'F', dataNascita: '1985-04-12', numeroDocumento: 'CA12345AB' })
    expect(e.conflitti).toEqual([])
  })
})
