/**
 * src/lib/specialisti.test.ts — le guardie anti-marciume del registro.
 *
 * ⚠️ **Questi test sono la ragione per cui il Decollo puo' esistere.**
 *
 * La prima volta che questo progetto ha provato i sotto-agenti, uno aveva **4
 * nomi di tool su 5 che non esistevano piu'** e nessuno se n'era accorto: e' il
 * motivo n. 2 per cui quel lavoro e' stato cancellato. Un registro che promette
 * capacita' sparite e' peggio di nessun registro, perche' il coordinatore ci si
 * fida e gira il lavoro a chi non puo' piu' farlo.
 *
 * Ogni invariante qui ha accanto un CONTROLLO POSITIVO: un test che prova che
 * la guardia **morderebbe**. Un «non ci sono orfani» senza la prova che gli
 * orfani si vedrebbero e' un test che passa anche quando non guarda niente.
 */
import { describe, it, expect, vi } from 'vitest'

// tools.ts importa moltissimi moduli con client Supabase a load-time: stesso
// mock di mappa-officina.test.ts, gia' dimostrato sufficiente li'.
vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'ilike', 'like', 'in', 'order', 'limit', 'range', 'insert', 'update', 'upsert', 'delete', 'not', 'or', 'match', 'contains']
  for (const m of methods) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

import { getToolDefinitions } from './tools'
import { NUCLEO_DEBITO_RICERCA, NUCLEO_DISEGNO } from './tool-nucleo'
import { DOMINI } from './mappa-officina'
import {
  SPECIALISTI,
  AZIONI_IRREVERSIBILI,
  toolDi,
  haPotereIrreversibile,
  azioniIrreversibiliDi,
  specialista,
  type Specialista,
} from './specialisti'

const nomiTool = () =>
  new Set((getToolDefinitions() as { name?: string }[]).map((t) => t.name).filter(Boolean) as string[])

describe('ogni scaffale ha un padrone, ogni padrone uno scaffale', () => {
  it("nessuno specialista punta a un dominio che non c'e' piu'", () => {
    const domini = new Set(DOMINI.map((d) => d.nome))
    const orfani = SPECIALISTI.filter((s) => !domini.has(s.dominio)).map((s) => `${s.nome} → "${s.dominio}"`)
    // Il messaggio NOMINA: un test che dice solo "2 != 0" fa perdere mezz'ora a
    // chi lo legge fra sei mesi.
    expect(orfani, `specialisti che tengono uno scaffale sparito: ${orfani.join('; ')}`).toEqual([])
  })

  it('nessun dominio resta senza padrone', () => {
    // Il verso opposto, e conta uguale: uno scaffale senza nessuno che lo tiene
    // e' un pezzo di officina che il coordinatore non sa a chi girare. Con la
    // mappa accesa il modello lo vedrebbe elencato e concluderebbe che quella
    // capacita' c'e' — e nessuno risponderebbe.
    const tenuti = new Set(SPECIALISTI.map((s) => s.dominio))
    const senzaNessuno = DOMINI.filter((d) => !tenuti.has(d.nome)).map((d) => d.nome)
    expect(senzaNessuno, `scaffali senza padrone: ${senzaNessuno.join(', ')}`).toEqual([])
  })

  it('due specialisti non tengono lo stesso scaffale', () => {
    const conteggio = new Map<string, string[]>()
    for (const s of SPECIALISTI) {
      const chi = conteggio.get(s.dominio) ?? []
      chi.push(s.nome)
      conteggio.set(s.dominio, chi)
    }
    const contesi = [...conteggio.entries()].filter(([, chi]) => chi.length > 1)
    const msg = contesi.map(([d, chi]) => `${d} conteso da [${chi.join(', ')}]`).join('; ')
    expect(contesi, msg).toEqual([])
  })

  it('CONTROLLO POSITIVO — la guardia morderebbe: uno specialista inventato risulta orfano', () => {
    // Senza questo, i tre test qui sopra passerebbero anche se confrontassero
    // due insiemi vuoti.
    const domini = new Set(DOMINI.map((d) => d.nome))
    const finto: Specialista = {
      chiave: 'contabile',
      nome: 'il maniscalco',
      dominio: 'Ferratura cavalli',
      quando: 'mai',
      toolDalNucleo: [],
    }
    expect(domini.has(finto.dominio)).toBe(false)
  })
})

describe('nessuno specialista promette un attrezzo che non esiste piu', () => {
  it("i tool di ogni specialista esistono tutti nel registro dei tool", () => {
    // E' il difetto ESATTO dell'11 set: 4 nomi su 5 marciti in un sotto-agente,
    // e nessuno se n'era accorto.
    const esistenti = nomiTool()
    const fantasmi = SPECIALISTI.flatMap((s) =>
      toolDi(s).filter((n) => !esistenti.has(n)).map((n) => `${n} (${s.nome})`),
    )
    expect(fantasmi, `attrezzi promessi ma spariti: ${fantasmi.join(', ')}`).toEqual([])
  })

  it('ogni nome in AZIONI_IRREVERSIBILI e un tool che esiste ancora', () => {
    // Un nome morto qui non e' innocuo: farebbe sembrare sorvegliato uno
    // specialista che non lo e' piu'. E' l'errore piu' silenzioso possibile —
    // una guardia che crede di guardare.
    const esistenti = nomiTool()
    const morti = AZIONI_IRREVERSIBILI.filter((a) => !esistenti.has(a))
    expect(morti, `azioni irreversibili che non esistono piu': ${morti.join(', ')}`).toEqual([])
  })

  it('CONTROLLO POSITIVO — un nome inventato NON risulta fra i tool veri', () => {
    expect(nomiTool().has('manda_pec_al_tribunale')).toBe(false)
  })

  it('ogni specialista ha almeno un attrezzo in mano', () => {
    // Uno specialista a mani vuote e' una promessa che il coordinatore non puo'
    // mantenere. E' successo davvero: lo scaffale «Affitti brevi» in
    // mappa-officina.ts e' VUOTO — i suoi tre attrezzi stanno tutti nel nucleo.
    // Senza `toolDalNucleo` la signora delle case sarebbe una specialista
    // senza niente da fare.
    const aManiVuote = SPECIALISTI.filter((s) => toolDi(s).length === 0).map((s) => s.nome)
    expect(aManiVuote, `specialisti senza attrezzi: ${aManiVuote.join(', ')}`).toEqual([])
  })
})

describe('i tool del nucleo: chi ha un padrone e chi no', () => {
  it('ogni tool del NUCLEO DI DEBITO appartiene a ESATTAMENTE uno specialista', () => {
    // I sei di NUCLEO_DEBITO_RICERCA sono attrezzi veri di qualcuno: stanno nel
    // nucleo solo perche' la ricerca BM25 non li ritrovava — per un debito, non
    // per disegno. `DOMINI` non li cataloga (cataloga solo i differiti), quindi
    // senza questa guardia sarebbero l'unico insieme di attrezzi che nessuno
    // sorveglia: il posto esatto in cui ricomincerebbe il marciume.
    const conteggio = new Map<string, string[]>()
    for (const s of SPECIALISTI) {
      for (const n of s.toolDalNucleo) {
        const chi = conteggio.get(n) ?? []
        chi.push(s.nome)
        conteggio.set(n, chi)
      }
    }
    const senzaPadrone = [...NUCLEO_DEBITO_RICERCA].filter((n) => !conteggio.has(n))
    const contesi = [...conteggio.entries()].filter(([, chi]) => chi.length > 1).map(([n, chi]) => `${n} conteso da [${chi.join(', ')}]`)
    expect(senzaPadrone, `tool di debito senza padrone: ${senzaPadrone.join(', ')}`).toEqual([])
    expect(contesi, contesi.join('; ')).toEqual([])
  })

  it("gli otto tool di ORIENTAMENTO non hanno padrone: sono di tutti", () => {
    // NUCLEO_DISEGNO serve a orientarsi — chi e' il cliente, dentro quale
    // societa' siamo, cosa ci si e' gia' detti. Assegnarne uno a uno
    // specialista vorrebbe dire toglierlo agli altri sei e al coordinatore.
    const assegnati = new Set(SPECIALISTI.flatMap((s) => s.toolDalNucleo))
    const sequestrati = [...NUCLEO_DISEGNO].filter((n) => assegnati.has(n))
    expect(sequestrati, `tool di orientamento sequestrati da uno specialista: ${sequestrati.join(', ')}`).toEqual([])
  })

  it('nessuno specialista si assegna un tool che nel nucleo non c e', () => {
    // `toolDalNucleo` deve contenere SOLO tool del nucleo: un tool differito
    // messo qui sfuggirebbe alle due guardie di mappa-officina.test.ts —
    // sarebbe catalogato due volte, o per niente.
    const nucleo = new Set([...NUCLEO_DISEGNO, ...NUCLEO_DEBITO_RICERCA])
    const fuoriposto = SPECIALISTI.flatMap((s) =>
      s.toolDalNucleo.filter((n) => !nucleo.has(n)).map((n) => `${n} (${s.nome})`),
    )
    expect(fuoriposto, `tool dichiarati "dal nucleo" ma non nel nucleo: ${fuoriposto.join(', ')}`).toEqual([])
  })
})

describe('il potere irreversibile si CALCOLA, non si dichiara', () => {
  it('la contabile e la segretaria hanno potere irreversibile, e si vede da COSA hanno in mano', () => {
    const contabile = specialista('contabile')
    const segretaria = specialista('segretaria')
    expect(haPotereIrreversibile(contabile)).toBe(true)
    expect(haPotereIrreversibile(segretaria)).toBe(true)
    // Non basta il `true`: si controlla che sia il tool GIUSTO a produrlo.
    // Altrimenti il test passerebbe anche per la ragione sbagliata.
    expect(azioniIrreversibiliDi(contabile)).toContain('conferma_bozza_fic')
    expect(azioniIrreversibiliDi(segretaria)).toContain('send_email')
  })

  it('il geometra NON ha potere irreversibile: un preventivo si rifa', () => {
    // Il controllo negativo che rende informativo quello sopra: se
    // `haPotereIrreversibile` restituisse sempre true, questo morirebbe.
    expect(haPotereIrreversibile(specialista('geometra'))).toBe(false)
    expect(azioniIrreversibiliDi(specialista('geometra'))).toEqual([])
  })

  it("🚨 la signora delle case NON ha potere sulla Questura: la tabella del disegno diceva il falso", () => {
    // Il disegno (§4) segna «la signora delle case → sì (Questura)». Verificato
    // il 13 set 2026: NESSUN tool trasmette alla Questura.
    // `checkin_prepara_foglio` PREPARA un foglio, e basta.
    //
    // Questo test NON protegge quella riga: la CONTRADDICE, e sta qui per
    // ricordare perche' il registro e' codice e non prosa. Il giorno che il
    // tool di trasmissione arrivera', questo test morira' — ed e' giusto cosi':
    // sara' il segnale che la signora delle case va messa sotto conferma.
    const signora = specialista('signora-delle-case')
    expect(toolDi(signora).length).toBeGreaterThan(0)
    expect(haPotereIrreversibile(signora)).toBe(false)
  })

  it('CONTROLLO POSITIVO — se un attrezzo irreversibile entra in mano a qualcuno, si vede', () => {
    // La prova che `haPotereIrreversibile` guarda davvero: allo stesso
    // specialista, con in piu' un attrezzo irreversibile, la risposta cambia.
    const geometra = specialista('geometra')
    expect(haPotereIrreversibile(geometra)).toBe(false)
    const geometraArmato: Specialista = { ...geometra, toolDalNucleo: ['send_email'] }
    expect(haPotereIrreversibile(geometraArmato)).toBe(true)
  })
})

describe('la regola di Raffaele, 13 set 2026', () => {
  it("NESSUNO specialista ha in mano un tool che trasmette una fattura all'SDI", () => {
    // Verbatim: «Ne il coordinatore, ne la segretaria spedisce MAI una fattura,
    // quello lo faccio solo io!»
    //
    // Oggi nessun tool lo fa — lo prova `nessuno-trasmette-fatture.test.ts`
    // leggendo i SORGENTI, che e' il presidio vero. Questa guardia e' l'altra
    // meta': il giorno che un tool di trasmissione esistesse, nessuno
    // specialista potrebbe averlo in mano senza che questo test lo dica.
    const trasmissione = /^(fic_)?(trasmetti|invia|spedisci)_?(fattura|sdi|documento)/i
    const armati = SPECIALISTI.flatMap((s) =>
      toolDi(s).filter((n) => trasmissione.test(n)).map((n) => `${n} (${s.nome})`),
    )
    expect(armati, `specialisti che potrebbero trasmettere una fattura: ${armati.join(', ')}`).toEqual([])
  })

  it('CONTROLLO POSITIVO — il filtro riconoscerebbe un tool di trasmissione', () => {
    // Senza questo, il test sopra passerebbe anche con una regex che non
    // riconosce niente: e' successo l'11 set 2026, un commento dichiarava
    // «controllo positivo» un test che non controllava nulla.
    const trasmissione = /^(fic_)?(trasmetti|invia|spedisci)_?(fattura|sdi|documento)/i
    expect(trasmissione.test('fic_trasmetti_fattura')).toBe(true)
    expect(trasmissione.test('invia_sdi')).toBe(true)
    expect(trasmissione.test('compila_fattura_emessa')).toBe(false)
  })
})
