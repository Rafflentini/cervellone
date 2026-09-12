/**
 * src/lib/comandi-uuid.fic.test.ts — i comandi di conferma FIC diventano toccabili.
 *
 * Segnalazione di Raffaele, 12 set 2026, la STESSA giornata in cui il difetto
 * gemello (trattini + lunghezza) era stato chiuso per tutte le altre famiglie:
 * i codici `/fic_ok_<uuid>` e `/fic_no_<uuid>` restavano scritti a mano in
 * `fic-write-tools.ts`, con l'uuid INTERO e i trattini — 39 caratteri, oltre
 * il limite di 32 di Telegram, e comunque troncati al primo `-`. Il commento a
 * `comandi-risolvi.ts:88` DICHIARAVA la lacuna («famiglia non risolvibile»):
 * non ignoranza, una lacuna nota e non chiusa.
 *
 * Qui si prova che le tre famiglie `fic_ok2`/`fic_ok`/`fic_no` sono entrate in
 * `ORIGINE_CODICE` come tutte le altre, e soprattutto che il codice corto che
 * emettono si RISOLVE — emetterne uno che nessuno sa rileggere sarebbe peggio
 * della situazione di oggi.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  comandoDaMostrare,
  comandoUuid,
  ORIGINE_CODICE,
} from './comandi-uuid'

const UUID = '3f3fc82f-4daa-408e-9308-78effecc338e'

describe('IL DIFETTO del 12 set: /fic_ok_ oggi entra nel limite di Telegram', () => {
  it('IL DIFETTO: fino ad oggi fic_ok emetteva 32 cifre, oltre il limite di Telegram — ora 16', () => {
    // Prima: `codiceDaEmettere('fic_ok', uuid).length === 32` → `/fic_ok_` (8) +
    // 32 = 40 caratteri, oltre il limite di 32 che Telegram riconosce come
    // bot_command. Dopo: 16 cifre, `/fic_ok_` (8) + 16 = 24.
    const codice = comandoDaMostrare('fic_ok', UUID).slice('/fic_ok_'.length)
    expect(codice).toHaveLength(16)
  })

  it('il comando sta sotto i 32 caratteri di Telegram', () => {
    expect(comandoDaMostrare('fic_ok', UUID).length).toBeLessThanOrEqual(32)
    expect(comandoDaMostrare('fic_ok2', UUID).length).toBeLessThanOrEqual(32)
    expect(comandoDaMostrare('fic_no', UUID).length).toBeLessThanOrEqual(32)
  })

  it('nessun trattino: Telegram troncherebbe al primo', () => {
    expect(comandoDaMostrare('fic_no', UUID)).not.toMatch(/-/)
    expect(comandoDaMostrare('fic_ok', UUID)).not.toMatch(/-/)
    expect(comandoDaMostrare('fic_ok2', UUID)).not.toMatch(/-/)
  })

  it('le tre famiglie sono in ORIGINE_CODICE, con la colonna VERIFICATA sul database, non dedotta', () => {
    // Verificato su `information_schema.columns` in produzione:
    // `cervellone_fic_pending.id` è di tipo `uuid`, NOT NULL. Non è il nome
    // scritto "per analogia" con le altre tabelle (quella del difetto A2, che
    // su questo repo è già costato tre mesi di conferme mail rotte).
    expect(ORIGINE_CODICE.fic_ok2).toEqual({ tabella: 'cervellone_fic_pending', colonna: 'id' })
    expect(ORIGINE_CODICE.fic_ok).toEqual({ tabella: 'cervellone_fic_pending', colonna: 'id' })
    expect(ORIGINE_CODICE.fic_no).toEqual({ tabella: 'cervellone_fic_pending', colonna: 'id' })
  })
})

/**
 * Il codice corto deve RISOLVERSI, non solo emettersi.
 *
 * Si mocka `getSupabaseServer` (usato da `comandi-risolvi.ts`) per simulare le
 * righe di `cervellone_fic_pending` che hanno un prefisso di 16 cifre in
 * comune col codice emesso: è esattamente la query che
 * `intervalloPrefisso`/`risolviPrefisso` producono in produzione.
 */
let righeFicPending: string[] = []

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: () => ({
    from: (tabella: string) => {
      if (tabella !== 'cervellone_fic_pending') {
        throw new Error(`tabella inattesa in questo test: ${tabella}`)
      }
      return {
        select: (colonna: string) => ({
          gte: () => ({
            lte: () => ({
              limit: async () => ({
                data: righeFicPending.map((id) => ({ [colonna]: id })),
                error: null,
              }),
            }),
          }),
        }),
      }
    },
  }),
}))

beforeEach(() => {
  righeFicPending = []
})

describe('il codice corto fic_ok si RISOLVE — il giro deve chiudersi', () => {
  it('emesso con comandoDaMostrare e riletto con espandiCodiceBreve + comandoUuid: torna lo STESSO uuid canonico', async () => {
    righeFicPending = [UUID]
    const comando = comandoDaMostrare('fic_ok', UUID)

    const { espandiCodiceBreve } = await import('./comandi-risolvi')
    const esito = await espandiCodiceBreve(comando)

    expect(esito.stato).toBe('espanso')
    if (esito.stato !== 'espanso') throw new Error('atteso espanso')
    expect(esito.uuid).toBe(UUID)
    expect(esito.nome).toBe('fic_ok')
    // Il testo riscritto, riletto con la forma lunga, dà lo stesso uuid: è la
    // prova che il giro si chiude — un codice che nessuno sa rileggere
    // sarebbe peggio della situazione di oggi (almeno oggi è copiabile a
    // mano).
    expect(comandoUuid(esito.testo, 'fic_ok')).toBe(UUID)
  })

  it('vale anche per fic_ok2 e fic_no, non solo per fic_ok', async () => {
    for (const nome of ['fic_ok2', 'fic_no'] as const) {
      righeFicPending = [UUID]
      const comando = comandoDaMostrare(nome, UUID)
      const { espandiCodiceBreve } = await import('./comandi-risolvi')
      const esito = await espandiCodiceBreve(comando)
      expect(esito.stato).toBe('espanso')
      if (esito.stato !== 'espanso') throw new Error('atteso espanso')
      expect(esito.uuid).toBe(UUID)
    }
  })

  it('CONTROLLO POSITIVO — un prefisso ambiguo NON viene risolto a caso', async () => {
    // Due righe con lo stesso prefisso di 16 cifre (le prime tre gruppi
    // dell'uuid: 8+4+4), diverse nel resto. Su una scrittura contabile
    // scegliere a caso è inaccettabile: deve dichiarare l'ambiguità.
    const GEMELLO = '3f3fc82f-4daa-408e-0000-000000000001'
    righeFicPending = [UUID, GEMELLO]
    const comando = comandoDaMostrare('fic_ok', UUID)

    const { espandiCodiceBreve } = await import('./comandi-risolvi')
    const esito = await espandiCodiceBreve(comando)

    expect(esito.stato).toBe('fermo')
    if (esito.stato !== 'fermo') throw new Error('atteso fermo')
    expect(esito.messaggio).toMatch(/NON ho fatto niente/)
    expect(esito.messaggio).toMatch(/bozze diverse/)
  })

  it('nessun candidato: lo dice, non inventa', async () => {
    righeFicPending = []
    const comando = comandoDaMostrare('fic_ok', UUID)

    const { espandiCodiceBreve } = await import('./comandi-risolvi')
    const esito = await espandiCodiceBreve(comando)

    expect(esito.stato).toBe('fermo')
    if (esito.stato !== 'fermo') throw new Error('atteso fermo')
    expect(esito.messaggio).toMatch(/Non trovo nessuna bozza/)
  })
})
