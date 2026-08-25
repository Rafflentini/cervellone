/**
 * Il tracciato per Alloggiati Web (Portale Alloggiati, Polizia di Stato).
 *
 * E' un file a lunghezza fissa: 168 caratteri per riga, ogni campo in una
 * posizione esatta. Un carattere in piu' o in meno e il file viene scartato
 * INTERO — non la riga sbagliata, tutto il file. E l'obbligo e' entro 24 ore
 * dall'arrivo, quindi lo scarto si scopre col cronometro che gira.
 *
 * Per questo qui i test contano le posizioni, non "il risultato sembra giusto".
 */
import { describe, it, expect } from 'vitest'
import { rigaAlloggiati, generaAlloggiati, type OspiteAlloggiati } from './alloggiati'

function ospite(over: Partial<OspiteAlloggiati> = {}): OspiteAlloggiati {
  return {
    tipoAlloggiato: '16',
    dataArrivo: '2026-08-10',
    notti: 3,
    cognome: 'ROSSI',
    nome: 'MARIO',
    sesso: 'M',
    dataNascita: '1980-01-01',
    codiceComuneNascita: '058091001',
    provinciaNascita: 'RM',
    codiceStatoNascita: '',
    codiceCittadinanza: '100000100',
    tipoDocumento: 'IDENT',
    numeroDocumento: 'AB1234567',
    codiceLuogoRilascio: '058091001',
    ...over,
  }
}

describe('la lunghezza, che e la cosa che fa scartare il file', () => {
  it('e sempre esattamente 168 caratteri', () => {
    expect(rigaAlloggiati(ospite())).toHaveLength(168)
  })

  it('resta 168 anche con tutti i campi vuoti', () => {
    const vuoto = ospite({
      cognome: '', nome: '', dataNascita: '', codiceComuneNascita: '',
      provinciaNascita: '', codiceStatoNascita: '', codiceCittadinanza: '',
      tipoDocumento: '', numeroDocumento: '', codiceLuogoRilascio: '',
    })
    expect(rigaAlloggiati(vuoto)).toHaveLength(168)
  })

  it('resta 168 anche con campi piu lunghi dello spazio previsto', () => {
    const lungo = ospite({
      cognome: 'A'.repeat(200), nome: 'B'.repeat(200), numeroDocumento: 'C'.repeat(200),
    })
    expect(rigaAlloggiati(lungo)).toHaveLength(168)
  })
})

describe('le posizioni dei campi', () => {
  const r = rigaAlloggiati(ospite())
  /** Il tracciato e 1-based; qui si taglia come nel manuale. */
  const campo = (da: number, a: number) => r.substring(da - 1, a)

  it('tipo alloggiato in 1-2', () => expect(campo(1, 2)).toBe('16'))
  it('data arrivo in 3-12, gg/mm/aaaa', () => expect(campo(3, 12)).toBe('10/08/2026'))
  it('giorni di permanenza in 13-14, con lo zero davanti', () => expect(campo(13, 14)).toBe('03'))
  it('cognome in 15-64, riempito di spazi', () => expect(campo(15, 64)).toBe('ROSSI'.padEnd(50)))
  it('nome in 65-94', () => expect(campo(65, 94)).toBe('MARIO'.padEnd(30)))
  it('sesso in 95, 1 per gli uomini', () => expect(campo(95, 95)).toBe('1'))
  it('data di nascita in 96-105', () => expect(campo(96, 105)).toBe('01/01/1980'))
  it('comune di nascita in 106-114', () => expect(campo(106, 114)).toBe('058091001'))
  it('provincia di nascita in 115-116', () => expect(campo(115, 116)).toBe('RM'))
  it('stato di nascita in 117-125', () => expect(campo(117, 125)).toBe(' '.repeat(9)))
  it('cittadinanza in 126-134', () => expect(campo(126, 134)).toBe('100000100'))
  it('tipo documento in 135-139', () => expect(campo(135, 139)).toBe('IDENT'))
  it('numero documento in 140-159', () => expect(campo(140, 159)).toBe('AB1234567'.padEnd(20)))
  it('luogo di rilascio in 160-168', () => expect(campo(160, 168)).toBe('058091001'))
})

describe('sesso', () => {
  it('2 per le donne', () => {
    expect(rigaAlloggiati(ospite({ sesso: 'F' })).substring(94, 95)).toBe('2')
  })
  it('non lascia mai la casella vuota: senza indicazione vale 1', () => {
    expect(rigaAlloggiati(ospite({ sesso: '' })).substring(94, 95)).toBe('1')
  })
})

describe('documento: solo per chi lo deve dichiarare', () => {
  it('i tipi 16, 17 e 18 portano il documento', () => {
    for (const t of ['16', '17', '18']) {
      const r = rigaAlloggiati(ospite({ tipoAlloggiato: t }))
      expect(r.substring(134, 139).trim(), t).toBe('IDENT')
      expect(r.substring(139, 159).trim(), t).toBe('AB1234567')
    }
  })

  it('i tipi 19 e 20 NO: sono familiari e membri di gruppo', () => {
    // Il manuale li vuole in bianco: metterceli fa scartare il file.
    for (const t of ['19', '20']) {
      const r = rigaAlloggiati(ospite({ tipoAlloggiato: t }))
      expect(r.substring(134, 139), t).toBe(' '.repeat(5))
      expect(r.substring(139, 159), t).toBe(' '.repeat(20))
      expect(r.substring(159, 168), t).toBe(' '.repeat(9))
    }
  })
})

describe('pulizia dei caratteri', () => {
  it('toglie gli accenti, che il tracciato non ammette', () => {
    const r = rigaAlloggiati(ospite({ cognome: "D'Angelò", nome: 'Niccolò' }))
    expect(r.substring(14, 64).trim()).toBe("D'ANGELO")
    expect(r.substring(64, 94).trim()).toBe('NICCOLO')
  })

  it('scrive tutto in maiuscolo', () => {
    expect(rigaAlloggiati(ospite({ cognome: 'rossi' })).substring(14, 19)).toBe('ROSSI')
  })

  it('sostituisce gli a capo, che spezzerebbero il file', () => {
    const r = rigaAlloggiati(ospite({ cognome: 'ROS\nSI' }))
    expect(r).toHaveLength(168)
    expect(r).not.toContain('\n')
  })
})

describe('giorni di permanenza', () => {
  it('sta in due cifre: oltre 99 notti si ferma a 99', () => {
    expect(rigaAlloggiati(ospite({ notti: 150 })).substring(12, 14)).toBe('99')
  })
  it('mai 00: un pernottamento c e sempre', () => {
    expect(rigaAlloggiati(ospite({ notti: 0 })).substring(12, 14)).toBe('01')
  })
})

describe('il file intero', () => {
  it('una riga per ospite, separate come vuole il tracciato', () => {
    const f = generaAlloggiati([ospite(), ospite({ cognome: 'VERDI' })])
    expect(f.righe).toBe(2)
    expect(f.contenuto.split('\r\n').filter(Boolean)).toHaveLength(2)
    expect(f.contenuto.endsWith('\r\n')).toBe(true)
  })

  it('segnala chi non ha i codici, invece di produrre righe monche', () => {
    // Un codice mancante non e un dettaglio: quella riga viene scartata dal
    // portale, e con lei l intero file.
    const f = generaAlloggiati([ospite({ codiceComuneNascita: '', codiceStatoNascita: '' })])
    expect(f.avvisi.join(' ')).toContain('ROSSI MARIO')
    expect(f.avvisi.join(' ')).toContain('luogo di nascita')
  })

  it('senza ospiti non produce un file vuoto', () => {
    const f = generaAlloggiati([])
    expect(f.righe).toBe(0)
    expect(f.contenuto).toBe('')
  })
})
