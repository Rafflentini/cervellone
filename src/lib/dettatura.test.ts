import { describe, test, expect } from 'vitest'
import {
  decidiDopoRiconoscimento,
  componiTestoDettatura,
  MAX_REGISTRAZIONE_MS,
  MAX_RIAVVII_RAPIDI,
} from './dettatura'

const registrando = (msTrascorsi: number) => ({
  utenteVuoleRegistrare: true,
  msTrascorsi,
  eLaSessioneCorrente: true,
  riavviiRapidiConsecutivi: 0,
})

describe('decidiDopoRiconoscimento', () => {
  // IL DIFETTO (8 set 2026): il riconoscimento del browser chiude da solo dopo
  // qualche secondo di silenzio, e in page.tsx quel `onend` fermava anche il
  // MediaRecorder. Bastava una pausa per pensare e la dettatura finiva.
  test('una pausa di silenzio non ferma la dettatura: si riavvia', () => {
    expect(decidiDopoRiconoscimento({ tipo: 'fine' }, registrando(30_000), MAX_REGISTRAZIONE_MS))
      .toBe('riavvia')
  })

  // CONTROLLO POSITIVO. Senza questi, un `return 'riavvia'` secco passerebbe il
  // test qui sopra e lascerebbe il microfono aperto per sempre.
  test('se l Ingegnere ha premuto stop, si ferma', () => {
    expect(decidiDopoRiconoscimento(
      { tipo: 'fine' },
      { ...registrando(30_000), utenteVuoleRegistrare: false },
      MAX_REGISTRAZIONE_MS,
    )).toBe('ferma')
  })

  test('raggiunto il tetto di 5 minuti, si ferma', () => {
    expect(decidiDopoRiconoscimento({ tipo: 'fine' }, registrando(MAX_REGISTRAZIONE_MS), MAX_REGISTRAZIONE_MS))
      .toBe('ferma')
  })

  test.each(['not-allowed', 'audio-capture', 'service-not-allowed'])(
    'errore fatale del microfono (%s): si ferma, riavviare non servirebbe',
    (codice) => {
      expect(decidiDopoRiconoscimento({ tipo: 'errore', codice }, registrando(5_000), MAX_REGISTRAZIONE_MS))
        .toBe('ferma')
    },
  )

  // REGRESSIONE TROVATA DALL'AUDIT (8 set 2026), introdotta dalla cura stessa.
  // Doppio tap sul microfono: lo `onend` della sessione vecchia arriva DOPO che
  // ne e' gia' partita una nuova. Senza guardia riavviava se stessa, restando
  // irraggiungibile sia dallo stop sia dal tetto (che fermano solo
  // `recognitionRef.current`): due riconoscimenti vivi insieme, testo mescolato
  // nella casella e microfono acceso fino alla chiusura della scheda.
  test('lo onend di una sessione gia sostituita non tocca niente', () => {
    expect(decidiDopoRiconoscimento(
      { tipo: 'fine' },
      { ...registrando(3_000), eLaSessioneCorrente: false },
      MAX_REGISTRAZIONE_MS,
    )).toBe('ignora')
  })

  test('una sessione superata non ferma la dettatura appena iniziata', () => {
    // 'ignora' e non 'ferma': fermare spegnerebbe la registrazione NUOVA.
    expect(decidiDopoRiconoscimento(
      { tipo: 'errore', codice: 'aborted' },
      { ...registrando(3_000), eLaSessioneCorrente: false },
      MAX_REGISTRAZIONE_MS,
    )).not.toBe('ferma')
  })

  // Con la rete giu' Chrome emette 'network' SUBITO dopo ogni start, non dopo
  // secondi come 'no-speech': il ciclo girerebbe a vuoto a piena velocita' per
  // tutti e cinque i minuti del tetto, bruciando CPU e batteria.
  test('dopo troppi riavvii a vuoto si ferma invece di girare a vuoto', () => {
    expect(decidiDopoRiconoscimento(
      { tipo: 'errore', codice: 'network' },
      { ...registrando(2_000), riavviiRapidiConsecutivi: MAX_RIAVVII_RAPIDI },
      MAX_REGISTRAZIONE_MS,
    )).toBe('ferma')
  })

  test('qualche riavvio rapido isolato non ferma la dettatura', () => {
    expect(decidiDopoRiconoscimento(
      { tipo: 'errore', codice: 'network' },
      { ...registrando(2_000), riavviiRapidiConsecutivi: MAX_RIAVVII_RAPIDI - 1 },
      MAX_REGISTRAZIONE_MS,
    )).toBe('riavvia')
  })

  // 'no-speech' e 'aborted' li emette Chrome sul silenzio: sono la normalita'
  // di una dettatura con pause, non un guasto.
  test.each(['no-speech', 'aborted', 'network'])(
    'errore passeggero (%s): si riavvia',
    (codice) => {
      expect(decidiDopoRiconoscimento({ tipo: 'errore', codice }, registrando(5_000), MAX_REGISTRAZIONE_MS))
        .toBe('riavvia')
    },
  )
})

describe('componiTestoDettatura', () => {
  // Al riavvio del riconoscimento `event.results` riparte da zero: senza
  // accumulare, il testo gia' dettato prima della pausa sparirebbe dalla casella.
  test('il testo dettato prima della pausa non si perde dopo il riavvio', () => {
    const prima = componiTestoDettatura('', 'Ripristino frontalini ', 'di gronda')
    expect(prima).toBe('Ripristino frontalini di gronda')

    const fissato = 'Ripristino frontalini di gronda '
    expect(componiTestoDettatura(fissato, '', 'sul prospetto Est'))
      .toBe('Ripristino frontalini di gronda sul prospetto Est')
  })

  test('non lascia spazi doppi ne bordi', () => {
    expect(componiTestoDettatura('  Primo pezzo  ', '  secondo  ', '  terzo  '))
      .toBe('Primo pezzo secondo terzo')
  })
})

describe('l ordine delle guardie, che il docstring promette', () => {
  // "Per primo, prima di ogni altra cosa": la guardia di sessione deve venire
  // PRIMA del controllo sullo stop. L'audit sui test ha mostrato che
  // scambiarle lasciava tutto verde, perche' i due test sulla sessione
  // superata usavano entrambi `utenteVuoleRegistrare: true`.
  //
  // Il caso che distingue: evento di una sessione VECCHIA che arriva mentre lo
  // stop e' gia' stato premuto. Deve essere ignorato, non trattato come "ferma":
  // 'ferma' spegnerebbe una registrazione nuova appena avviata.
  test('sessione superata E stop premuto: si ignora, non si ferma', () => {
    expect(decidiDopoRiconoscimento(
      { tipo: 'fine' },
      { ...registrando(3_000), eLaSessioneCorrente: false, utenteVuoleRegistrare: false },
      MAX_REGISTRAZIONE_MS,
    )).toBe('ignora')
  })

  test('sessione superata e tetto superato: si ignora lo stesso', () => {
    expect(decidiDopoRiconoscimento(
      { tipo: 'fine' },
      { ...registrando(MAX_REGISTRAZIONE_MS + 1), eLaSessioneCorrente: false },
      MAX_REGISTRAZIONE_MS,
    )).toBe('ignora')
  })
})
