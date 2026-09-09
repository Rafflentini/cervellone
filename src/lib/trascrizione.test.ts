/**
 * Trascrizione dei vocali Telegram.
 *
 * Nasce da una sessione reale del 3 settembre 2026, in cui l'Ingegnere ha
 * parlato al bot e si e' ritrovato:
 * - "Mr. Laboda Luminico" al posto di "La Colla Domenico"
 * - "poteri di film" al posto di "poteri di firma"
 * - cinque messaggi ridotti a "🎙 Trascrizione: ... ... ... ... ..."
 *
 * L'ultimo e' il piu' insidioso: quei puntini venivano passati al modello COME
 * SE FOSSERO una richiesta dell'utente, e il bot rispondeva "il messaggio e'
 * arrivato spezzato, non capisco a quale cosa si riferisca". Non era confuso
 * lui: gli era stato detto "...".
 *
 * Nessuna rete: fetch e Supabase sono mockati.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const righeEntita: Array<{ name: string; type: string }> = []
// ⚠️ `order` in supabase-js e' CONCATENABILE: ritorna il builder, non un
// oggetto con il solo `limit`. Il mock precedente ne ammetteva una sola, e
// aggiungendo un secondo criterio di ordinamento faceva sparire tutti i nomi
// invece di segnalare l'errore — cioe' collaudava un'API che non esiste.
vi.mock('./supabase', () => {
  const builder: Record<string, unknown> = {}
  builder.select = () => builder
  builder.order = () => builder
  builder.limit = async () => ({ data: righeEntita, error: null })
  return { supabase: { from: () => builder } }
})

import { trascrizioneDegenere, costruisciVocabolario, LESSICO_TECNICO } from './trascrizione'

beforeEach(() => {
  righeEntita.length = 0
})

describe('trascrizioneDegenere — quello che Whisper produce sul silenzio', () => {
  it('riconosce i puntini, che sono il caso vero visto in produzione', () => {
    // "🎙 Trascrizione: ... ... ... ... ..." — cinque messaggi cosi' in una
    // sessione sola. Passarli al modello significa fargli interpretare il nulla.
    for (const t of ['...', '... ... ... ... ...', '. . .', '…', '……', '...!?']) {
      expect(trascrizioneDegenere(t), `"${t}"`).toBe(true)
    }
  })

  it('riconosce il vuoto e lo spazio bianco', () => {
    for (const t of ['', '   ', '\n\n', '\t']) {
      expect(trascrizioneDegenere(t), `"${t}"`).toBe(true)
    }
  })

  it('riconosce un frammento troppo corto per essere una richiesta', () => {
    // Un vocale premuto per sbaglio produce una o due sillabe.
    for (const t of ['eh', 'mm', 'ah']) {
      expect(trascrizioneDegenere(t), `"${t}"`).toBe(true)
    }
  })

  it('NON scarta un vocale breve ma vero', () => {
    // Il rischio opposto, e' quello che conta: se questa soglia mangia le frasi
    // brevi, l'Ingegnere non puo' piu' dire "sì", "procedi", "annulla tutto".
    for (const t of ['sì', 'no', 'procedi', 'annulla', 'va bene', 'ok manda']) {
      expect(trascrizioneDegenere(t), `"${t}"`).toBe(false)
    }
  })

  it('NON scarta una frase normale', () => {
    expect(trascrizioneDegenere('Preparami la lettera per il committente.')).toBe(false)
  })

  it('riconosce le frasi che il trascrittore INVENTA sul silenzio', () => {
    // Casi veri, dai vocali dell'Ingegnere del 3 settembre 2026. Whisper e'
    // addestrato su sottotitoli: quando non sente parlato produce le didascalie
    // di coda dei video. Sono frasi intere e grammaticali — nessun controllo di
    // lunghezza o di punteggiatura le prende.
    for (const t of [
      'Sottotitoli creati dalla comunità Amara.org',
      'Sottotitoli e revisione a cura di QTSS',
      // A questa il bot rispose "Grazie a Lei, Ingegnere": si e' congedato da
      // una conversazione che l'utente non aveva chiuso.
      "Grazie per l'attenzione",
      'Grazie per aver guardato il video',
      // Variante arrivata mezz'ora dopo la prima correzione: avevo elencato
      // "il video" e non "questo video", e questa e' passata. Da li' il pattern
      // generico su "grazie per aver guardato/visto/seguito ...".
      'Grazie per aver guardato questo video.',
      'Iscriviti al canale',
      'Subtitles by the Amara.org community',
      'Thanks for watching!',
    ]) {
      expect(trascrizioneDegenere(t), `"${t}"`).toBe(true)
    }
  })

  it('ma non butta un discorso vero che FINISCE con quelle parole', () => {
    // Il confronto e' sull'intera trascrizione. Se l'Ingegnere chiude davvero
    // un ragionamento con "grazie per l'attenzione", quel messaggio contiene
    // lavoro e non va scartato.
    const vero = 'Allora, per il cantiere di Paterno rimandiamo il sopralluogo a lunedì. Grazie per l\'attenzione.'
    expect(trascrizioneDegenere(vero)).toBe(false)
  })
})

describe('costruisciVocabolario — l orecchio impara i nomi che Cervellone gia conosce', () => {
  it('contiene sempre il lessico tecnico, anche senza entita a DB', async () => {
    const v = await costruisciVocabolario()

    for (const parola of LESSICO_TECNICO) expect(v).toContain(parola)
  })

  it('aggiunge i nomi propri veri: e la cura per "Laboda Luminico"', async () => {
    righeEntita.push(
      { name: 'La Colla Domenico', type: 'cliente' },
      { name: 'Casetta Margot', type: 'cantiere' },
      { name: 'Lloyd\'s', type: 'fornitore' },
    )

    const v = await costruisciVocabolario()

    expect(v).toContain('La Colla Domenico')
    expect(v).toContain('Casetta Margot')
    expect(v).toContain('Lloyd\'s')
  })

  it('non esplode se il DB non risponde: il vocabolario e un di piu, non un requisito', async () => {
    const { supabase } = await import('./supabase')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const originale = (supabase as any).from
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabase as any).from = () => { throw new Error('DB giu') }

    const v = await costruisciVocabolario()

    expect(v).toContain(LESSICO_TECNICO[0])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(supabase as any).from = originale
  })

  it('resta dentro il limite dei 224 token accettati dall API', async () => {
    // L'API tronca il prompt oltre quella soglia: se sfora, a cadere sono le
    // parole in fondo — cioe' i nomi propri, che sono il motivo per cui esiste.
    for (let i = 0; i < 200; i++) {
      righeEntita.push({ name: `Committente Numero ${i} Con Nome Lungo`, type: 'cliente' })
    }

    const v = await costruisciVocabolario()

    // Stima prudente: ~4 caratteri per token.
    expect(v.length).toBeLessThanOrEqual(224 * 4)
  })
})

/**
 * Misurato in produzione il 9 set 2026: `cervellone_entita_menzionate` ha 56
 * nomi, che occupano **1.047 caratteri contro un tetto di 896**.
 *
 * Conseguenze, nessuna delle quali si vede:
 * - il lessico tecnico NON arriva mai al trascrittore: sborda gia' prima;
 * - anche gli ultimi nomi si perdono, e quali si salvano lo decide l'ORDINE
 *   ALFABETICO — non l'importanza. Zaccagnino sparisce, Albini resta.
 *
 * ⭐ Il commento nel codice diceva la cosa giusta — «i nomi propri prima: se il
 * troncamento morde, deve mangiare le parole comuni» — ma nessuno aveva
 * misurato che il troncamento morde gia' DENTRO i nomi.
 *
 * ⭐ E il test che c'era prometteva «contiene SEMPRE il lessico tecnico»,
 * misurando pero' il solo caso a database vuoto: un «sempre» che collaudava
 * l'unica condizione in cui non poteva fallire.
 */
describe('il vocabolario regge anche coi nomi VERI, non solo col DB vuoto', () => {
  it('col numero di nomi che c e in produzione, il lessico tecnico c e ancora', async () => {
    // 56 nomi lunghi come quelli veri: e' lo scenario misurato in produzione.
    for (let i = 0; i < 56; i++) {
      righeEntita.push({ name: `Committente Numero ${String(i).padStart(2, '0')} S.r.l.`, type: 'cliente' })
    }

    const v = await costruisciVocabolario()

    for (const parola of LESSICO_TECNICO) expect(v).toContain(parola)
  })

  it('quando lo spazio non basta si perdono i nomi in FONDO, non il lessico', async () => {
    for (let i = 0; i < 56; i++) {
      righeEntita.push({ name: `Committente Numero ${String(i).padStart(2, '0')} S.r.l.`, type: 'cliente' })
    }

    const v = await costruisciVocabolario()

    // Il primo nome che il chiamante ha messo in cima sopravvive sempre:
    // l'ordine lo decide chi interroga il database, non l'alfabeto.
    expect(v).toContain('Committente Numero 00 S.r.l.')
    expect(v.length).toBeLessThanOrEqual(224 * 4)
  })

  it('CONTROLLO POSITIVO: con pochi nomi non si perde niente', async () => {
    // Senza questo, i test sopra passerebbero anche con un codice che scarta
    // sempre tutti i nomi e tiene solo il lessico.
    righeEntita.push({ name: 'La Colla Domenico', type: 'cliente' })
    righeEntita.push({ name: 'Cond. San Biagio', type: 'cantiere' })

    const v = await costruisciVocabolario()

    expect(v).toContain('La Colla Domenico')
    expect(v).toContain('Cond. San Biagio')
    for (const parola of LESSICO_TECNICO) expect(v).toContain(parola)
  })
})
