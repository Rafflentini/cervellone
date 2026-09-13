/**
 * src/lib/delega.test.ts — il confine, e il quinto criterio di riuscita.
 *
 * ⚠️ **Il quinto criterio mancava nella prima stesura del disegno.** I primi
 * quattro provano solo cammini di SUCCESSO: il pilota poteva passare 4 su 4
 * senza aver mai esercitato il pezzo che il disegno stesso chiama il più
 * importante — «una domanda a cui la contabile non sa rispondere → l'esito
 * arriva al coordinatore come `ok: false` con `cosa_ho_provato` NON VUOTO, e il
 * coordinatore lo riporta senza travestirlo da successo parziale né da
 * silenzio».
 *
 * Per questo qui i test di fallimento sono più di quelli di successo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EsitoTurno } from './claude'

const mockRunAgentTurn = vi.fn()
vi.mock('./claude', () => ({
  runAgentTurn: (...a: unknown[]) => mockRunAgentTurn(...a),
  sinkMuto: () => ({ onText: () => {}, muto: true as const }),
}))

vi.mock('./mappa-officina', () => ({
  DOMINI: [{ nome: 'Contabilita e fatture', contiene: 'fatture', tool: ['fic_fatture_ricevute', 'conferma_bozza_fic'] }],
}))

import { delega, componiMessaggio, leggiEsito, type Incarico } from './delega'
import type { Specialista } from './specialisti'

const contabile: Specialista = {
  chiave: 'contabile',
  nome: 'la contabile',
  dominio: 'Contabilita e fatture',
  quando: 'fatture',
  toolDalNucleo: ['riconcilia_automatico'],
}

const turnoBase: EsitoTurno = {
  testo: 'Le fatture non pagate sono due.',
  outcome: 'success',
  troncato: false,
  iterazioni: 2,
  tool_chiamati: ['fic_fatture_ricevute'],
}

beforeEach(() => {
  mockRunAgentTurn.mockReset()
  mockRunAgentTurn.mockResolvedValue(turnoBase)
})

describe('⭐ gli identificativi ESATTI, non un riassunto in prosa', () => {
  it('i riferimenti finiscono nel messaggio, uno per uno', () => {
    // Se il coordinatore scrivesse «le 5 fatture Limongi trovate prima», lo
    // specialista rifarebbe la query e potrebbe trovare un insieme DIVERSO —
    // una fattura registrata nel frattempo, un filtro applicato in modo un po'
    // diverso. L'Ingegnere riceverebbe due risposte plausibili su due insiemi
    // diversi senza saperlo: e' «l'insieme presentato non e' l'insieme
    // descritto», il difetto piu' grave del 12 set 2026.
    const msg = componiMessaggio({
      compito: 'segnale pagate alla data della fattura',
      riferimenti: ['2/1144', '2/1145'],
      societa: 'Restruktura',
    })
    expect(msg).toContain('2/1144')
    expect(msg).toContain('2/1145')
    expect(msg).toContain('Restruktura')
    // E gli dice di NON rifare la ricerca: e' la meta' che rende utili gli id.
    expect(msg).toMatch(/non rifare la ricerca/i)
  })

  it('CONTROLLO POSITIVO — senza riferimenti il messaggio non se li inventa', () => {
    const msg = componiMessaggio({ compito: 'quali fatture Limongi non sono pagate' })
    expect(msg).not.toMatch(/riferimenti/i)
    expect(msg.trim()).toBe('quali fatture Limongi non sono pagate')
  })

  it('il messaggio composto e quello che arriva davvero al motore', async () => {
    // Il cavo, non solo la spina: il 12 set un difetto e' vissuto per giorni
    // perche' nessun test seguiva il valore fino a destinazione.
    const incarico: Incarico = { compito: 'controlla', riferimenti: ['2/1144'] }
    await delega(contabile, incarico, 'prompt')
    const [richiesta] = mockRunAgentTurn.mock.calls[0]
    expect(richiesta.messages[0].content).toContain('2/1144')
  })
})

describe('lo specialista lavora zitto, e solo coi suoi attrezzi', () => {
  it('il sink e MUTO', async () => {
    await delega(contabile, { compito: 'x' }, 'prompt')
    const [, sink] = mockRunAgentTurn.mock.calls[0]
    expect(sink.muto).toBe(true)
  })

  it('⭐ il perimetro sono i suoi attrezzi MENO quelli irreversibili', async () => {
    // «Ne il coordinatore, ne la segretaria spedisce MAI una fattura, quello lo
    // faccio solo io!» — e il disegno §6: lo specialista PREPARA, il
    // coordinatore chiede e gira.
    //
    // `conferma_bozza_fic` e' nel dominio della contabile ed e' in
    // AZIONI_IRREVERSIBILI: non deve arrivarle. Se ci arrivasse, salterebbe
    // l'unico punto sorvegliato — quello in cui l'Ingegnere dice «invia».
    await delega(contabile, { compito: 'x' }, 'prompt')
    const [, , , perimetro] = mockRunAgentTurn.mock.calls[0]
    expect([...perimetro.toolConsentiti].sort()).toEqual([
      'fic_fatture_ricevute',
      'riconcilia_automatico',
    ])
    expect(perimetro.toolConsentiti.has('conferma_bozza_fic')).toBe(false)
  })

  it('CONTROLLO POSITIVO — quel tool E nei suoi attrezzi: e la regola a toglierlo, non la sua assenza', async () => {
    // Senza questo, il test sopra passerebbe anche se `conferma_bozza_fic` non
    // fosse mai stato nel dominio della contabile: proverebbe zero.
    const { toolDi } = await import('./specialisti')
    expect(toolDi(contabile)).toContain('conferma_bozza_fic')
  })

  it("la posta NON e' nel perimetro della contabile", async () => {
    // «Ne il coordinatore, ne la segretaria spedisce MAI una fattura, quello lo
    // faccio solo io!» — Raffaele, 13 set 2026.
    await delega(contabile, { compito: 'x' }, 'prompt')
    const [, , , perimetro] = mockRunAgentTurn.mock.calls[0]
    expect(perimetro.toolConsentiti.has('send_email')).toBe(false)
  })

  it("l'incarico NON viene scritto nella cronologia dell'Ingegnere", async () => {
    // E' un messaggio fra due macchine. Scriverlo riempirebbe la conversazione
    // di monologhi interni, e la memoria semantica se li ritroverebbe come se
    // fossero conoscenza — difetto gia' visto: i drive_file_id veri legati a un
    // messaggio di scusa, e per 24 ore il bot «sapeva» di aver estratto quello.
    await delega(contabile, { compito: 'x' }, 'prompt')
    const [, , policy] = mockRunAgentTurn.mock.calls[0]
    expect(policy.persistUserMessage).toBe(false)
  })
})

describe('⭐ IL QUINTO CRITERIO — il cammino del fallimento', () => {
  it('un turno TRONCATO torna ok:false, e cosa_ho_provato NON e vuoto', async () => {
    mockRunAgentTurn.mockResolvedValue({
      ...turnoBase,
      testo: 'Ho guardato le prime tre fatture e',
      troncato: true,
      outcome: 'run_aborted',
      tool_chiamati: ['fic_fatture_ricevute', 'fic_leggi_allegato_fattura'],
    })
    const esito = await delega(contabile, { compito: 'x' }, 'prompt')
    expect(esito.ok).toBe(false)
    if (esito.ok) throw new Error('irraggiungibile')
    expect(esito.cosa_ho_provato).toEqual(['fic_fatture_ricevute', 'fic_leggi_allegato_fattura'])
    expect(esito.motivo).toMatch(/fermata a met/i)
  })

  it("⚠️ il testo parziale NON diventa una risposta: e' il difetto peggiore che questo progetto conosce", async () => {
    // Senza questo, il coordinatore riceverebbe «Ho guardato le prime tre
    // fatture e» e lo riporterebbe all'Ingegnere come se fosse l'esito.
    mockRunAgentTurn.mockResolvedValue({
      ...turnoBase,
      testo: 'Ho guardato le prime tre fatture e',
      troncato: true,
      outcome: 'run_aborted',
    })
    const esito = await delega(contabile, { compito: 'x' }, 'prompt')
    expect(esito).not.toHaveProperty('risposta')
  })

  it("🚨 troncato:true CON outcome 'success' — il caso che sembra riuscito e non lo è", async () => {
    // ⚠️ Questo test nasce da una MUTAZIONE SOPRAVVISSUTA, 13 set 2026.
    // Disattivando il controllo su `troncato` restavano tutti verdi, perche'
    // ogni caso di troncamento che avevo scritto portava ANCHE un outcome
    // sbagliato: era il secondo controllo a salvarli, non il primo.
    //
    // La combinazione qui sotto e' reale e nasce dal motore: quando il ciclo
    // esaurisce i 10 giri col modello che scrive testo a ogni giro e chiede
    // ancora tool, l'outcome resta 'success' — perche' il modello non ha
    // sbagliato niente — ma il lavoro e' tagliato a meta'.
    //
    // E' il caso PIU' pericoloso di tutti: il testo e' scorrevole, l'esito e'
    // pulito, e il lavoro non e' finito. Senza il controllo su `troncato`, il
    // coordinatore lo riporterebbe all'Ingegnere come risposta.
    mockRunAgentTurn.mockResolvedValue({
      testo: 'Ho controllato le fatture 2/1144, 2/1145 e 2/1146. Procedo con le altre.',
      outcome: 'success',
      troncato: true,
      iterazioni: 10,
      tool_chiamati: ['fic_fatture_ricevute', 'fic_leggi_allegato_fattura'],
    })
    const esito = await delega(contabile, { compito: 'x' }, 'prompt')
    expect(esito.ok).toBe(false)
    if (esito.ok) throw new Error('irraggiungibile')
    expect(esito.cosa_ho_provato.length).toBeGreaterThan(0)
  })

  it('un turno ALLUCINATO avvisa di NON fidarsi del testo', async () => {
    mockRunAgentTurn.mockResolvedValue({ ...turnoBase, outcome: 'hallucination' })
    const esito = await delega(contabile, { compito: 'x' }, 'prompt')
    expect(esito.ok).toBe(false)
    if (esito.ok) throw new Error('irraggiungibile')
    expect(esito.motivo).toMatch(/NON fidarti/i)
  })

  it("un turno 'success' ma MUTO non e' una risposta", async () => {
    // Il motore classifica il TURNO. Un turno tecnicamente riuscito che non
    // scrive niente non e' un esito, e il coordinatore riferirebbe il vuoto.
    mockRunAgentTurn.mockResolvedValue({ ...turnoBase, testo: '   ' })
    const esito = await delega(contabile, { compito: 'x' }, 'prompt')
    expect(esito.ok).toBe(false)
  })

  it('⭐ se lo specialista NON RISPONDE AFFATTO, la delega torna lo stesso', async () => {
    // §5.4 del disegno: un reject salterebbe il tipo di ritorno e risalirebbe
    // al turno del coordinatore, dove diventa «il bot e' rotto».
    mockRunAgentTurn.mockRejectedValue(new Error('function timeout'))
    const esito = await delega(contabile, { compito: 'x' }, 'prompt')
    expect(esito.ok).toBe(false)
    if (esito.ok) throw new Error('irraggiungibile')
    expect(esito.motivo).toMatch(/non ha risposto/i)
    // Vuoto ED E' LA VERITA': il turno non e' tornato, non sappiamo cosa abbia
    // eseguito. Riempirlo con un'ipotesi sarebbe la bugia che questo file
    // esiste per impedire.
    expect(esito.cosa_ho_provato).toEqual([])
  })

  it('CONTROLLO POSITIVO — la delega non rilancia MAI', async () => {
    mockRunAgentTurn.mockRejectedValue(new Error('boom'))
    await expect(delega(contabile, { compito: 'x' }, 'prompt')).resolves.toBeDefined()
  })
})

describe("l'esito si legge dal MOTORE, mai dal testo del modello", () => {
  it("un modello che si dichiara riuscito mentre il turno e' troncato NON passa", () => {
    // L'autoaccusa al contrario: il 12 set 2026 ho creduto a un modello che si
    // accusava. Credere a un modello che si assolve e' lo stesso errore.
    const esito = leggiEsito(
      {
        testo: 'Fatto tutto, tutto a posto, nessun problema.',
        outcome: 'run_aborted',
        troncato: true,
        iterazioni: 10,
        tool_chiamati: ['fic_fatture_ricevute'],
      },
      'la contabile',
    )
    expect(esito.ok).toBe(false)
  })

  it("un modello che si scusa mentre il turno e' riuscito passa lo stesso", () => {
    // E il verso opposto, che conta uguale: il testo non decide, ne' in bene
    // ne' in male.
    const esito = leggiEsito(
      {
        testo: 'Mi scuso, non sono sicuro di aver fatto bene.',
        outcome: 'success',
        troncato: false,
        iterazioni: 2,
        tool_chiamati: ['fic_fatture_ricevute'],
      },
      'la contabile',
    )
    expect(esito.ok).toBe(true)
  })

  it('azioni_fatte viene da tool_chiamati, non dal racconto', () => {
    const esito = leggiEsito(
      {
        testo: 'Ho aperto tutte le fatture e mandato la mail di riepilogo.',
        outcome: 'success',
        troncato: false,
        iterazioni: 2,
        tool_chiamati: ['fic_fatture_ricevute'],
      },
      'la contabile',
    )
    expect(esito.ok).toBe(true)
    if (!esito.ok) throw new Error('irraggiungibile')
    // Il modello dice di aver mandato una mail. Non l'ha fatto, e non poteva:
    // la posta non e' nel suo perimetro.
    expect(esito.azioni_fatte).toEqual(['fic_fatture_ricevute'])
  })
})
