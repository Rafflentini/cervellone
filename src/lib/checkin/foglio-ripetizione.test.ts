/**
 * src/lib/checkin/foglio-ripetizione.test.ts
 *
 * I ritentativi sul foglio, e soprattutto QUANDO non si ritenta.
 *
 * La parte pericolosa non e' riprovare: e' riprovare un'operazione che era
 * gia' arrivata. Un `append` ripetuto scrive lo stesso ospite due volte — e
 * quell'ospite finisce due volte nel file per la Questura e due volte nel
 * conteggio dell'imposta di soggiorno.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { conRipetizione } from './foglio-google'

/** Un errore come lo confeziona la libreria di Google. */
function errore(stato: number) {
  return Object.assign(new Error('richiesta rifiutata'), { response: { status: stato } })
}

/** Un guasto di rete: non si sa se la richiesta sia arrivata. */
function reteCaduta(codice = 'ECONNRESET') {
  return Object.assign(new Error('connessione interrotta'), { code: codice })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * Esegue e fa scorrere le attese, che altrimenti bloccherebbero il test.
 *
 * L'esito si cattura SUBITO, prima di far correre i timer: attaccando il
 * gestore dopo, il rifiuto resta scoperto per un istante e vitest lo segnala
 * come errore non gestito. Il test passava lo stesso, ma sporcava l'output —
 * e un test che urla mentre passa insegna a non leggere piu' quello che dice.
 */
async function esegui<T>(p: Promise<T>): Promise<T> {
  const esito = p.then(
    (v) => ({ riuscito: true as const, v }),
    (e) => ({ riuscito: false as const, e }),
  )
  await vi.runAllTimersAsync()
  const r = await esito
  if (r.riuscito) return r.v
  throw r.e
}

describe('conRipetizione', () => {
  it('CONTROLLO POSITIVO: senza errori chiama UNA volta sola e restituisce il valore', async () => {
    // Senza questo, un test che conta i tentativi potrebbe passare per il
    // motivo sbagliato: perche' la funzione non viene mai chiamata.
    const fn = vi.fn().mockResolvedValue('fatto')
    await expect(esegui(conRipetizione('sempre', fn))).resolves.toBe('fatto')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('una 429 viene riprovata, e alla fine riesce', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(errore(429))
      .mockResolvedValue('fatto')
    await expect(esegui(conRipetizione('sempre', fn))).resolves.toBe('fatto')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('anche un append viene riprovato su 429: quel no vuol dire "respinta"', async () => {
    // 429 e 503 sono un rifiuto esplicito: la richiesta non e' stata
    // applicata, quindi ripeterla non duplica niente.
    const fn = vi.fn()
      .mockRejectedValueOnce(errore(429))
      .mockRejectedValueOnce(errore(503))
      .mockResolvedValue('fatto')
    await expect(esegui(conRipetizione('solo-rifiuti', fn))).resolves.toBe('fatto')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('⭐ un append NON viene riprovato se cade la rete: potrebbe essere arrivato', async () => {
    // E' la regola che protegge dagli ospiti duplicati. Meglio un errore
    // visibile a chi salva che una riga in piu' che nessuno nota.
    const fn = vi.fn().mockRejectedValue(reteCaduta())
    await expect(esegui(conRipetizione('solo-rifiuti', fn))).rejects.toThrow('connessione interrotta')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('una riscrittura invece si riprova anche se cade la rete: rifarla non fa danno', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(reteCaduta('ETIMEDOUT'))
      .mockResolvedValue('fatto')
    await expect(esegui(conRipetizione('sempre', fn))).resolves.toBe('fatto')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('un 400 non si riprova mai: la richiesta e sbagliata, non sfortunata', async () => {
    const fn = vi.fn().mockRejectedValue(errore(400))
    await expect(esegui(conRipetizione('sempre', fn))).rejects.toThrow('richiesta rifiutata')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('un 403 non si riprova: mancano i permessi, e riprovare non li fa comparire', async () => {
    const fn = vi.fn().mockRejectedValue(errore(403))
    await expect(esegui(conRipetizione('sempre', fn))).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('dopo tre tentativi si arrende e lascia passare l errore', async () => {
    // Non si riprova all'infinito: chi sta davanti allo schermo deve ricevere
    // una risposta, anche brutta.
    const fn = vi.fn().mockRejectedValue(errore(429))
    await expect(esegui(conRipetizione('sempre', fn))).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('riconosce lo stato anche quando Google lo mette altrove', async () => {
    // Le due forme che escono davvero dalla libreria.
    const soloStatus = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('x'), { status: 429 }))
      .mockResolvedValue('ok')
    await expect(esegui(conRipetizione('sempre', soloStatus))).resolves.toBe('ok')
    expect(soloStatus).toHaveBeenCalledTimes(2)
  })
})
