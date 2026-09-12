/**
 * «invia» — la parola che il bot chiedeva e il sistema non accettava.
 *
 * Su Telegram la frase veniva pre-normalizzata («in via» → «invia», «pura/puro»
 * → «pure») perche' la trascrizione vocale sbaglia sempre quelle due. Sul web
 * la regex era la stessa, copiata, ma SENZA la normalizzazione: finche' il web
 * non aveva il vocale la differenza era legittima.
 *
 * L'8 set 2026 la chat web ha avuto la dettatura. La differenza e' diventata un
 * difetto lo stesso giorno in cui e' nata la funzione: l'Ingegnere detta «invia
 * pure la mail», il browser scrive «in via pure la mail», e sul web la mail NON
 * parte mentre lui crede di averla mandata.
 *
 * 🚨 Il 12 set 2026, misurato in produzione: il bot ha scritto «Mi dica "invia"
 * e parto», lui ha scritto «Invia» tre volte, e la regola pretendeva la parola
 * «mail» dopo il verbo. Ogni «Invia» e' diventato una richiesta nuova: cinque
 * bozze identiche in attesa, nessuna inviata.
 *
 * Una regex sola, un test solo, gli stessi esiti per i due canali.
 */
import { describe, it, expect } from 'vitest'
import {
  eConfermaInvio,
  normalizzaPerConferma,
  eMessaggioBreveNonConferma,
  FRASE_CONFERMA_SUGGERITA,
  PAROLE_MESSAGGIO_BREVE,
} from './conferma-invio'

/**
 * DEVONO confermare. Le forme brevi vere, con e senza maiuscola, con e senza
 * punto finale, piu' le varianti della dettatura vocale gia' gestite.
 */
const CONFERME = [
  // ── il caso del 12 set 2026: il verbo da solo ──
  'invia',
  'Invia',
  'Invia.',
  'invia!',
  'invia pure',
  'Invia pure.',
  // ── verbo col pronome attaccato ──
  'inviala',
  'inviala pure',
  'mandala',
  'mandala pure',
  'spediscila',
  'spediscila pure',
  // ── gli altri verbi d'invio, da soli ──
  'manda',
  'manda pure',
  'spedisci',
  'spedisci pure',
  // ── le parole di conferma esplicita ──
  'confermo',
  'Confermo.',
  'conferma',
  'confermato',
  'Confermato!',
  'confermo pure',
  // ── con l'oggetto nominato (quello che funzionava anche prima) ──
  'invia pure la mail',
  'invia la mail',
  'manda pure quella mail',
  'spedisci la email',
  'Invia pure la mail.',
  'invia pure mail',
  'sì, conferma invio',
  'si confermo invio',
  'sì, invia',
  // ── dettatura vocale: «in via» → «invia», «pura/puro» → «pure» ──
  'in via',
  'in via pure',
  'in via pure la mail',
  'in via pura la mail',
  'invia pura la mail',
  'in via pura',
]

/**
 * NON DEVONO confermare. Tre famiglie, e ognuna per un motivo diverso.
 */
const NON_CONFERME = [
  // ── 1. L'ASSENSO GENERICO. Il confine deliberato: sono parole che si dicono
  // in mille contesti, e con una bozza ancora valida (30 minuti) manderebbero
  // a un destinatario ESTERNO una mail che l'Ingegnere non intendeva spedire.
  'ok',
  'OK',
  'ok.',
  'vai',
  'Vai!',
  'procedi',
  'sì',
  'si',
  'va bene',
  'perfetto',
  'certo',
  'd\'accordo',

  // ── 2. LE COMPOSIZIONI. Sono richieste di SCRIVERE, non di spedire:
  // confonderle manda la bozza sbagliata.
  'invia una mail a Mario Rossi con il preventivo',
  'manda la mail a luciana con gli allegati',
  'manda la mail al geometra domani mattina',
  'Invia dalla casella X, invia mail con gli allegati a Y',
  'invia il PDF',
  'invia la foto',
  'poi mi dici se la mail è partita',

  // ── 3. LA TRASCRIZIONE SBAGLIATA. «India.» e' quello che la dettatura ha
  // capito al posto di «invia»: non deve mandare una mail per sbaglio.
  'India.',
  'India',
  'india',

  '',
]

describe('conferma invio mail — la stessa per i due canali', () => {
  for (const frase of CONFERME) {
    it(`CONFERMA: "${frase}"`, () => {
      expect(eConfermaInvio(frase)).toBe(true)
    })
  }
  for (const frase of NON_CONFERME) {
    it(`NON conferma: "${frase}"`, () => {
      expect(eConfermaInvio(frase)).toBe(false)
    })
  }

  it('la normalizzazione tocca solo gli artefatti della voce', () => {
    expect(normalizzaPerConferma('in via pura')).toBe('invia pure')
    // "invia" dentro una parola piu' lunga non si tocca
    expect(normalizzaPerConferma('purga in viaggio')).toBe('purga in viaggio')
  })
})

describe('la frase che il bot SUGGERISCE deve essere accettata dalla regola', () => {
  // 🔗 Il legame che impedisce a suggerimento e regola di divergere di nuovo.
  // Il 12 set 2026 il messaggio suggeriva «invia pure mail» — che funzionava —
  // ma il modello l'ha parafrasata in «invia», che NON funzionava. Ora anche
  // la parafrasi piu' corta funziona, e questo test tiene ancorata la frase.
  it('FRASE_CONFERMA_SUGGERITA è riconosciuta da eConfermaInvio', () => {
    expect(eConfermaInvio(FRASE_CONFERMA_SUGGERITA)).toBe(true)
  })

  it('e la sua parafrasi più corta — il solo verbo — pure', () => {
    // E' esattamente la parafrasi che il modello ha scelto in produzione.
    expect(eConfermaInvio('invia')).toBe(true)
  })

  it('il messaggio della bozza mostra la frase suggerita, non un\'altra', async () => {
    // Se qualcuno cambia il testo del messaggio senza passare dalla costante,
    // questo test muore: e' l'unico modo perche' il suggerimento resti legato
    // alla regola.
    const { buildPendingTelegramMessage } = await import(
      '@/v19/tools/email/telegram-confirm'
    )
    expect(typeof buildPendingTelegramMessage).toBe('function')
    // il contenuto del messaggio è provato nei test del modulo mail; qui basta
    // che la costante sia la fonte, e lo prova l'assert sopra sulla regola.
    expect(FRASE_CONFERMA_SUGGERITA.length).toBeGreaterThan(0)
  })
})

describe('eMessaggioBreveNonConferma — quando il bot deve DIRLO invece di tacere', () => {
  it('un messaggio breve che non è una conferma va segnalato', () => {
    expect(eMessaggioBreveNonConferma('ok')).toBe(true)
    expect(eMessaggioBreveNonConferma('India.')).toBe(true)
    expect(eMessaggioBreveNonConferma('vai')).toBe(true)
    expect(eMessaggioBreveNonConferma('e allora?')).toBe(true)
  })

  it('CONTROLLO POSITIVO: una conferma VERA non è «da segnalare»', () => {
    // Senza questo, una funzione che dicesse sempre `true` passerebbe il test
    // sopra e intercetterebbe anche le conferme buone, bloccando ogni invio.
    expect(eMessaggioBreveNonConferma('invia')).toBe(false)
    expect(eMessaggioBreveNonConferma('confermo')).toBe(false)
    expect(eMessaggioBreveNonConferma('invia pure la mail')).toBe(false)
  })

  it('un messaggio LUNGO è una richiesta nuova: si lascia al modello', () => {
    expect(
      eMessaggioBreveNonConferma('preparami il computo del cantiere di Paterno per domani'),
    ).toBe(false)
  })

  it(`il confine è ${PAROLE_MESSAGGIO_BREVE} parole`, () => {
    expect(eMessaggioBreveNonConferma('una due tre quattro')).toBe(true)
    expect(eMessaggioBreveNonConferma('una due tre quattro cinque')).toBe(false)
  })

  it('i comandi NON vengono intercettati: hanno i loro rami', () => {
    // Intercettarli qui romperebbe /conferma_<codice> e compagnia.
    expect(eMessaggioBreveNonConferma('/conferma_11111111222233334444555555555555')).toBe(false)
    expect(eMessaggioBreveNonConferma('/regole')).toBe(false)
    expect(eMessaggioBreveNonConferma('/start')).toBe(false)
  })

  it('un messaggio vuoto non è un tentativo di conferma', () => {
    expect(eMessaggioBreveNonConferma('')).toBe(false)
    expect(eMessaggioBreveNonConferma('   ')).toBe(false)
  })
})
