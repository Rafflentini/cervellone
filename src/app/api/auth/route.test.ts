import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { POST } from './route'

/**
 * ⚠️ LA PORTA DI CASA, provata nei due versi.
 *
 * Fino al 14 settembre 2026 questa rotta non aveva NESSUN test, e la sua
 * guardia era `password !== process.env.APP_PASSWORD` senza verificare che la
 * variabile esistesse: con `APP_PASSWORD` assente, un POST col corpo `{}`
 * manda `password` = `undefined`, e `undefined !== undefined` e' falso. Si
 * entrava senza indovinare niente. `/api/auth` e' pubblica (`src/proxy.ts`).
 *
 * Qui si misura CHI ENTRA. Il test che conta e' il primo; gli altri esistono
 * perche' senza di loro il primo resterebbe verde anche murando il login.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function req(corpo: unknown): any {
  return { json: async () => corpo }
}

const PASSWORD = 'password-di-prova-lunga-abbastanza'
let passwordDiPrima: string | undefined
let segretoDiPrima: string | undefined
let spia: { mockRestore: () => void }

beforeEach(() => {
  passwordDiPrima = process.env.APP_PASSWORD
  segretoDiPrima = process.env.AUTH_SECRET
  // AUTH_SECRET presente e' lo scenario REALISTICO del difetto: un deploy in
  // cui si e' copiata meta' configurazione. Con AUTH_SECRET assente la rotta
  // risponderebbe 503 piu' avanti e il buco resterebbe nascosto dietro.
  process.env.AUTH_SECRET = 'segreto-di-sessione-di-prova'
  spia = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  if (passwordDiPrima === undefined) delete process.env.APP_PASSWORD
  else process.env.APP_PASSWORD = passwordDiPrima
  if (segretoDiPrima === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = segretoDiPrima
  spia.mockRestore()
})

describe('POST /api/auth — un APP_PASSWORD che manca CHIUDE', () => {
  it('🚨 senza APP_PASSWORD, un corpo vuoto NON entra', async () => {
    delete process.env.APP_PASSWORD

    const r = await POST(req({}))

    // Il punto: NON 200, e nessun cookie di sessione emesso.
    expect(r.status).toBe(503)
    expect(r.cookies.get('cervellone_auth')).toBeUndefined()
  })

  it('🚨 senza APP_PASSWORD non entra nemmeno chi manda la stringa "undefined"', async () => {
    delete process.env.APP_PASSWORD

    const r = await POST(req({ password: 'undefined' }))

    expect(r.status).toBe(503)
  })

  it('🚨 APP_PASSWORD fatta di spazi vale come assente', async () => {
    // Su Vercel una variabile «impostata a niente» esiste come stringa vuota:
    // senza il trim, `''` sarebbe una password, e il corpo `{password:''}`
    // aprirebbe. (Nota: `confrontoCostante` rifiuta comunque le stringhe
    // vuote — questa e' la seconda delle due difese, e le si provano
    // entrambe perche' una sola che cade in silenzio non si vede.)
    process.env.APP_PASSWORD = '   '

    expect((await POST(req({ password: '   ' }))).status).toBe(503)
    expect((await POST(req({ password: '' }))).status).toBe(503)
  })

  it('con APP_PASSWORD configurata, la password sbagliata prende 401', async () => {
    process.env.APP_PASSWORD = PASSWORD

    const r = await POST(req({ password: 'non e la password' }))

    expect(r.status).toBe(401)
    expect(r.cookies.get('cervellone_auth')).toBeUndefined()
  })

  it('una password non-stringa non passa (niente `undefined`, niente oggetti)', async () => {
    process.env.APP_PASSWORD = PASSWORD

    expect((await POST(req({}))).status).toBe(401)
    expect((await POST(req({ password: null }))).status).toBe(401)
    expect((await POST(req({ password: 123 }))).status).toBe(401)
  })

  it('CONTROLLO POSITIVO — con la password GIUSTA si entra e si riceve il cookie', async () => {
    // Senza questo, tutti i test qui sopra resterebbero verdi anche murando il
    // login: risponderebbe 401 sempre, e nessuno se ne accorgerebbe fino al
    // momento in cui Raffaele non riesce piu' ad aprire la chat.
    process.env.APP_PASSWORD = PASSWORD

    const r = await POST(req({ password: PASSWORD }))

    expect(r.status).toBe(200)
    const cookie = r.cookies.get('cervellone_auth')
    expect(cookie?.value).toBeTruthy()
    expect(cookie?.httpOnly).toBe(true)
  })

  it('CONTROLLO POSITIVO — senza AUTH_SECRET il login si disabilita, non si apre', async () => {
    // L'altra meta' della stessa regola, gia' in vigore da settembre: la si
    // prova qui perche' nessun test la copriva.
    process.env.APP_PASSWORD = PASSWORD
    delete process.env.AUTH_SECRET

    const r = await POST(req({ password: PASSWORD }))

    expect(r.status).toBe(503)
    expect(r.cookies.get('cervellone_auth')).toBeUndefined()
  })
})
