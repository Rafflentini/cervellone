// src/v19/__tests__/email-pending-doppioni.spec.ts
/**
 * Niente bozze doppie.
 *
 * Il 12 set 2026 il bot ha chiesto «mi dica "invia" e parto». L'Ingegnere ha
 * scritto «Invia», e la regola della conferma pretendeva la parola «mail» dopo
 * il verbo: quindi il modello ha letto «Invia» come una RICHIESTA NUOVA e ha
 * preparato un'altra bozza. Poi un'altra. In
 * `cervellone_email_pending_send` sono finite CINQUE bozze identiche in attesa,
 * e nessuna inviata.
 *
 * Cinque bozze non sono solo disordine: fanno scattare la guardia
 * anti-ambiguità, che a quel punto rifiuta la conferma a parole e pretende il
 * codice — cioè proprio la cosa che dal telefono lui non riusciva a usare. Un
 * difetto che si mangia la cura dell'altro.
 *
 * La deduplica sta in `createPendingSend`, l'imbuto unico: `send_email`,
 * `send_email_with_attachments`, `forward_email` e `pack_emails_and_send`
 * passano tutti da `sendEmailInternal`, che la chiama in un punto solo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Riga = { uuid: string; expires_at: string; to_addrs: string[] }

const FRA_MEZZORA = new Date(Date.now() + 30 * 60_000).toISOString()

/** Registra cosa è stato chiesto al database, per poterlo verificare. */
const chiamate = {
  filtri: [] as Array<[string, unknown]>,
  inserite: [] as unknown[],
}

let esistenti: Riga[] = []
let erroreRicerca: { message: string } | null = null

function makeDbStub() {
  const b = {
    select: vi.fn(() => b),
    eq: vi.fn((col: string, val: unknown) => {
      chiamate.filtri.push([col, val])
      return b
    }),
    gt: vi.fn((col: string, val: unknown) => {
      chiamate.filtri.push([col, val])
      return b
    }),
    order: vi.fn(() => b),
    insert: vi.fn((row: unknown) => {
      chiamate.inserite.push(row)
      return {
        select: () => ({
          single: async () => ({
            data: { uuid: 'uuid-NUOVO', expires_at: FRA_MEZZORA },
            error: null,
          }),
        }),
      }
    }),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        resolve(
          erroreRicerca
            ? { data: null, error: erroreRicerca }
            : { data: esistenti, error: null },
        ),
      ),
  }
  return b
}

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: vi.fn(() => ({ from: () => makeDbStub() })),
}))

import { createPendingSend } from '../tools/email/pending'

const INPUT = {
  from_account: 'restruktura' as const,
  to: ['destinataria@esterno.it'],
  subject: 'Due contratti',
  body_text: 'in allegato i due contratti',
}

beforeEach(() => {
  chiamate.filtri = []
  chiamate.inserite = []
  esistenti = []
  erroreRicerca = null
})

describe('createPendingSend — una bozza identica si riusa, non si duplica', () => {
  it('CONTROLLO POSITIVO: senza doppioni la bozza viene creata davvero', () => {
    // Senza questo, i test sotto proverebbero solo che la funzione non crea
    // MAI niente.
    esistenti = []
    return createPendingSend(INPUT as never).then((r) => {
      expect(r.riusato).toBe(false)
      expect(r.uuid).toBe('uuid-NUOVO')
      expect(chiamate.inserite).toHaveLength(1)
    })
  })

  it('con una bozza identica in attesa la RIUSA e NON inserisce', async () => {
    esistenti = [
      { uuid: 'uuid-GIA-IN-ATTESA', expires_at: FRA_MEZZORA, to_addrs: ['destinataria@esterno.it'] },
    ]
    const r = await createPendingSend(INPUT as never)

    expect(r.riusato).toBe(true)
    expect(r.uuid).toBe('uuid-GIA-IN-ATTESA')
    // la prova che conta: nessuna riga nuova
    expect(chiamate.inserite).toHaveLength(0)
  })

  it('cerca il doppione coi filtri giusti: oggetto, stato pending, non scaduto', async () => {
    esistenti = []
    await createPendingSend(INPUT as never)

    expect(chiamate.filtri).toEqual(
      expect.arrayContaining([
        ['status', 'pending'],
        ['subject', 'Due contratti'],
        ['expires_at', expect.any(String)],
      ]),
    )
  })

  it('i destinatari si confrontano per INSIEME, non per ordine', async () => {
    // Il modello non garantisce l'ordine fra un tentativo e l'altro, e
    // [a, b] è la stessa mail di [b, a].
    esistenti = [
      {
        uuid: 'uuid-GEMELLO',
        expires_at: FRA_MEZZORA,
        to_addrs: ['seconda@esterno.it', 'PRIMA@Esterno.IT'],
      },
    ]
    const r = await createPendingSend({
      ...INPUT,
      to: ['prima@esterno.it', 'seconda@esterno.it'],
    } as never)

    expect(r.riusato).toBe(true)
    expect(r.uuid).toBe('uuid-GEMELLO')
  })

  it('destinatari DIVERSI non sono un doppione: la bozza nuova si crea', async () => {
    // Il confine che conta: se dedupplicassimo troppo, una mail destinata a
    // un'altra persona verrebbe silenziosamente sostituita da quella di prima.
    esistenti = [
      { uuid: 'uuid-ALTRO', expires_at: FRA_MEZZORA, to_addrs: ['qualcunaltro@esterno.it'] },
    ]
    const r = await createPendingSend(INPUT as never)

    expect(r.riusato).toBe(false)
    expect(r.uuid).toBe('uuid-NUOVO')
    expect(chiamate.inserite).toHaveLength(1)
  })

  it('un destinatario IN PIÙ non è un doppione', async () => {
    esistenti = [
      { uuid: 'uuid-PARZIALE', expires_at: FRA_MEZZORA, to_addrs: ['destinataria@esterno.it'] },
    ]
    const r = await createPendingSend({
      ...INPUT,
      to: ['destinataria@esterno.it', 'in-copia@esterno.it'],
    } as never)

    expect(r.riusato).toBe(false)
    expect(chiamate.inserite).toHaveLength(1)
  })

  it('se la ricerca dei doppioni FALLISCE, la bozza si crea comunque', async () => {
    // Direzione sicura: al peggio nasce un doppione (disordine). Il contrario
    // perderebbe una mail che l'Ingegnere ha chiesto di preparare. In nessuno
    // dei due casi viene spedito niente: qui si prepara soltanto.
    erroreRicerca = { message: 'connection refused' }
    const r = await createPendingSend(INPUT as never)

    expect(r.riusato).toBe(false)
    expect(chiamate.inserite).toHaveLength(1)
  })
})
