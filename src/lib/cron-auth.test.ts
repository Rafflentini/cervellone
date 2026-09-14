// src/lib/cron-auth.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

beforeEach(() => { segretoDiPrima = process.env.CRON_SECRET })
afterEach(() => {
  if (segretoDiPrima === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = segretoDiPrima
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

  it('il rifiuto e un 401 col corpo che ciascuna rotta gia rispondeva', async () => {
    delete process.env.CRON_SECRET

    const predefinito = rispostaSeFuoriDalCron(req('Bearer undefined'))!
    expect(await predefinito.json()).toEqual({ ok: false, error: 'unauthorized' })

    const suo = rispostaSeFuoriDalCron(req('Bearer undefined'), { ok: false, errore: 'non autorizzato' })!
    expect(await suo.json()).toEqual({ ok: false, errore: 'non autorizzato' })
  })
})
