/**
 * «invia pure la mail» detto a voce.
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
 * Una regex sola, un test solo, gli stessi esiti per i due canali.
 */
import { describe, it, expect } from 'vitest'
import { eConfermaInvio, normalizzaPerConferma } from './conferma-invio'

const CONFERME = [
  'invia pure la mail',
  'in via pure la mail',      // trascrizione vocale
  'in via pura la mail',      // trascrizione vocale, genere sbagliato
  'invia pura la mail',
  'sì, conferma invio',
  'si confermo invio',
  'manda pure quella mail',
  'spedisci la email',
  'Invia pure la mail.',
]

const NON_CONFERME = [
  // Senza il nome della cosa non si sa COSA inviare: la mail, la foto, il PDF.
  // Confermare qui manderebbe la bozza sbagliata. Vale su tutti e due i canali.
  'inviala pure',
  'invia una mail a Mario Rossi con il preventivo',  // composizione, non conferma
  'manda la mail al geometra domani mattina',
  'invia il PDF',
  'poi mi dici se la mail è partita',
  '',
  'ok',
]

describe('conferma invio mail — la stessa per i due canali', () => {
  for (const frase of CONFERME) {
    it(`conferma: "${frase}"`, () => {
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
