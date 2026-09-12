import { describe, it, expect, vi } from 'vitest'

// Pilotiamo direttamente l'esito di leggiSocietaAttiva (Task 2): quel livello
// e' gia' coperto dai test di societa-attiva.test.ts contro un finto Supabase.
// Rifarlo qui vorrebbe dire testare due volte la stessa cosa, e nessuna volta
// questa: se chi genera un documento propaga davvero l'errore invece di
// indovinare Restruktura.
let esito: unknown

vi.mock('./societa-attiva', () => ({
  leggiSocietaAttiva: async () => esito,
}))

import { societaPerDocumento } from './societa-documenti'
import { getSocieta } from './societa'

const LAREALESTATE = getSocieta('larealestate')
const RESTRUKTURA = getSocieta('restruktura')

describe('societaPerDocumento', () => {
  it('societa scelta esplicitamente -> ok:true con esplicita:true', async () => {
    esito = { ok: true, codice: 'larealestate', esplicita: true }
    const r = await societaPerDocumento('conv-1')
    expect(r).toEqual({
      ok: true,
      societa: { denominazione: LAREALESTATE.denominazione, piva: LAREALESTATE.piva },
      esplicita: true,
    })
  })

  it('nessuna scelta -> ok:true Restruktura con esplicita:false', async () => {
    esito = { ok: true, codice: 'restruktura', esplicita: false }
    const r = await societaPerDocumento()
    expect(r).toEqual({
      ok: true,
      societa: { denominazione: RESTRUKTURA.denominazione, piva: RESTRUKTURA.piva },
      esplicita: false,
    })
  })

  // CONTROLLO POSITIVO: se il ramo d'errore rispondesse ok:true (per esempio
  // con la mutazione "in caso di dubbio, Restruktura"), questo test muore.
  it('leggiSocietaAttiva fallisce -> ok:false col messaggio dentro, NON Restruktura silenziosa', async () => {
    esito = { ok: false, errore: 'connessione a supabase persa' }
    const r = await societaPerDocumento('conv-1')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('non deve arrivare qui: il ramo di errore ha risposto ok:true')
    expect(r.errore).toContain('connessione a supabase persa')
  })

  // Caso non nel brief, autorizzato dal contesto del task: un codice che
  // leggiSocietaAttiva restituisse ma che il registro non conosce (per
  // esempio un valore scritto prima di un'estensione del registro, sfuggito
  // alla difesa che sta dentro leggiSocietaAttiva) non deve esplodere con un
  // TypeError su un `undefined.denominazione`.
  it('codice imprevisto nel registro -> ok:false leggibile, non un TypeError', async () => {
    esito = { ok: true, codice: 'fantasma', esplicita: true }
    const r = await societaPerDocumento('conv-1')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('non deve arrivare qui: un codice sconosciuto non puo dare ok:true')
    expect(typeof r.errore).toBe('string')
    expect(r.errore.length).toBeGreaterThan(0)
  })
})

// `societaAttivaPerDocumenti` — la funzione transitoria che questa suite
// testava qui sotto — e' stata RIMOSSA dal Task 5: i suoi chiamanti
// (tools.ts, document-template-tools.ts, e i due comandi /sal_ok2_ su
// Telegram e web) risolvono la societa' con `societaPerDocumento` e, su
// `ok:false`, non generano nulla invece di ereditare Restruktura in silenzio.
