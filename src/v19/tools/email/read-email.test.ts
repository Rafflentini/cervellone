import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./connection', () => ({ openImap: vi.fn(), closeImap: vi.fn() }))
vi.mock('./audit', () => ({ logEmail: vi.fn() }))

import { readEmail } from './read-email'
import { openImap } from './connection'

const apri = openImap as unknown as ReturnType<typeof vi.fn>

function clienteCheCerca(risultato: unknown) {
  return {
    mailboxOpen: vi.fn().mockResolvedValue({ exists: 0 }),
    search: vi.fn().mockResolvedValue(risultato),
    // eslint-disable-next-line require-yield
    fetch: vi.fn().mockImplementation(async function* () {}),
    logout: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => vi.clearAllMocks())

describe('una ricerca IMAP fallita non e una casella vuota', () => {
  // Misurato in produzione il 5 settembre 2026: chiedendo al server TopHost una
  // finestra che finisce nel FUTURO, `search` non restituisce un elenco ma
  // `undefined`. Il codice lo trasformava in `[]`, e chi chiamava leggeva
  // "nessun messaggio" — su una casella che ne conteneva 45. La routine delle
  // fatture estere riportava tranquillamente "0 su 0 esaminati".
  // Un guasto travestito da niente da fare: la stessa forma del difetto che
  // questa giornata e' servita a chiudere. [[feedback_misura_non_e_dato]]

  it('se il server non restituisce un elenco, la lettura FALLISCE invece di dire zero', async () => {
    apri.mockResolvedValue(clienteCheCerca(undefined))

    await expect(readEmail({ account: 'raffaele', since: '2026-09-01', before: '2099-01-01' })).rejects.toThrow(
      /Ricerca IMAP non riuscita/,
    )
  })

  it('vale anche quando il server risponde false', async () => {
    apri.mockResolvedValue(clienteCheCerca(false))

    await expect(readEmail({ account: 'info' })).rejects.toThrow(/Ricerca IMAP non riuscita/)
  })

  it("il messaggio d'errore dice quali criteri erano stati chiesti", async () => {
    // Senza i criteri, chi legge l'errore non puo' capire PERCHE' e' fallita.
    apri.mockResolvedValue(clienteCheCerca(undefined))

    await expect(readEmail({ account: 'info', since: '2026-09-01', before: '2099-01-01' })).rejects.toThrow(
      /2099-01-01/,
    )
  })

  it('CONTROLLO POSITIVO: una casella davvero vuota resta zero, non diventa un errore', async () => {
    // Se alzassimo l'eccezione anche sull'elenco vuoto, ogni mese tranquillo
    // sembrerebbe un guasto — e l'allarme, diventato rumore, verrebbe ignorato
    // proprio quando conta.
    apri.mockResolvedValue(clienteCheCerca([]))

    const r = await readEmail({ account: 'info' })

    expect(r.messages).toEqual([])
    expect(r.total_matched).toBe(0)
  })
})
