/**
 * Registrazione di un check-in.
 *
 * E' il punto in cui dati scritti a mano da una persona diventano righe che
 * poi generano una fattura e una comunicazione alla Questura. Quello che passa
 * di qui sbagliato non viene piu' guardato da nessuno.
 *
 * Due principi nei test:
 *  - le righe si costruiscono per NOME di colonna e si proiettano sullo schema,
 *    cosi' aggiungere una colonna non puo' disallineare i valori;
 *  - un rifiuto deve dire cosa manca, in modo che chi sta al portone possa
 *    rimediare subito invece di scoprirlo dopo.
 */
import { describe, it, expect } from 'vitest'
import { registraCheckin, type PayloadCheckin } from './registrazione'
import { COL_SOGGIORNI, COL_OSPITI } from './foglio-schema'
import { REGOLE_MARATEA } from './imposta-soggiorno'

const ORA = new Date(Date.UTC(2026, 7, 24, 10, 15, 30))
const catastale = (l: string) => ({ ROMA: 'H501', MARATEA: 'E919', GERMANIA: 'Z112' }[l.toUpperCase()] ?? '')

function payload(over: Partial<PayloadCheckin> = {}): PayloadCheckin {
  return {
    unita: 'Unità 1',
    portale: 'Booking',
    codPrenotazione: '123456',
    checkin: '2026-07-01',
    checkout: '2026-07-04',
    importoLordo: '450,00',
    intestatario: 'Mario Rossi',
    codiceFiscale: 'RSSMRA80A01H501U',
    piva: '', sdi: '', indirizzo: 'Via Roma 1', cap: '00100', citta: 'Roma',
    provincia: 'RM', nazione: 'IT', email: 'mario@example.com', telefono: '3331234567',
    note: '',
    ospiti: [{
      tipoAlloggiato: '16', cognome: 'Rossi', nome: 'Mario', sesso: 'M',
      dataNascita: '1980-01-01', comuneNascita: 'ROMA', provNascita: 'RM',
      statoNascita: '', cittadinanza: 'ITALIA', tipoDocumento: 'IDENT',
      numeroDocumento: 'AB1234567', luogoRilascio: 'ROMA',
      codiceFiscale: 'RSSMRA80A01H501U', esente: false, motivoEsenzione: '',
    }],
    ...over,
  }
}

const esegui = (p: PayloadCheckin) =>
  registraCheckin(p, { ora: ORA, cercaCatastale: catastale, regole: REGOLE_MARATEA })

describe('un check-in completo', () => {
  it('produce un ID leggibile e ordinabile', () => {
    const r = esegui(payload())
    expect(r.ok).toBe(true)
    expect(r.id).toBe('SOG-20260824-101530')
  })

  it('costruisce la riga Soggiorni allineata allo schema', () => {
    const r = esegui(payload())
    expect(r.rigaSoggiorno).toHaveLength(COL_SOGGIORNI.length)

    const col = (nome: string) => r.rigaSoggiorno[COL_SOGGIORNI.indexOf(nome as never)]
    expect(col('ID Soggiorno')).toBe('SOG-20260824-101530')
    expect(col('Unità')).toBe('Unità 1')
    expect(col('Notti')).toBe('3')
    expect(col('N. ospiti')).toBe('1')
    expect(col('Fattura emessa')).toBe('NO')
    expect(col('Inviato Alloggiati')).toBe('NO')
  })

  it('costruisce una riga Ospiti per ogni ospite, legata allo stesso ID', () => {
    const p = payload()
    p.ospiti.push({ ...p.ospiti[0], cognome: 'Bianchi', nome: 'Anna', sesso: 'F', dataNascita: '1985-03-12', codiceFiscale: '' })
    const r = esegui(p)

    expect(r.righeOspiti).toHaveLength(2)
    for (const riga of r.righeOspiti) {
      expect(riga).toHaveLength(COL_OSPITI.length)
      expect(riga[COL_OSPITI.indexOf('ID Soggiorno' as never)]).toBe(r.id)
    }
    expect(r.righeOspiti[1][COL_OSPITI.indexOf('Progressivo' as never)]).toBe('2')
  })
})

describe('importo lordo', () => {
  it('accetta la virgola come separatore decimale', () => {
    const r = esegui(payload({ importoLordo: '450,00' }))
    expect(r.rigaSoggiorno[COL_SOGGIORNI.indexOf('Importo lordo €' as never)]).toBe('450')
  })

  it('accetta anche il punto', () => {
    const r = esegui(payload({ importoLordo: '450.50' }))
    expect(r.rigaSoggiorno[COL_SOGGIORNI.indexOf('Importo lordo €' as never)]).toBe('450.5')
  })

  it('rifiuta un importo che non e un numero invece di scrivere zero', () => {
    // Zero silenzioso significa fattura da zero euro: meglio fermarsi.
    const r = esegui(payload({ importoLordo: 'contanti' }))
    expect(r.ok).toBe(false)
    expect(r.errori.join(' ')).toContain('Importo')
  })
})

describe('imposta di soggiorno', () => {
  it('la calcola e la scrive nella riga', () => {
    const r = esegui(payload())
    expect(r.rigaSoggiorno[COL_SOGGIORNI.indexOf('Imposta soggiorno €' as never)]).toBe('7.5')
  })

  it('non conta i bambini, anche senza spuntare nulla', () => {
    const p = payload()
    p.ospiti.push({ ...p.ospiti[0], cognome: 'Rossi', nome: 'Luca', dataNascita: '2020-05-01', codiceFiscale: '' })
    const r = esegui(p)
    expect(r.rigaSoggiorno[COL_SOGGIORNI.indexOf('Imposta soggiorno €' as never)]).toBe('7.5')
  })
})

describe('codice fiscale — la regola concordata', () => {
  it('lo pretende, valido, da chi dichiara cittadinanza italiana', () => {
    const p = payload()
    p.ospiti[0].codiceFiscale = ''
    const r = esegui(p)
    expect(r.ok).toBe(false)
    expect(r.errori.join(' ')).toContain('codice fiscale')
  })

  it('rifiuta un codice fiscale storpiato', () => {
    const p = payload()
    p.ospiti[0].codiceFiscale = 'RSSMRA80A01H501X'
    const r = esegui(p)
    expect(r.ok).toBe(false)
    expect(r.errori.join(' ')).toContain('controllo')
  })

  it('NON lo pretende da uno straniero', () => {
    // Un tedesco il codice fiscale italiano non ce l ha: bloccarlo
    // significherebbe impedirgli di fare il check-in.
    const p = payload()
    p.ospiti[0] = {
      ...p.ospiti[0], cognome: 'Muller', nome: 'Hans', cittadinanza: 'GERMANIA',
      comuneNascita: '', statoNascita: 'GERMANIA', codiceFiscale: '',
    }
    const r = esegui(p)
    expect(r.ok).toBe(true)
  })

  it('ma se lo straniero ne scrive uno, deve essere valido', () => {
    const p = payload()
    p.ospiti[0] = {
      ...p.ospiti[0], cittadinanza: 'GERMANIA', comuneNascita: '', statoNascita: 'GERMANIA',
      codiceFiscale: 'QUESTOEUNCODICE',
    }
    const r = esegui(p)
    expect(r.ok).toBe(false)
  })

  it('avvisa quando il codice non corrisponde alla data dichiarata', () => {
    const p = payload()
    p.ospiti[0].dataNascita = '1990-05-20'
    const r = esegui(p)
    expect(r.avvisi.join(' ')).toContain('non corrisponde')
  })
})

describe('dati che mancano', () => {
  it('elenca TUTTO cio che manca, non solo il primo', () => {
    // Chi sta al portone deve poter rimediare in una volta sola.
    const r = esegui(payload({ unita: '', checkin: '', ospiti: [] }))
    expect(r.ok).toBe(false)
    expect(r.errori.length).toBeGreaterThanOrEqual(3)
  })

  it('pretende cognome, nome e data di nascita di ogni ospite', () => {
    const p = payload()
    p.ospiti[0].cognome = ''
    const r = esegui(p)
    expect(r.ok).toBe(false)
    expect(r.errori.join(' ')).toContain('Ospite 1')
  })

  it('rifiuta un soggiorno senza ospiti', () => {
    const r = esegui(payload({ ospiti: [] }))
    expect(r.ok).toBe(false)
    expect(r.errori.join(' ')).toContain('ospite')
  })

  it('pretende il motivo quando si dichiara un esenzione', () => {
    const p = payload()
    p.ospiti[0].esente = true
    p.ospiti[0].motivoEsenzione = ''
    const r = esegui(p)
    expect(r.ok).toBe(false)
    expect(r.errori.join(' ')).toContain('motivo')
  })
})

describe('cose che non devono finire nel foglio', () => {
  it('taglia gli a capo, che spezzerebbero la riga', () => {
    const r = esegui(payload({ note: 'prima riga\nseconda riga' }))
    expect(r.rigaSoggiorno[COL_SOGGIORNI.indexOf('Note' as never)]).not.toContain('\n')
  })

  it('non lascia che un valore cominci con = e diventi una formula', () => {
    // Un campo che inizia per = viene interpretato da Google come formula:
    // e' iniezione in un foglio di calcolo, e la scrive un estraneo.
    const r = esegui(payload({ intestatario: '=IMPORTRANGE("altrui";"A1")' }))
    const v = r.rigaSoggiorno[COL_SOGGIORNI.indexOf('Intestatario fattura' as never)]
    expect(v.startsWith('=')).toBe(false)
  })
})

describe('intestazione della fattura senza riscrivere niente', () => {
  it('senza intestatario, la fattura va al primo ospite', () => {
    // Nome e codice fiscale sono gia' stati scritti nella sezione Ospiti:
    // richiederli di nuovo significa chiedere due volte la stessa cosa a chi
    // ha l ospite davanti, e ogni ripetizione e' un modo per divergere.
    const p = payload({ intestatario: '', codiceFiscale: '' })
    const r = esegui(p)
    expect(r.ok).toBe(true)
    expect(r.rigaSoggiorno[COL_SOGGIORNI.indexOf('Intestatario fattura' as never)]).toBe('ROSSI MARIO')
    expect(r.rigaSoggiorno[COL_SOGGIORNI.indexOf('Codice fiscale' as never)]).toBe('RSSMRA80A01H501U')
  })

  it('se l intestatario e dichiarato, vince su quello dedotto', () => {
    const r = esegui(payload({ intestatario: 'ACME SRL', codiceFiscale: '', piva: '01234567890' }))
    expect(r.rigaSoggiorno[COL_SOGGIORNI.indexOf('Intestatario fattura' as never)]).toBe('ACME SRL')
  })

  it('non inventa un intestatario se non ci sono ospiti', () => {
    const r = esegui(payload({ intestatario: '', ospiti: [] }))
    expect(r.rigaSoggiorno[COL_SOGGIORNI.indexOf('Intestatario fattura' as never)]).toBe('')
  })
})

describe('codice destinatario', () => {
  it('mette 0000000 per un italiano che non lo indica', () => {
    const r = esegui(payload({ sdi: '', nazione: 'IT' }))
    expect(r.rigaSoggiorno[COL_SOGGIORNI.indexOf('Codice SDI / PEC' as never)]).toBe('0000000')
  })

  it('mette XXXXXXX per uno straniero', () => {
    const r = esegui(payload({ sdi: '', nazione: 'DE' }))
    expect(r.rigaSoggiorno[COL_SOGGIORNI.indexOf('Codice SDI / PEC' as never)]).toBe('XXXXXXX')
  })

  it('non sovrascrive un codice indicato davvero', () => {
    const r = esegui(payload({ sdi: 'ABCDEFG' }))
    expect(r.rigaSoggiorno[COL_SOGGIORNI.indexOf('Codice SDI / PEC' as never)]).toBe('ABCDEFG')
  })
})

describe('indirizzo — obbligatorio perche la fattura non si genera senza', () => {
  it('rifiuta un check-in senza indirizzo, CAP o comune', () => {
    // Verificato sullo schema XSD ufficiale (FatturaPA 1.2.2): nel blocco
    // CessionarioCommittente l'elemento Sede NON ha minOccurs="0", mentre
    // StabileOrganizzazione e RappresentanteFiscale ce l hanno. E obbligatorio.
    // Senza, il file viene scartato prima ancora di arrivare allo SdI.
    const r = esegui(payload({ indirizzo: '', cap: '', citta: '' }))
    expect(r.ok).toBe(false)
    expect(r.errori.join(' ')).toContain('indirizzo')
    expect(r.errori.join(' ')).toContain('CAP')
    expect(r.errori.join(' ')).toContain('omune')
  })

  it('NON pretende la provincia, che nello schema e facoltativa', () => {
    const r = esegui(payload({ provincia: '' }))
    expect(r.ok).toBe(true)
  })

  it('per uno straniero senza CAP usa 00000, la convenzione prevista', () => {
    const r = esegui(payload({ nazione: 'DE', cap: '' }))
    expect(r.ok).toBe(true)
    expect(r.rigaSoggiorno[COL_SOGGIORNI.indexOf('CAP' as never)]).toBe('00000')
  })

  it('a un italiano il CAP lo chiede davvero', () => {
    const r = esegui(payload({ nazione: 'IT', cap: '' }))
    expect(r.ok).toBe(false)
  })
})

describe('quando la fattura e a una societa', () => {
  it('la societa prevale sull ospite, e il suo codice fiscale non viene dedotto', () => {
    const r = esegui(payload({ intestatario: 'ACME SRL', codiceFiscale: '', piva: '01234567890' }))
    const col = (n: string) => r.rigaSoggiorno[COL_SOGGIORNI.indexOf(n as never)]
    expect(col('Intestatario fattura')).toBe('ACME SRL')
    expect(col('Codice fiscale')).toBe('')
    expect(col('P.IVA')).toBe('01234567890')
  })
})

describe('i messaggi li legge anche chi non parla italiano', () => {
  it('ogni errore porta con se la versione inglese', () => {
    const r = esegui(payload({ unita: '', indirizzo: '', importoLordo: '' }))
    expect(r.ok).toBe(false)
    for (const e of r.errori) expect(e, `senza inglese: ${e}`).toContain(' / ')
  })
})
