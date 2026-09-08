/**
 * Un 401 veniva salvato come se fosse il file della Questura.
 *
 * Il pulsante era un `<a download>`: il browser scarica QUALUNQUE cosa gli
 * risponda la rotta, compreso `{"ok":false,"errore":"Non autorizzato."}`.
 * Chi consegna le chiavi si ritrovava sul telefono un `Alloggiati_20260909.txt`
 * di 45 byte, apparentemente pronto da caricare sul Portale, e nessun
 * messaggio. Un file che si scarica senza dire niente sembra pronto — e la
 * rotta stessa lo scrive nel suo commento in cima.
 *
 * Qui la decisione sta fuori dal componente, cosi' e' provabile davvero.
 */
import { describe, it, expect, vi } from 'vitest'
import { scaricaFileQuestura } from './scarica-file'

function risposta(corpo: string, opzioni: { ok: boolean; status: number; disposition?: string; tipo?: string }) {
  return {
    ok: opzioni.ok,
    status: opzioni.status,
    headers: new Headers(
      opzioni.disposition ? { 'content-disposition': opzioni.disposition, 'content-type': opzioni.tipo ?? 'text/plain' } : {},
    ),
    text: async () => corpo,
  } as unknown as Response
}

describe('scaricaFileQuestura', () => {
  it('il file vero torna col suo nome', async () => {
    const esito = await scaricaFileQuestura(
      '/api/checkin/alloggiati?scarica=1',
      async () => risposta('0123456789|RSSMRA...', {
        ok: true, status: 200,
        disposition: 'attachment; filename="Alloggiati_20260909.txt"',
      }),
    )

    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.nome).toBe('Alloggiati_20260909.txt')
    expect(esito.contenuto).toContain('RSSMRA')
  })

  // IL DIFETTO: prima questo finiva sul telefono come file da caricare.
  it('un 401 NON diventa un file: torna il messaggio della rotta', async () => {
    const esito = await scaricaFileQuestura(
      '/api/checkin/alloggiati?scarica=1',
      async () => risposta('{"ok":false,"errore":"Non autorizzato."}', { ok: false, status: 401 }),
    )

    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.errore).toContain('Non autorizzato')
  })

  it('un errore senza JSON leggibile dice comunque qualcosa di utile', async () => {
    const esito = await scaricaFileQuestura(
      '/api/checkin/alloggiati?scarica=1',
      async () => risposta('<html>502 Bad Gateway</html>', { ok: false, status: 502 }),
    )

    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.errore).toContain('502')
  })

  it('la rete che cade non lancia: lo dice', async () => {
    const esito = await scaricaFileQuestura(
      '/api/checkin/alloggiati?scarica=1',
      async () => { throw new Error('Failed to fetch') },
    )

    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.errore).toContain('Failed to fetch')
  })

  // Un file vuoto non e' un file pronto: e' proprio il caso che il commento
  // della rotta descrive.
  it('un file vuoto viene DETTO, non salvato', async () => {
    const esito = await scaricaFileQuestura(
      '/api/checkin/alloggiati?scarica=1',
      async () => risposta('', { ok: true, status: 200, disposition: 'attachment; filename="vuoto.txt"' }),
    )

    expect(esito.ok).toBe(false)
    if (esito.ok) return
    expect(esito.errore.toLowerCase()).toContain('vuoto')
  })

  it('senza Content-Disposition si usa un nome di ripiego', async () => {
    const esito = await scaricaFileQuestura(
      '/api/checkin/alloggiati?scarica=1&data=2026-09-09',
      async () => risposta('righe', { ok: true, status: 200, disposition: 'attachment' }),
    )

    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.nome).toMatch(/\.txt$/)
  })
})
