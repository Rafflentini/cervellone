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
