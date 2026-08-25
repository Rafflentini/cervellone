/**
 * Archivio e viste dell'elenco prenotazioni.
 *
 * La proprieta' che conta: **niente sparisce perche' e' passato.** Una
 * prenotazione di luglio con il check-in incompleto, o senza il file per la
 * Questura, resta sotto gli occhi anche a settembre. Nell'archivio ci finisce
 * solo cio' che e' concluso E a posto.
 *
 * Il rischio speculare e' altrettanto vero: se l'elenco cresce e basta, a meta'
 * stagione per vedere chi arriva domani si scorre sopra a ottanta schede — e a
 * quel punto non si guarda piu' niente.
 */
import { describe, it, expect } from 'vitest'
import {
  classifica, mesePratica, indiceMesi, selezionaPratiche, contaNumeri, numeroIt,
  statoFatturaDi, STATI_FATTURA,
  type PraticaArchiviabile,
} from './archivio'

const OGGI = '2026-09-15'

function p(x: Partial<PraticaArchiviabile> = {}): PraticaArchiviabile {
  return {
    id: 'SOG-1',
    unita: 'Unità 1',
    intestatario: 'ROSSI MARIO',
    codPrenotazione: '',
    checkin: '2026-09-20',
    checkout: '2026-09-23',
    notti: '3',
    imposta: '15',
    stato: 'CHECKIN OK',
    inviatoAlloggiati: true,
    statoFattura: 'EMESSA',
    ...x,
  }
}

describe('cosa e ancora lavoro aperto', () => {
  it('una prenotazione futura sta in ADESSO', () => {
    expect(classifica(p({ checkin: '2026-10-01', checkout: '2026-10-05' }), OGGI)).toBe('adesso')
  })

  it('un ospite ancora in casa sta in ADESSO', () => {
    // Arrivato ieri, riparte domani: il soggiorno e' in corso.
    expect(classifica(p({ checkin: '2026-09-14', checkout: '2026-09-16' }), OGGI)).toBe('adesso')
  })

  it('chi riparte OGGI sta ancora in ADESSO', () => {
    // Il giorno del check-out non e' passato: e' oggi. Archiviarlo mentre
    // l'ospite e' ancora sulla porta e' il caso classico di un limite scritto
    // con > invece di >=.
    expect(classifica(p({ checkin: '2026-09-12', checkout: OGGI }), OGGI)).toBe('adesso')
  })

  it('un soggiorno concluso e a posto va in ARCHIVIO', () => {
    expect(classifica(p({ checkin: '2026-09-01', checkout: '2026-09-05' }), OGGI)).toBe('archivio')
  })
})

describe('cosa NON si lascia archiviare', () => {
  it('un check-in mai completato resta in ADESSO anche se il soggiorno e finito', () => {
    const vecchia = p({ checkin: '2026-07-01', checkout: '2026-07-05', stato: 'PARZIALE' })
    expect(classifica(vecchia, OGGI)).toBe('adesso')
  })

  it('un check-in nemmeno cominciato resta in ADESSO', () => {
    const vecchia = p({ checkin: '2026-07-01', checkout: '2026-07-05', stato: 'DA COMPILARE' })
    expect(classifica(vecchia, OGGI)).toBe('adesso')
  })

  it('senza il file per la Questura resta in ADESSO: l obbligo e a 24 ore', () => {
    // Non e' una dimenticanza qualunque: e' l'articolo 109 T.U.L.P.S., e il
    // ritardo non si recupera. Sparire dall'elenco sarebbe il modo migliore
    // per non accorgersene mai.
    const vecchia = p({ checkin: '2026-07-01', checkout: '2026-07-05', inviatoAlloggiati: false })
    expect(classifica(vecchia, OGGI)).toBe('adesso')
  })

  it('lo stato della fattura invece NON trattiene in ADESSO', () => {
    /*
      Scelta deliberata, e va detta. La fattura vive su Fatture in Cloud;
      l'archivio qui dice se il FASCICOLO DEL CHECK-IN e' completo. Due motivi
      concreti:

      - finche' l'emissione non e' costruita, nessuno scrive quello stato: se
        bloccasse, NESSUNA prenotazione entrerebbe mai in archivio e l'elenco
        crescerebbe come oggi — cioe' il problema che stiamo chiudendo;
      - il giorno che il collegamento con Fatture in Cloud si guasta, tutto
        franerebbe dentro ADESSO in una volta sola.

      Le fatture mancanti non spariscono: stanno nei contatori in cima, che
      sono filtri e si vedono da tutt'e due le viste.
    */
    const base = { checkin: '2026-07-01', checkout: '2026-07-05' }
    expect(classifica(p({ ...base, statoFattura: 'DA FARE' }), OGGI)).toBe('archivio')
    expect(classifica(p({ ...base, statoFattura: 'COMPILATA' }), OGGI)).toBe('archivio')
  })
})

describe('i tre stati della fattura', () => {
  it('sono da fare, compilata, emessa — e in quest ordine', () => {
    // COMPILATA e' la fattura che Cervellone ha preparato su Fatture in Cloud;
    // EMESSA e' quella che l'Ingegnere ha davvero inviato. Sono due cose
    // diverse, e confonderle vorrebbe dire credere spedito cio' che e' solo
    // scritto.
    expect(STATI_FATTURA).toEqual(['DA FARE', 'COMPILATA', 'EMESSA'])
  })

  it('legge la colonna nuova quando c e', () => {
    expect(statoFatturaDi({ 'Stato fattura': 'COMPILATA', 'Fattura emessa': 'NO' })).toBe('COMPILATA')
  })

  it('su una riga vecchia ripiega sul SI/NO che c era prima', () => {
    // Le righe scritte prima di questa colonna non hanno lo stato. Devono
    // continuare a leggersi giuste, senza che nessuno le converta a mano.
    expect(statoFatturaDi({ 'Fattura emessa': 'SI' })).toBe('EMESSA')
    expect(statoFatturaDi({ 'Fattura emessa': 'NO' })).toBe('DA FARE')
    expect(statoFatturaDi({})).toBe('DA FARE')
  })

  it('uno stato scritto a mano e non riconosciuto vale DA FARE', () => {
    // Sul foglio ci scrive anche una persona. "fatta" non e' uno stato: meglio
    // ricadere sul piu' prudente che credere emessa una fattura che non c'e'.
    expect(statoFatturaDi({ 'Stato fattura': 'fatta' })).toBe('DA FARE')
  })

  it('non si fa ingannare da spazi e minuscole', () => {
    expect(statoFatturaDi({ 'Stato fattura': '  emessa ' })).toBe('EMESSA')
  })
})

describe('i numeri in cima', () => {
  const elenco = [
    p({ id: 'A', checkin: '2026-09-20', checkout: '2026-09-23' }),                    // in arrivo
    p({ id: 'B', checkin: '2026-09-14', checkout: '2026-09-16' }),                    // in casa
    p({ id: 'C', checkin: '2026-07-01', checkout: '2026-07-05', stato: 'PARZIALE' }), // da completare
    p({ id: 'D', checkin: '2026-07-10', checkout: '2026-07-14', statoFattura: 'DA FARE' }),
    p({ id: 'E', checkin: '2026-06-20', checkout: '2026-06-24', statoFattura: 'COMPILATA' }),
    p({ id: 'F', checkin: '2026-06-01', checkout: '2026-06-05', inviatoAlloggiati: false }),
  ]

  it('contano su TUTTO, non solo su quello che si sta guardando', () => {
    // Se contassero solo la vista aperta, passando in archivio i numeri
    // cambierebbero — e un contatore che cambia perche' hai cambiato pagina
    // non e' un contatore, e' un inganno.
    const n = contaNumeri(elenco, OGGI)
    expect(n.inArrivo).toBe(1)
    expect(n.inCasa).toBe(1)
    expect(n.daCompletare).toBe(1)
    expect(n.daFatturare).toBe(1)
    expect(n.daInviare).toBe(1)
    expect(n.alloggiatiMancante).toBe(1)
  })

  it('tiene separate le fatture da fare da quelle solo da inviare', () => {
    // Sono due gesti diversi: una la deve preparare Cervellone, l'altra la
    // deve spedire l'Ingegnere da Fatture in Cloud. Sommarle direbbe "5 cose
    // da fare" senza dire di CHI.
    const n = contaNumeri(elenco, OGGI)
    expect(n.daFatturare).not.toBe(n.daInviare + n.daFatturare)
  })

  it('su un elenco vuoto sono tutti zero, non indefiniti', () => {
    const n = contaNumeri([], OGGI)
    expect(n).toEqual({
      inArrivo: 0, inCasa: 0, daCompletare: 0,
      daFatturare: 0, daInviare: 0, alloggiatiMancante: 0,
    })
  })
})

describe('il mese di una prenotazione', () => {
  it('e quello dell arrivo', () => {
    expect(mesePratica(p({ checkin: '2026-09-20' }))).toBe('2026-09')
  })

  it('con una data illeggibile non inventa un mese', () => {
    // Meglio un gruppo "senza data" che una prenotazione infilata in gennaio.
    expect(mesePratica(p({ checkin: '' }))).toBe('')
    expect(mesePratica(p({ checkin: '20/09/2026' }))).toBe('')
  })
})

describe('i numeri scritti a mano sul foglio', () => {
  it('legge sia il punto sia la virgola', () => {
    // Sul foglio ci scrive anche una persona, e una persona scrive "12,50".
    expect(numeroIt('12,50')).toBe(12.5)
    expect(numeroIt('12.50')).toBe(12.5)
    expect(numeroIt('15')).toBe(15)
  })

  it('una cella vuota o illeggibile vale zero, non NaN', () => {
    // Un NaN in un totale si propaga e rende illeggibile TUTTA la colonna,
    // non solo la riga sbagliata.
    expect(numeroIt('')).toBe(0)
    expect(numeroIt('  ')).toBe(0)
    expect(numeroIt('n.d.')).toBe(0)
  })

  it('non scambia il separatore delle migliaia per un decimale', () => {
    expect(numeroIt('1.250,00')).toBe(1250)
  })
})

describe('l indice dei mesi', () => {
  const elenco = [
    p({ id: 'A', checkin: '2026-09-02', notti: '3', imposta: '15' }),
    p({ id: 'B', checkin: '2026-09-20', notti: '4', imposta: '20,50' }),
    p({ id: 'C', checkin: '2026-08-11', notti: '7', imposta: '35' }),
  ]

  it('raggruppa per mese e somma notti e imposta', () => {
    expect(indiceMesi(elenco)).toEqual([
      { mese: '2026-09', prenotazioni: 2, notti: 7, imposta: 35.5 },
      { mese: '2026-08', prenotazioni: 1, notti: 7, imposta: 35 },
    ])
  })

  it('mette prima i mesi piu recenti', () => {
    const mesi = indiceMesi(elenco).map((m) => m.mese)
    expect(mesi).toEqual([...mesi].sort().reverse())
  })

  it('non perde le prenotazioni con la data illeggibile', () => {
    // Sparire da un indice e' peggio che comparire in un gruppo strano: la
    // riga esiste, l'imposta e' dovuta lo stesso.
    const con = indiceMesi([...elenco, p({ id: 'X', checkin: '', notti: '2', imposta: '10' })])
    const senzaData = con.find((m) => m.mese === '')
    expect(senzaData).toEqual({ mese: '', prenotazioni: 1, notti: 2, imposta: 10 })
  })

  it('somma in centesimi: tre volte 0,10 fanno 0,30 e non 0,30000000000000004', () => {
    // Le somme in virgola mobile sbagliano l'ultima cifra, e questa colonna
    // finisce in una dichiarazione al Comune.
    const tre = [
      p({ id: '1', checkin: '2026-07-01', notti: '1', imposta: '0,10' }),
      p({ id: '2', checkin: '2026-07-02', notti: '1', imposta: '0,10' }),
      p({ id: '3', checkin: '2026-07-03', notti: '1', imposta: '0,10' }),
    ]
    expect(indiceMesi(tre)[0].imposta).toBe(0.3)
  })
})

describe('la selezione di cosa mostrare', () => {
  const elenco = [
    p({ id: 'A', checkin: '2026-09-20', checkout: '2026-09-23', unita: 'Unità 1' }),
    p({ id: 'B', checkin: '2026-08-02', checkout: '2026-08-09', unita: 'Unità 2',
      intestatario: 'MULLER HANS', codPrenotazione: 'BK-99', statoFattura: 'DA FARE' }),
    p({ id: 'C', checkin: '2026-08-20', checkout: '2026-08-27', unita: 'Unità 1' }),
  ]

  it('ADESSO mostra solo il lavoro aperto', () => {
    const r = selezionaPratiche(elenco, { vista: 'adesso', oggi: OGGI })
    expect(r.map((x) => x.id)).toEqual(['A'])
  })

  it('ARCHIVIO mostra solo il concluso', () => {
    const r = selezionaPratiche(elenco, { vista: 'archivio', oggi: OGGI })
    expect(r.map((x) => x.id).sort()).toEqual(['B', 'C'])
  })

  it('nell archivio si filtra per mese', () => {
    const r = selezionaPratiche(elenco, { vista: 'archivio', oggi: OGGI, mese: '2026-08' })
    expect(r.map((x) => x.id).sort()).toEqual(['B', 'C'])
  })

  it('e per appartamento', () => {
    const r = selezionaPratiche(elenco, { vista: 'archivio', oggi: OGGI, unita: 'Unità 1' })
    expect(r.map((x) => x.id)).toEqual(['C'])
  })

  it('il filtro delle fatture da fare guarda ovunque, non solo in archivio', () => {
    // E' un contatore in cima: cliccandolo si vogliono TUTTE quelle da fare,
    // non quelle da fare che per caso sono gia' concluse.
    const r = selezionaPratiche(elenco, { vista: 'adesso', oggi: OGGI, fattura: 'DA FARE' })
    expect(r.map((x) => x.id)).toEqual(['B'])
  })

  it('il filtro dei check-in incompleti guarda ovunque', () => {
    const con = [...elenco, p({ id: 'D', checkin: '2026-07-01', checkout: '2026-07-05', stato: 'PARZIALE' })]
    const r = selezionaPratiche(con, { vista: 'archivio', oggi: OGGI, manca: 'checkin' })
    expect(r.map((x) => x.id)).toEqual(['D'])
  })

  it('il filtro della Questura mostra proprio quelle che il contatore conta', () => {
    /*
      La proprieta' che tiene onesto un contatore-filtro: cliccando "Questura 3"
      devono uscire QUELLE tre. Un numero che apre un elenco diverso e' peggio
      di un numero non cliccabile — si impara a non fidarsi di nessuno dei due.
    */
    const con = [...elenco, p({ id: 'E', checkin: '2026-06-01', checkout: '2026-06-05', inviatoAlloggiati: false })]
    const contati = contaNumeri(con, OGGI).alloggiatiMancante
    const mostrati = selezionaPratiche(con, { vista: 'adesso', oggi: OGGI, manca: 'questura' })
    expect(mostrati).toHaveLength(contati)
    expect(mostrati.map((x) => x.id)).toEqual(['E'])
  })

  it('lo stesso vale per il contatore dei check-in da completare', () => {
    const con = [...elenco, p({ id: 'F', checkin: '2026-07-01', checkout: '2026-07-05', stato: 'PARZIALE' })]
    const contati = contaNumeri(con, OGGI).daCompletare
    const mostrati = selezionaPratiche(con, { vista: 'archivio', oggi: OGGI, manca: 'checkin' })
    expect(mostrati).toHaveLength(contati)
  })

  it('e per quello delle fatture da fare', () => {
    const contati = contaNumeri(elenco, OGGI).daFatturare
    const mostrati = selezionaPratiche(elenco, { vista: 'adesso', oggi: OGGI, fattura: 'DA FARE' })
    expect(mostrati).toHaveLength(contati)
  })

  it('la ricerca per nome ignora maiuscole e accenti', () => {
    const r = selezionaPratiche(elenco, { vista: 'archivio', oggi: OGGI, q: 'müller' })
    expect(r.map((x) => x.id)).toEqual(['B'])
  })

  it('la ricerca trova anche il codice della prenotazione', () => {
    const r = selezionaPratiche(elenco, { vista: 'archivio', oggi: OGGI, q: 'bk-99' })
    expect(r.map((x) => x.id)).toEqual(['B'])
  })

  it('cercando si guarda ovunque, non solo nella vista aperta', () => {
    /*
      Quando si cerca un nome si vuole QUELLA prenotazione, non "quella
      prenotazione purche' sia nella meta' che stavi guardando". Una ricerca
      che risponde "nessun risultato" mentre la riga esiste e' peggio di
      nessuna ricerca: si conclude che il dato non c'e'.
    */
    const r = selezionaPratiche(elenco, { vista: 'adesso', oggi: OGGI, q: 'muller' })
    expect(r.map((x) => x.id)).toEqual(['B'])
  })

  it('le piu recenti in cima', () => {
    const r = selezionaPratiche(elenco, { vista: 'archivio', oggi: OGGI })
    expect(r.map((x) => x.checkin)).toEqual(['2026-08-20', '2026-08-02'])
  })
})
