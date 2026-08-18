import { describe, it, expect } from 'vitest'
import {
  matchNamedFolderScored,
  scoreFotoFolder,
  pickFotoFolder,
  isFotoFolderName,
  hasFotoFolder,
  significantTokens,
  commessaNumbers,
  isMoveSuccess,
  pickTopScored,
  tokenWeights,
  similarityRatio,
  editDistanceAtMost,
  SOGLIA_DUPLICATO,
  type FolderMatch,
} from './foto-archive-match'

// Helper: cartella Drive fittizia con id derivato dal nome (asserzioni leggibili).
function f(name: string): FolderMatch {
  return { id: `id:${name}`, name }
}

// Scorciatoia: [nome, forza] per ogni candidato, nell'ordine di ritorno.
function scored(folders: FolderMatch[], query: string): Array<[string, string]> {
  return matchNamedFolderScored(folders, query).map(m => [m.name, m.strength])
}

// ---------------------------------------------------------------------------
// PIN: comportamento GIÀ CORRETTO che i fix non devono rompere.
// ---------------------------------------------------------------------------
describe('matchNamedFolderScored — comportamento corretto da preservare', () => {
  it('accenti NFD: "Città della Scienza" matcha la cartella "Citta della Scienza"', () => {
    const folders = [f('Citta della Scienza')]
    expect(scored(folders, 'Città della Scienza')).toEqual([['Citta della Scienza', 'esatto']])
  })

  it('maiuscole/minuscole irrilevanti: "CONDOMINIO VIA ROMA 12"', () => {
    const folders = [f('2026-007 Condominio via Roma 12')]
    expect(scored(folders, 'CONDOMINIO VIA ROMA 12')).toEqual([
      ['2026-007 Condominio via Roma 12', 'esatto'],
    ])
  })

  it('due commesse dello stesso comune: il match resta DEBOLE (chiede conferma)', () => {
    const folders = [
      f('2026-012 Comune di Potenza - Scuola Media'),
      f('2026-030 Comune di Potenza - Palestra'),
    ]
    // Solo la scuola aggancia (overlap potenza+scuola), ma come 'debole': NON deve
    // archiviare in silenzio, la commessa giusta potrebbe essere un'altra dello stesso comune.
    expect(scored(folders, 'Comune di Potenza scuola')).toEqual([
      ['2026-012 Comune di Potenza - Scuola Media', 'debole'],
    ])
  })

  it('due scuole dello stesso comune: due candidati, entrambi deboli → disambigua', () => {
    const folders = [
      f('2026-012 Comune di Potenza - Scuola Media'),
      f('2026-030 Comune di Potenza - Scuola Elementare'),
    ]
    expect(scored(folders, 'Comune di Potenza scuola')).toEqual([
      ['2026-012 Comune di Potenza - Scuola Media', 'debole'],
      ['2026-030 Comune di Potenza - Scuola Elementare', 'debole'],
    ])
  })

  it('nessuna prova sufficiente → nessun candidato (non_trovata)', () => {
    expect(scored([f('2026-001 Palazzo Rossi')], 'Villa Verdi')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// B6 — substring unidirezionale spacciato per match forte.
// ---------------------------------------------------------------------------
describe('B6 — substring che non finisce su confine di parola', () => {
  it('"Bianchi" contro "2026-031 Villa Bianchini" è DEBOLE, non esatto', () => {
    // Prima del fix: 'esatto' → archiviava le foto in casa di un altro cliente
    // senza chiedere nulla.
    expect(scored([f('2026-031 Villa Bianchini')], 'Bianchi')).toEqual([
      ['2026-031 Villa Bianchini', 'debole'],
    ])
  })

  it('"Rossi" contro "Rossini Costruzioni" è DEBOLE', () => {
    expect(scored([f('Rossini Costruzioni')], 'Rossi')).toEqual([['Rossini Costruzioni', 'debole']])
  })

  it('il match su parola intera resta ESATTO: "Bianchi" → "2026-040 Ditta Bianchi"', () => {
    expect(scored([f('2026-040 Ditta Bianchi')], 'Bianchi')).toEqual([
      ['2026-040 Ditta Bianchi', 'esatto'],
    ])
  })

  it('distingue le due ditte nella stessa lista: Bianchini debole, Bianchi esatto', () => {
    const folders = [f('2026-031 Villa Bianchini'), f('2026-040 Ditta Bianchi')]
    expect(scored(folders, 'Bianchi')).toEqual([
      ['2026-031 Villa Bianchini', 'debole'],
      ['2026-040 Ditta Bianchi', 'esatto'],
    ])
  })

  it('INTENZIONALE: "Bar Do" → "Bar Do Re Mi" resta ESATTO (confine di parola)', () => {
    // La regola declassa solo i match che finiscono DENTRO una parola. Qui "bar do"
    // finisce su uno spazio, quindi resta forte: è lo stesso caso della ricerca per
    // nome parziale ("Condominio via Roma" → "Condominio via Roma 12"), che deve
    // continuare a funzionare senza conferma.
    expect(scored([f('Bar Do Re Mi')], 'Bar Do')).toEqual([['Bar Do Re Mi', 'esatto']])
  })

  it('INTENZIONALE: query più lunga del nome cartella non matcha affatto', () => {
    // "Bianchi Ristrutturazione" contro la cartella "Bianchi": un solo token
    // significativo in comune → nessun candidato (stato "non_trovata").
    // Comportamento invariato dal fix B6, pinnato perché sia una scelta e non un caso.
    expect(scored([f('Bianchi')], 'Bianchi Ristrutturazione')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// B7 — regex numero commessa senza word boundary.
// ---------------------------------------------------------------------------
describe('B7 — numero commessa NNNN-NNN con confini', () => {
  it('"2026-012" NON è il numero commessa di "2026-0125 Palazzo Verdi"', () => {
    expect(commessaNumbers('2026-0125 Palazzo Verdi')).toEqual([])
    expect(commessaNumbers('2026-012 Scuola Media')).toEqual(['2026-012'])
  })

  it('la commessa giusta non viene più esclusa dal prefisso "2026-0125"', () => {
    const folders = [f('2026-0125 Palazzo Verdi'), f('2026-012 Scuola Media')]
    // Prima del fix: "2026-0125 Palazzo Verdi" agganciava con forza 'numero' e la
    // restrizione by-number ESCLUDEVA "2026-012 Scuola Media", la commessa vera.
    expect(scored(folders, '2026-012')).toEqual([['2026-012 Scuola Media', 'numero']])
  })

  it('da sola, "2026-0125 Palazzo Verdi" non è più una prova forte per "2026-012"', () => {
    // Resta un candidato (substring), ma DEBOLE → il chiamante chiede conferma
    // invece di archiviare in una commessa diversa.
    expect(scored([f('2026-0125 Palazzo Verdi')], '2026-012')).toEqual([
      ['2026-0125 Palazzo Verdi', 'debole'],
    ])
  })

  it('nemmeno una cifra in più a sinistra fa numero commessa', () => {
    expect(commessaNumbers('12026-012 Deposito')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// B8 — scoreFotoFolder valutava "foto" sul nome NON spogliato del prefisso.
// ---------------------------------------------------------------------------
describe('B8 — punteggio cartella foto sul nome spogliato del prefisso', () => {
  it('"08_Foto cantiere" vale quanto "08 - Foto cantiere" (underscore normalizzato)', () => {
    // Prima del fix: 60 vs 70, perché "\bfoto\b" non trova confine dopo "_".
    expect(scoreFotoFolder('08_Foto cantiere')).toBe(scoreFotoFolder('08 - Foto cantiere'))
    expect(scoreFotoFolder('08_Foto cantiere')).toBe(80)
  })

  it('"Foto_2026" è una cartella foto a pieno titolo', () => {
    expect(scoreFotoFolder('Foto_2026')).toBe(80)
  })

  it('"08_Foto" (prefisso numerato + solo "Foto") è il massimo', () => {
    expect(scoreFotoFolder('08_Foto')).toBe(100)
  })

  it('"Documentazione fotografica" resta in cima ai nomi composti', () => {
    expect(scoreFotoFolder('03_Documentazione fotografica')).toBe(90)
  })

  it('le foto di cantiere NON finiscono più nel rilievo fotografico', () => {
    // 03_Rilievo fotografico è un elaborato di progetto, non l'archivio delle foto
    // scattate in cantiere. Prima del fix vinceva 80 a 60, in silenzio.
    const picked = pickFotoFolder([f('03_Rilievo fotografico'), f('08_Foto cantiere')])
    expect(picked.match?.name).toBe('08_Foto cantiere')
  })

  it('"Fotografie" e "Rilievo fotografico" restano cartelle foto accettabili', () => {
    expect(scoreFotoFolder('Fotografie')).toBe(70)
    expect(scoreFotoFolder('Rilievo fotografico')).toBe(70)
  })
})

// ---------------------------------------------------------------------------
// B9 — "foto" dentro fotovoltaico/fotocopie + scoring saltato con un solo candidato.
// ---------------------------------------------------------------------------
describe('B9 — deny-list e soglia anche con un solo candidato', () => {
  it('"05_Impianto Fotovoltaico" non è una cartella foto', () => {
    expect(scoreFotoFolder('05_Impianto Fotovoltaico')).toBe(0)
    expect(isFotoFolderName('05_Impianto Fotovoltaico')).toBe(false)
    expect(hasFotoFolder([f('05_Impianto Fotovoltaico')])).toBe(false)
  })

  it('"Fotocopie" non è una cartella foto', () => {
    expect(scoreFotoFolder('Fotocopie')).toBe(0)
    expect(isFotoFolderName('Fotocopie')).toBe(false)
  })

  it('commessa fotovoltaico: nessuna cartella scelta, si chiede conferma', () => {
    // Prima del fix: unico candidato → accettato senza scoring, e le foto di
    // cantiere finivano fra gli schemi elettrici.
    const picked = pickFotoFolder([f('05_Impianto Fotovoltaico'), f('04_Schemi elettrici')])
    expect(picked.match).toBeUndefined()
    expect(picked.candidates).toEqual([])
  })

  it('un solo candidato sotto soglia non viene accettato in silenzio', () => {
    const picked = pickFotoFolder([f('07_Fotomontaggi')])
    expect(scoreFotoFolder('07_Fotomontaggi')).toBe(60)
    expect(picked.match).toBeUndefined()
  })

  it('un solo candidato valido viene ancora scelto', () => {
    const picked = pickFotoFolder([f('08_Foto cantiere'), f('04_Schemi elettrici')])
    expect(picked.match?.name).toBe('08_Foto cantiere')
  })

  it('la deny-list non uccide una vera cartella foto di un impianto fotovoltaico', () => {
    expect(scoreFotoFolder('06_Foto impianto fotovoltaico')).toBe(80)
    expect(pickFotoFolder([f('06_Foto impianto fotovoltaico')]).match?.name)
      .toBe('06_Foto impianto fotovoltaico')
  })

  it('vero pareggio fra due cartelle foto → nessuna scelta, si disambigua', () => {
    const picked = pickFotoFolder([f('08_Foto cantiere'), f('09_Foto collaudo')])
    expect(picked.match).toBeUndefined()
    expect(picked.candidates.map(c => c.name)).toEqual(['08_Foto cantiere', '09_Foto collaudo'])
  })
})

// ---------------------------------------------------------------------------
// B13 — replace del numero commessa senza flag /g.
// ---------------------------------------------------------------------------
describe('B13 — tutti i numeri commessa vengono rimossi dai token', () => {
  it('con più occorrenze del numero, l\'anno non resta un token significativo', () => {
    // Prima del fix: ['melfi', '2026', '045', 'palestra'] → "2026" faceva da token
    // jolly fra tutte le commesse dello stesso anno.
    expect(significantTokens('2026-045 Melfi 2026-045 Palestra')).toEqual(['melfi', 'palestra'])
  })

  it('due commesse diverse dello stesso anno non matchano più', () => {
    // Con due numeri commessa nel nome (lotti accorpati / righe di registro) l\'anno
    // sopravvissuto al replace portava l'overlap da 1 a 2 → falso match 'debole'.
    const folders = [f('2026-050 2026-051 Villa Neri')]
    expect(scored(folders, '2026-012 2026-013 Ristrutturazione Villa')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// isMoveSuccess — esito spostamento file (estratta insieme al resto).
// ---------------------------------------------------------------------------
describe('isMoveSuccess', () => {
  it('successo verificato', () => {
    expect(isMoveSuccess('File "IMG_1.jpg" spostato nella nuova cartella.')).toBe(true)
  })

  it('errore, policy e testo ambiguo → falso', () => {
    expect(isMoveSuccess('Errore: permessi insufficienti')).toBe(false)
    expect(isMoveSuccess('🔒 scrittura non consentita')).toBe(false)
    expect(isMoveSuccess('File aggiornato')).toBe(false)
    expect(isMoveSuccess('')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// pickTopScored — la scelta della cartella foto ANNIDATA (BFS).
// La BFS parte dai figli diretti, quindi senza la soglia riaccettava esattamente
// ciò che pickFotoFolder aveva appena scartato: la protezione di B9 restava
// inerte proprio nel caso che doveva coprire.
// ---------------------------------------------------------------------------
describe('pickTopScored (cartella foto annidata)', () => {
  const c = (name: string, score: number) => ({ id: name, name, score })

  it('un solo candidato SOTTO soglia → non sceglie, lo restituisce per la domanda', () => {
    // "05_Impianto Fotovoltaico" arriva qui con score 0: in una commessa
    // fotovoltaico le foto di cantiere finivano fra gli schemi elettrici.
    const { match, tied } = pickTopScored([c('05_Impianto Fotovoltaico', 0)])
    expect(match).toBeUndefined()
    expect(tied.map(x => x.name)).toEqual(['05_Impianto Fotovoltaico'])
  })

  it('un solo candidato SOPRA soglia → sceglie', () => {
    const { match } = pickTopScored([c('08_Foto cantiere', 80)])
    expect(match?.name).toBe('08_Foto cantiere')
  })

  it('vince il punteggio più alto, non l ordine di arrivo', () => {
    const { match } = pickTopScored([c('03_Rilievo fotografico', 70), c('08_Foto cantiere', 80)])
    expect(match?.name).toBe('08_Foto cantiere')
  })

  it('vero pareggio sopra soglia → NON sceglie, chiede con entrambi i candidati', () => {
    const { match, tied } = pickTopScored([c('Foto cantiere', 80), c('Foto lavori', 80)])
    expect(match).toBeUndefined()
    expect(tied.map(x => x.name)).toEqual(['Foto cantiere', 'Foto lavori'])
  })

  it('nessun candidato → nessuna scelta e nessun candidato da mostrare', () => {
    expect(pickTopScored([])).toEqual({ tied: [] })
  })

  it('non muta l array ricevuto (il sort lavora su una copia)', () => {
    const input = [c('a', 10), c('b', 90)]
    pickTopScored(input)
    expect(input.map(x => x.name)).toEqual(['a', 'b'])
  })
})

// ── Peso dei token e somiglianza fra commesse ───────────────────────────────
describe('tokenWeights / similarityRatio', () => {
  const REGISTRO = [
    '2020-001 Potenza Rossi Srl Rifacimento copertura',
    '2020-002 Potenza Bianchi Spa Rifacimento copertura',
    '2020-003 Potenza Lombardi Rifacimento copertura',
    '2020-004 Matera Ferrovie Appulo Lucane Adeguamento sismico',
  ]

  it('un token frequente pesa meno di uno raro', () => {
    const pesi = tokenWeights(REGISTRO)
    // 'potenza' sta in 3 righe su 4, 'lucane' in 1.
    expect(pesi.get('potenza')!).toBeLessThan(pesi.get('lucane')!)
  })

  it('lo stesso token ripetuto nella riga conta una volta sola', () => {
    const pesi = tokenWeights(['2020-005 Potenza Comune di Potenza Demolizione'])
    // Con 1 riga: frequenza 1 → log(2/2) = 0. Se contasse due volte sarebbe 2.
    expect(pesi.get('potenza')).toBeCloseTo(Math.log(2 / 2), 6)
  })

  it('la riga identica ha somiglianza piena', () => {
    const pesi = tokenWeights(REGISTRO)
    const r = similarityRatio(REGISTRO[3], REGISTRO[3], pesi, REGISTRO.length)
    expect(r).toBeCloseTo(1, 6)
  })

  it('un committente mai visto abbassa la somiglianza: e la prova che la commessa non c e', () => {
    const pesi = tokenWeights(REGISTRO)
    const conNuovo = similarityRatio('2030-001 Potenza Zeta Immobiliare Rifacimento copertura', REGISTRO[0], pesi, REGISTRO.length)
    const conNoto = similarityRatio('2030-001 Potenza Rossi Srl Rifacimento copertura', REGISTRO[0], pesi, REGISTRO.length)
    expect(conNuovo).toBeLessThan(conNoto)
  })

  it('non esplode sul Registro vuoto o su una riga senza token', () => {
    expect(similarityRatio('2030-001 Venosa Alfa', 'qualcosa', tokenWeights([]), 0)).toBe(0)
    expect(similarityRatio('', 'x', tokenWeights(REGISTRO), 4)).toBe(0)
  })

  it('la ragione sociale per esteso resta riconoscibile: le parole generiche non pesano', () => {
    // Il duplicato nasce cosi': la stessa ditta reinserita scrivendo per esteso
    // cio' che la prima volta era un'abbreviazione. Le parole in piu' non
    // identificano NESSUN committente, quindi non devono affossare il rapporto.
    const registro = [...REGISTRO, '2020-005 Venosa Coviello Srl Rifacimento copertura']
    const pesi = tokenWeights(registro)
    const esteso = '2031-001 Venosa Impresa Edile Coviello Societa a responsabilita limitata Rifacimento copertura'
    const r = similarityRatio(esteso, registro[4], pesi, registro.length)
    expect(r).toBeGreaterThanOrEqual(SOGLIA_DUPLICATO)
  })

  it('le parole generiche di forma societaria non sono token significativi', () => {
    const t = significantTokens('Impresa Edile Rossi Societa a responsabilita limitata')
    expect(t).toEqual(['rossi'])
  })

  it('un typo nel cognome non fa perdere il match, ma vale meno di un match esatto', () => {
    const registro = [...REGISTRO, '2020-005 Venosa Coviello Rifacimento copertura']
    const pesi = tokenWeights(registro)
    const conTypo = similarityRatio('2031-001 Venosa Coviella Rifacimento copertura', registro[4], pesi, registro.length)
    const esatto = similarityRatio('2031-001 Venosa Coviello Rifacimento copertura', registro[4], pesi, registro.length)
    expect(conTypo).toBeGreaterThanOrEqual(SOGLIA_DUPLICATO)
    // Un match approssimato NON deve essere indistinguibile da uno esatto:
    // se valesse il peso pieno, "quasi uguale" e "uguale" sarebbero la stessa prova.
    expect(conTypo).toBeLessThan(esatto)
  })

  it('editDistanceAtMost: 1 per i token corti, 2 per quelli lunghi', () => {
    expect(editDistanceAtMost('rossi', 'rossa', 1)).toBe(true)
    expect(editDistanceAtMost('rossi', 'rosse', 1)).toBe(true)
    expect(editDistanceAtMost('rossi', 'russo', 1)).toBe(false)
    expect(editDistanceAtMost('coviello', 'coviella', 2)).toBe(true)
    // early-exit sulla differenza di lunghezza
    expect(editDistanceAtMost('abc', 'abcdefgh', 1)).toBe(false)
  })

  it('COSTO NOTO: due cognomi DIVERSI ma simili possono collidere', () => {
    // Misurato: 6 coppie su 18 di cognomi italiani confondibili superano la
    // soglia contro un cliente DIVERSO (Gallo/Gallu, Conti/Conte, Rizzo/Rizzi,
    // Costa/Cesta, Fontana/Fontano, Barbieri/Barbiero).
    // NON e' tarabile: "typo dello stesso cliente" e "cliente diverso col
    // cognome simile" sono lo STESSO segnale, e nessuna soglia li separa.
    // Accettato consapevolmente: l'esito e' una domanda di conferma in piu',
    // mai una perdita di dati, mentre il falso negativo costa una commessa
    // duplicata sul Drive.
    expect(editDistanceAtMost('conti', 'conte', 1)).toBe(true)
    expect(editDistanceAtMost('rizzo', 'rizzi', 1)).toBe(true)
  })

  it('LIMITE NOTO: le parole di dettaglio in piu nell oggetto restano invisibili', () => {
    // Misurato 0% di riconoscimento in TUTTE le configurazioni provate
    // (baseline e ogni combinazione di interventi sui token). L'unica cura
    // sarebbe simmetrizzare la formula, e il Dice pesato e' stato misurato e
    // REFUTATO: vedi il commento su SOGLIA_DUPLICATO.
    const registro = [...REGISTRO, '2020-005 Venosa Coviello Rifacimento copertura']
    const pesi = tokenWeights(registro)
    const conDettagli = similarityRatio(
      '2031-001 Venosa Coviello Rifacimento copertura con sostituzione lattoneria e pluviali esterni',
      registro[4], pesi, registro.length,
    )
    expect(conDettagli).toBeLessThan(SOGLIA_DUPLICATO)
  })
})

// Questo e IL test che protegge la calibrazione: senza, si puo tornare a un
// guardrail che blocca tutto (o che non blocca niente) e la suite resta verde.
// Il bug originale non era "manca un controllo", era "il controllo grida
// sempre": e un difetto STATISTICO, e va misurato su una popolazione.
describe('SOGLIA_DUPLICATO — calibrazione', () => {
  const COMUNI = ['Potenza', 'Matera', 'Melfi', 'Lavello', 'Venosa', 'Tito', 'Bernalda', 'Policoro']
  const LAVORI = ['Rifacimento copertura', 'Manutenzione straordinaria', 'Ristrutturazione edilizia', 'Nuova costruzione', 'Demolizione capannone']
  const COGNOMI = ['Rossi', 'Bianchi', 'Lombardi', 'Santoro', 'Coviello', 'Telesca', 'Summa', 'Pace']

  // PRNG deterministico: Math.random renderebbe il test instabile.
  let seed = 12345
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]

  function scenario(n: number) {
    seed = 12345
    const registro = Array.from({ length: n }, (_, i) =>
      `${2015 + (i % 11)}-${String((i % 900) + 1).padStart(3, '0')} ${pick(COMUNI)} ${pick(COGNOMI)} ${pick(LAVORI)}`)
    const pesi = tokenWeights(registro)
    const bloccata = (nuova: string) =>
      registro.some(r => similarityRatio(nuova, r, pesi, registro.length) >= SOGLIA_DUPLICATO)
    return { registro, bloccata }
  }

  it('NON blocca la maggioranza delle commesse nuove e scorrelate (anti-saturazione)', () => {
    const { bloccata } = scenario(400)
    const nuove = Array.from({ length: 100 }, (_, i) =>
      `2030-${String(i + 1).padStart(3, '0')} ${pick(COMUNI)} Studio${i}Xq Progetti ${pick(LAVORI)}`)

    const bloccate = nuove.filter(bloccata).length
    // Prima dei pesi era 100%. Il numero esatto puo muoversi, ma se torna sopra
    // un terzo il guardrail e di nuovo rumore e verra ignorato.
    expect(bloccate / nuove.length).toBeLessThan(0.34)
  })

  it('blocca le QUASI-COPIE: stesso comune e committente, lavoro descritto diversamente', () => {
    const { registro, bloccata } = scenario(400)
    // NON copie identiche col solo numero cambiato — quelle hanno somiglianza 1
    // e le prenderebbe qualunque soglia, anche una tarata cosi in alto da
    // lasciar passare tutto il resto. Il caso realistico e la stessa commessa
    // reinserita con l'oggetto scritto in un altro modo.
    const quasiCopie = registro.slice(0, 40).map((r, i) => {
      const c = r.split(' ')
      const comune = c[1]
      const cognome = c[2]
      return `2031-${String(i + 1).padStart(3, '0')} ${comune} ${cognome} ${pick(LAVORI)}`
    })

    const prese = quasiCopie.filter(bloccata).length
    expect(prese / quasiCopie.length).toBeGreaterThan(0.9)
  })

  it('la calibrazione regge anche su un Registro piccolo', () => {
    const { registro, bloccata } = scenario(40)
    const copie = registro.slice(0, 20).map((r, i) => `2031-${String(i + 1).padStart(3, '0')} ${r.split(' ').slice(1).join(' ')}`)
    expect(copie.filter(bloccata).length / copie.length).toBeGreaterThan(0.9)
  })
})
