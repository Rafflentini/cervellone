// src/lib/cron-auth.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rispostaSeFuoriDalCron, segretoCronValido } from './cron-auth'

/**
 * ⚠️ C43 — IL DIFETTO CHE QUESTI TEST CHIUDONO. Undici cron confrontavano
 * `auth !== \`Bearer ${process.env.CRON_SECRET}\`` SENZA verificare che il
 * segreto esistesse. Con `CRON_SECRET` non configurata quel confronto diventa
 * con la stringa `"Bearer undefined"` — che chiunque puo' scrivere a mano.
 *
 * Non e' sfruttabile oggi (i cron girano, quindi il segreto c'e'): e' un
 * deploy sbagliato di distanza. Ed e' la stessa famiglia del ripiego
 * silenzioso su client anonimo: **un guasto di configurazione che invece di
 * chiudere, apre**.
 */

/** Una richiesta come la vede la guardia: solo le intestazioni. */
function req(authorization?: string) {
  const intestazioni = new Map<string, string>()
  if (authorization !== undefined) intestazioni.set('authorization', authorization)
  return {
    headers: { get: (nome: string) => intestazioni.get(nome.toLowerCase()) ?? null },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

const SEGRETO_VERO = 'segreto-di-prova-del-cron'
let segretoDiPrima: string | undefined
let errori: ReturnType<typeof vi.spyOn>
let avvisi: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  segretoDiPrima = process.env.CRON_SECRET
  errori = vi.spyOn(console, 'error').mockImplementation(() => {})
  avvisi = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  if (segretoDiPrima === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = segretoDiPrima
  errori.mockRestore()
  avvisi.mockRestore()
})

describe('C43 — la porta dei cron: un segreto che manca CHIUDE, non apre', () => {
  it('🚨 senza CRON_SECRET, «Bearer undefined» NON apre', () => {
    delete process.env.CRON_SECRET

    expect(segretoCronValido(req('Bearer undefined'))).toBe(false)
    expect(rispostaSeFuoriDalCron(req('Bearer undefined'))?.status).toBe(401)
  })

  it('🚨 con CRON_SECRET vuota o fatta di spazi, non apre nessuna intestazione', () => {
    // Su Vercel una variabile «impostata a niente» esiste come stringa vuota:
    // senza il `trim`, `Bearer ` (con lo spazio) sarebbe la chiave di casa.
    process.env.CRON_SECRET = '   '

    expect(segretoCronValido(req('Bearer    '))).toBe(false)
    expect(segretoCronValido(req('Bearer '))).toBe(false)
    expect(segretoCronValido(req(''))).toBe(false)
  })

  it('senza CRON_SECRET non apre NEMMENO chi indovinasse la forma giusta', () => {
    delete process.env.CRON_SECRET

    for (const tentativo of ['Bearer', 'Bearer ', 'Bearer null', 'Bearer NaN', '']) {
      expect(segretoCronValido(req(tentativo))).toBe(false)
    }
  })

  it('col segreto configurato, un Bearer sbagliato resta fuori', () => {
    process.env.CRON_SECRET = SEGRETO_VERO

    expect(segretoCronValido(req('Bearer sbagliato'))).toBe(false)
    expect(segretoCronValido(req())).toBe(false)
    expect(rispostaSeFuoriDalCron(req('Bearer sbagliato'))?.status).toBe(401)
  })

  it('CONTROLLO POSITIVO: col segreto giusto la porta si apre', async () => {
    // Senza questo, tutti i test qui sopra resterebbero verdi anche con una
    // guardia che rifiuta SEMPRE — cioe' con i dodici cron spenti, e nessuno se
    // ne accorgerebbe fino alla mattina in cui otto operai non riescono a
    // timbrare.
    process.env.CRON_SECRET = SEGRETO_VERO

    expect(segretoCronValido(req(`Bearer ${SEGRETO_VERO}`))).toBe(true)
    expect(rispostaSeFuoriDalCron(req(`Bearer ${SEGRETO_VERO}`))).toBeNull()
  })

  it('🚨 un segreto che manca NON chiude in silenzio: lo scrive', () => {
    // Un guasto che chiude senza dirlo e' la forma esatta dei difetti che
    // questa casa si e' gia' presa (l'autodiagnosi mai consegnata, le fatture
    // estere a zero per quattro mesi). Il caso gemello in auth.ts lo scrive
    // gia': qui si allinea.
    delete process.env.CRON_SECRET

    segretoCronValido(req('Bearer qualunque'))

    expect(errori).toHaveBeenCalledTimes(1)
    expect(String(errori.mock.calls[0]?.[0])).toContain('CRON_SECRET')
  })

  it('un bearer soltanto SBAGLIATO non logga niente: quello e rumore', () => {
    // Un log che urla a ogni tentativo respinto non lo legge piu' nessuno, e
    // il giorno del guasto vero si perde in mezzo.
    process.env.CRON_SECRET = SEGRETO_VERO

    segretoCronValido(req('Bearer sbagliato'))

    expect(errori).not.toHaveBeenCalled()
    expect(avvisi).not.toHaveBeenCalled()
  })

  it('🚨 un CRON_SECRET con un a-capo in coda apre lo stesso, e AVVISA', () => {
    // Il difetto che il solo `trim()` di validazione non vedeva: la variabile
    // superava il controllo e poi non combaciava con NESSUNA intestazione —
    // undici cron a 401 per sempre, in silenzio. In questa casa e' successo
    // davvero: `TOOL_DEFER` e' valso `"1\n"` per giorni perche' scritta con
    // `echo` invece che con `printf`.
    process.env.CRON_SECRET = `${SEGRETO_VERO}\n`

    expect(segretoCronValido(req(`Bearer ${SEGRETO_VERO}`))).toBe(true)
    expect(avvisi).toHaveBeenCalledTimes(1)
    expect(String(avvisi.mock.calls[0]?.[0])).toContain('printf')
  })

  it('ripulire il segreto non lo indebolisce: resta fuori chi manda gli spazi', () => {
    process.env.CRON_SECRET = `  ${SEGRETO_VERO}  `

    expect(segretoCronValido(req(`Bearer   ${SEGRETO_VERO}  `))).toBe(false)
    expect(segretoCronValido(req(`Bearer ${SEGRETO_VERO}`))).toBe(true)
  })

  it('il rifiuto e un 401 col corpo che ciascuna rotta gia rispondeva', async () => {
    delete process.env.CRON_SECRET

    const predefinito = rispostaSeFuoriDalCron(req('Bearer undefined'))!
    expect(await predefinito.json()).toEqual({ ok: false, error: 'unauthorized' })

    const suo = rispostaSeFuoriDalCron(req('Bearer undefined'), { ok: false, errore: 'non autorizzato' })!
    expect(await suo.json()).toEqual({ ok: false, errore: 'non autorizzato' })
  })
})
