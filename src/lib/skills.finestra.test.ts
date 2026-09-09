/**
 * Una skill si attivava e spariva al turno dopo.
 *
 * `matchSkills` riceveva SOLO l'ultimo messaggio. L'Ingegnere chiede «quanto
 * devo versare di imposta di soggiorno»: la skill dei tributi si attiva e il
 * bot risponde con le regole giuste. Chiede «e a luglio?»: in quella frase non
 * c'e' nessuna parola chiave, la skill sparisce, e il bot risponde senza le
 * regole — con la stessa sicurezza di prima.
 *
 * Vale per TUTTE le skill, ed e' il difetto piu' insidioso perche' non si vede:
 * la risposta arriva lo stesso, solo peggiore.
 *
 * La cura ha un costo dichiarato: una skill resta viva qualche turno di piu' di
 * quanto servirebbe. E' il verso giusto in cui sbagliare — la domanda di
 * approfondimento e' proprio quella in cui le regole servono.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const skillFinte = [
  { id: '1', nome: 'Imposta di soggiorno', istruzioni: 'Esenti gli under 12.', keywords: ['imposta di soggiorno', 'tributi'] },
  { id: '2', nome: 'Ponteggi', istruzioni: 'Il PiMUS va sempre allegato.', keywords: ['ponteggio', 'pimus'] },
]

vi.mock('./supabase', () => ({
  supabase: { from: () => ({ select: async () => ({ data: skillFinte }) }) },
}))

import { matchSkills, invalidateSkillCache, FINESTRA_SKILL } from './skills'

beforeEach(() => { invalidateSkillCache() })

/** L'elenco va sempre dal messaggio PIU RECENTE al piu vecchio. */
describe('matchSkills — la skill non sparisce alla domanda dopo', () => {
  it('sul messaggio corrente si attiva, come prima', async () => {
    const testo = await matchSkills('quanto devo versare di imposta di soggiorno?')
    expect(testo).toContain('under 12')
  })

  it('resta viva sulla domanda di approfondimento, che la parola non ce l ha', async () => {
    const testo = await matchSkills(['e a luglio?', 'quanto devo versare di imposta di soggiorno?'])
    expect(testo).toContain('under 12')
  })

  // CONTROLLO POSITIVO: senza, una funzione che inietta SEMPRE tutte le skill
  // passerebbe i test qui sopra a mani basse.
  it('una conversazione che non le nomina non attiva niente', async () => {
    const testo = await matchSkills(['che tempo fa a Marsicovetere?', 'e domani?'])
    expect(testo).toBe('')
  })

  it('due skill nominate in turni diversi ci sono tutte e due', async () => {
    const testo = await matchSkills(['e per l imposta di soggiorno?', 'il ponteggio di via Roma'])
    expect(testo).toContain('PiMUS')
    expect(testo).toContain('under 12')
  })

  // La finestra e' limitata apposta: una skill non deve restare accesa per
  // tutta la conversazione. `maratea` in memoria e' segnato come ANTI-segnale
  // proprio perche' le attivazioni sbagliate costano.
  it('oltre la finestra la skill si spegne', async () => {
    // L'elenco e' dal piu' RECENTE al piu' vecchio: la frase che accendeva la
    // skill e' scivolata fuori dalla finestra.
    const recenti = Array.from({ length: FINESTRA_SKILL }, (_, i) => `messaggio numero ${i}`)
    const testo = await matchSkills([...recenti, 'quanto devo versare di imposta di soggiorno?'])
    expect(testo).toBe('')
  })

  // ⭐ Trovato dal mutation testing. Una riga di `cervellone_skills` con una
  // parola chiave vuota — un errore di battitura nel Config, o un campo
  // salvato a meta — si attiverebbe su OGNI messaggio: `"".includes("")` e
  // vero. La guardia `!skill.keywords?.length` copre l elenco vuoto, non la
  // stringa vuota dentro l elenco.
  it('una parola chiave vuota non attiva la skill su tutto', async () => {
    skillFinte.push({ id: '3', nome: 'Rotta', istruzioni: 'NON DEVE COMPARIRE', keywords: ['', '   '] })
    invalidateSkillCache()
    try {
      const testo = await matchSkills('che tempo fa domani?')
      expect(testo).not.toContain('NON DEVE COMPARIRE')
    } finally {
      skillFinte.pop()
      invalidateSkillCache()
    }
  })

  it('una lista vuota non attiva niente e non lancia', async () => {
    expect(await matchSkills([])).toBe('')
    expect(await matchSkills('')).toBe('')
  })
})
