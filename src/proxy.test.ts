import { describe, it, expect } from 'vitest'
import type { NextRequest } from 'next/server'
import proxy from './proxy'

/**
 * Quali percorsi si aprono SENZA la password dell'app.
 *
 * L'elenco vive in un `if` lungo, e dimenticarne una voce non fa rumore: la
 * pagina semplicemente reindirizza al login, e chi l'ha scritta se ne accorge
 * solo se la prova in produzione. E' successo il 6 settembre 2026 con
 * l'informativa privacy: pubblicata, e per un turista invisibile.
 *
 * Qui l'elenco diventa una promessa verificabile — nei DUE versi: cio' che
 * dev'essere pubblico lo e', e cio' che non deve esserlo continua a chiedere
 * il login.
 */

function richiesta(pathname: string, conCookie = false): NextRequest {
  return {
    cookies: { get: (n: string) => (conCookie && n === 'cervellone_auth' ? { value: 'x' } : undefined) },
    nextUrl: { pathname },
    url: `https://esempio.test${pathname}`,
  } as unknown as NextRequest
}

/** 200/next = passa; 307 = reindirizzato al login. */
async function reindirizza(pathname: string): Promise<boolean> {
  const res = await proxy(richiesta(pathname))
  return res.status === 307 || res.status === 308
}

const PUBBLICI = [
  '/checkin',
  '/checkin/privacy',
  '/checkin/nuova',
  '/checkin/gestione',
  '/api/checkin/registra',
  '/api/checkin/dati',
  '/api/checkin/comuni',
  '/api/checkin/pratica',
  '/api/checkin/logo',
  '/api/checkin/documento',
  '/api/checkin/alloggiati',
  '/api/checkin/pratiche',
  '/api/checkin/manifest',
  '/api/checkin/prenotazione',
  '/api/checkin/segna',
  '/api/cron/scadenze',
  '/api/telegram',
]

const PROTETTI = [
  '/chat',
  '/api/chat',
  '/impostazioni',
  '/api/drive/lista',
  '/checkin/privacy-ma-non-davvero',
]

describe('cosa si apre senza password', () => {
  it('CONTROLLO POSITIVO: l informativa privacy e pubblica', async () => {
    // Dev'essere leggibile PRIMA di consegnare un documento d'identita, e da
    // chiunque. Un'informativa dietro un login non e un'informativa.
    expect(await reindirizza('/checkin/privacy')).toBe(false)
  })

  it('tutti i percorsi del check-in restano aperti a chi ha il collegamento', async () => {
    const chiusi: string[] = []
    for (const p of PUBBLICI) if (await reindirizza(p)) chiusi.push(p)
    expect(chiusi, `dovevano essere pubblici: ${chiusi.join(', ')}`).toEqual([])
  })

  it('CONTROPROVA: il resto dell app continua a chiedere la password', async () => {
    // Senza questa prova, "lascia passare tutto" supererebbe i test qui sopra.
    const aperti: string[] = []
    for (const p of PROTETTI) if (!(await reindirizza(p))) aperti.push(p)
    expect(aperti, `dovevano essere protetti: ${aperti.join(', ')}`).toEqual([])
  })

  it('con la sessione valida non si viene piu rimandati al login', async () => {
    const res = await proxy(richiesta('/chat', true))
    expect(res.status === 307 || res.status === 308).toBe(false)
  })
})
